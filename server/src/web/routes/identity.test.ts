import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createIdentityRoutes } from './identity'

function createApp(store: Record<string, unknown>, options?: {
    role?: 'developer' | 'operator'
    email?: string
    namespace?: string
}) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('namespace', options?.namespace ?? 'default')
        c.set('role', options?.role ?? 'developer')
        c.set('email', options?.email ?? 'admin@example.com')
        c.set('orgs', [])
        await next()
    })
    app.route('/api', createIdentityRoutes(store as any))
    return app
}

describe('createIdentityRoutes', () => {
    // Candidate list / reject / decide tests moved to the unified Approvals
    // Engine (see server/src/approvals/executor.test.ts + generic
    // /api/approvals route integration tests).

    it('exposes identity governance audits for org admins', async () => {
        const audit = {
            id: 'audit-1',
            action: 'merge_persons',
            personId: 'person-source',
            targetPersonId: 'person-target',
        }
        const calls: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'owner',
            listPersonIdentityAudits: async (options: Record<string, unknown>) => {
                calls.push(options)
                return [audit]
            },
        })

        const response = await app.request('/api/identity/audits?orgId=org-1&personId=person-source&limit=10')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ audits: [audit] })
        expect(calls).toEqual([{
            namespace: 'org-1',
            orgId: 'org-1',
            personId: 'person-source',
            identityId: null,
            limit: 10,
        }])
    })

    it('allows operators to merge and unmerge persons within an org', async () => {
        const calls: Array<Record<string, unknown>> = []
        const app = createApp({
            mergePersons: async (data: Record<string, unknown>) => {
                calls.push({ op: 'merge', data })
                return {
                    id: 'person-source',
                    status: 'merged',
                    mergedIntoPersonId: 'person-target',
                }
            },
            unmergePerson: async (data: Record<string, unknown>) => {
                calls.push({ op: 'unmerge', data })
                return {
                    id: 'person-source',
                    status: 'active',
                    mergedIntoPersonId: null,
                }
            },
        }, {
            role: 'operator',
            email: 'operator@example.com',
        })

        const mergeResponse = await app.request('/api/identity/persons/person-source/merge?orgId=org-1', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                targetPersonId: 'person-target',
                reason: 'duplicate person',
            }),
        })
        const unmergeResponse = await app.request('/api/identity/persons/person-source/unmerge?orgId=org-1', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                reason: 'rollback duplicate merge',
            }),
        })

        expect(mergeResponse.status).toBe(200)
        expect(await mergeResponse.json()).toEqual({
            ok: true,
            person: {
                id: 'person-source',
                status: 'merged',
                mergedIntoPersonId: 'person-target',
            },
        })
        expect(unmergeResponse.status).toBe(200)
        expect(await unmergeResponse.json()).toEqual({
            ok: true,
            person: {
                id: 'person-source',
                status: 'active',
                mergedIntoPersonId: null,
            },
        })
        expect(calls).toEqual([
            {
                op: 'merge',
                data: {
                    namespace: 'org-1',
                    orgId: 'org-1',
                    sourcePersonId: 'person-source',
                    targetPersonId: 'person-target',
                    reason: 'duplicate person',
                    decidedBy: 'operator@example.com',
                },
            },
            {
                op: 'unmerge',
                data: {
                    namespace: 'org-1',
                    orgId: 'org-1',
                    personId: 'person-source',
                    reason: 'rollback duplicate merge',
                    decidedBy: 'operator@example.com',
                },
            },
        ])
    })

    it('allows org admins to detach active identity links', async () => {
        const calls: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            detachPersonIdentityLink: async (data: Record<string, unknown>) => {
                calls.push(data)
                return {
                    id: 'link-1',
                    personId: 'person-1',
                    identityId: 'ident-1',
                    state: 'detached',
                }
            },
        }, {
            email: 'admin@example.com',
        })

        const response = await app.request('/api/identity/links/link-1/detach?orgId=org-1', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                reason: 'wrong Feishu account binding',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            link: {
                id: 'link-1',
                personId: 'person-1',
                identityId: 'ident-1',
                state: 'detached',
            },
        })
        expect(calls).toEqual([{
            namespace: 'org-1',
            orgId: 'org-1',
            linkId: 'link-1',
            reason: 'wrong Feishu account binding',
            decidedBy: 'admin@example.com',
        }])
    })

    it('returns person detail with active identities for admins', async () => {
        const calls: Array<Record<string, unknown>> = []
        const person = {
            id: 'person-1',
            namespace: 'org-1',
            orgId: 'org-1',
            personType: 'human',
            canonicalName: 'Guang Yang',
            status: 'active',
        }
        const identity = {
            id: 'ident-1',
            namespace: 'org-1',
            channel: 'feishu',
            externalId: 'feishu-guang',
            status: 'active',
        }
        const link = {
            id: 'link-1',
            personId: 'person-1',
            identityId: 'ident-1',
            state: 'admin_verified',
            confidence: 0.98,
        }
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            getPersonWithIdentities: async (options: Record<string, unknown>) => {
                calls.push(options)
                return { person, identities: [{ identity, link }] }
            },
        })

        const response = await app.request('/api/identity/persons/person-1?orgId=org-1')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            person,
            identities: [{ identity, link }],
        })
        expect(calls).toEqual([{
            namespace: 'org-1',
            orgId: 'org-1',
            personId: 'person-1',
        }])
    })

    it('returns 404 when person detail is missing or cross-org', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            getPersonWithIdentities: async () => null,
        })

        const response = await app.request('/api/identity/persons/person-missing?orgId=org-1')

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'Person not found' })
    })
})
