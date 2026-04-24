import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { IStore, OrgRole } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const statusSchema = z.enum(['pending', 'approved', 'rejected', 'superseded', 'expired'])

const proposeSchema = z.object({
    content: z.string().min(1).max(4000),
    source: z.string().max(200).nullable().optional(),
    sessionId: z.string().max(200).nullable().optional(),
})

const decideSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('approve'),
        memoryRef: z.string().max(500).nullable().optional(),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('reject'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('supersede'),
        memoryRef: z.string().max(500).nullable().optional(),
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

async function requireOrgMember(
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
    if (!role) {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }
    return null
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

export function createTeamMemoryRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Members can propose a team memory candidate (always 'pending', requires admin approval).
    app.post('/team-memory/candidates', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        const parsed = proposeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400)
        }

        const email = c.get('email') ?? null
        // proposedByPersonId left null here; the brain can attach actor resolution when writing.
        const candidate = await store.proposeTeamMemoryCandidate({
            namespace: orgId,
            orgId,
            proposedByPersonId: null,
            proposedByEmail: email,
            content: parsed.data.content,
            source: parsed.data.source ?? null,
            sessionId: parsed.data.sessionId ?? null,
        })
        return c.json({ candidate }, 201)
    })

    // Members can list (so contributors can see their own pending). Admin-only filtering is UI concern.
    app.get('/team-memory/candidates', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const statusRaw = c.req.query('status')
        const status = statusRaw ? statusSchema.safeParse(statusRaw) : null
        if (status && !status.success) {
            return c.json({ error: 'Invalid status' }, 400)
        }
        const limit = Number(c.req.query('limit') ?? 50)
        const candidates = await store.listTeamMemoryCandidates({
            namespace: orgId,
            orgId,
            status: status?.data ?? null,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ candidates })
    })

    app.get('/team-memory/candidates/:id', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const candidate = await store.getTeamMemoryCandidate({
            namespace: orgId,
            orgId,
            id,
        })
        if (!candidate) {
            return c.json({ error: 'Team memory candidate not found' }, 404)
        }
        return c.json({ candidate })
    })

    // Decide: admin-only. No auto-promotion; a rejected/expired candidate stays in audit trail.
    app.post('/team-memory/candidates/:id/decide', async (c) => {
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

        const memoryRef = parsed.data.action === 'approve' || parsed.data.action === 'supersede'
            ? parsed.data.memoryRef ?? null
            : null

        const updated = await store.decideTeamMemoryCandidate({
            namespace: orgId,
            orgId,
            id,
            action: parsed.data.action,
            actorEmail,
            reason: parsed.data.reason ?? null,
            memoryRef,
        })
        if (!updated) {
            return c.json({ error: 'Team memory candidate not found' }, 404)
        }
        return c.json({ ok: true, candidate: updated })
    })

    // Audit list: admin-only to avoid leaking who rejected whose proposal.
    app.get('/team-memory/candidates/:id/audits', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const limit = Number(c.req.query('limit') ?? 50)
        const audits = await store.listTeamMemoryAudits({
            namespace: orgId,
            orgId,
            candidateId: id,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ audits })
    })

    return app
}
