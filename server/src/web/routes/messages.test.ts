import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

function createSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        activeMonitors: [],
        ...overrides,
    }
}

function withResumeTrace<T extends Record<string, unknown>>(engine: T): T & {
    noteResumeClientEvent: (sessionId: string, event: string, details?: Record<string, unknown>) => void
} {
    return {
        noteResumeClientEvent() {},
        ...engine,
    }
}

describe('createMessagesRoutes', () => {
    it('rejects negative keepCount values', async () => {
        const fakeEngine = withResumeTrace({
            getOrRefreshSession: async () => createSession(),
            clearSessionMessages: async () => ({ deleted: 0, remaining: 0 })
        })

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

        const fakeEngine = withResumeTrace({
            getOrRefreshSession: async () => createSession(),
            clearSessionMessages: async (_sessionId: string, keepCount: number) => {
                clearStarted = true
                expect(keepCount).toBe(0)
                await clearPromise
                return { deleted: 5, remaining: 0 }
            }
        })

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

    it('accepts messages for inactive brain sessions and returns queued delivery semantics', async () => {
        const sendMessageCalls: Array<{ sessionId: string; payload: unknown }> = []
        const fakeEngine = withResumeTrace({
            getOrRefreshSession: async () => createSession({
                active: false,
                thinking: false,
                metadata: {
                    source: 'brain',
                },
            }),
            sendMessage: async (sessionId: string, payload: unknown) => {
                sendMessageCalls.push({ sessionId, payload })
                return { status: 'delivered' }
            },
        })

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => fakeEngine as any, {} as any))

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({ text: 'queue this', localId: 'local-1' }),
        })

        expect(response.status).toBe(200)
        const payload = await response.json()
        expect(payload).toMatchObject({
            ok: true,
            sessionId: 'session-1',
            status: 'delivered',
            brainDelivery: {
                phase: 'queued',
            },
        })
        expect(sendMessageCalls).toHaveLength(1)
        expect(sendMessageCalls[0]).toMatchObject({
            sessionId: 'session-1',
            payload: {
                text: 'queue this',
                localId: 'local-1',
                sentFrom: 'webapp',
                meta: {
                    brainDelivery: {
                        phase: 'queued',
                    },
                },
            },
        })
    })

    it('adds resolved actor metadata while preserving Brain delivery metadata', async () => {
        const sendMessageCalls: Array<{ sessionId: string; payload: unknown }> = []
        const fakeEngine = withResumeTrace({
            getOrRefreshSession: async () => createSession({
                active: false,
                thinking: false,
                metadata: {
                    source: 'brain',
                },
            }),
            sendMessage: async (sessionId: string, payload: unknown) => {
                sendMessageCalls.push({ sessionId, payload })
                return { status: 'delivered' }
            },
        })

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('identityActor', {
                identityId: 'identity-1',
                personId: 'person-1',
                channel: 'keycloak',
                resolution: 'auto_verified',
                displayName: 'Dev User',
                email: 'dev@example.com',
                externalId: 'keycloak-user-1',
                accountType: 'human',
            })
            await next()
        })
        app.route('/api', createMessagesRoutes(() => fakeEngine as any, {} as any))

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({ text: 'queue this', localId: 'local-1' }),
        })

        expect(response.status).toBe(200)
        expect(sendMessageCalls).toHaveLength(1)
        expect(sendMessageCalls[0]).toMatchObject({
            sessionId: 'session-1',
            payload: {
                text: 'queue this',
                localId: 'local-1',
                sentFrom: 'webapp',
                meta: {
                    brainDelivery: {
                        phase: 'queued',
                    },
                    actor: {
                        identityId: 'identity-1',
                        personId: 'person-1',
                        channel: 'keycloak',
                        resolution: 'auto_verified',
                        displayName: 'Dev User',
                        email: 'dev@example.com',
                        externalId: 'keycloak-user-1',
                        accountType: 'human',
                    },
                },
            },
        })
    })

    it('keeps rejecting inactive non-brain sessions', async () => {
        const fakeEngine = withResumeTrace({
            getOrRefreshSession: async () => createSession({
                active: false,
                metadata: {
                    source: 'cli',
                },
            }),
        })

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => fakeEngine as any, {} as any))

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({ text: 'hello' }),
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session is inactive',
        })
    })

    it('records resume trace events for messages fetch and first message post', async () => {
        const resumeEvents: Array<{ sessionId: string; event: string; details?: Record<string, unknown> }> = []
        const fakeEngine = withResumeTrace({
            getOrRefreshSession: async () => createSession(),
            getMessagesPage: async () => ({
                messages: [],
                page: {
                    hasMore: false,
                    nextBeforeSeq: null,
                },
            }),
            sendMessage: async () => ({ status: 'delivered' }),
            noteResumeClientEvent: (sessionId: string, event: string, details?: Record<string, unknown>) => {
                resumeEvents.push({ sessionId, event, details })
            },
        })

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            await next()
        })
        app.route('/api', createMessagesRoutes(() => fakeEngine as any, {} as any))

        const getResponse = await app.request('/api/sessions/session-1/messages')
        expect(getResponse.status).toBe(200)

        const postResponse = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({ text: 'hello after resume' }),
        })
        expect(postResponse.status).toBe(200)

        expect(resumeEvents).toEqual([
            {
                sessionId: 'session-1',
                event: 'messages-get',
                details: undefined,
            },
            {
                sessionId: 'session-1',
                event: 'message-post',
                details: {
                    sentFrom: 'webapp',
                },
            },
        ])
    })
})
