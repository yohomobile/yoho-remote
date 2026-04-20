import { describe, expect, test } from 'bun:test'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from './messages'

function createMessage(overrides: Partial<DecryptedMessage> & Pick<DecryptedMessage, 'id'>): DecryptedMessage {
    const message: DecryptedMessage = {
        id: overrides.id,
        seq: overrides.seq ?? null,
        localId: overrides.localId ?? null,
        content: overrides.content ?? {},
        createdAt: overrides.createdAt ?? 0
    }

    if (overrides.status) {
        message.status = overrides.status
    }
    if (overrides.originalText !== undefined) {
        message.originalText = overrides.originalText
    }

    return message
}

describe('mergeMessages', () => {
    test('orders messages by seq before falling back to insertion order', () => {
        const messages = mergeMessages([], [
            createMessage({ id: 'b', seq: 2, createdAt: 1 }),
            createMessage({ id: 'a', seq: 1, createdAt: 1 })
        ])

        expect(messages.map((message) => message.id)).toEqual(['a', 'b'])
    })

    test('uses localId as a stable tiebreaker when seq is missing', () => {
        const messages = mergeMessages([], [
            createMessage({ id: 'z', seq: null, localId: 'b', createdAt: 1 }),
            createMessage({ id: 'y', seq: null, localId: 'a', createdAt: 1 })
        ])

        expect(messages.map((message) => message.id)).toEqual(['y', 'z'])
    })

    test('keeps original insertion order when seq and localId are absent', () => {
        const messages = mergeMessages([], [
            createMessage({ id: 'c', seq: null, localId: null, createdAt: 1 }),
            createMessage({ id: 'a', seq: null, localId: null, createdAt: 1 }),
            createMessage({ id: 'b', seq: null, localId: null, createdAt: 1 })
        ])

        expect(messages.map((message) => message.id)).toEqual(['c', 'a', 'b'])
    })

    test('keeps persisted monitor events ahead of later optimistic user bubbles', () => {
        const messages = mergeMessages([
            createMessage({
                id: 'local-user-1',
                seq: null,
                localId: 'local-user-1',
                createdAt: 200,
                status: 'sending',
                content: { role: 'user', content: 'next prompt' },
                originalText: 'next prompt',
            })
        ], [
            createMessage({
                id: 'monitor-result',
                seq: 150,
                createdAt: 150,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'task_notification',
                            status: 'completed',
                            summary: 'monitor completed'
                        }
                    }
                }
            })
        ])

        expect(messages.map((message) => message.id)).toEqual([
            'monitor-result',
            'local-user-1'
        ])
    })
})
