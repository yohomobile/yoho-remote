import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { StoredSession } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function createStoredSession(overrides: Partial<StoredSession>): StoredSession {
    return {
        id: 'session-default',
        tag: null,
        namespace: 'ns-test',
        machineId: 'machine-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        createdBy: null,
        orgId: null,
        metadata: {
            path: '/tmp/default',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        todos: null,
        todosUpdatedAt: null,
        active: false,
        activeAt: null,
        seq: 0,
        advisorTaskId: null,
        creatorChatId: null,
        advisorMode: false,
        advisorPromptInjected: false,
        rolePromptSent: false,
        permissionMode: null,
        modelMode: null,
        modelReasoningEffort: null,
        fastMode: null,
        terminationReason: null,
        lastMessageAt: null,
        ...overrides,
    }
}

describe('createSessionsRoutes', () => {
    it('sorts sessions by lastMessageAt before falling back to updatedAt', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'session-stale-message',
                updatedAt: 1_700_000_000_500,
                lastMessageAt: 1_700_000_000_100,
                metadata: { path: '/tmp/stale' },
            }),
            createStoredSession({
                id: 'session-new-message',
                updatedAt: 1_700_000_000_200,
                lastMessageAt: 1_700_000_000_400,
                metadata: { path: '/tmp/new' },
            }),
            createStoredSession({
                id: 'session-no-message',
                updatedAt: 1_700_000_000_300,
                lastMessageAt: null,
                metadata: { path: '/tmp/fallback' },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [],
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', [])
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions')
        expect(response.status).toBe(200)

        const payload = await response.json() as { sessions: Array<{ id: string; lastMessageAt: number | null }> }
        expect(payload.sessions.map((session) => session.id)).toEqual([
            'session-new-message',
            'session-no-message',
            'session-stale-message',
        ])
        expect(payload.sessions[0]?.lastMessageAt).toBe(1_700_000_000_400)
        expect(payload.sessions[1]?.lastMessageAt).toBeNull()
    })
})
