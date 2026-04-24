import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    loggerDebug: vi.fn(),
    loggerWarn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mocks.loggerDebug,
        warn: mocks.loggerWarn,
    },
}));

import { MessageBuffer } from '../ui/ink/messageBuffer';
import type { CodexSession } from './session';
import { __testOnly } from './codexExecLauncher';

type SentCodexMessage = Record<string, unknown>;

function createHarness(opts: {
    currentThreadId?: string | null;
    patchArtifactResolvers?: {
        resolveUnifiedDiff?: (change: { path: string; kind: 'add' | 'delete' | 'update' }) => string | null;
        resolveContent?: (change: { path: string; kind: 'add' | 'delete' | 'update' }) => string | null;
    };
} = {}) {
    const sent: SentCodexMessage[] = [];
    const onThreadId = vi.fn();
    const onSessionFound = vi.fn();
    let currentThreadId = opts.currentThreadId ?? null;
    let pendingReplacementThreadId: string | null = null;
    const session = {
        sendCodexMessage: vi.fn((message: SentCodexMessage) => {
            sent.push(message);
        }),
        onSessionFound,
    } as unknown as CodexSession;

    const ctx = {
        session,
        messageBuffer: new MessageBuffer(),
        turnPrefix: 'turn-1',
        onThreadId,
        announcedToolCalls: new Set<string>(),
        currentThreadId: () => currentThreadId,
        queueReplacementThreadId: (id: string) => {
            pendingReplacementThreadId = id;
        },
        discardPendingThreadId: () => {
            pendingReplacementThreadId = null;
        },
        commitPendingReplacementThreadId: () => {
            if (!pendingReplacementThreadId) {
                return null;
            }
            const replacementThreadId = pendingReplacementThreadId;
            pendingReplacementThreadId = null;
            currentThreadId = replacementThreadId;
            onThreadId(replacementThreadId);
            onSessionFound(replacementThreadId);
            return replacementThreadId;
        },
        patchArtifactResolvers: opts.patchArtifactResolvers,
    };

    return {
        ctx,
        sent,
        onThreadId,
        onSessionFound,
    };
}

describe('codexExecLauncher event bridge', () => {
    beforeEach(() => {
        mocks.loggerDebug.mockReset();
        mocks.loggerWarn.mockReset();
    });

    it('starts first remote turn from an existing session id', () => {
        expect(__testOnly.getInitialExecThreadId({ sessionId: 'thread-existing' } as Pick<CodexSession, 'sessionId'>))
            .toBe('thread-existing');
        expect(__testOnly.getInitialExecThreadId({ sessionId: null } as Pick<CodexSession, 'sessionId'>))
            .toBeNull();
    });

    it('bridges todo_list start and update without duplicating tool-call', () => {
        const { ctx, sent } = createHarness();
        const item = {
            id: 'todo-1',
            type: 'todo_list',
            items: [
                { text: '检查事件映射', completed: false },
                { text: '补回归测试', completed: true },
            ],
        };

        __testOnly.handleExecEvent({ type: 'item.started', item }, ctx);
        __testOnly.handleExecEvent({ type: 'item.updated', item }, ctx);

        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({
            type: 'tool-call',
            name: 'CodexPlan',
            callId: 'turn-1-todo-1',
            input: {
                plan: [
                    { step: '检查事件映射', status: 'pending' },
                    { step: '补回归测试', status: 'completed' },
                ],
            },
        });
        expect(sent[1]).toMatchObject({
            type: 'tool-call-result',
            callId: 'turn-1-todo-1',
            output: {
                plan: [
                    { step: '检查事件映射', status: 'pending' },
                    { step: '补回归测试', status: 'completed' },
                ],
            },
        });
        expect(sent.filter((message) => message.type === 'tool-call')).toHaveLength(1);
    });

    it('bridges web_search into tool call and result payloads', () => {
        const { ctx, sent } = createHarness();
        const item = {
            id: 'search-1',
            type: 'web_search',
            query: 'codex exec json event types',
            action: { kind: 'search' },
        };

        __testOnly.handleExecEvent({ type: 'item.started', item }, ctx);
        __testOnly.handleExecEvent({ type: 'item.completed', item }, ctx);

        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({
            type: 'tool-call',
            name: 'WebSearch',
            callId: 'turn-1-search-1',
            input: {
                id: 'search-1',
                query: 'codex exec json event types',
                action: { kind: 'search' },
            },
        });
        expect(sent[1]).toMatchObject({
            type: 'tool-call-result',
            callId: 'turn-1-search-1',
            output: {
                id: 'search-1',
                query: 'codex exec json event types',
                action: { kind: 'search' },
            },
        });
    });

    it('emits reasoning only once on completion', () => {
        const { ctx, sent } = createHarness();
        const item = {
            id: 'reasoning-1',
            type: 'reasoning',
            text: 'thinking',
        };

        __testOnly.handleExecEvent({ type: 'item.started', item }, ctx);
        __testOnly.handleExecEvent({ type: 'item.completed', item }, ctx);
        __testOnly.handleExecEvent({ type: 'item.completed', item }, ctx);

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            type: 'reasoning-delta',
            delta: 'thinking',
            id: 'reasoning-1',
        });
    });

    it('bridges file_change completion into CodexPatch messages', () => {
        const { ctx, sent } = createHarness({
            patchArtifactResolvers: {
                resolveUnifiedDiff: (change) => change.path === 'web/src/chat/normalize.ts'
                    ? [
                        'diff --git a/web/src/chat/normalize.ts b/web/src/chat/normalize.ts',
                        '--- a/web/src/chat/normalize.ts',
                        '+++ b/web/src/chat/normalize.ts',
                        '@@ -1 +1 @@',
                        '-old',
                        '+new',
                    ].join('\n')
                    : null,
                resolveContent: (change) => change.path === 'web/src/chat/reducer.ts'
                    ? 'export const reducer = true;\n'
                    : null,
            },
        });
        const item = {
            id: 'patch-1',
            type: 'file_change',
            status: 'completed',
            changes: [
                { path: 'web/src/chat/normalize.ts', kind: 'update' },
                { path: 'web/src/chat/reducer.ts', kind: 'update' },
            ],
        };

        __testOnly.handleExecEvent({ type: 'item.completed', item }, ctx);

        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({
            type: 'tool-call',
            name: 'CodexPatch',
            callId: 'turn-1-patch-1',
            input: {
                changes: {
                    'web/src/chat/normalize.ts': {
                        kind: 'update',
                        unified_diff: [
                            'diff --git a/web/src/chat/normalize.ts b/web/src/chat/normalize.ts',
                            '--- a/web/src/chat/normalize.ts',
                            '+++ b/web/src/chat/normalize.ts',
                            '@@ -1 +1 @@',
                            '-old',
                            '+new',
                        ].join('\n'),
                    },
                    'web/src/chat/reducer.ts': {
                        kind: 'update',
                        content: 'export const reducer = true;\n',
                    },
                },
            },
        });
        expect(sent[1]).toMatchObject({
            type: 'tool-call-result',
            callId: 'turn-1-patch-1',
            output: {
                changes: [
                    {
                        path: 'web/src/chat/normalize.ts',
                        kind: 'update',
                        unified_diff: [
                            'diff --git a/web/src/chat/normalize.ts b/web/src/chat/normalize.ts',
                            '--- a/web/src/chat/normalize.ts',
                            '+++ b/web/src/chat/normalize.ts',
                            '@@ -1 +1 @@',
                            '-old',
                            '+new',
                        ].join('\n'),
                    },
                    {
                        path: 'web/src/chat/reducer.ts',
                        kind: 'update',
                        content: 'export const reducer = true;\n',
                    },
                ],
                status: 'completed',
            },
        });
    });

    it('maps collab wait events to wait_agent tool messages', () => {
        const { ctx, sent } = createHarness();
        const item = {
            id: 'collab-1',
            type: 'collab_tool_call',
            tool: 'wait',
            status: 'completed',
            sender_thread_id: 'thread-main',
            receiver_thread_ids: ['thread-worker-1'],
            prompt: '等子 agent 完成',
            agents_states: {
                'thread-worker-1': {
                    status: 'completed',
                    message: 'done',
                },
            },
        };

        __testOnly.handleExecEvent({ type: 'item.completed', item }, ctx);

        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({
            type: 'tool-call',
            name: 'wait_agent',
            callId: 'turn-1-collab-1',
            input: {
                sender_thread_id: 'thread-main',
                receiver_thread_ids: ['thread-worker-1'],
                prompt: '等子 agent 完成',
                agents_states: {
                    'thread-worker-1': {
                        status: 'completed',
                        message: 'done',
                    },
                },
                status: 'completed',
            },
        });
        expect(sent[1]).toMatchObject({
            type: 'tool-call-result',
            callId: 'turn-1-collab-1',
            output: {
                sender_thread_id: 'thread-main',
                receiver_thread_ids: ['thread-worker-1'],
                prompt: '等子 agent 完成',
                agents_states: {
                    'thread-worker-1': {
                        status: 'completed',
                        message: 'done',
                    },
                },
                status: 'completed',
            },
        });
    });

    it('dedupes identical stream errors from turn.failed and surfaces cached usage', () => {
        const { ctx, sent, onThreadId, onSessionFound } = createHarness({
            currentThreadId: 'thread-123',
        });

        __testOnly.handleExecEvent({ type: 'thread.started', thread_id: 'thread-123' }, ctx);
        __testOnly.handleExecEvent({ type: 'error', message: 'transport error' }, ctx);
        __testOnly.handleExecEvent({ type: 'turn.failed', error: { message: 'transport error' } }, ctx);
        __testOnly.handleExecEvent({
            type: 'turn.completed',
            usage: {
                input_tokens: 128,
                cached_input_tokens: 64,
                output_tokens: 32,
            },
        }, ctx);

        expect(onThreadId).toHaveBeenCalledWith('thread-123');
        expect(onSessionFound).toHaveBeenCalledWith('thread-123');
        expect(sent).toEqual([
            expect.objectContaining({
                type: 'error',
                message: 'transport error',
                source: 'stream',
            }),
            expect.objectContaining({
                type: 'token_count',
                info: {
                    input_tokens: 128,
                    cache_read_input_tokens: 64,
                    output_tokens: 32,
                },
            }),
        ]);
    });

    it('defers a new thread id until the first turn succeeds', () => {
        const { ctx, onThreadId, onSessionFound } = createHarness();

        __testOnly.handleExecEvent({ type: 'thread.started', thread_id: 'thread-new' }, ctx);

        expect(onThreadId).not.toHaveBeenCalled();
        expect(onSessionFound).not.toHaveBeenCalled();

        __testOnly.handleExecEvent({ type: 'turn.completed' }, ctx);

        expect(onThreadId).toHaveBeenCalledWith('thread-new');
        expect(onSessionFound).toHaveBeenCalledWith('thread-new');
    });

    it('does not promote a new thread id when the first turn fails', () => {
        const { ctx, onThreadId, onSessionFound } = createHarness();

        __testOnly.handleExecEvent({ type: 'thread.started', thread_id: 'thread-new' }, ctx);
        __testOnly.handleExecEvent({ type: 'turn.failed', error: { message: 'resume failed' } }, ctx);
        __testOnly.handleExecEvent({ type: 'turn.completed' }, ctx);

        expect(onThreadId).not.toHaveBeenCalled();
        expect(onSessionFound).not.toHaveBeenCalled();
    });

    it('defers replacement thread id until the resumed turn succeeds', () => {
        const { ctx, onThreadId, onSessionFound } = createHarness({
            currentThreadId: 'thread-existing',
        });

        __testOnly.handleExecEvent({ type: 'thread.started', thread_id: 'thread-new' }, ctx);

        expect(mocks.loggerWarn).toHaveBeenCalledWith('[codex-exec] Thread ID changed during exec stream; deferring replacement until success', {
            previousThreadId: 'thread-existing',
            nextThreadId: 'thread-new',
        });
        expect(onThreadId).not.toHaveBeenCalled();
        expect(onSessionFound).not.toHaveBeenCalled();

        __testOnly.handleExecEvent({ type: 'turn.completed' }, ctx);

        expect(onThreadId).toHaveBeenCalledWith('thread-new');
        expect(onSessionFound).toHaveBeenCalledWith('thread-new');

    });

    it('accepts thread.started when it matches the existing thread id', () => {
        const { ctx, onThreadId, onSessionFound } = createHarness({
            currentThreadId: 'thread-existing',
        });

        __testOnly.handleExecEvent({ type: 'thread.started', thread_id: 'thread-existing' }, ctx);

        expect(onThreadId).toHaveBeenCalledWith('thread-existing');
        expect(onSessionFound).toHaveBeenCalledWith('thread-existing');
    });

    it('does not promote a replacement thread id when the resumed turn fails', () => {
        const { ctx, onThreadId, onSessionFound } = createHarness({
            currentThreadId: 'thread-existing',
        });

        __testOnly.handleExecEvent({ type: 'thread.started', thread_id: 'thread-new' }, ctx);
        __testOnly.handleExecEvent({ type: 'turn.failed', error: { message: 'resume failed' } }, ctx);
        __testOnly.handleExecEvent({ type: 'turn.completed' }, ctx);

        expect(onThreadId).not.toHaveBeenCalled();
        expect(onSessionFound).not.toHaveBeenCalled();
    });

    it('classifies only local Codex resume corruption as unrecoverable', () => {
        expect(__testOnly.isUnrecoverableCodexResumeError(
            'codex exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id 019dc176'
        )).toBe(true);
        expect(__testOnly.isUnrecoverableCodexResumeError(
            'codex exec exited with code 1: Error: thread/resume: thread/resume failed: failed to load rollout `/tmp/rollout.jsonl`: stream did not contain valid UTF-8'
        )).toBe(true);
        expect(__testOnly.isUnrecoverableCodexResumeError(
            'codex exec exited with code 1: unexpected status 503 Service Unavailable'
        )).toBe(false);
    });

    it('formats signal exits as failures instead of successful null exit codes', () => {
        expect(__testOnly.formatProcessExit(1, null)).toBe('code 1');
        expect(__testOnly.formatProcessExit(null, 'SIGTERM')).toBe('signal SIGTERM');
        expect(__testOnly.formatProcessExit(null, null)).toBe('unknown exit status');
    });

    it('bridges error items as non-fatal notices', () => {
        const { ctx, sent } = createHarness();

        __testOnly.handleExecEvent({
            type: 'item.completed',
            item: {
                id: 'notice-1',
                type: 'error',
                message: 'model rerouted: gpt-5 -> gpt-5-mini',
            },
        }, ctx);

        expect(sent).toEqual([
            expect.objectContaining({
                type: 'notice',
                level: 'warning',
                source: 'item',
                message: 'model rerouted: gpt-5 -> gpt-5-mini',
            }),
        ]);
    });

    it('warns and emits raw fallback messages for unknown event and item types', () => {
        const { ctx, sent } = createHarness();

        const unknownEvent = { type: 'new.event', payload: { hello: 'world' } };
        const startedItem = {
            id: 'unknown-1',
            type: 'new_item_type',
        };
        const completedItem = {
            id: 'unknown-2',
            type: 'new_item_type',
        };

        __testOnly.handleExecEvent(unknownEvent as never, ctx);
        __testOnly.handleExecEvent({
            type: 'item.started',
            item: startedItem,
        } as never, ctx);
        __testOnly.handleExecEvent({
            type: 'item.completed',
            item: completedItem,
        } as never, ctx);

        expect(mocks.loggerWarn).toHaveBeenCalledTimes(3);
        expect(sent).toHaveLength(3);
        expect(sent[0]).toMatchObject({
            type: 'unknown-event:new.event',
            eventType: 'new.event',
            rawEvent: unknownEvent,
        });
        expect(sent[1]).toMatchObject({
            type: 'unknown-item-started:new_item_type',
            itemType: 'new_item_type',
            itemId: 'unknown-1',
            rawItem: startedItem,
        });
        expect(sent[2]).toMatchObject({
            type: 'unknown-item-completed:new_item_type',
            itemType: 'new_item_type',
            itemId: 'unknown-2',
            rawItem: completedItem,
        });
    });
});
