import { describe, expect, test } from 'bun:test'
import { deriveBrainMessageDelivery, readBrainMessageDelivery } from './brainDelivery'
import type { ChatBlock, UserTextBlock } from './types'
import type { Session } from '@/types/api'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
        active: false,
        thinking: false,
        metadata: {
            path: '/tmp/session',
            host: 'localhost',
            source: 'brain',
        },
        agentState: null,
        ...overrides,
    }
}

function createUserBlock(meta: unknown): UserTextBlock {
    return {
        kind: 'user-text',
        id: 'user-1',
        localId: 'local-1',
        createdAt: 1,
        text: 'Continue',
        meta,
    }
}

describe('brainDelivery', () => {
    test('maps delivered brainSessionQueue entries to pending_consume', () => {
        expect(readBrainMessageDelivery({
            brainSessionQueue: {
                delivery: 'delivered',
                acceptedAt: 1,
                wakeQueueDepth: 1,
            },
        })).toEqual({
            phase: 'pending_consume',
            acceptedAt: 1,
        })
    })

    test('keeps explicit brainDelivery phase over brainSessionQueue fallback', () => {
        const block = createUserBlock({
            brainDelivery: {
                phase: 'consuming',
                acceptedAt: 1,
            },
            brainSessionQueue: {
                delivery: 'delivered',
                acceptedAt: 2,
                wakeQueueDepth: 1,
            },
        })

        expect(deriveBrainMessageDelivery(block, 0, [block as ChatBlock], createSession())).toEqual({
            phase: 'consuming',
            acceptedAt: 1,
        })
    })

    test('keeps delivered history pending until a later consumption boundary appears', () => {
        const block = createUserBlock({
            brainSessionQueue: {
                delivery: 'delivered',
                acceptedAt: 1,
                wakeQueueDepth: 1,
            },
        })
        const blocks: ChatBlock[] = [
            block,
        ]

        expect(deriveBrainMessageDelivery(block, 0, blocks, createSession())).toEqual({
            phase: 'pending_consume',
            acceptedAt: 1,
        })
    })

    test('promotes delivered history to consuming once a consumption boundary is present', () => {
        const block = createUserBlock({
            brainSessionQueue: {
                delivery: 'delivered',
                acceptedAt: 1,
                wakeQueueDepth: 1,
            },
        })
        const blocks: ChatBlock[] = [
            block,
            {
                kind: 'agent-text',
                id: 'assistant-1',
                localId: null,
                createdAt: 2,
                text: 'Working',
            },
        ]

        expect(deriveBrainMessageDelivery(block, 0, blocks, createSession())).toEqual({
            phase: 'consuming',
            acceptedAt: 1,
        })
    })
})
