import { describe, expect, test } from 'bun:test'
import { reconcileChatBlocks } from './reconcile'
import type { ChatBlock } from './types'

describe('reconcileChatBlocks', () => {
    test('keeps the previous tool block when meta, input, and result are structurally equal', () => {
        const prevBlock: ChatBlock = {
            kind: 'tool-call',
            id: 'tool-1',
            localId: 'local-1',
            createdAt: 1,
            seq: 1,
            tool: {
                id: 'tool-1',
                name: 'Read',
                state: 'completed',
                input: {
                    z: 3,
                    a: 1
                },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                parentUUID: 'parent-1',
                result: {
                    z: 3,
                    a: 1
                }
            },
            children: [],
            meta: {
                z: 3,
                a: 1
            }
        }

        const nextBlock: ChatBlock = {
            kind: 'tool-call',
            id: 'tool-1',
            localId: 'local-1',
            createdAt: 1,
            seq: 1,
            tool: {
                id: 'tool-1',
                name: 'Read',
                state: 'completed',
                input: {
                    a: 1,
                    z: 3
                },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                parentUUID: 'parent-1',
                result: {
                    a: 1,
                    z: 3
                }
            },
            children: [],
            meta: {
                a: 1,
                z: 3
            }
        }

        const prevById = new Map<string, ChatBlock>([[prevBlock.id, prevBlock]])
        const reconciled = reconcileChatBlocks([nextBlock], prevById)

        expect(reconciled.blocks[0]).toBe(prevBlock)
    })
})
