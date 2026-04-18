import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

function createSession(): Record<string, unknown> {
    return {
        id: 'session-1',
        namespace: 'ns-test',
        active: true,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        lastMessageAt: null,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1_700_000_000_000,
        seq: 0,
        activeAt: 1_700_000_000_000,
        activeMonitors: []
    }
}

describe('createMessagesRoutes', () => {
    it('rejects negative keepCount values', async () => {
        const fakeEngine = {
            getOrRefreshSession: async () => createSession(),
            clearSessionMessages: async () => ({ deleted: 0, remaining: 0 })
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => fakeEngine as any, {} as any))

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'DELETE',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({ keepCount: -1 })
        })

        expect(response.status).toBe(400)
    })

    it('awaits clearSessionMessages before responding', async () => {
        let clearStarted = false
        let resolveClear!: () => void
        const clearPromise = new Promise<void>((resolve) => {
            resolveClear = resolve
        })

        const fakeEngine = {
            getOrRefreshSession: async () => createSession(),
            clearSessionMessages: async (_sessionId: string, keepCount: number) => {
                clearStarted = true
                expect(keepCount).toBe(0)
                await clearPromise
                return { deleted: 5, remaining: 0 }
            }
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => fakeEngine as any, {} as any))

        const requestPromise = Promise.resolve(app.request('/api/sessions/session-1/messages', {
            method: 'DELETE',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({ keepCount: 0 })
        }))

        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(clearStarted).toBe(true)

        let settled = false
        requestPromise.then(() => {
            settled = true
        })

        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(settled).toBe(false)

        resolveClear()

        const response = await requestPromise
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            deleted: 5,
            remaining: 0,
            compacted: false
        })
    })
})
