import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createCommunicationPlanRoutes } from './communication-plan'

function createApp(store: Record<string, unknown>, options?: {
    personId?: string | null
    orgs?: Array<{ id: string; name: string; role: 'owner' | 'admin' | 'member' }>
    role?: 'developer' | 'operator'
    email?: string
}) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('role', options?.role ?? 'developer')
        c.set('email', options?.email ?? 'user@example.com')
        c.set('namespace', 'default')
        c.set('orgs', options?.orgs ?? [{ id: 'org-1', name: 'Acme', role: 'member' }])
        if (options?.personId !== null) {
            c.set('identityActor', {
                identityId: 'ident-1',
                personId: options?.personId ?? 'person-1',
                channel: 'keycloak',
                resolution: 'admin_verified',
                displayName: 'Dev',
                email: 'user@example.com',
                externalId: 'sub-1',
                accountType: 'human',
                assurance: 'high',
            } as any)
        }
        await next()
    })
    app.route('/api', createCommunicationPlanRoutes(store as any))
    return app
}

describe('createCommunicationPlanRoutes', () => {
    it('returns null plan when none exists', async () => {
        const app = createApp({
            getCommunicationPlanByPerson: async () => null,
        })
        const response = await app.request('/api/communication-plans/me')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ plan: null })
    })

    it('rejects when the request has no linked person', async () => {
        const app = createApp({}, { personId: null })
        const response = await app.request('/api/communication-plans/me')
        expect(response.status).toBe(409)
    })

    it('rejects when the user has no organization', async () => {
        const app = createApp({}, { orgs: [] })
        const response = await app.request('/api/communication-plans/me')
        expect(response.status).toBe(400)
    })

    it('upserts preferences for the current person and returns the stored plan', async () => {
        const upserts: Array<Record<string, unknown>> = []
        const app = createApp({
            upsertCommunicationPlan: async (input: Record<string, unknown>) => {
                upserts.push(input)
                return {
                    id: 'plan-1',
                    namespace: 'org-1',
                    orgId: 'org-1',
                    personId: 'person-1',
                    preferences: input.preferences,
                    enabled: true,
                    version: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    updatedBy: 'user@example.com',
                }
            },
        })

        const response = await app.request('/api/communication-plans/me', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                preferences: { tone: 'direct', length: 'concise' },
                reason: 'user preference',
            }),
        })

        expect(response.status).toBe(200)
        expect(upserts).toEqual([{
            namespace: 'org-1',
            orgId: 'org-1',
            personId: 'person-1',
            preferences: { tone: 'direct', length: 'concise' },
            enabled: undefined,
            editedBy: 'user@example.com',
            reason: 'user preference',
        }])
    })

    it('rejects invalid enum values on PUT', async () => {
        const app = createApp({
            upsertCommunicationPlan: async () => ({}),
        })
        const response = await app.request('/api/communication-plans/me', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                preferences: { length: 'weird' },
            }),
        })
        expect(response.status).toBe(400)
    })

    it('returns 404 when disabling a plan that does not exist', async () => {
        const app = createApp({
            setCommunicationPlanEnabled: async () => null,
        })
        const response = await app.request('/api/communication-plans/me/enabled', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        })
        expect(response.status).toBe(404)
    })

    it('toggles enabled=false and forwards reason', async () => {
        const calls: Array<Record<string, unknown>> = []
        const app = createApp({
            setCommunicationPlanEnabled: async (input: Record<string, unknown>) => {
                calls.push(input)
                return {
                    id: 'plan-1',
                    namespace: 'org-1',
                    orgId: 'org-1',
                    personId: 'person-1',
                    preferences: {},
                    enabled: false,
                    version: 2,
                    createdAt: 1,
                    updatedAt: 2,
                    updatedBy: 'user@example.com',
                }
            },
        })
        const response = await app.request('/api/communication-plans/me/enabled', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false, reason: 'opt-out' }),
        })
        expect(response.status).toBe(200)
        expect(calls[0]).toEqual({
            namespace: 'org-1',
            orgId: 'org-1',
            personId: 'person-1',
            enabled: false,
            editedBy: 'user@example.com',
            reason: 'opt-out',
        })
    })

    it('lists audits for the current person', async () => {
        const calls: Array<Record<string, unknown>> = []
        const app = createApp({
            listCommunicationPlanAudits: async (options: Record<string, unknown>) => {
                calls.push(options)
                return [{ id: 'audit-1' }]
            },
        })
        const response = await app.request('/api/communication-plans/me/audits?limit=10')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ audits: [{ id: 'audit-1' }] })
        expect(calls[0]).toEqual({
            namespace: 'org-1',
            orgId: 'org-1',
            personId: 'person-1',
            limit: 10,
        })
    })
})
