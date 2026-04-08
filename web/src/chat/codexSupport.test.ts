import { describe, expect, test } from 'bun:test'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { getToolPresentation } from '../components/ToolCard/knownTools'
import type { NormalizedMessage } from './types'
import type { DecryptedMessage } from '../types/api'

function makeMessage(props: {
    id: string
    createdAt: number
    content: unknown
}): DecryptedMessage {
    return {
        id: props.id,
        seq: null,
        localId: null,
        content: props.content,
        createdAt: props.createdAt
    }
}

function normalize(message: DecryptedMessage): NormalizedMessage[] {
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized) return []
    return Array.isArray(normalized) ? normalized : [normalized]
}

describe('Codex frontend support', () => {
    test('marks non-zero Codex tool results as error blocks', () => {
        const normalized = [
            ...normalize(makeMessage({
                id: 'tool-call',
                createdAt: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'call-1',
                            name: 'CodexBash',
                            input: { command: 'bun typecheck' },
                            id: 'tool-call-item'
                        }
                    }
                }
            })),
            ...normalize(makeMessage({
                id: 'tool-result',
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call-result',
                            callId: 'call-1',
                            output: {
                                command: 'bun typecheck',
                                exit_code: 127
                            },
                            id: 'tool-result-item'
                        }
                    }
                }
            }))
        ]

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(1)
        const block = reduced.blocks[0]
        expect(block.kind).toBe('tool-call')
        if (block.kind !== 'tool-call') {
            throw new Error('Expected tool-call block')
        }
        expect(block.tool.state).toBe('error')
        expect(block.tool.result).toEqual({
            command: 'bun typecheck',
            exit_code: 127
        })
    })

    test('uses Codex token_count as latest usage without rendering a timeline event', () => {
        const normalized = normalize(makeMessage({
            id: 'token-count',
            createdAt: 100,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'token_count',
                        info: {
                            input_tokens: 123_456,
                            output_tokens: 789
                        },
                        id: 'token-count-item'
                    }
                }
            }
        }))

        const reduced = reduceChatBlocks(normalized, null)
        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.inputTokens).toBe(123_456)
        expect(reduced.latestUsage?.outputTokens).toBe(789)
        expect(reduced.latestUsage?.contextSize).toBe(123_456)
    })

    test('renders Codex plan messages as assistant text instead of dropping them', () => {
        const normalized = normalize(makeMessage({
            id: 'plan-message',
            createdAt: 100,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'plan',
                        entries: [
                            { content: 'Inspect the repo', priority: 'high', status: 'completed' },
                            { content: 'Patch the UI', priority: 'medium', status: 'in_progress' }
                        ]
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]?.role).toBe('agent')
        if (normalized[0]?.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        expect(normalized[0].content[0]).toMatchObject({
            type: 'text'
        })
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('Plan')
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('Inspect the repo')
        expect(normalized[0].content[0]?.type === 'text' ? normalized[0].content[0].text : '').toContain('Patch the UI')
    })

    test('renders Codex error messages as visible timeline events', () => {
        const normalized = normalize(makeMessage({
            id: 'error-message',
            createdAt: 101,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'error',
                        message: 'Tool chain exploded'
                    }
                }
            }
        }))

        expect(normalized).toHaveLength(1)
        expect(normalized[0]).toMatchObject({
            role: 'event',
            content: {
                type: 'message',
                message: 'Error: Tool chain exploded'
            }
        })
    })

    test('prefers Claude assistant usage over cumulative session-result usage', () => {
        const normalized: NormalizedMessage[] = [
            {
                id: 'assistant-usage',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: 'Done',
                    uuid: 'assistant-usage',
                    parentUUID: null
                }],
                usage: {
                    input_tokens: 6,
                    output_tokens: 200,
                    cache_creation_input_tokens: 4_972,
                    cache_read_input_tokens: 806_111
                }
            },
            {
                id: 'session-result',
                localId: null,
                createdAt: 2,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'session-result',
                    durationMs: 1234,
                    numTurns: 1,
                    isError: false
                },
                usage: {
                    input_tokens: 120_000,
                    output_tokens: 400,
                    cache_creation_input_tokens: 40_000,
                    cache_read_input_tokens: 5_200_000
                }
            }
        ]

        const reduced = reduceChatBlocks(normalized, null)

        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.inputTokens).toBe(6)
        expect(reduced.latestUsage?.cacheCreation).toBe(4_972)
        expect(reduced.latestUsage?.cacheRead).toBe(806_111)
        expect(reduced.latestUsage?.contextSize).toBe(811_089)
    })

    test('falls back to Claude session-result usage when assistant usage is missing', () => {
        const normalized: NormalizedMessage[] = [{
            id: 'session-result-only',
            localId: null,
            createdAt: 2,
            role: 'event',
            isSidechain: false,
            content: {
                type: 'session-result',
                durationMs: 1234,
                numTurns: 1,
                isError: false
            },
            usage: {
                input_tokens: 6,
                output_tokens: 200,
                cache_creation_input_tokens: 4_972,
                cache_read_input_tokens: 806_111
            }
        }]

        const reduced = reduceChatBlocks(normalized, null)

        expect(reduced.latestUsage).not.toBeNull()
        expect(reduced.latestUsage?.contextSize).toBe(811_089)
        expect(reduced.latestUsage?.timestamp).toBe(2)
    })

    test('formats yoho namespaced tools with MCP-style titles and useful subtitles', () => {
        const presentation = getToolPresentation({
            toolName: 'yoho_memory__recall',
            input: {
                input: 'Yoho Remote Codex 前端支持'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.title).toBe('MCP: Yoho Memory Recall')
        expect(presentation.subtitle).toBe('Yoho Remote Codex 前端支持')
        expect(presentation.minimal).toBe(true)
    })
})
