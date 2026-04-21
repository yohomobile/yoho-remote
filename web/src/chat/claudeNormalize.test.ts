import { describe, expect, test } from 'bun:test'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from './types'
import { normalizeDecryptedMessage } from './normalize'

function makeMessage(props: {
    id: string
    createdAt: number
    role: 'assistant' | 'user'
    data: Record<string, unknown>
    meta?: Record<string, unknown>
    seq?: number | null
    localId?: string | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: props.seq ?? null,
        localId: props.localId ?? null,
        createdAt: props.createdAt,
        content: {
            role: props.role,
            content: {
                type: 'output',
                data: props.data
            },
            ...(props.meta ? { meta: props.meta } : {})
        }
    }
}

function normalize(message: DecryptedMessage): NormalizedMessage[] {
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized) return []
    return Array.isArray(normalized) ? normalized : [normalized]
}

describe('Claude 原始 output/JSONL 归一化兼容性', () => {
    test('normalizes assistant content blocks, sidechain metadata, and assistant usage', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-assistant-output',
            createdAt: 1,
            role: 'assistant',
            data: {
                type: 'assistant',
                uuid: 'assistant-uuid',
                parentUuid: 'parent-uuid',
                isSidechain: true,
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Hello Claude' },
                        { type: 'thinking', thinking: 'I should inspect the repo first.' },
                        {
                            type: 'tool_use',
                            id: 'tool-use-1',
                            name: 'Read',
                            input: {
                                file_path: '/tmp/demo.ts',
                                description: 'read demo file'
                            }
                        },
                        {
                            type: 'server_tool_use',
                            id: 'server-tool-1',
                            name: 'server.read',
                            input: '{"path":"/tmp/server.ts","description":"server read"}'
                        },
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool-use-1',
                            content: 'file contents',
                            is_error: false
                        }
                    ],
                    usage: {
                        input_tokens: 11,
                        output_tokens: 22,
                        cache_creation_input_tokens: 3,
                        cache_read_input_tokens: 4,
                        service_tier: 'standard',
                        extra_cost_usd: 0.42,
                        trace_id: 'usage-trace-1'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        const message = normalized[0]
        expect(message.role).toBe('agent')
        expect(message.isSidechain).toBe(true)
        expect(message.usage).toEqual({
            input_tokens: 11,
            output_tokens: 22,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            service_tier: 'standard',
            raw: {
                extra_cost_usd: 0.42,
                trace_id: 'usage-trace-1'
            }
        })
        if (message.role !== 'agent') {
            throw new Error('Expected agent message')
        }

        expect(message.content).toHaveLength(5)
        expect(message.content[0]).toMatchObject({
            type: 'text',
            text: 'Hello Claude',
            uuid: 'assistant-uuid',
            parentUUID: 'parent-uuid'
        })
        expect(message.content[1]).toMatchObject({
            type: 'reasoning',
            text: 'I should inspect the repo first.',
            uuid: 'assistant-uuid',
            parentUUID: 'parent-uuid'
        })
        expect(message.content[2]).toMatchObject({
            type: 'tool-call',
            id: 'tool-use-1',
            name: 'Read',
            input: {
                file_path: '/tmp/demo.ts',
                description: 'read demo file'
            },
            description: 'read demo file',
            uuid: 'assistant-uuid',
            parentUUID: 'parent-uuid'
        })
        expect(message.content[3]).toMatchObject({
            type: 'tool-call',
            id: 'server-tool-1',
            name: 'server.read',
            input: {
                path: '/tmp/server.ts',
                description: 'server read'
            },
            description: 'server read',
            uuid: 'assistant-uuid',
            parentUUID: 'parent-uuid'
        })
        expect(message.content[4]).toMatchObject({
            type: 'tool-result',
            tool_use_id: 'tool-use-1',
            content: 'file contents',
            is_error: false,
            uuid: 'assistant-uuid',
            parentUUID: 'parent-uuid'
        })
    })

    test('normalizes user content arrays with tool_result blocks into paired user and agent messages', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-user-tool-result',
            createdAt: 2,
            role: 'assistant',
            data: {
                type: 'user',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Please run the tool.' },
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool-use-2',
                            content: 'tool output',
                            is_error: true
                        }
                    ]
                }
            }
        }))

        expect(normalized).toHaveLength(2)
        expect(normalized[0]).toMatchObject({
            role: 'user',
            content: {
                type: 'text',
                text: 'Please run the tool.'
            }
        })
        expect(normalized[1]).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-result',
                    tool_use_id: 'tool-use-2',
                    content: 'tool output',
                    is_error: true
                }
            ]
        })
    })

    test('normalizes Claude system, summary, and result output records with their expected semantics', () => {
        const systemMessage = normalize(makeMessage({
            id: 'claude-system-turn-duration',
            createdAt: 3,
            role: 'assistant',
            data: {
                type: 'system',
                subtype: 'turn_duration',
                durationMs: 987
            }
        }))

        const summaryMessage = normalize(makeMessage({
            id: 'claude-summary',
            createdAt: 4,
            role: 'assistant',
            data: {
                type: 'summary',
                summary: 'Turn summary from Claude'
            }
        }))

        const resultMessage = normalize(makeMessage({
            id: 'claude-result',
            createdAt: 5,
            role: 'assistant',
            data: {
                type: 'result',
                total_cost_usd: 1.23,
                duration_ms: 4567,
                num_turns: 8,
                is_error: false,
                stop_reason: 'end_turn',
                terminal_reason: 'max_turns',
                result: 'Final Claude answer',
                usage: {
                    input_tokens: 100,
                    output_tokens: 200,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 40
                }
            }
        }))

        expect(systemMessage).toHaveLength(1)
        expect(systemMessage[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'turn-duration',
                durationMs: 987
            }
        })

        expect(summaryMessage).toHaveLength(1)
        expect(summaryMessage[0]).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'summary',
                    summary: 'Turn summary from Claude'
                }
            ]
        })

        expect(resultMessage).toHaveLength(2)
        expect(resultMessage[0]).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'text',
                    text: 'Final Claude answer'
                }
            ]
        })
        expect(resultMessage[1]).toMatchObject({
            role: 'event',
            content: {
                type: 'session-result',
                cost: 1.23,
                durationMs: 4567,
                numTurns: 8,
                isError: false,
                stopReason: 'end_turn',
                terminalReason: 'max_turns'
            },
            usage: {
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 40
            }
        })
    })

    test('suppresses non-compacting Claude status records', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-status-idle',
            createdAt: 6,
            role: 'assistant',
            data: {
                type: 'system',
                subtype: 'status',
                status: 'idle'
            }
        }))

        expect(normalized).toHaveLength(0)
    })

    test('normalizes Claude attachment output records without falling back to raw JSON', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-attachment-queued-command',
            createdAt: 6,
            role: 'assistant',
            data: {
                type: 'attachment',
                attachment: {
                    type: 'queued_command',
                    commandMode: 'prompt',
                    prompt: 'show me the current git status'
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'message',
                message: 'Queued command: show me the current git status'
            }
        })
    })

    test('keeps mixed Claude content block order stable and shows unknown blocks as fallback text', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-mixed-unknown-blocks',
            createdAt: 7,
            role: 'assistant',
            data: {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'alpha' },
                        { type: 'future_block', foo: 'bar' },
                        {
                            type: 'tool_use',
                            id: 'tool-use-unknown-order',
                            name: 'Read',
                            input: { path: '/tmp/order.ts' }
                        },
                        { type: 'mystery_block', bar: 2 }
                    ]
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]?.role).toBe('agent')
        if (normalized[0]?.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        expect(normalized[0].content).toHaveLength(4)
        expect(normalized[0].content.map((block) => block.type)).toEqual([
            'text',
            'text',
            'tool-call',
            'text'
        ])
        expect(normalized[0].content[0]).toMatchObject({
            type: 'text',
            text: 'alpha'
        })
        expect(normalized[0].content[1]?.type === 'text' ? normalized[0].content[1].text : '').toContain('future_block')
        expect(normalized[0].content[1]?.type === 'text' ? normalized[0].content[1].text : '').toContain('foo')
        expect(normalized[0].content[2]).toMatchObject({
            type: 'tool-call',
            id: 'tool-use-unknown-order',
            name: 'Read',
            input: {
                path: '/tmp/order.ts'
            }
        })
        expect(normalized[0].content[3]?.type === 'text' ? normalized[0].content[3].text : '').toContain('mystery_block')
    })

    test('renders non-string Claude result payloads as visible fallback text', () => {
        const normalized = normalize(makeMessage({
            id: 'claude-result-object',
            createdAt: 8,
            role: 'assistant',
            data: {
                type: 'result',
                total_cost_usd: 2.5,
                duration_ms: 123,
                num_turns: 1,
                is_error: false,
                result: {
                    type: 'structured_result',
                    payload: 'answer',
                    nested: {
                        items: 2
                    }
                },
                usage: {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1,
                    cache_read_input_tokens: 2,
                    trace_id: 'result-usage-trace'
                }
            }
        }))

        expect(normalized).toHaveLength(2)
        expect(normalized[0]).toMatchObject({
            role: 'agent'
        })
        if (normalized[0]?.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        expect(normalized[0].content[0]).toMatchObject({
            type: 'text'
        })
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('structured_result')
        expect(normalized[1]).toMatchObject({
            role: 'event',
            usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 2,
                raw: {
                    trace_id: 'result-usage-trace'
                }
            }
        })
    })
})
