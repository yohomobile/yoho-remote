import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createTeamMemoryRoutes } from './team-memory'

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
    app.route('/api', createTeamMemoryRoutes(store as any))
    return app
}

function sampleCandidate() {
    return {
        id: 'tm-1',
        namespace: 'org-1',
        orgId: 'org-1',
        proposedByPersonId: null,
        proposedByEmail: 'guang@example.com',
        scope: 'team' as const,
        content: 'sgprod 主库端口是 5432',
        source: 'chat',
        sessionId: 'sess-1',
        status: 'pending' as const,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        memoryRef: null,
        createdAt: 1,
        updatedAt: 1,
    }
}

describe('createTeamMemoryRoutes', () => {
    it('requires orgId on list', async () => {
        const app = createApp({})
        const response = await app.request('/api/team-memory/candidates')
        expect(response.status).toBe(400)
    })

    it('rejects unauthenticated requests', async () => {
        const app = createApp({}, { email: null })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1')
        expect(response.status).toBe(401)
    })

    it('rejects non-members (no role)', async () => {
        const app = createApp({
            getUserOrgRole: async () => null,
        })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1')
        expect(response.status).toBe(403)
    })

    it('allows regular member to list candidates', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            listTeamMemoryCandidates: async () => [sampleCandidate()],
        })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1&status=pending')
        expect(response.status).toBe(200)
        const body = await response.json() as { candidates: unknown[] }
        expect(body.candidates).toHaveLength(1)
    })

    it('rejects invalid status filter', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1&status=bogus')
        expect(response.status).toBe(400)
    })

    it('POST propose creates pending candidate for member', async () => {
        const proposals: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'member',
            proposeTeamMemoryCandidate: async (input: Record<string, unknown>) => {
                proposals.push(input)
                return sampleCandidate()
            },
        })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'sgprod 主库端口是 5432',
                source: 'chat',
                sessionId: 'sess-1',
            }),
        })
        expect(response.status).toBe(201)
        const body = await response.json() as { candidate: { status: string } }
        expect(body.candidate.status).toBe('pending')
        expect(proposals[0]).toMatchObject({
            orgId: 'org-1',
            content: 'sgprod 主库端口是 5432',
            source: 'chat',
            sessionId: 'sess-1',
            proposedByEmail: 'admin@example.com',
        })
    })

    it('POST propose rejects empty content', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '' }),
        })
        expect(response.status).toBe(400)
    })

    it('GET /:id returns 404 when missing', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            getTeamMemoryCandidate: async () => null,
        })
        const response = await app.request('/api/team-memory/candidates/missing?orgId=org-1')
        expect(response.status).toBe(404)
    })

    it('POST decide rejects non-admin', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        })
        const response = await app.request('/api/team-memory/candidates/tm-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'approve' }),
        })
        expect(response.status).toBe(403)
    })

    it('POST decide approve succeeds with memoryRef', async () => {
        const decisions: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideTeamMemoryCandidate: async (input: Record<string, unknown>) => {
                decisions.push(input)
                return { ...sampleCandidate(), status: 'approved', memoryRef: 'team/xyz' }
            },
        })
        const response = await app.request('/api/team-memory/candidates/tm-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'approve',
                memoryRef: 'team/xyz',
                reason: 'approved, stored in team memory',
            }),
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { candidate: { status: string; memoryRef: string } }
        expect(body.candidate.status).toBe('approved')
        expect(body.candidate.memoryRef).toBe('team/xyz')
        expect(decisions[0]).toMatchObject({
            action: 'approve',
            memoryRef: 'team/xyz',
            actorEmail: 'admin@example.com',
            reason: 'approved, stored in team memory',
        })
    })

    it('POST decide reject omits memoryRef', async () => {
        const decisions: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideTeamMemoryCandidate: async (input: Record<string, unknown>) => {
                decisions.push(input)
                return { ...sampleCandidate(), status: 'rejected' }
            },
        })
        const response = await app.request('/api/team-memory/candidates/tm-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reject', reason: 'not relevant' }),
        })
        expect(response.status).toBe(200)
        expect(decisions[0]).toMatchObject({ action: 'reject', memoryRef: null })
    })

    it('POST decide returns 404 when missing', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideTeamMemoryCandidate: async () => null,
        })
        const response = await app.request('/api/team-memory/candidates/missing/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'approve' }),
        })
        expect(response.status).toBe(404)
    })

    it('GET audits requires admin', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        })
        const response = await app.request('/api/team-memory/candidates/tm-1/audits?orgId=org-1')
        expect(response.status).toBe(403)
    })

    it('GET audits returns list for admin', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            listTeamMemoryAudits: async () => [
                {
                    id: 'a-1',
                    namespace: 'org-1',
                    orgId: 'org-1',
                    candidateId: 'tm-1',
                    action: 'proposed',
                    priorStatus: null,
                    newStatus: 'pending',
                    actorEmail: 'guang@example.com',
                    reason: null,
                    memoryRef: null,
                    payload: null,
                    createdAt: 1,
                },
            ],
        })
        const response = await app.request('/api/team-memory/candidates/tm-1/audits?orgId=org-1')
        expect(response.status).toBe(200)
        const body = await response.json() as { audits: unknown[] }
        expect(body.audits).toHaveLength(1)
    })

    it('operator bypasses member/admin checks', async () => {
        const app = createApp({
            listTeamMemoryCandidates: async () => [],
        }, { role: 'operator' })
        const response = await app.request('/api/team-memory/candidates?orgId=org-1')
        expect(response.status).toBe(200)
    })
})
