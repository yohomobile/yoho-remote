import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import {
    buildSessionAffect,
    extractSessionAffectFromMetadata,
    resolveSessionAffectContext,
    SESSION_AFFECT_METADATA_KEY,
    type SessionAffectMode,
} from '../../brain/sessionAffect'

// Phase 3E HTTP endpoint for session-only affect.
// Hard boundaries (see docs/design/k1-phase3-actor-aware-brain.md §4.E):
// - Session-only; never writes long-term persona or team profile.
// - Only affects response pacing; does not touch tool calls or fact judgement.
// - TTL expiry is a soft boundary — expired affect is dropped on next init.

const modeSchema = z.enum(['concise', 'detailed', 'default']) satisfies z.ZodType<SessionAffectMode>
const sourceSchema = z.enum(['user_explicit', 'user_toggle', 'system_signal'])

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const upsertSchema = z.object({
    mode: modeSchema,
    source: sourceSchema.optional(),
    note: z.string().max(500).nullable().optional(),
    ttlMs: z.number().int().positive().max(MAX_TTL_MS).nullable().optional(),
})

async function requireSessionAccess(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    store: IStore,
    sessionId: string,
): Promise<{ namespace: string } | Response> {
    const email = c.get('email')
    if (!email) return c.json({ error: 'Unauthorized' }, 401)

    const session = engine.getSession(sessionId) ?? (await store.getSession(sessionId).catch(() => null))
    if (!session) return c.json({ error: 'Session not found' }, 404)

    // Operator bypass.
    if (c.get('role') === 'operator') return { namespace: session.namespace }

    // Creator or org member of session's org can modify.
    const orgs = c.get('orgs') ?? []
    const sessionOrgId = (session as { orgId?: string | null }).orgId ?? null
    if (sessionOrgId && orgs.some((o) => o.id === sessionOrgId)) {
        return { namespace: session.namespace }
    }
    const createdBy = (session.metadata as Record<string, unknown> | null | undefined)?.createdByEmail
    if (createdBy === email) return { namespace: session.namespace }

    return c.json({ error: 'Insufficient permissions' }, 403)
}

export function createSessionAffectRoutes(
    getSyncEngine: () => SyncEngine,
    store: IStore,
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/affect', async (c) => {
        const engine = getSyncEngine()
        const sessionId = c.req.param('id')
        const access = await requireSessionAccess(c, engine, store, sessionId)
        if (access instanceof Response) return access

        const session = engine.getSession(sessionId) ?? (await store.getSession(sessionId).catch(() => null))
        const metadata = (session?.metadata as Record<string, unknown> | null | undefined) ?? null
        const resolved = resolveSessionAffectContext({
            affect: extractSessionAffectFromMetadata(metadata),
            now: Date.now(),
        })
        return c.json({
            affect: resolved.affect,
            status: resolved.metadataPatch.sessionAffectStatus,
        })
    })

    app.put('/sessions/:id/affect', async (c) => {
        const engine = getSyncEngine()
        const sessionId = c.req.param('id')
        const access = await requireSessionAccess(c, engine, store, sessionId)
        if (access instanceof Response) return access

        const body = await c.req.json().catch(() => null)
        const parsed = upsertSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', details: parsed.error.issues }, 400)
        }

        const affect = buildSessionAffect({
            mode: parsed.data.mode,
            source: parsed.data.source ?? 'user_explicit',
            note: parsed.data.note ?? null,
            ttlMs: parsed.data.ttlMs ?? null,
        })

        const resolved = resolveSessionAffectContext({ affect, now: affect.setAt })

        const patch: Record<string, unknown> = {
            [SESSION_AFFECT_METADATA_KEY]: affect,
            ...resolved.metadataPatch,
        }
        const result = await engine.patchSessionMetadata(sessionId, patch)
        if (!result.ok) {
            return c.json({ error: result.error }, 500)
        }
        return c.json({ ok: true, affect, status: resolved.metadataPatch.sessionAffectStatus })
    })

    app.delete('/sessions/:id/affect', async (c) => {
        const engine = getSyncEngine()
        const sessionId = c.req.param('id')
        const access = await requireSessionAccess(c, engine, store, sessionId)
        if (access instanceof Response) return access

        const patch: Record<string, unknown> = {
            [SESSION_AFFECT_METADATA_KEY]: null,
            sessionAffectAttached: false,
            sessionAffectStatus: 'none',
            sessionAffectMode: null,
            sessionAffectExpiresAt: null,
        }
        const result = await engine.patchSessionMetadata(sessionId, patch)
        if (!result.ok) {
            return c.json({ error: result.error }, 500)
        }
        return c.json({ ok: true })
    })

    return app
}
