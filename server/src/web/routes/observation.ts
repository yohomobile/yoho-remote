import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { IStore, OrgRole } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

// Observation Hypothesis Pool (Phase 3F)
// 硬边界：候选默认不进 prompt；确认后才升级为 communicationPlan。

const statusSchema = z.enum(['pending', 'confirmed', 'rejected', 'dismissed', 'expired'])

const decideSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('confirm'),
        promotedCommunicationPlanId: z.string().max(200).nullable().optional(),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('reject'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('dismiss'),
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

export function createObservationRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Users can see their own hypotheses (subject filter). Admins can see all.
    app.get('/observations', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const statusRaw = c.req.query('status')
        const status = statusRaw ? statusSchema.safeParse(statusRaw) : null
        if (status && !status.success) {
            return c.json({ error: 'Invalid status' }, 400)
        }
        const subjectPersonId = c.req.query('subjectPersonId')?.trim() || null
        const subjectEmail = c.req.query('subjectEmail')?.trim() || null
        const limit = Number(c.req.query('limit') ?? 50)

        const candidates = await store.listObservationCandidates({
            namespace: orgId,
            orgId,
            subjectPersonId,
            subjectEmail,
            status: status?.data ?? null,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ candidates })
    })

    app.get('/observations/:id', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const candidate = await store.getObservationCandidate({
            namespace: orgId,
            orgId,
            id,
        })
        if (!candidate) {
            return c.json({ error: 'Observation candidate not found' }, 404)
        }
        return c.json({ candidate })
    })

    // Decide: subject (via email) or org admin can decide.
    // No auto-promotion: confirm returns the updated candidate so the caller can then
    // create a communicationPlan from the suggestedPatch and pass back promotedCommunicationPlanId.
    app.post('/observations/:id/decide', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        const parsed = decideSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400)
        }

        const id = c.req.param('id')
        const actorEmail = c.get('email') ?? null

        // Permission refinement: if actor is not org admin and not operator,
        // they must be the subject of the observation.
        const isOperator = c.get('role') === 'operator'
        if (!isOperator) {
            const role = actorEmail ? await store.getUserOrgRole(orgId, actorEmail) : null
            const isAdmin = role && orgAdminRoles.includes(role)
            if (!isAdmin) {
                const existing = await store.getObservationCandidate({
                    namespace: orgId,
                    orgId,
                    id,
                })
                if (!existing) {
                    return c.json({ error: 'Observation candidate not found' }, 404)
                }
                if (existing.subjectEmail !== actorEmail) {
                    return c.json({ error: 'Only the subject or an org admin can decide' }, 403)
                }
            }
        }

        const promotedCommunicationPlanId = parsed.data.action === 'confirm'
            ? parsed.data.promotedCommunicationPlanId ?? null
            : null

        const updated = await store.decideObservationCandidate({
            namespace: orgId,
            orgId,
            id,
            action: parsed.data.action,
            actorEmail,
            reason: parsed.data.reason ?? null,
            promotedCommunicationPlanId,
        })
        if (!updated) {
            return c.json({ error: 'Observation candidate not found' }, 404)
        }
        return c.json({ ok: true, candidate: updated })
    })

    // Audits: admin-only.
    app.get('/observations/:id/audits', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const limit = Number(c.req.query('limit') ?? 50)
        const audits = await store.listObservationAudits({
            namespace: orgId,
            orgId,
            candidateId: id,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ audits })
    })

    return app
}
