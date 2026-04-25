import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { IStore, OrgRole } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

// Candidate-decision endpoints migrated to /api/approvals (identity domain).
// Person management endpoints (persons / merge / unmerge / detach / audits)
// stay here — they are not approval-flow endpoints.

const identityReasonSchema = z.string().max(1000).nullable().optional()

const mergePersonsSchema = z.object({
    targetPersonId: z.string().min(1),
    reason: identityReasonSchema,
})

const identityReasonBodySchema = z.object({
    reason: identityReasonSchema,
}).nullable().optional()

const orgAdminRoles: OrgRole[] = ['owner', 'admin']

function requireIdentityOrgId(c: Context<WebAppEnv>): string | Response {
    const orgId = c.req.query('orgId')?.trim()
    if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400)
    }
    return orgId
}

async function requireIdentityAdmin(c: Context<WebAppEnv>, store: IStore, orgId: string): Promise<Response | null> {
    const email = c.get('email')
    if (!email) {
        return c.json({ error: 'Unauthorized' }, 401)
    }

    if (c.get('role') === 'operator') {
        return null
    }

    const role = await store.getUserOrgRole(orgId, email)
    if (!role || !orgAdminRoles.includes(role)) {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }
    return null
}

export function createIdentityRoutes(
    store: IStore,
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/identity/persons', async (c) => {
        const orgId = requireIdentityOrgId(c)
        if (orgId instanceof Response) return orgId
        const namespace = orgId
        const permissionError = await requireIdentityAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const limit = Number(c.req.query('limit') ?? 20)
        const persons = await store.searchPersons({
            namespace,
            orgId,
            q: c.req.query('q') ?? null,
            limit: Number.isFinite(limit) ? limit : 20,
        })
        return c.json({ persons })
    })

    app.get('/identity/persons/:personId', async (c) => {
        const orgId = requireIdentityOrgId(c)
        if (orgId instanceof Response) return orgId
        const namespace = orgId
        const permissionError = await requireIdentityAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const detail = await store.getPersonWithIdentities({
            namespace,
            orgId,
            personId: c.req.param('personId'),
        })
        if (!detail) {
            return c.json({ error: 'Person not found' }, 404)
        }
        return c.json(detail)
    })

    app.get('/identity/audits', async (c) => {
        const orgId = requireIdentityOrgId(c)
        if (orgId instanceof Response) return orgId
        const namespace = orgId
        const permissionError = await requireIdentityAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const limit = Number(c.req.query('limit') ?? 50)
        const audits = await store.listPersonIdentityAudits({
            namespace,
            orgId,
            personId: c.req.query('personId') ?? null,
            identityId: c.req.query('identityId') ?? null,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ audits })
    })

    app.post('/identity/persons/:personId/merge', async (c) => {
        const orgId = requireIdentityOrgId(c)
        if (orgId instanceof Response) return orgId
        const namespace = orgId
        const permissionError = await requireIdentityAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        const parsed = mergePersonsSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid merge request', details: parsed.error.issues }, 400)
        }

        try {
            const person = await store.mergePersons({
                namespace,
                orgId,
                sourcePersonId: c.req.param('personId'),
                targetPersonId: parsed.data.targetPersonId,
                reason: parsed.data.reason ?? null,
                decidedBy: c.get('email') ?? null,
            })
            if (!person) {
                return c.json({ error: 'Person not found' }, 404)
            }
            return c.json({ ok: true, person })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to merge persons' }, 400)
        }
    })

    app.post('/identity/persons/:personId/unmerge', async (c) => {
        const orgId = requireIdentityOrgId(c)
        if (orgId instanceof Response) return orgId
        const namespace = orgId
        const permissionError = await requireIdentityAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        const parsed = identityReasonBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid unmerge request', details: parsed.error.issues }, 400)
        }

        try {
            const person = await store.unmergePerson({
                namespace,
                orgId,
                personId: c.req.param('personId'),
                reason: parsed.data?.reason ?? null,
                decidedBy: c.get('email') ?? null,
            })
            if (!person) {
                return c.json({ error: 'Person not found' }, 404)
            }
            return c.json({ ok: true, person })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to unmerge person' }, 400)
        }
    })

    app.post('/identity/links/:linkId/detach', async (c) => {
        const orgId = requireIdentityOrgId(c)
        if (orgId instanceof Response) return orgId
        const namespace = orgId
        const permissionError = await requireIdentityAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        const parsed = identityReasonBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid detach request', details: parsed.error.issues }, 400)
        }

        const link = await store.detachPersonIdentityLink({
            namespace,
            orgId,
            linkId: c.req.param('linkId'),
            reason: parsed.data?.reason ?? null,
            decidedBy: c.get('email') ?? null,
        })
        if (!link) {
            return c.json({ error: 'Identity link not found' }, 404)
        }
        return c.json({ ok: true, link })
    })

    return app
}
