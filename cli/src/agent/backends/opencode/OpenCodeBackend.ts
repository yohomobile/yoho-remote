import type { AgentBackend, AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { asString, isObject } from '@/agent/utils';
import { AcpStdioTransport } from '../acp/AcpStdioTransport';
import { AcpMessageHandler } from '../acp/AcpMessageHandler';
import { logger } from '@/ui/logger';
import packageJson from '../../../../package.json';

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

export type OpenCodeBackendOptions = {
    /** Default model to use (e.g., 'anthropic/claude-sonnet-4') */
    defaultModel?: string;
    /** Model variant/reasoning effort (e.g., 'high', 'max', 'minimal') */
    variant?: string;
    /** Timeout for initialization in ms (default: 30000) */
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

export class OpenCodeBackend implements AgentBackend {
    private transport: AcpStdioTransport | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private messageHandler: AcpMessageHandler | null = null;
    private activeSessionId: string | null = null;
    private readonly initTimeoutMs: number;
    private currentModel: string;
    private currentVariant: string | undefined;

    constructor(private readonly options: OpenCodeBackendOptions = {}) {
        this.initTimeoutMs = options.initTimeoutMs ?? 30_000;
        this.currentModel = options.defaultModel ?? 'anthropic.claude-sonnet-4-20250514';
        this.currentVariant = options.variant;
    }

    async initialize(): Promise<void> {
        await this.startTransport();
    }

    private async startTransport(): Promise<void> {
        if (this.transport) {
            await this.transport.close().catch(() => {});
            this.transport = null;
        }

        // Build environment with model configuration using OPENCODE_CONFIG_CONTENT
        const configContent: Record<string, unknown> = {
            model: this.currentModel
        };
        // Only add reasoningEffort for OpenAI models (they support this parameter)
        if (this.currentVariant && this.currentModel.startsWith('openai/')) {
            configContent.reasoningEffort = this.currentVariant;
        }
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent),
        };

        logger.debug(`[OpenCode] Starting ACP with config: ${JSON.stringify(configContent)}`);

        // Use opencode acp mode via stdio
        this.transport = new AcpStdioTransport({
            command: 'opencode',
            args: ['acp'],
            env
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
                `OpenCode ACP initialize timed out after ${this.initTimeoutMs}ms`
            );

            if (!isObject(response) || typeof response.protocolVersion !== 'number') {
                throw new Error('Invalid initialize response from OpenCode ACP');
            }

            logger.debug(`[OpenCode] ACP initialized with protocol version ${response.protocolVersion}, model: ${this.currentModel}`);
        } catch (error) {
            await this.transport.close().catch(() => {});
            this.transport = null;
            throw error;
        }
    }

    // Method to get current model
    getModel(_sessionId: string): string {
        return this.currentModel;
    }

    // Method to change model - requires restarting the ACP process
    async setModel(_sessionId: string, model: string): Promise<void> {
        if (this.currentModel === model) {
            return;
        }
        logger.debug(`[OpenCode] Changing model from ${this.currentModel} to ${model}`);
        this.currentModel = model;
        // Restart transport with new model
        await this.startTransport();
        // Note: This will lose the current OpenCode session state
        // A new session will be created on next newSession() call
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        if (!this.transport) {
            throw new Error('OpenCode transport not initialized');
        }

        const sessionParams: Record<string, unknown> = {
            cwd: config.cwd,
            mcpServers: config.mcpServers,
            model: this.currentModel
        };
        if (this.currentVariant) {
            sessionParams.variant = this.currentVariant;
        }
        logger.debug(`[OpenCode] Creating session with model: ${this.currentModel}, variant: ${this.currentVariant ?? 'default'}`);

        const response = await withTimeout(
            this.transport.sendRequest('session/new', sessionParams),
            this.initTimeoutMs,
            `OpenCode session/new timed out after ${this.initTimeoutMs}ms`
        );

        // Check for errors
        if (isObject(response) && response.error) {
            const errorObj = response.error as Record<string, unknown>;
            const errorMessage = asString(errorObj.message) ?? 'Unknown error';
            throw new Error(`OpenCode session creation failed: ${errorMessage}`);
        }

        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) {
            const responseStr = JSON.stringify(response).slice(0, 200);
            throw new Error(`Invalid session/new response from OpenCode: ${responseStr}`);
        }

        this.activeSessionId = sessionId;
        logger.debug(`[OpenCode] Created session: ${sessionId}`);
        return sessionId;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('OpenCode transport not initialized');
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
            logger.debug('[OpenCode] No pending permission request for id', request.id);
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
        if (this.transport) {
            await this.transport.close();
            this.transport = null;
        }
    }

    private handleSessionUpdate(params: unknown): void {
        if (!this.messageHandler) return;
        if (!isObject(params)) return;

        const update = params.update;
        if (!isObject(update)) return;

        this.messageHandler.handleUpdate(update);
    }

    private async handlePermissionRequest(params: unknown, requestId: string | number | null): Promise<unknown> {
        if (!isObject(params)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const sessionId = asString(params.sessionId) ?? this.activeSessionId;
        if (!sessionId) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const permission = params.permission;
        if (!isObject(permission)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const requestIdString = typeof requestId === 'string'
            ? requestId
            : typeof requestId === 'number'
                ? String(requestId)
                : '';
        const fallbackId = requestIdString || asString(permission.callId) || `${sessionId}-${Date.now()}`;
        const id = asString(permission.id) ?? fallbackId;
        const title = asString(permission.title) ?? 'Permission Request';
        const kind = asString(permission.type) ?? 'unknown';

        const request: PermissionRequest = {
            id,
            sessionId,
            toolCallId: asString(permission.callId) ?? id,
            title,
            kind,
            rawInput: permission.metadata ?? {},
            options: [
                { optionId: 'once', name: 'Allow Once', kind: 'allow_once' },
                { optionId: 'always', name: 'Allow Always', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
            ]
        };

        if (this.permissionHandler) {
            this.permissionHandler(request);
        }

        return new Promise((resolve) => {
            this.pendingPermissions.set(id, { resolve });
        });
    }
}
