/**
 * Permission Handler for Codex tool approval integration
 * 
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { AgentState, type SessionPermissionMode } from "@/api/types";

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
}

interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
}

export class CodexPermissionHandler {
    private pendingRequests = new Map<string, PendingRequest>();
    private responses = new Map<string, PermissionResponse>();
    private session: ApiSessionClient;
    private readonly getPermissionMode?: () => SessionPermissionMode | undefined;

    constructor(session: ApiSessionClient, options?: { getPermissionMode?: () => SessionPermissionMode | undefined }) {
        this.session = session;
        this.getPermissionMode = options?.getPermissionMode;
        this.setupRpcHandler();
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown,
        options?: { approvalKind?: 'mcp_tool_call' | 'exec_command' | 'unknown' }
    ): Promise<PermissionResult> {
        const permissionMode = this.getPermissionMode?.();
        logger.debug(`[Codex] handleToolCall called: id=${toolCallId} tool=${toolName} kind=${options?.approvalKind ?? 'unknown'} mode=${permissionMode ?? 'unknown'}`);
        if (
            options?.approvalKind === 'mcp_tool_call'
            && (permissionMode === 'yolo' || permissionMode === 'safe-yolo')
        ) {
            logger.debug(`[Codex] Auto-approving MCP tool call in ${permissionMode}: ${toolName} (${toolCallId})`);
            return { decision: 'approved' };
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            const pendingRequest: PendingRequest = {
                resolve,
                reject,
                toolName,
                input
            };

            // Store the pending request
            this.pendingRequests.set(toolCallId, pendingRequest);

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            // Update agent state with pending request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            const existingResponse = this.responses.get(toolCallId);
            if (existingResponse) {
                this.pendingRequests.delete(toolCallId);
                const result = this.buildPermissionResult(existingResponse);
                pendingRequest.resolve(result);
                this.completeRequestState(toolCallId, existingResponse, result);
                return;
            }

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    private buildPermissionResult(response: PermissionResponse): PermissionResult {
        const reason = typeof response.reason === 'string' ? response.reason : undefined;
        return response.approved
            ? {
                decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved',
                reason
            }
            : {
                decision: response.decision === 'denied' ? 'denied' : 'abort',
                reason
            };
    }

    private completeRequestState(id: string, response: PermissionResponse, result: PermissionResult): void {
        this.session.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;

            const { [id]: _, ...remainingRequests } = currentState.requests || {};

            return {
                ...currentState,
                requests: remainingRequests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: response.approved ? 'approved' : 'denied',
                        decision: result.decision,
                        reason: result.reason
                    }
                }
            } satisfies AgentState;
        });
    }

    /**
     * Setup RPC handler for permission responses
     */
    private setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                // console.log(`[Codex] Permission response received:`, response);
                this.responses.set(response.id, response);

                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug('[Codex] Permission request not found yet, stored response for later replay');
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result = this.buildPermissionResult(response);

                pending.resolve(result);
                logger.debug(`[Codex] Permission RPC resolved: id=${response.id} tool=${pending.toolName} decision=${result.decision}`);

                this.completeRequestState(response.id, response, result);

                logger.debug(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();
        this.responses.clear();

        // Clear requests in agent state
        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move all pending to completed as canceled
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session reset'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });

        logger.debug('[Codex] Permission handler reset');
    }
}
