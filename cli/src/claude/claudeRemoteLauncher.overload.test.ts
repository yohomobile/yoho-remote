import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from './loop';

vi.mock('./claudeRemote', () => ({
    claudeRemote: vi.fn(),
    ThinkingTimeoutError: class ThinkingTimeoutError extends Error {}
}));

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class PermissionHandler {
        setOnPermissionRequest(): void {}
        handleModeChange(): void {}
        onMessage(): void {}
        isAborted(): boolean { return false; }
        reset(): void {}
        getResponses(): Map<string, unknown> { return new Map(); }
        async handleToolCall(): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> {
            return { behavior: 'allow', updatedInput: {} };
        }
    }
}));

import { claudeRemote } from './claudeRemote';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';

type RpcHandler = (...args: unknown[]) => unknown;

function createSessionStub(messageMode: EnhancedMode) {
    const rpcHandlers = new Map<string, RpcHandler>();
    let consumed = false;

    const queue = {
        waitForMessagesAndGetAsString: vi.fn(async () => {
            if (consumed) {
                return null;
            }
            consumed = true;
            return {
                message: '请继续这个任务',
                mode: messageMode,
                isolate: false,
                hash: 'mode-hash-1'
            };
        }),
        size: vi.fn(() => 0),
        reset: vi.fn(),
        pushImmediate: vi.fn((message: string, mode: EnhancedMode) => {
            const switchHandler = rpcHandlers.get('switch');
            if (switchHandler) {
                void switchHandler();
            }
            return { message, mode };
        })
    };

    const client = {
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: RpcHandler) => {
                rpcHandlers.set(method, handler);
            })
        },
        sendClaudeSessionMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
            updater({ requests: {}, completedRequests: {} });
        })
    };

    const session: Record<string, unknown> = {
        logPath: '/tmp/claude-remote-launcher-test.log',
        queue,
        client,
        addSessionFoundCallback: vi.fn(),
        removeSessionFoundCallback: vi.fn(),
        sessionId: 'session-1',
        path: '/tmp',
        allowedTools: [],
        mcpServers: {},
        hookSettingsPath: '/tmp/hook-settings.json',
        claudeEnvVars: undefined,
        claudeArgs: undefined,
        onSessionFound: vi.fn(),
        onThinkingChange: vi.fn(),
        clearSessionId: vi.fn(),
        consumeOneTimeFlags: vi.fn()
    };

    return {
        queue,
        client,
        session,
        rpcHandlers
    };
}

describe('claudeRemoteLauncher overload fallback', () => {
    const claudeRemoteMock = vi.mocked(claudeRemote);
    const originalSessionSource = process.env.YR_SESSION_SOURCE;
    const originalFallbackModel = process.env.YR_CLAUDE_OPENAI_FALLBACK_MODEL;

    beforeEach(() => {
        process.env.YR_SESSION_SOURCE = 'brain';
        delete process.env.YR_CLAUDE_OPENAI_FALLBACK_MODEL;
        claudeRemoteMock.mockReset();
    });

    afterEach(() => {
        if (originalSessionSource === undefined) {
            delete process.env.YR_SESSION_SOURCE;
        } else {
            process.env.YR_SESSION_SOURCE = originalSessionSource;
        }

        if (originalFallbackModel === undefined) {
            delete process.env.YR_CLAUDE_OPENAI_FALLBACK_MODEL;
        } else {
            process.env.YR_CLAUDE_OPENAI_FALLBACK_MODEL = originalFallbackModel;
        }

        vi.restoreAllMocks();
    });

    it('requeues message with fallback model on E012/529 overload', async () => {
        claudeRemoteMock.mockImplementationOnce(async (opts: any) => {
            await opts.nextMessage();
            throw new Error('API Error: 400 {"error":{"code":"E012","message":"Server overloaded"},"status":529}');
        });

        const initialMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: 'opus'
        };

        const { session, queue, client } = createSessionStub(initialMode);

        const result = await claudeRemoteLauncher(session as any);

        expect(result).toBe('switch');
        expect(queue.pushImmediate).toHaveBeenCalledTimes(1);
        expect(queue.pushImmediate).toHaveBeenCalledWith(
            '请继续这个任务',
            expect.objectContaining({
                model: 'opus',
                fallbackModel: 'gpt-5.2'
            })
        );
        expect(client.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'message',
                message: expect.stringContaining('备用模型 gpt-5.2')
            })
        );
    });
});
