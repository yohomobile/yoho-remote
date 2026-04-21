import { describe, expect, test } from 'bun:test'
import type { ChatBlock } from '@/chat/types'
import { reduceChatBlocks } from '@/chat/reducer'
import type { Session } from '@/types/api'
import { convertBlocksToThreadMessages } from './assistant-runtime'
import type { NormalizedMessage } from '@/chat/types'

function getMessageParts(message: ReturnType<typeof convertBlocksToThreadMessages>[number]) {
    if (!Array.isArray(message.content)) {
        throw new Error('Expected message.content to be an array')
    }
    return message.content
}

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'brain-1',
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
        active: true,
        thinking: false,
        metadata: {
            path: '/tmp/brain',
            host: 'ncu',
            source: 'brain',
        },
        agentState: null,
        ...overrides,
    }
}

describe('convertBlocksToThreadMessages', () => {
    test('groups consecutive assistant blocks into one thread message', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-reasoning',
                id: 'reasoning-1',
                localId: null,
                createdAt: 1,
                text: 'Thinking'
            },
            {
                kind: 'tool-call',
                id: 'tool-1',
                localId: null,
                createdAt: 2,
                tool: {
                    id: 'tool-1',
                    name: 'Read',
                    state: 'completed',
                    input: { file_path: 'README.md' },
                    createdAt: 2,
                    startedAt: 2,
                    completedAt: 3,
                    description: null,
                    result: 'done'
                },
                children: []
            },
            {
                kind: 'agent-text',
                id: 'text-1',
                localId: null,
                createdAt: 4,
                text: 'Summary'
            }
        ]

        const messages = convertBlocksToThreadMessages(blocks)

        expect(messages).toHaveLength(1)
        expect(messages[0]?.role).toBe('assistant')
        expect(getMessageParts(messages[0]!)).toHaveLength(3)
        expect(getMessageParts(messages[0]!).map((part) => part.type)).toEqual(['reasoning', 'tool-call', 'text'])
    })

    test('uses a stable assistant id when a tool call appears before text blocks', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'tool-call',
                id: 'tool-1',
                localId: null,
                createdAt: 1,
                tool: {
                    id: 'tool-1',
                    name: 'Read',
                    state: 'completed',
                    input: { file_path: 'README.md' },
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 2,
                    description: null,
                    result: 'done'
                },
                children: []
            },
            {
                kind: 'agent-text',
                id: 'turn-42:1',
                localId: null,
                createdAt: 2,
                text: 'Later reply'
            },
            {
                kind: 'agent-reasoning',
                id: 'turn-42:2',
                localId: null,
                createdAt: 3,
                text: 'Reasoning'
            }
        ]

        const messages = convertBlocksToThreadMessages(blocks)

        expect(messages).toHaveLength(1)
        expect(messages[0]?.id).toBe('assistant:tool-1')
    })

    test('prefers a shared parent tool id when all assistant blocks belong to the same parent', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-text',
                id: 'turn-99:0',
                localId: null,
                createdAt: 1,
                seq: 1,
                text: 'Hello',
                parentUUID: 'tool-parent'
            },
            {
                kind: 'agent-reasoning',
                id: 'turn-99:1',
                localId: null,
                createdAt: 2,
                seq: 2,
                text: 'Thinking',
                reasoningId: 'reasoning-99',
                parentUUID: 'tool-parent'
            }
        ]

        const messages = convertBlocksToThreadMessages(blocks)

        expect(messages).toHaveLength(1)
        expect(messages[0]?.id).toBe('assistant:tool-parent')
    })

    test('prefers localId over message id when available on grouped blocks', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-reasoning',
                id: 'turn-1:0',
                localId: 'local-1',
                createdAt: 1,
                text: 'Thinking'
            },
            {
                kind: 'tool-call',
                id: 'tool-2',
                localId: 'local-1',
                createdAt: 2,
                tool: {
                    id: 'tool-2',
                    name: 'Read',
                    state: 'completed',
                    input: { file_path: 'README.md' },
                    createdAt: 2,
                    startedAt: 2,
                    completedAt: 3,
                    description: null,
                    result: 'done'
                },
                children: []
            }
        ]

        const messages = convertBlocksToThreadMessages(blocks)

        expect(messages).toHaveLength(1)
        expect(messages[0]?.id).toBe('assistant:local-1')
    })

    test('keeps user, system, and cli-output boundaries intact', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 1,
                text: 'First reply'
            },
            {
                kind: 'agent-event',
                id: 'event-1',
                createdAt: 2,
                event: { type: 'message', message: 'Turn completed' }
            },
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 3,
                text: 'Next prompt'
            },
            {
                kind: 'cli-output',
                id: 'cli-1',
                localId: null,
                createdAt: 4,
                text: '<command-name>ls</command-name>',
                source: 'assistant'
            },
            {
                kind: 'agent-text',
                id: 'assistant-2',
                localId: null,
                createdAt: 5,
                text: 'Second reply'
            }
        ]

        const messages = convertBlocksToThreadMessages(blocks)

        expect(messages).toHaveLength(5)
        expect(messages.map((message) => message.role)).toEqual(['assistant', 'system', 'user', 'assistant', 'assistant'])
        expect(messages[3]!.metadata?.custom).toMatchObject({
            kind: 'cli-output',
            source: 'assistant'
        })
    })

    test('rekeys system event thread messages when the visible event content changes', () => {
        const before: ChatBlock[] = [{
            kind: 'agent-event',
            id: 'event-monitor',
            createdAt: 2,
            event: {
                type: 'task-started',
                taskId: 'task-1',
                toolUseId: 'monitor-1',
                description: 'watch logs'
            }
        }]
        const after: ChatBlock[] = [{
            kind: 'agent-event',
            id: 'event-monitor',
            createdAt: 2,
            event: {
                type: 'task-started',
                taskId: 'task-1',
                toolUseId: 'monitor-1',
                status: 'completed',
                summary: '日志监控结束，发现端口已恢复'
            }
        }]

        const beforeMessages = convertBlocksToThreadMessages(before)
        const afterMessages = convertBlocksToThreadMessages(after)

        expect(beforeMessages).toHaveLength(1)
        expect(afterMessages).toHaveLength(1)
        expect(beforeMessages[0]?.id).not.toBe(afterMessages[0]?.id)
        expect(getMessageParts(afterMessages[0]!)).toEqual([
            { type: 'text', text: '日志监控结束，发现端口已恢复' }
        ])
    })

    test('surfaces queued brain delivery on inactive brain sessions', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Keep going',
                meta: {
                    brainDelivery: {
                        phase: 'queued',
                        acceptedAt: 1,
                    },
                },
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: false,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'queued',
                acceptedAt: 1,
            },
        })
    })

    test('does not merge pending-consume brain messages on the first child callback boundary', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Do task B next',
                meta: {
                    brainDelivery: {
                        phase: 'pending_consume',
                        acceptedAt: 1,
                    },
                },
            },
            {
                kind: 'agent-event',
                id: 'event-1',
                createdAt: 2,
                event: {
                    type: 'brain-child-callback',
                    title: 'Task A done',
                    details: [],
                },
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: true,
            thinking: true,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'consuming',
                acceptedAt: 1,
            },
        })
    })

    test('merges pending-consume brain messages after a second consumption boundary', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Do task B next',
                meta: {
                    brainDelivery: {
                        phase: 'pending_consume',
                        acceptedAt: 1,
                    },
                },
            },
            {
                kind: 'agent-event',
                id: 'event-1',
                createdAt: 2,
                event: {
                    type: 'brain-child-callback',
                    title: 'Task A done',
                    details: [],
                },
            },
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 3,
                text: 'Task B started',
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: true,
            thinking: true,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'merged',
                acceptedAt: 1,
            },
        })
    })

    test('surfaces brain session queue metadata as user delivery state during replay', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Queue this',
                meta: {
                    brainSessionQueue: {
                        delivery: 'queued',
                        acceptedAt: 1,
                        wakeQueueDepth: 1,
                    },
                },
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: false,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'queued',
                acceptedAt: 1,
            },
        })
    })

    test('surfaces delivered brain session queue metadata as pending_consume during replay', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Queue this',
                meta: {
                    brainSessionQueue: {
                        delivery: 'delivered',
                        acceptedAt: 1,
                        wakeQueueDepth: 1,
                    },
                },
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: false,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'pending_consume',
                acceptedAt: 1,
            },
        })
    })

    test('promotes delivered brain session queue metadata to consuming after a consumption boundary', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Queue this',
                meta: {
                    brainSessionQueue: {
                        delivery: 'delivered',
                        acceptedAt: 1,
                        wakeQueueDepth: 1,
                    },
                },
            },
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 2,
                text: 'Working',
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: false,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'consuming',
                acceptedAt: 1,
            },
        })
    })

    test('prefers brain delivery metadata over brain session queue metadata', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Queue this',
                meta: {
                    brainDelivery: {
                        phase: 'pending_consume',
                        acceptedAt: 1,
                    },
                    brainSessionQueue: {
                        delivery: 'queued',
                        acceptedAt: 2,
                        wakeQueueDepth: 1,
                    },
                },
            },
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 2,
                text: 'Working',
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            thinking: true,
        }))

        expect(messages).toHaveLength(2)
        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'consuming',
                acceptedAt: 1,
            },
        })
    })

    test('prefers explicit brain delivery phase over brain session queue fallback', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: 'local-1',
                createdAt: 1,
                text: 'Queue this',
                meta: {
                    brainDelivery: {
                        phase: 'consuming',
                        acceptedAt: 1,
                    },
                    brainSessionQueue: {
                        delivery: 'delivered',
                        acceptedAt: 2,
                        wakeQueueDepth: 1,
                    },
                },
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            active: false,
        }))

        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'user',
            brainDelivery: {
                phase: 'consuming',
                acceptedAt: 1,
            },
        })
    })

    test('surfaces display turn metadata on assistant thread messages', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 1,
                text: 'Working',
            },
        ]

        const messages = convertBlocksToThreadMessages(blocks, createSession({
            thinking: true,
        }))

        expect(messages).toHaveLength(1)
        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'assistant',
            displayTurnId: 'turn:assistant-1',
            activeItemId: 'assistant-1',
            activeItemKind: 'agent-text',
        })
    })

    test('preserves assistant text and reasoning while merging tool results into the artifact', () => {
        const reduced = reduceChatBlocks([
            {
                id: 'assistant-turn',
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'text',
                        text: 'Answer',
                        uuid: 'assistant-turn-0',
                        parentUUID: null,
                    },
                    {
                        type: 'reasoning',
                        text: 'Because the file changed',
                        uuid: 'assistant-turn-1',
                        parentUUID: null,
                    },
                    {
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Write',
                        input: { path: 'README.md' },
                        description: null,
                        uuid: 'assistant-turn-2',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'tool-result',
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: {
                        file: {
                            filePath: 'README.md',
                            content: '# Hello',
                        },
                    },
                    is_error: false,
                    uuid: 'tool-result-1',
                    parentUUID: null,
                }],
            }
        ] satisfies NormalizedMessage[], null)

        const messages = convertBlocksToThreadMessages(reduced.blocks, createSession({
            thinking: true,
        }))

        expect(messages).toHaveLength(1)
        const parts = getMessageParts(messages[0]!)
        expect(parts.map((part) => part.type)).toEqual(['text', 'reasoning', 'tool-call'])

        const toolPart = parts[2]
        if (!toolPart || toolPart.type !== 'tool-call') {
            throw new Error('Expected tool-call part')
        }

        expect(toolPart.result).toEqual({
            file: {
                filePath: 'README.md',
                content: '# Hello',
            },
        })
        expect(toolPart.artifact).toMatchObject({
            kind: 'tool-call',
            id: 'tool-1',
            tool: {
                id: 'tool-1',
                name: 'Write',
                state: 'completed',
                result: {
                    file: {
                        filePath: 'README.md',
                        content: '# Hello',
                    },
                },
            },
        })
        expect(messages[0]?.metadata?.custom).toMatchObject({
            kind: 'assistant',
            displayTurnId: 'turn:assistant-turn:0',
            activeItemId: 'assistant-turn:1',
            activeItemKind: 'agent-reasoning',
        })
    })
})
