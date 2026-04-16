/**
 * Permission Handler for canCallTool integration
 * 
 * Replaces the MCP permission server with direct SDK integration.
 * Handles tool permission requests, responses, and state management.
 */

import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PermissionResult } from "../sdk/types";
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from "../sdk/prompts";
import { Session } from "../session";
import { deepEqual } from "@/utils/deepEqual";
import { getToolName } from "./getToolName";
import { EnhancedMode, PermissionMode } from "../loop";

import { delay } from "@/utils/time";

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'bypassPermissions';
    allowTools?: string[];
    answers?: Record<string, string[]>;
    receivedAt?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isAskUserQuestionToolName(toolName: string): boolean {
    return toolName === 'AskUserQuestion' || toolName === 'ask_user_question';
}

function isExitPlanModeToolName(toolName: string): boolean {
    return toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode';
}

function isAgentToolName(toolName: string): boolean {
    return toolName === 'Agent' || toolName === 'Task';
}

function isRootOnlySubagentToolName(toolName: string): boolean {
    return isAgentToolName(toolName) || isExitPlanModeToolName(toolName);
}

function buildSubagentRootOnlyDenyMessage(toolName: string): string {
    return `Tool "${toolName}" is only available in the top-level session. Complete the task with the tools provided and return findings to the orchestrator.`;
}

const ROOT_ONLY_TOOL_CALL_TIMEOUT_MS = 5_000;

const SUBAGENT_PROMPT_GUARD_MARKER = '<yoho-remote-subagent-constraints>';
const SUBAGENT_PROMPT_GUARD = `${SUBAGENT_PROMPT_GUARD_MARKER}
You are a subagent running inside another Claude session.
- Do NOT use Agent, Task, or ExitPlanMode in this context.
- Only use tools that are actually available in this session.
- Complete the task and return findings to the orchestrator instead of trying to exit plan mode or spawning more agents.`;

/** Tools that must always go through user approval, regardless of permission mode */
function requiresUserApproval(toolName: string): boolean {
    return isAskUserQuestionToolName(toolName) || isExitPlanModeToolName(toolName);
}

function formatAskUserQuestionAnswers(answers: Record<string, string[]>, input: unknown): string {
    const questions = (() => {
        if (!isObject(input)) return null;
        const raw = input.questions;
        if (!Array.isArray(raw)) return null;
        return raw.filter((q) => isObject(q));
    })();

    const keys = Object.keys(answers).sort((a, b) => {
        const aNum = Number.parseInt(a, 10);
        const bNum = Number.parseInt(b, 10);
        if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
        if (Number.isFinite(aNum)) return -1;
        if (Number.isFinite(bNum)) return 1;
        return a.localeCompare(b);
    });

    const lines = keys.map((key) => {
        const idx = Number.parseInt(key, 10);
        const q = questions && Number.isFinite(idx) ? questions[idx] : null;
        const header = q && typeof q.header === 'string' && q.header.trim().length > 0
            ? q.header.trim()
            : Number.isFinite(idx)
                ? `Question ${idx + 1}`
                : `Question ${key}`;
        const value = answers[key] ?? [];
        const joined = value.map((v) => String(v)).filter((v) => v.trim().length > 0).join(', ');
        return `${header}: ${joined || '(no answer)'}`;
    });

    const rawJson = (() => {
        try {
            return JSON.stringify(answers);
        } catch {
            return null;
        }
    })();

    const body = lines.length > 0 ? lines.join('\n') : '(no answers)';
    return rawJson
        ? `User answered:\n${body}\n\nRaw answers JSON:\n${rawJson}`
        : `User answered:\n${body}`;
}

function buildAskUserQuestionUpdatedInput(input: unknown, answers: Record<string, string[]>): Record<string, unknown> {
    if (!isObject(input)) {
        return { answers };
    }

    return {
        ...input,
        answers
    };
}

const TOOL_USE_ERROR_REGEX = /<tool_use_error>(.*?)<\/tool_use_error>/s;
const TOOL_RESULT_REASON_KEYS = ['text', 'content', 'message', 'error', 'output', 'result'] as const;

function stripToolUseErrorWrapper(text: string): string {
    const match = text.match(TOOL_USE_ERROR_REGEX);
    return typeof match?.[1] === 'string' ? match[1].trim() : text.trim();
}

function extractToolResultReason(value: unknown, depth: number = 0): string | null {
    if (depth > 3 || value === null || value === undefined) return null;

    if (typeof value === 'string') {
        const trimmed = stripToolUseErrorWrapper(value);
        return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const reason = extractToolResultReason(item, depth + 1);
            if (reason) return reason;
        }
        return null;
    }

    if (!isObject(value)) return null;

    if (value.type === 'text' && typeof value.text === 'string') {
        return extractToolResultReason(value.text, depth + 1);
    }

    for (const key of TOOL_RESULT_REASON_KEYS) {
        const reason = extractToolResultReason(value[key], depth + 1);
        if (reason) return reason;
    }

    return null;
}

interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

interface ToolCallRecord {
    id: string;
    name: string;
    input: unknown;
    used: boolean;
    parentToolUseId: string | null;
    createdAt: number;
}

function buildSubagentPromptInput(input: unknown): Record<string, unknown> | null {
    if (!isObject(input) || typeof input.prompt !== 'string') {
        return null;
    }

    const prompt = input.prompt;
    if (prompt.includes(SUBAGENT_PROMPT_GUARD_MARKER)) {
        return input;
    }

    return {
        ...input,
        prompt: `${SUBAGENT_PROMPT_GUARD}\n\n${prompt}`
    };
}

export class PermissionHandler {
    private toolCalls: ToolCallRecord[] = [];
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'bypassPermissions';
    private onPermissionRequestCallback?: (toolCallId: string) => void;

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }
    
    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        this.permissionMode = mode;
        this.session.setPermissionMode(mode);
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {
        const toolCall = this.toolCalls.find(tc => tc.id === response.id);
        const isSidechain = Boolean(toolCall?.parentToolUseId);

        // Update allowed tools
        if (response.allowTools && response.allowTools.length > 0) {
            response.allowTools.forEach(tool => {
                if (isAskUserQuestionToolName(tool)) {
                    return;
                }
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
            this.session.setPermissionMode(response.mode);
        }

        // Handle 
        if (isAskUserQuestionToolName(pending.toolName)) {
            const answers = response.answers ?? {};
            if (Object.keys(answers).length === 0) {
                pending.resolve({ behavior: 'deny', message: 'No answers were provided.' });
                return;
            }

            pending.resolve({
                behavior: 'allow',
                updatedInput: buildAskUserQuestionUpdatedInput(pending.input, answers)
            });
            return;
        }

        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            if (isSidechain) {
                pending.resolve({
                    behavior: 'deny',
                    message: buildSubagentRootOnlyDenyMessage(pending.toolName)
                });
                return;
            }
            // Handle exit_plan_mode specially
            logger.debug('Plan mode result received', response);
            if (response.approved) {
                logger.debug('Plan approved - injecting PLAN_FAKE_RESTART');
                this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'bypassPermissions' });
                pending.resolve({ behavior: 'deny', message: PLAN_FAKE_REJECT });
            } else {
                pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
            }
        } else {
            // Handle default case for all other tools
            const result: PermissionResult = response.approved
                ? { behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} }
                : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` };

            pending.resolve(result);
        }
    }

    /**
     * Creates the canCallTool callback for the SDK
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }): Promise<PermissionResult> => {
        // Enforce tool whitelist (e.g. Brain mode only allows MCP tools)
        // If allowedTools is set in the mode, reject any tool not in the list
        if (mode.allowedTools && mode.allowedTools.length > 0 && !mode.allowedTools.includes(toolName)) {
            logger.debug(`[permissionHandler] Tool "${toolName}" not in allowedTools whitelist, denying`);
            return { behavior: 'deny', message: `Tool "${toolName}" is not available in this session.` };
        }

        if (isAgentToolName(toolName)) {
            const matchedAgentToolCall = await this.awaitToolCall(toolName, input, options.signal, ROOT_ONLY_TOOL_CALL_TIMEOUT_MS);
            if (matchedAgentToolCall?.parentToolUseId) {
                logger.debug(`[permissionHandler] Blocking root-only tool "${toolName}" inside sidechain`);
                return { behavior: 'deny', message: buildSubagentRootOnlyDenyMessage(toolName) };
            }
            const updatedInput = buildSubagentPromptInput(input);
            if (updatedInput) {
                return { behavior: 'allow', updatedInput };
            }
        }

        const matchedToolCall = isExitPlanModeToolName(toolName)
            ? await this.awaitToolCall(toolName, input, options.signal, ROOT_ONLY_TOOL_CALL_TIMEOUT_MS)
            : null;
        const isSidechainTool = Boolean(matchedToolCall?.parentToolUseId);

        if (isSidechainTool && isRootOnlySubagentToolName(toolName)) {
            logger.debug(`[permissionHandler] Blocking root-only tool "${toolName}" inside sidechain`);
            return { behavior: 'deny', message: buildSubagentRootOnlyDenyMessage(toolName) };
        }

        // Check if tool is explicitly allowed
        // Tools that require user approval (AskUserQuestion, ExitPlanMode) are never auto-allowed
        if (!requiresUserApproval(toolName) && toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                    }
                }
            }
        } else if (!requiresUserApproval(toolName) && this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Handle special cases
        //

        if (!requiresUserApproval(toolName) && this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        const toolCallId = matchedToolCall?.id ?? await this.awaitToolCallId(toolName, input, options.signal);
        if (!toolCallId) {
            throw new Error(`Could not resolve tool call ID for ${toolName}`);
        }
        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            const pendingRequest: PendingRequest = {
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input
            };

            // Store the pending request
            this.pendingRequests.set(id, pendingRequest);

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }
            
            // Update agent state
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            const existingResponse = this.responses.get(id);
            if (existingResponse) {
                this.pendingRequests.delete(id);
                this.handlePermissionResponse(existingResponse, pendingRequest);
                this.completeRequestState(id, existingResponse);
                return;
            }

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);
        
        if (!match) {
            return;
        }

        const command = match[1];
        
        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Resolves tool call ID based on tool name and input
     */
    private resolveToolCallId(name: string, args: unknown): string | null {
        // Search in reverse (most recent first)
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.name === name && deepEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        return null;
    }

    private findUnusedToolCall(name: string, args: unknown): ToolCallRecord | null {
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.used) {
                continue;
            }
            if (call.name === name && deepEqual(call.input, args)) {
                return call;
            }
        }

        return null;
    }

    private async awaitToolCall(name: string, args: unknown, signal: AbortSignal, timeoutMs = 5_000): Promise<ToolCallRecord | null> {
        const deadline = Date.now() + timeoutMs;
        while (!signal.aborted) {
            const call = this.findUnusedToolCall(name, args);
            if (call) {
                return call;
            }
            if (Date.now() >= deadline) {
                return null;
            }
            await delay(50);
        }

        return null;
    }

    private async awaitToolCallId(name: string, args: unknown, signal: AbortSignal, timeoutMs = 5_000): Promise<string | null> {
        const deadline = Date.now() + timeoutMs;
        while (!signal.aborted) {
            const id = this.resolveToolCallId(name, args);
            if (id) {
                return id;
            }
            if (Date.now() >= deadline) {
                return null;
            }
            await delay(50);
        }

        return null;
    }

    /**
     * Handles messages to track tool calls
     */
    onMessage(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        this.toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false,
                            parentToolUseId: assistantMsg.parent_tool_use_id ?? null,
                            createdAt: Date.now()
                        });
                    }
                }
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = this.toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                            if (requiresUserApproval(toolCall.name) && block.is_error === true && !block.permissions) {
                                const reason = extractToolResultReason(block.content)
                                    ?? 'Tool call failed before a permission request was created.';
                                logger.debug(`[permissionHandler] Synthesizing completed request for orphan ${toolCall.name} error: ${toolCall.id}`);
                                this.completeOrphanRequestState(toolCall.id, toolCall, reason);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {

        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
            return true;
        }

        // Always abort exit_plan_mode
        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && (toolCall.name === 'exit_plan_mode' || toolCall.name === 'ExitPlanMode')) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(): void {
        this.toolCalls = [];
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session switched to local mode'
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    private completeRequestState(id: string, message: PermissionResponse): void {
        this.session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;
            const requests = { ...currentState.requests };
            delete requests[id];
            return {
                ...currentState,
                requests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: message.approved ? 'approved' : 'denied',
                        reason: message.reason,
                        mode: message.mode,
                        allowTools: message.allowTools,
                        answers: message.answers
                    }
                }
            };
        });
    }

    private completeOrphanRequestState(id: string, toolCall: ToolCallRecord, reason: string): void {
        this.session.client.updateAgentState((currentState) => {
            if (currentState.requests?.[id] || currentState.completedRequests?.[id]) {
                return currentState;
            }

            return {
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        tool: toolCall.name,
                        arguments: toolCall.input,
                        createdAt: toolCall.createdAt,
                        completedAt: Date.now(),
                        status: 'canceled',
                        reason
                    }
                }
            };
        });
    }

    /**
     * Sets up the client handler for permission responses
     */
    private setupClientHandler(): void {
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
            logger.debug(`Permission response: ${JSON.stringify(message)}`);

            const id = message.id;
            this.responses.set(id, { ...message, receivedAt: Date.now() });
            const pending = this.pendingRequests.get(id);

            if (!pending) {
                logger.debug('Permission request not found yet, stored response for later replay');
                return;
            }

            this.pendingRequests.delete(id);

            // Handle the permission response based on tool type
            this.handlePermissionResponse(message, pending);

            this.completeRequestState(id, message);
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}
