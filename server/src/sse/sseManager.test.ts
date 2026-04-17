import { describe, expect, it } from 'bun:test'
import { SSEManager } from './sseManager'
import type { SyncEvent } from '../sync/syncEngine'

describe('SSEManager namespace filtering', () => {
    it('routes events to matching namespace', () => {
        const manager = new SSEManager(0)
        const receivedAlpha: SyncEvent[] = []
        const receivedBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                receivedAlpha.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                receivedBeta.push(event)
            },
            sendHeartbeat: () => {}
        })

        // subscribe() 会立即发送 online-users-changed；清空以只断言后续 broadcast 行为
        receivedAlpha.length = 0
        receivedBeta.length = 0

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        expect(receivedAlpha).toHaveLength(1)
        expect(receivedBeta).toHaveLength(0)
    })

    it('broadcasts connection-changed to all namespaces', () => {
        const manager = new SSEManager(0)
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                received.push({ id: 'alpha', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
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
            namespace: 'alpha',
            all: true,
            clientId: 'all-client',
            send: (event) => {
                receivedAll.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'detail',
            namespace: 'alpha',
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
            namespace: 'alpha',
            sessionId: 's1',
            data: {
                activeMonitors: [{ id: 'mon-1', command: 'tail -f app.log' }]
            },
            notifyRecipientClientIds: []
        })

        expect(receivedAll).toHaveLength(0)
        expect(receivedDetail).toHaveLength(1)
    })
})
