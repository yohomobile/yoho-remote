import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { IStore, OrgRole } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const scopeSchema = z.enum(['personal', 'team'])
const statusSchema = z.enum(['open', 'resolved', 'dismissed', 'expired'])
const resolutionSchema = z.enum(['keep_a', 'keep_b', 'supersede', 'discard_all', 'mark_expired'])

const decideSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('resolve'),
        resolution: resolutionSchema,
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('dismiss'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('reopen'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('expire'),
        reason: z.string().max(1000).nullable().optional(),
    }),
])

const orgAdminRoles: OrgRole[] = ['owner', 'admin']

function requireOrgId(c: Context<WebAppEnv>): string | Response {
    const orgId = c.req.query('orgId')?.trim()
    if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400)
    }
    return orgId
}

async function requireOrgAdmin(
    c: Context<WebAppEnv>,
    store: IStore,
    orgId: string,
): Promise<Response | null> {
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

export function createMemoryConflictRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/memory-conflicts', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const scopeRaw = c.req.query('scope')
        const scope = scopeRaw ? scopeSchema.safeParse(scopeRaw) : null
        if (scope && !scope.success) {
            return c.json({ error: 'Invalid scope' }, 400)
        }
        const statusRaw = c.req.query('status')
        const status = statusRaw ? statusSchema.safeParse(statusRaw) : null
        if (status && !status.success) {
            return c.json({ error: 'Invalid status' }, 400)
        }
        const limit = Number(c.req.query('limit') ?? 50)
        const candidates = await store.listMemoryConflictCandidates({
            namespace: orgId,
            orgId,
            scope: scope?.data ?? null,
            status: status?.data ?? null,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ candidates })
    })

    app.get('/memory-conflicts/:id', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const candidate = await store.getMemoryConflictCandidate({
            namespace: orgId,
            orgId,
            id,
        })
        if (!candidate) {
            return c.json({ error: 'Conflict candidate not found' }, 404)
        }
        return c.json({ candidate })
    })

    app.post('/memory-conflicts/:id/decide', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        const parsed = decideSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400)
        }

        const id = c.req.param('id')
        const actorEmail = c.get('email') ?? null

        const updated = await store.decideMemoryConflictCandidate({
            namespace: orgId,
            orgId,
            id,
            action: parsed.data.action,
            resolution: parsed.data.action === 'resolve' ? parsed.data.resolution : null,
            actorEmail,
            reason: parsed.data.reason ?? null,
        })
        if (!updated) {
            return c.json({ error: 'Conflict candidate not found' }, 404)
        }
        return c.json({ ok: true, candidate: updated })
    })

    app.get('/memory-conflicts/:id/audits', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const limit = Number(c.req.query('limit') ?? 50)
        const audits = await store.listMemoryConflictAudits({
            namespace: orgId,
            orgId,
            candidateId: id,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ audits })
    })

    return app
}
