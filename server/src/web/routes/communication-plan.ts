import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const lengthSchema = z.enum(['concise', 'detailed', 'default']).nullable().optional()
const explanationDepthSchema = z.enum(['minimal', 'moderate', 'thorough']).nullable().optional()
const formalitySchema = z.enum(['casual', 'neutral', 'formal']).nullable().optional()

const preferencesSchema = z.object({
    tone: z.string().max(200).nullable().optional(),
    length: lengthSchema,
    explanationDepth: explanationDepthSchema,
    formality: formalitySchema,
    customInstructions: z.string().max(2000).nullable().optional(),
})

const upsertSchema = z.object({
    preferences: preferencesSchema,
    enabled: z.boolean().optional(),
    reason: z.string().max(500).nullable().optional(),
})

const enableSchema = z.object({
    enabled: z.boolean(),
    reason: z.string().max(500).nullable().optional(),
})

function resolveScope(c: Context<WebAppEnv>): { namespace: string; orgId: string | null; personId: string } | Response {
    const actor = c.get('identityActor')
    if (!actor || !actor.personId) {
        return c.json({ error: 'No linked person for current actor' }, 409)
    }
    const orgQuery = c.req.query('orgId')?.trim() || null
    const orgs = c.get('orgs') ?? []
    const orgId = orgQuery && (c.get('role') === 'operator' || orgs.some((o) => o.id === orgQuery))
        ? orgQuery
        : (orgs[0]?.id ?? null)
    if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400)
    }
    return { namespace: orgId, orgId, personId: actor.personId }
}

export function createCommunicationPlanRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/communication-plans/me', async (c) => {
        const scope = resolveScope(c)
        if (scope instanceof Response) return scope
        const plan = await store.getCommunicationPlanByPerson(scope)
        return c.json({ plan: plan ?? null })
    })

    app.put('/communication-plans/me', async (c) => {
        const scope = resolveScope(c)
        if (scope instanceof Response) return scope
        const body = await c.req.json().catch(() => null)
        const parsed = upsertSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400)
        }
        const plan = await store.upsertCommunicationPlan({
            namespace: scope.namespace,
            orgId: scope.orgId,
            personId: scope.personId,
            preferences: parsed.data.preferences,
            enabled: parsed.data.enabled,
            editedBy: c.get('email') ?? null,
            reason: parsed.data.reason ?? null,
        })
        return c.json({ ok: true, plan })
    })

    app.post('/communication-plans/me/enabled', async (c) => {
        const scope = resolveScope(c)
        if (scope instanceof Response) return scope
        const body = await c.req.json().catch(() => null)
        const parsed = enableSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400)
        }
        const plan = await store.setCommunicationPlanEnabled({
            namespace: scope.namespace,
            orgId: scope.orgId,
            personId: scope.personId,
            enabled: parsed.data.enabled,
            editedBy: c.get('email') ?? null,
            reason: parsed.data.reason ?? null,
        })
        if (!plan) {
            return c.json({ error: 'Communication plan not found' }, 404)
        }
        return c.json({ ok: true, plan })
    })

    app.get('/communication-plans/me/audits', async (c) => {
        const scope = resolveScope(c)
        if (scope instanceof Response) return scope
        const limit = Number(c.req.query('limit') ?? 50)
        const audits = await store.listCommunicationPlanAudits({
            namespace: scope.namespace,
            orgId: scope.orgId,
            personId: scope.personId,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ audits })
    })

    return app
}
