import type { AgentBackend, AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { asString, isObject } from '@/agent/utils';
import { AcpStdioTransport } from './AcpStdioTransport';
import { AcpMessageHandler } from './AcpMessageHandler';
import { logger } from '@/ui/logger';
import packageJson from '../../../../package.json';

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

type AcpSdkBackendOptions = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    fallbackArgs?: string[][];
    initTimeoutMs?: number;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);

        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }).catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

export class AcpSdkBackend implements AgentBackend {
    private transport: AcpStdioTransport | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private messageHandler: AcpMessageHandler | null = null;
    private activeSessionId: string | null = null;
    private readonly argsCandidates: string[][];
    private readonly initTimeoutMs: number;

    constructor(private readonly options: AcpSdkBackendOptions) {
        this.argsCandidates = options.fallbackArgs && options.fallbackArgs.length > 0
            ? options.fallbackArgs
            : [options.args ?? []];
        this.initTimeoutMs = options.initTimeoutMs ?? 10_000;
    }

    async initialize(): Promise<void> {
        if (this.transport) return;

        let lastError: Error | null = null;

        for (const args of this.argsCandidates) {
            this.transport = new AcpStdioTransport({
                command: this.options.command,
                args,
                env: this.options.env
            });

            this.transport.onNotification((method, params) => {
                if (method === 'session/update') {
                    this.handleSessionUpdate(params);
                }
            });

            this.transport.registerRequestHandler('session/request_permission', async (params, requestId) => {
                return await this.handlePermissionRequest(params, requestId);
            });

            try {
                const response = await withTimeout(
                    this.transport.sendRequest('initialize', {
                        protocolVersion: 1,
                        clientCapabilities: {
                            fs: { readTextFile: false, writeTextFile: false },
                            terminal: false
                        },
                        clientInfo: {
                            name: 'yoho-remote',
                            version: packageJson.version
                        }
                    }),
                    this.initTimeoutMs,
                    `ACP initialize timed out after ${this.initTimeoutMs}ms`
                );

                if (!isObject(response) || typeof response.protocolVersion !== 'number') {
                    throw new Error('Invalid initialize response from ACP agent');
                }

                logger.debug(`[ACP] Initialized with protocol version ${response.protocolVersion}`);
                return;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logger.debug('[ACP] Initialize failed, trying next args', {
                    command: this.options.command,
                    args,
                    error: lastError.message
                });
                await this.transport.close().catch(() => {});
                this.transport = null;
            }
        }

        throw lastError ?? new Error('Failed to initialize ACP agent');
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withTimeout(
            this.transport.sendRequest('session/new', {
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            this.initTimeoutMs,
            `ACP session/new timed out after ${this.initTimeoutMs}ms`
        );

        // Check for authentication errors
        if (isObject(response) && response.error) {
            const errorObj = response.error as Record<string, unknown>;
            const errorMessage = asString(errorObj.message) ?? 'Unknown error';
            const errorCode = errorObj.code;

            // Provide helpful hints for common auth errors
            if (errorMessage.includes('auth') || errorMessage.includes('API key') ||
                errorMessage.includes('credentials') || errorCode === 401) {
                throw new Error(`Authentication failed: ${errorMessage}. ` +
                    `For Gemini, set GEMINI_API_KEY environment variable.`);
            }
            throw new Error(`ACP session creation failed: ${errorMessage}`);
        }

        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) {
            const responseStr = JSON.stringify(response).slice(0, 200);
            throw new Error(`Invalid session/new response from ACP agent: ${responseStr}`);
        }

        this.activeSessionId = sessionId;
        return sessionId;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        this.activeSessionId = sessionId;
        this.messageHandler = new AcpMessageHandler(onUpdate);

        try {
            const response = await this.transport.sendRequest('session/prompt', {
                sessionId,
                prompt: content
            });

            const stopReason = isObject(response) ? asString(response.stopReason) : null;
            if (stopReason) {
                onUpdate({ type: 'turn_complete', stopReason });
            }
        } finally {
            this.messageHandler = null;
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        if (!this.transport) {
            return;
        }

        this.transport.sendNotification('session/cancel', { sessionId });
    }

    async respondToPermission(
        _sessionId: string,
        request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const pending = this.pendingPermissions.get(request.id);
        if (!pending) {
            logger.debug('[ACP] No pending permission request for id', request.id);
            return;
        }

        this.pendingPermissions.delete(request.id);

        if (response.outcome === 'cancelled') {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            return;
        }

        pending.resolve({
            outcome: {
                outcome: 'selected',
                optionId: response.optionId
            }
        });
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    async disconnect(): Promise<void> {
        if (!this.transport) return;
        await this.transport.close();
        this.transport = null;
    }

    private handleSessionUpdate(params: unknown): void {
        if (!isObject(params)) return;
        const sessionId = asString(params.sessionId);
        if (this.activeSessionId && sessionId && sessionId !== this.activeSessionId) {
            return;
        }
        const update = params.update;
        if (!this.messageHandler) return;
        this.messageHandler.handleUpdate(update);
    }

    private async handlePermissionRequest(params: unknown, requestId: string | number | null): Promise<unknown> {
        if (!isObject(params)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const sessionId = asString(params.sessionId) ?? this.activeSessionId ?? 'unknown';
        const toolCall = isObject(params.toolCall) ? params.toolCall : {};
        const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
        const title = asString(toolCall.title) ?? undefined;
        const kind = asString(toolCall.kind) ?? undefined;
        const rawInput = 'rawInput' in toolCall ? toolCall.rawInput : undefined;
        const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined;
        const options = Array.isArray(params.options)
            ? params.options
                .filter((option) => isObject(option))
                .map((option, index) => ({
                    optionId: asString(option.optionId) ?? `option-${index + 1}`,
                    name: asString(option.name) ?? `Option ${index + 1}`,
                    kind: asString(option.kind) ?? 'allow_once'
                }))
            : [];

        const request: PermissionRequest = {
            id: toolCallId,
            sessionId,
            toolCallId,
            title,
            kind,
            rawInput,
            rawOutput,
            options
        };

        if (this.permissionHandler) {
            this.permissionHandler(request);
        } else {
            logger.debug('[ACP] No permission handler registered; cancelling request');
            return { outcome: { outcome: 'cancelled' } };
        }

        return await new Promise((resolve) => {
            this.pendingPermissions.set(toolCallId, { resolve });
        });
    }
}
