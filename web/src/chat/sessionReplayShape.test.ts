import { describe, expect, test } from 'bun:test'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from './types'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { mergeMessages } from '../lib/messages'

type StoredMessageLike = DecryptedMessage & {
    sessionId: string
}

function makeStoredMessage(props: {
    sessionId: string
    id: string
    seq: number | null
    localId: string | null
    createdAt: number
    content: unknown
    status?: DecryptedMessage['status']
    originalText?: string
    meta?: Record<string, unknown>
}): StoredMessageLike {
    const content = props.meta && props.content && typeof props.content === 'object' && !Array.isArray(props.content)
        ? {
            ...(props.content as Record<string, unknown>),
            meta: props.meta
        }
        : props.content

    return {
        sessionId: props.sessionId,
        id: props.id,
        seq: props.seq,
        localId: props.localId,
        createdAt: props.createdAt,
        content,
        ...(props.status ? { status: props.status } : {}),
        ...(props.originalText !== undefined ? { originalText: props.originalText } : {})
    }
}

function stripSessionId(message: StoredMessageLike): DecryptedMessage {
    const { sessionId: _sessionId, ...rest } = message
    return rest
}

function normalizeAll(messages: DecryptedMessage[]): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = []
    for (const message of messages) {
        const value = normalizeDecryptedMessage(message)
        if (!value) continue
        if (Array.isArray(value)) {
            normalized.push(...value)
            continue
        }
        normalized.push(value)
    }
    return normalized
}

function normalizeStoredMessages(messages: StoredMessageLike[]): NormalizedMessage[] {
    return normalizeAll(messages.map(stripSessionId))
}

function reduceStoredMessages(messages: StoredMessageLike[]) {
    return reduceChatBlocks(normalizeStoredMessages(messages), null)
}

describe('session replay shape stability', () => {
    test('merges stored replay rows by seq/localId and removes optimistic duplicates with the same localId', () => {
        const sessionId = 'session-1'
        const existing = [
            makeStoredMessage({
                sessionId,
                id: 'optimistic-turn-b',
                seq: null,
                localId: 'turn-b',
                createdAt: 1_700_000_000_000,
                status: 'sending',
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'optimistic bubble'
                    }
                }
            })
        ]

        const incoming = [
            makeStoredMessage({
                sessionId,
                id: 'row-turn-c',
                seq: 3,
                localId: 'turn-c',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'event',
                    content: {
                        type: 'status',
                        status: 'compacting'
                    }
                }
            }),
            makeStoredMessage({
                sessionId,
                id: 'row-turn-b',
                seq: 2,
                localId: 'turn-b',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'future_codex_shape',
                            alpha: 1,
                            beta: true
                        }
                    }
                }
            }),
            makeStoredMessage({
                sessionId,
                id: 'row-turn-a',
                seq: 2,
                localId: 'turn-a',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                role: 'assistant',
                                content: 'turn a'
                            }
                        }
                    }
                }
            }),
            makeStoredMessage({
                sessionId,
                id: 'row-turn-d',
                seq: 1,
                localId: 'turn-d',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'turn d'
                    }
                }
            })
        ]

        const merged = mergeMessages(
            existing.map(stripSessionId),
            incoming.map(stripSessionId)
        )

        expect(merged.map((message) => message.id)).toEqual([
            'row-turn-d',
            'row-turn-a',
            'row-turn-b',
            'row-turn-c'
        ])
        expect(merged.map((message) => message.localId)).toEqual([
            'turn-d',
            'turn-a',
            'turn-b',
            'turn-c'
        ])
        expect(merged.some((message) => message.id === 'optimistic-turn-b')).toBe(false)
    })

    test('normalizes mixed user, agent, event, and Codex replay rows in a stable same-timestamp order', () => {
        const replayMeta = {
            summary: {
                text: 'session summary',
                updatedAt: 1_700_000_000_500
            },
            attachment: {
                id: 'attachment-1',
                filename: 'trace.json'
            },
            download: {
                id: 'download-1',
                filename: 'trace.json'
            }
        }

        const brainMeta = {
            ...replayMeta,
            sentFrom: 'brain-callback',
            brainChildCallback: {
                type: 'brain-child-callback',
                version: 1,
                sessionId: 'child-session-1',
                mainSessionId: 'brain-main-1',
                title: '修复展示',
                previousSummary: '上次总结',
                details: ['消息数: 5'],
                stats: {
                    messageCount: 5,
                    contextBudget: 100_000,
                    contextSize: 4_321,
                    contextRemainingPercent: 96,
                    inputTokens: 3_210,
                    outputTokens: 456
                },
                result: {
                    text: '结构化回传正文',
                    source: 'result',
                    seq: 9
                }
            }
        }

        const replayRows = [
            makeStoredMessage({
                sessionId: 'session-1',
                id: 'event-raw',
                seq: 5,
                localId: 'turn-5',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'event',
                    content: {
                        type: 'status',
                        status: 'compacting'
                    }
                },
                meta: replayMeta
            }),
            makeStoredMessage({
                sessionId: 'session-1',
                id: 'codex-unknown',
                seq: 4,
                localId: 'turn-4',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'future_codex_shape',
                            alpha: 1,
                            beta: true
                        }
                    }
                },
                meta: replayMeta
            }),
            makeStoredMessage({
                sessionId: 'session-1',
                id: 'claude-output',
                seq: 3,
                localId: 'turn-3',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                role: 'assistant',
                                content: 'Claude text output'
                            }
                        }
                    }
                },
                meta: replayMeta
            }),
            makeStoredMessage({
                sessionId: 'session-1',
                id: 'brain-callback',
                seq: 2,
                localId: 'turn-2',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'ignored because the meta envelope wins'
                    }
                },
                meta: brainMeta
            }),
            makeStoredMessage({
                sessionId: 'session-1',
                id: 'plain-user',
                seq: 1,
                localId: 'turn-1',
                createdAt: 1_700_000_000_000,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'Continue'
                    }
                },
                meta: replayMeta
            })
        ]

        const merged = mergeMessages([], replayRows.map(stripSessionId))
        const normalized = normalizeAll(merged)
        const reduced = reduceChatBlocks(normalized, null)

        expect(normalized.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5])
        expect(normalized.map((message) => message.localId)).toEqual([
            'turn-1',
            'turn-2',
            'turn-3',
            'turn-4',
            'turn-5'
        ])
        expect(reduced.blocks.map((block) => block.id)).toEqual([
            'plain-user',
            'brain-callback',
            'claude-output:0',
            'codex-unknown:0',
            'event-raw'
        ])

        expect(reduced.blocks[0]).toMatchObject({
            kind: 'user-text',
            text: 'Continue',
            meta: replayMeta
        })

        expect(reduced.blocks[1]).toMatchObject({
            kind: 'agent-event',
            event: {
                type: 'brain-child-callback',
                sessionId: 'child-session-1',
                title: '修复展示',
                previousSummary: '上次总结',
                details: ['消息数: 5'],
                envelope: {
                    mainSessionId: 'brain-main-1',
                    result: {
                        seq: 9
                    }
                }
            },
            meta: brainMeta
        })

        expect(reduced.blocks[2]).toMatchObject({
            kind: 'agent-text',
            meta: replayMeta
        })
        if (reduced.blocks[2]?.kind !== 'agent-text') {
            throw new Error('Expected Claude assistant text block')
        }
        expect(reduced.blocks[2].text).toBe('Claude text output')

        expect(reduced.blocks[3]).toMatchObject({
            kind: 'agent-text',
            meta: replayMeta
        })
        if (reduced.blocks[3]?.kind !== 'agent-text') {
            throw new Error('Expected Codex fallback text block')
        }
        expect(reduced.blocks[3].text).toContain('future_codex_shape')

        expect(reduced.blocks[4]).toMatchObject({
            kind: 'agent-event',
            event: {
                type: 'status',
                status: 'compacting'
            },
            meta: replayMeta
        })
    })
})
