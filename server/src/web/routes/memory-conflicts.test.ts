import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createMemoryConflictRoutes } from './memory-conflicts'

function createApp(store: Record<string, unknown>, options?: {
    orgs?: Array<{ id: string; name: string; role: 'owner' | 'admin' | 'member' }>
    role?: 'developer' | 'operator'
    email?: string | null
}) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('role', options?.role ?? 'developer')
        if (options?.email !== null) {
            c.set('email', options?.email ?? 'admin@example.com')
        }
        c.set('namespace', 'default')
        c.set('orgs', options?.orgs ?? [{ id: 'org-1', name: 'Acme', role: 'admin' }])
        await next()
    })
    app.route('/api', createMemoryConflictRoutes(store as any))
    return app
}

function sampleCandidate() {
    return {
        id: 'conflict-1',
        namespace: 'org-1',
        orgId: 'org-1',
        scope: 'team',
        subjectKey: 'sgprod.db.port',
        summary: 'port differs',
        entries: [],
        evidence: null,
        detectorVersion: 'v1',
        status: 'open',
        resolution: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        createdAt: 1,
        updatedAt: 1,
    }
}

describe('createMemoryConflictRoutes', () => {
    it('requires orgId', async () => {
        const app = createApp({})
        const response = await app.request('/api/memory-conflicts')
        expect(response.status).toBe(400)
    })

    it('rejects unauthenticated requests', async () => {
        const app = createApp({}, { email: null })
        const response = await app.request('/api/memory-conflicts?orgId=org-1')
        expect(response.status).toBe(401)
    })

    it('rejects non-admin users', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        }, {
            orgs: [{ id: 'org-1', name: 'Acme', role: 'member' }],
        })
        const response = await app.request('/api/memory-conflicts?orgId=org-1')
        expect(response.status).toBe(403)
    })

    it('returns candidate list for admin', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            listMemoryConflictCandidates: async () => [sampleCandidate()],
        })
        const response = await app.request('/api/memory-conflicts?orgId=org-1&status=open&scope=team')
        expect(response.status).toBe(200)
        const body = await response.json() as { candidates: unknown[] }
        expect(body.candidates).toHaveLength(1)
    })

    it('returns 400 for invalid status filter', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
        })
        const response = await app.request('/api/memory-conflicts?orgId=org-1&status=bogus')
        expect(response.status).toBe(400)
    })

    it('operator bypasses org admin check', async () => {
        const app = createApp({
            listMemoryConflictCandidates: async () => [],
        }, { role: 'operator' })
        const response = await app.request('/api/memory-conflicts?orgId=org-1')
        expect(response.status).toBe(200)
    })

    it('GET /:id returns 404 when candidate not found', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            getMemoryConflictCandidate: async () => null,
        })
        const response = await app.request('/api/memory-conflicts/missing?orgId=org-1')
        expect(response.status).toBe(404)
    })

    it('POST /:id/decide validates action and resolution', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
        })
        const response = await app.request('/api/memory-conflicts/c-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resolve' }),
        })
        expect(response.status).toBe(400)
    })

    it('POST /:id/decide succeeds with valid resolution', async () => {
        const decisions: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideMemoryConflictCandidate: async (input: Record<string, unknown>) => {
                decisions.push(input)
                return { ...sampleCandidate(), status: 'resolved', resolution: 'keep_a' }
            },
        })
        const response = await app.request('/api/memory-conflicts/c-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'resolve',
                resolution: 'keep_a',
                reason: 'port 5432 canonical',
            }),
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { candidate: { status: string; resolution: string } }
        expect(body.candidate.status).toBe('resolved')
        expect(body.candidate.resolution).toBe('keep_a')
        expect(decisions[0]).toMatchObject({
            action: 'resolve',
            resolution: 'keep_a',
            actorEmail: 'admin@example.com',
            reason: 'port 5432 canonical',
        })
    })

    it('POST /:id/decide returns 404 when candidate missing', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideMemoryConflictCandidate: async () => null,
        })
        const response = await app.request('/api/memory-conflicts/missing/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'dismiss', reason: 'not actionable' }),
        })
        expect(response.status).toBe(404)
    })

    it('GET /:id/audits returns audit list', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            listMemoryConflictAudits: async () => [
                {
                    id: 'a-1',
                    namespace: 'org-1',
                    orgId: 'org-1',
                    candidateId: 'c-1',
                    action: 'generated',
                    priorStatus: null,
                    newStatus: 'open',
                    resolution: null,
                    actorEmail: null,
                    reason: null,
                    payload: null,
                    createdAt: 1,
                },
            ],
        })
        const response = await app.request('/api/memory-conflicts/c-1/audits?orgId=org-1&limit=10')
        expect(response.status).toBe(200)
        const body = await response.json() as { audits: unknown[] }
        expect(body.audits).toHaveLength(1)
    })
})
