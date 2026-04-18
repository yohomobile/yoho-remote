import { describe, expect, test } from 'bun:test'
import { traceMessages } from './tracer'
import type { NormalizedMessage } from './types'

describe('traceMessages', () => {
    test('matches sidechains by tool ids before falling back to prompt text', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'task-root',
                seq: 1,
                localId: null,
                createdAt: 1,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Task',
                    input: { prompt: 'correct prompt' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }],
                meta: { sentFrom: 'cli' }
            },
            {
                id: 'sidechain-child',
                seq: 2,
                localId: null,
                createdAt: 2,
                role: 'agent',
                isSidechain: true,
                content: [
                    {
                        type: 'text',
                        text: 'wrong prompt',
                        uuid: 'sidechain-uuid',
                        parentUUID: null
                    },
                    {
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Task',
                        input: { prompt: 'correct prompt' },
                        description: null,
                        uuid: 'sidechain-uuid',
                        parentUUID: null
                    }
                ],
                meta: { sentFrom: 'cli' }
            }
        ]

        const traced = traceMessages(messages)
        const child = traced.find((message) => message.id === 'sidechain-child')
        expect(child?.sidechainId).toBe('task-root')
    })
})
