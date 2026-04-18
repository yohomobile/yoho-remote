import { describe, expect, test } from 'bun:test'
import type { ChatBlock } from '@/chat/types'
import { convertBlocksToThreadMessages } from './assistant-runtime'

function getMessageParts(message: ReturnType<typeof convertBlocksToThreadMessages>[number]) {
    if (!Array.isArray(message.content)) {
        throw new Error('Expected message.content to be an array')
    }
    return message.content
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
})
