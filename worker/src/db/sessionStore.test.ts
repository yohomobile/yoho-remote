import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import { SessionStore } from './sessionStore'

function row(seq: number, content: unknown): Record<string, unknown> {
    return {
        id: `msg-${seq}`,
        seq,
        content,
        created_at: seq * 1000,
    }
}

describe('SessionStore.getTurnMessages', () => {
    it('only starts a new turn on the next text-like user message', async () => {
        const batches = [{
            rows: [
                row(10, {
                    role: 'user',
                    content: { type: 'text', text: '先跑一下测试' },
                }),
                row(11, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test' } },
                                ],
                            },
                        },
                    },
                }),
                row(12, {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
                    ],
                }),
                row(13, {
                    role: 'assistant',
                    content: '测试跑完了',
                }),
                row(14, {
                    role: 'user',
                    content: { type: 'text', text: '再看一下类型错误' },
                }),
                row(15, {
                    role: 'assistant',
                    content: '第二轮回复',
                }),
            ],
        }]

        const pool = {
            query: async () => batches.shift() ?? { rows: [] },
        } as unknown as Pool

        const store = new SessionStore(pool)
        const messages = await store.getTurnMessages('session-1', 10)

        expect(messages.map((message) => message.seq)).toEqual([10, 11, 12, 13])
    })
})
