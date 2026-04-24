import { describe, expect, it } from 'bun:test'
import { SSEManager } from './sseManager'
import type { SyncEvent } from '../sync/syncEngine'

function createMessage(seq: number): SyncEvent['message'] {
    return {
        id: `msg-${seq}`,
        seq,
        localId: null,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: `message-${seq}`
            }
        },
        createdAt: 1_700_000_000_000 + seq
    }
}

describe('SSEManager org filtering', () => {
    it('routes events to matching org', () => {
        const manager = new SSEManager(0)
        const receivedAlpha: SyncEvent[] = []
        const receivedBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha',
            orgId: 'alpha',
            all: true,
            send: (event) => {
                receivedAlpha.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            orgId: 'beta',
            all: true,
            send: (event) => {
                receivedBeta.push(event)
            },
            sendHeartbeat: () => {}
        })

        // subscribe() 会立即发送 online-users-changed；清空以只断言后续 broadcast 行为
        receivedAlpha.length = 0
        receivedBeta.length = 0

        manager.broadcast({ type: 'session-updated', sessionId: 's1', orgId: 'alpha' })

        expect(receivedAlpha).toHaveLength(1)
        expect(receivedBeta).toHaveLength(0)
    })

    it('broadcasts connection-changed to all orgs', () => {
        const manager = new SSEManager(0)
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'alpha',
            orgId: 'alpha',
            all: true,
            send: (event) => {
                received.push({ id: 'alpha', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            orgId: 'beta',
            all: true,
            send: (event) => {
                received.push({ id: 'beta', event })
            },
            sendHeartbeat: () => {}
        })

        // subscribe() 会立即发送 online-users-changed；清空以只断言后续 broadcast 行为
        received.length = 0

        manager.broadcast({ type: 'connection-changed', data: { status: 'connected' } })

        expect(received).toHaveLength(2)
        expect(received.map((entry) => entry.id).sort()).toEqual(['alpha', 'beta'])
    })

    it('keeps detail-only session updates away from all-sessions subscribers', () => {
        const manager = new SSEManager(0)
        const receivedAll: SyncEvent[] = []
        const receivedDetail: SyncEvent[] = []

        manager.subscribe({
            id: 'all',
            orgId: 'alpha',
            all: true,
            clientId: 'all-client',
            send: (event) => {
                receivedAll.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'detail',
            orgId: 'alpha',
            sessionId: 's1',
            clientId: 'detail-client',
            send: (event) => {
                receivedDetail.push(event)
            },
            sendHeartbeat: () => {}
        })

        receivedAll.length = 0
        receivedDetail.length = 0

        manager.broadcast({
            type: 'session-updated',
            orgId: 'alpha',
            sessionId: 's1',
            data: {
                activeMonitors: [{ id: 'mon-1', command: 'tail -f app.log' }]
            },
            notifyRecipientClientIds: []
        })

        expect(receivedAll).toHaveLength(0)
        expect(receivedDetail).toHaveLength(1)
    })

    it('lets all-sessions subscribers receive message-received while preserving session filtering', () => {
        const manager = new SSEManager(0)
        const receivedAll: string[] = []
        const receivedDetail: string[] = []

        manager.subscribe({
            id: 'all',
            orgId: 'alpha',
            all: true,
            send: (event) => {
                if (event.type === 'message-received') {
                    receivedAll.push(event.sessionId as string)
                }
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'detail',
            orgId: 'alpha',
            all: true,
            sessionId: 's1',
            send: (event) => {
                if (event.type === 'message-received') {
                    receivedDetail.push(event.sessionId as string)
                }
            },
            sendHeartbeat: () => {}
        })

        receivedAll.length = 0
        receivedDetail.length = 0

        manager.broadcast({
            type: 'message-received',
            orgId: 'alpha',
            sessionId: 's1',
            message: createMessage(1)
        })
        manager.broadcast({
            type: 'message-received',
            orgId: 'alpha',
            sessionId: 's2',
            message: createMessage(2)
        })

        expect(receivedAll).toEqual(['s1', 's2'])
        expect(receivedDetail).toEqual(['s1'])
    })

    it('lets all-sessions subscribers receive messages-cleared while preserving session filtering', () => {
        const manager = new SSEManager(0)
        const receivedAll: string[] = []
        const receivedDetail: string[] = []

        manager.subscribe({
            id: 'all',
            orgId: 'alpha',
            all: true,
            send: (event) => {
                if (event.type === 'messages-cleared') {
                    receivedAll.push(event.sessionId as string)
                }
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'detail',
            orgId: 'alpha',
            sessionId: 's1',
            send: (event) => {
                if (event.type === 'messages-cleared') {
                    receivedDetail.push(event.sessionId as string)
                }
            },
            sendHeartbeat: () => {}
        })

        receivedAll.length = 0
        receivedDetail.length = 0

        manager.broadcast({
            type: 'messages-cleared',
            orgId: 'alpha',
            sessionId: 's1'
        })
        manager.broadcast({
            type: 'messages-cleared',
            orgId: 'alpha',
            sessionId: 's2'
        })

        expect(receivedAll).toEqual(['s1', 's2'])
        expect(receivedDetail).toEqual(['s1'])
    })
})
