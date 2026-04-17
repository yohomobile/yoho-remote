import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '../ui/ink/messageBuffer';
import type { CodexSession } from './session';
import { __testOnly } from './codexExecLauncher';

type SentCodexMessage = Record<string, unknown>;

function createHarness(opts: {
    patchArtifactResolvers?: {
        resolveUnifiedDiff?: (change: { path: string; kind: 'add' | 'delete' | 'update' }) => string | null;
        resolveContent?: (change: { path: string; kind: 'add' | 'delete' | 'update' }) => string | null;
    };
} = {}) {
    const sent: SentCodexMessage[] = [];
    const onThreadId = vi.fn();
    const onSessionFound = vi.fn();
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
        const { ctx, sent, onThreadId, onSessionFound } = createHarness();

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
});
