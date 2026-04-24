import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createObservationRoutes } from './observation'

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
    app.route('/api', createObservationRoutes(store as any))
    return app
}

function sampleCandidate(overrides: Record<string, unknown> = {}) {
    return {
        id: 'obs-1',
        namespace: 'org-1',
        orgId: 'org-1',
        subjectPersonId: 'person-1',
        subjectEmail: 'guang@example.com',
        hypothesisKey: 'reply.conciseness.preference',
        summary: '最近多次要求更短回复',
        detail: null,
        detectorVersion: 'obs-v1',
        confidence: 0.72,
        signals: [],
        suggestedPatch: null,
        status: 'pending' as const,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        promotedCommunicationPlanId: null,
        expiresAt: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    }
}

describe('createObservationRoutes', () => {
    it('requires orgId', async () => {
        const app = createApp({})
        const response = await app.request('/api/observations')
        expect(response.status).toBe(400)
    })

    it('rejects unauthenticated requests', async () => {
        const app = createApp({}, { email: null })
        const response = await app.request('/api/observations?orgId=org-1')
        expect(response.status).toBe(401)
    })

    it('member can list own observations', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            listObservationCandidates: async () => [sampleCandidate()],
        })
        const response = await app.request('/api/observations?orgId=org-1&subjectEmail=guang@example.com&status=pending')
        expect(response.status).toBe(200)
        const body = await response.json() as { candidates: unknown[] }
        expect(body.candidates).toHaveLength(1)
    })

    it('rejects invalid status', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        })
        const response = await app.request('/api/observations?orgId=org-1&status=bogus')
        expect(response.status).toBe(400)
    })

    it('GET /:id returns 404 when missing', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            getObservationCandidate: async () => null,
        })
        const response = await app.request('/api/observations/missing?orgId=org-1')
        expect(response.status).toBe(404)
    })

    it('admin can confirm with promotedCommunicationPlanId', async () => {
        const decisions: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideObservationCandidate: async (input: Record<string, unknown>) => {
                decisions.push(input)
                return sampleCandidate({ status: 'confirmed', promotedCommunicationPlanId: 'plan-1' })
            },
        })
        const response = await app.request('/api/observations/obs-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'confirm',
                promotedCommunicationPlanId: 'plan-1',
                reason: 'agree, promoting to plan',
            }),
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { candidate: { status: string; promotedCommunicationPlanId: string } }
        expect(body.candidate.status).toBe('confirmed')
        expect(body.candidate.promotedCommunicationPlanId).toBe('plan-1')
        expect(decisions[0]).toMatchObject({
            action: 'confirm',
            promotedCommunicationPlanId: 'plan-1',
        })
    })

    it('member who is subject can decide their own observation', async () => {
        const decisions: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'member',
            getObservationCandidate: async () => sampleCandidate({ subjectEmail: 'guang@example.com' }),
            decideObservationCandidate: async (input: Record<string, unknown>) => {
                decisions.push(input)
                return sampleCandidate({ status: 'rejected' })
            },
        }, { email: 'guang@example.com' })
        const response = await app.request('/api/observations/obs-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reject', reason: 'not accurate' }),
        })
        expect(response.status).toBe(200)
        expect(decisions).toHaveLength(1)
    })

    it('non-admin, non-subject cannot decide', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            getObservationCandidate: async () => sampleCandidate({ subjectEmail: 'someone-else@example.com' }),
        }, { email: 'guang@example.com' })
        const response = await app.request('/api/observations/obs-1/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reject' }),
        })
        expect(response.status).toBe(403)
    })

    it('subject-check 404 when candidate missing', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            getObservationCandidate: async () => null,
        }, { email: 'guang@example.com' })
        const response = await app.request('/api/observations/missing/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reject' }),
        })
        expect(response.status).toBe(404)
    })

    it('decide returns 404 when store returns null', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            decideObservationCandidate: async () => null,
        })
        const response = await app.request('/api/observations/missing/decide?orgId=org-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'dismiss' }),
        })
        expect(response.status).toBe(404)
    })

    it('GET audits requires admin', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
        })
        const response = await app.request('/api/observations/obs-1/audits?orgId=org-1')
        expect(response.status).toBe(403)
    })

    it('GET audits returns list for admin', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            listObservationAudits: async () => [
                {
                    id: 'a-1',
                    namespace: 'org-1',
                    orgId: 'org-1',
                    candidateId: 'obs-1',
                    action: 'generated',
                    priorStatus: null,
                    newStatus: 'pending',
                    actorEmail: null,
                    reason: null,
                    payload: null,
                    createdAt: 1,
                },
            ],
        })
        const response = await app.request('/api/observations/obs-1/audits?orgId=org-1&limit=10')
        expect(response.status).toBe(200)
        const body = await response.json() as { audits: unknown[] }
        expect(body.audits).toHaveLength(1)
    })

    it('operator bypasses all role checks', async () => {
        const app = createApp({
            listObservationCandidates: async () => [],
        }, { role: 'operator' })
        const response = await app.request('/api/observations?orgId=org-1')
        expect(response.status).toBe(200)
    })
})
