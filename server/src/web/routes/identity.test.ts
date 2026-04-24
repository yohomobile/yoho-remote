import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createIdentityRoutes } from './identity'

function createApp(store: Record<string, unknown>, options?: {
    role?: 'developer' | 'operator'
    email?: string
    namespace?: string
    events?: unknown[]
}) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('namespace', options?.namespace ?? 'default')
        c.set('role', options?.role ?? 'developer')
        c.set('email', options?.email ?? 'admin@example.com')
        c.set('orgs', [])
        await next()
    })
    app.route('/api', createIdentityRoutes(store as any, options?.events
        ? () => ({ broadcast: (event: unknown) => options.events?.push(event) }) as any
        : undefined))
    return app
}

describe('createIdentityRoutes', () => {
    it('lists identity candidates for org admins', async () => {
        const candidate = {
            id: 'cand-1',
            identityId: 'ident-1',
            status: 'open',
            score: 0.82,
        }
        const calls: Array<Record<string, unknown>> = []
        const app = createApp({
            getUserOrgRole: async () => 'admin',
            listPersonIdentityCandidates: async (options: Record<string, unknown>) => {
                calls.push(options)
                return [candidate]
            },
        })

        const response = await app.request('/api/identity/candidates?orgId=org-1&status=open')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ candidates: [candidate] })
        expect(calls).toEqual([{
            namespace: 'org-1',
            orgId: 'org-1',
            status: 'open',
            limit: 50,
        }])
    })

    it('rejects identity candidate reads for non-admin org members', async () => {
        const app = createApp({
            getUserOrgRole: async () => 'member',
            listPersonIdentityCandidates: async () => [],
        })

        const response = await app.request('/api/identity/candidates?orgId=org-1')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Insufficient permissions' })
    })

    it('allows operators to decide candidates within an org and broadcasts a candidate update', async () => {
        const events: unknown[] = []
        const decisions: Array<Record<string, unknown>> = []
        const app = createApp({
            decidePersonIdentityCandidate: async (candidateId: string, decision: Record<string, unknown>) => {
                decisions.push({ candidateId, decision })
                return {
                    id: candidateId,
                    identityId: 'ident-1',
                    status: 'confirmed',
                    score: 0.95,
                }
            },
        }, {
            role: 'operator',
            email: 'operator@example.com',
            events,
        })

        const response = await app.request('/api/identity/candidates/cand-1/decision?orgId=org-1', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'confirm_existing_person',
                personId: 'person-1',
                reason: 'email exact match',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            candidate: {
                id: 'cand-1',
                identityId: 'ident-1',
                status: 'confirmed',
                score: 0.95,
            },
        })
        expect(decisions).toEqual([{
            candidateId: 'cand-1',
            decision: {
                action: 'confirm_existing_person',
                personId: 'person-1',
                reason: 'email exact match',
                decidedBy: 'operator@example.com',
            },
        }])
        expect(events).toEqual([{
            type: 'identity-candidate-updated',
            namespace: 'org-1',
            data: {
                orgId: 'org-1',
                candidateId: 'cand-1',
                identityId: 'ident-1',
                status: 'confirmed',
                score: 0.95,
            },
        }])
    })

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
})
