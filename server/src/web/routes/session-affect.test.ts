import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionAffectRoutes } from './session-affect'

type FakeSession = {
    id: string
    namespace: string
    orgId?: string | null
    metadata?: Record<string, unknown> | null
}

function createApp(options: {
    session?: FakeSession | null
    orgs?: Array<{ id: string; name: string; role: 'owner' | 'admin' | 'member' }>
    role?: 'developer' | 'operator'
    email?: string | null
    patchResult?: { ok: true } | { ok: false; error: string }
    onPatch?: (id: string, patch: Record<string, unknown>) => void
}) {
    const patchResult = options.patchResult ?? { ok: true as const }
    const engine = {
        getSession: (_id: string) => options.session ?? undefined,
        patchSessionMetadata: async (id: string, patch: Record<string, unknown>) => {
            options.onPatch?.(id, patch)
            return patchResult
        },
    }
    const store = {
        getSession: async (_id: string) => options.session ?? null,
    }
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('role', options.role ?? 'developer')
        if (options.email !== null) {
            c.set('email', options.email ?? 'guang@example.com')
        }
        c.set('namespace', 'org-1')
        c.set('orgs', options.orgs ?? [{ id: 'org-1', name: 'Acme', role: 'admin' }])
        await next()
    })
    app.route('/api', createSessionAffectRoutes(() => engine as any, store as any))
    return app
}

const baseSession: FakeSession = {
    id: 'sess-1',
    namespace: 'org-1',
    orgId: 'org-1',
    metadata: null,
}

describe('createSessionAffectRoutes', () => {
    it('rejects unauthenticated', async () => {
        const app = createApp({ session: baseSession, email: null })
        const response = await app.request('/api/sessions/sess-1/affect')
        expect(response.status).toBe(401)
    })

    it('404 when session missing', async () => {
        const app = createApp({ session: null })
        const response = await app.request('/api/sessions/missing/affect')
        expect(response.status).toBe(404)
    })

    it('403 when user not in session org', async () => {
        const app = createApp({
            session: baseSession,
            orgs: [{ id: 'other', name: 'Other', role: 'member' }],
        })
        const response = await app.request('/api/sessions/sess-1/affect')
        expect(response.status).toBe(403)
    })

    it('GET returns none when no affect set', async () => {
        const app = createApp({ session: baseSession })
        const response = await app.request('/api/sessions/sess-1/affect')
        expect(response.status).toBe(200)
        const body = await response.json() as { affect: unknown; status: string }
        expect(body.affect).toBeNull()
        expect(body.status).toBe('none')
    })

    it('PUT sets concise affect', async () => {
        const patches: Array<Record<string, unknown>> = []
        const app = createApp({
            session: baseSession,
            onPatch: (_id, patch) => patches.push(patch),
        })
        const response = await app.request('/api/sessions/sess-1/affect', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'concise', note: '用户明确要求更短' }),
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { affect: { mode: string }; status: string }
        expect(body.affect.mode).toBe('concise')
        expect(body.status).toBe('attached')
        expect(patches).toHaveLength(1)
        expect(patches[0].sessionAffectStatus).toBe('attached')
        expect(patches[0].sessionAffectMode).toBe('concise')
    })

    it('PUT rejects invalid mode', async () => {
        const app = createApp({ session: baseSession })
        const response = await app.request('/api/sessions/sess-1/affect', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'bogus' }),
        })
        expect(response.status).toBe(400)
    })

    it('PUT default mode returns default status', async () => {
        const app = createApp({ session: baseSession })
        const response = await app.request('/api/sessions/sess-1/affect', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'default' }),
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { status: string }
        expect(body.status).toBe('default')
    })

    it('DELETE clears affect', async () => {
        const patches: Array<Record<string, unknown>> = []
        const app = createApp({
            session: { ...baseSession, metadata: { sessionAffect: { mode: 'concise' } } },
            onPatch: (_id, patch) => patches.push(patch),
        })
        const response = await app.request('/api/sessions/sess-1/affect', { method: 'DELETE' })
        expect(response.status).toBe(200)
        expect(patches[0].sessionAffect).toBeNull()
        expect(patches[0].sessionAffectStatus).toBe('none')
    })

    it('operator bypasses org check', async () => {
        const app = createApp({
            session: baseSession,
            role: 'operator',
            orgs: [],
        })
        const response = await app.request('/api/sessions/sess-1/affect')
        expect(response.status).toBe(200)
    })

    it('GET shows expired status when TTL elapsed', async () => {
        const pastAffect = {
            mode: 'concise',
            source: 'user_explicit',
            setAt: 1,
            expiresAt: 2,
            note: null,
        }
        const app = createApp({
            session: { ...baseSession, metadata: { sessionAffect: pastAffect } },
        })
        const response = await app.request('/api/sessions/sess-1/affect')
        expect(response.status).toBe(200)
        const body = await response.json() as { status: string }
        expect(body.status).toBe('expired')
    })

    it('creator can access even without matching org', async () => {
        const app = createApp({
            session: {
                ...baseSession,
                orgId: null,
                metadata: { createdByEmail: 'guang@example.com' },
            },
            orgs: [],
        })
        const response = await app.request('/api/sessions/sess-1/affect')
        expect(response.status).toBe(200)
    })
})
