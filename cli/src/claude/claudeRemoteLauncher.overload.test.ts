import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from './loop';
import { PLAN_FAKE_REJECT } from './sdk/prompts';

vi.mock('./claudeRemote', () => ({
    claudeRemote: vi.fn(),
    ThinkingTimeoutError: class ThinkingTimeoutError extends Error {}
}));

const permissionHandlerInstances: Array<{ onMessage: ReturnType<typeof vi.fn> }> = [];

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class PermissionHandler {
        onMessage = vi.fn();

        constructor() {
            permissionHandlerInstances.push(this);
        }

        setOnPermissionRequest(): void {}
        handleModeChange(): void {}
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
        permissionHandlerInstances.length = 0;
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

    it('keeps sidechain ExitPlanMode tool results out of the top-level plan-mode hack', async () => {
        const initialMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: 'opus'
        };

        const { session, client, rpcHandlers } = createSessionStub(initialMode);

        claudeRemoteMock.mockImplementationOnce(async (opts: any) => {
            await opts.nextMessage();
            opts.onMessage({
                type: 'assistant',
                parent_tool_use_id: 'parent-tool',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'tool-sidechain-exit',
                        name: 'ExitPlanMode',
                        input: { plan: 'subagent plan' }
                    }]
                }
            });
            opts.onMessage({
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool-sidechain-exit',
                        content: PLAN_FAKE_REJECT,
                        is_error: true
                    }]
                }
            });
            const switchHandler = rpcHandlers.get('switch');
            if (switchHandler) {
                void switchHandler();
            }
        });

        const result = await claudeRemoteLauncher(session as any);

        expect(result).toBe('switch');
        const toolResultMessage = client.sendClaudeSessionMessage.mock.calls
            .map((args: any[]) => args[0])
            .find((message: any) => message?.message?.content?.[0]?.type === 'tool_result');
        expect(toolResultMessage?.message?.content?.[0]?.content).toBe(PLAN_FAKE_REJECT);
    });

    it('still rewrites top-level ExitPlanMode tool results into approved plan messages', async () => {
        const initialMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: 'opus'
        };

        const { session, client, rpcHandlers } = createSessionStub(initialMode);

        claudeRemoteMock.mockImplementationOnce(async (opts: any) => {
            await opts.nextMessage();
            opts.onMessage({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'tool-top-level-exit',
                        name: 'ExitPlanMode',
                        input: { plan: 'top-level plan' }
                    }]
                }
            });
            opts.onMessage({
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool-top-level-exit',
                        content: PLAN_FAKE_REJECT,
                        is_error: true
                    }]
                }
            });
            const switchHandler = rpcHandlers.get('switch');
            if (switchHandler) {
                void switchHandler();
            }
        });

        const result = await claudeRemoteLauncher(session as any);

        expect(result).toBe('switch');
        const toolResultMessage = client.sendClaudeSessionMessage.mock.calls
            .map((args: any[]) => args[0])
            .find((message: any) => message?.message?.content?.[0]?.type === 'tool_result');
        expect(toolResultMessage?.message?.content?.[0]?.content).toBe('Plan approved');
    });

    it('does not emit fake sidechain start messages when Agent never actually spawns a sidechain', async () => {
        const initialMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: 'opus'
        };

        const { session, client, rpcHandlers } = createSessionStub(initialMode);

        claudeRemoteMock.mockImplementationOnce(async (opts: any) => {
            await opts.nextMessage();
            opts.onMessage({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'tool-agent-denied',
                        name: 'Agent',
                        input: { prompt: 'Inspect the repo and report back.' }
                    }]
                }
            });
            opts.onMessage({
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool-agent-denied',
                        content: 'Permission denied',
                        is_error: true
                    }]
                }
            });
            const switchHandler = rpcHandlers.get('switch');
            if (switchHandler) {
                void switchHandler();
            }
        });

        const result = await claudeRemoteLauncher(session as any);

        expect(result).toBe('switch');
        const userStringMessages = client.sendClaudeSessionMessage.mock.calls
            .map((args: any[]) => args[0])
            .filter((message: any) => message?.type === 'user' && typeof message?.message?.content === 'string')
            .map((message: any) => message.message.content);
        expect(userStringMessages).not.toContain('Inspect the repo and report back.');
    });

    it('emits the sidechain start message only when the first real sidechain message arrives', async () => {
        const initialMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: 'opus'
        };

        const { session, client, rpcHandlers } = createSessionStub(initialMode);

        claudeRemoteMock.mockImplementationOnce(async (opts: any) => {
            await opts.nextMessage();
            opts.onMessage({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'tool-agent-started',
                        name: 'Agent',
                        input: { prompt: 'Inspect the repo and report back.' }
                    }]
                }
            });
            opts.onMessage({
                type: 'assistant',
                parent_tool_use_id: 'tool-agent-started',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'text',
                        text: 'Subagent started'
                    }]
                }
            });
            const switchHandler = rpcHandlers.get('switch');
            if (switchHandler) {
                void switchHandler();
            }
        });

        const result = await claudeRemoteLauncher(session as any);

        expect(result).toBe('switch');
        const userStringMessages = client.sendClaudeSessionMessage.mock.calls
            .map((args: any[]) => args[0])
            .filter((message: any) => message?.type === 'user' && typeof message?.message?.content === 'string')
            .map((message: any) => message.message.content);
        expect(userStringMessages).toContain('Inspect the repo and report back.');
    });

    it('passes response-id tool_use assistants to PermissionHandler immediately', async () => {
        const initialMode: EnhancedMode = {
            permissionMode: 'bypassPermissions',
            model: 'opus'
        };

        const { session, rpcHandlers } = createSessionStub(initialMode);

        claudeRemoteMock.mockImplementationOnce(async (opts: any) => {
            await opts.nextMessage();
            opts.onMessage({
                type: 'assistant',
                message: {
                    id: 'resp-ask-user-question',
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'tool-ask-user-question',
                        name: 'AskUserQuestion',
                        input: {
                            questions: [{
                                header: '部署方式',
                                question: '如何部署修复到生产？',
                                options: [{ label: '仅构建 server + reload PM2', description: '推荐' }]
                            }]
                        }
                    }]
                }
            });

            const switchHandler = rpcHandlers.get('switch');
            if (switchHandler) {
                void switchHandler();
            }
        });

        const result = await claudeRemoteLauncher(session as any);

        expect(result).toBe('switch');
        expect(permissionHandlerInstances).toHaveLength(1);
        expect(permissionHandlerInstances[0]?.onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                id: 'resp-ask-user-question'
            })
        }));
    });
});
