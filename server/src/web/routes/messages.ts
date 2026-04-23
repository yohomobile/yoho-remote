import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParamWithShareCheck, requireSyncEngine } from './guards'
import { mergeMessageMeta } from '../identityContext'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional()
})

const sendMessageBodySchema = z.object({
    text: z.string().min(1),
    localId: z.string().min(1).optional(),
    sentFrom: z.string().min(1).max(50).optional()
})

const clearMessagesBodySchema = z.object({
    keepCount: z.coerce.number().int().min(0).max(100).optional(),
    compact: z.boolean().optional()
})

type BrainDeliveryPhase = 'queued' | 'pending_consume' | 'consuming'

function getBrainDeliveryPhase(session: { active: boolean; thinking: boolean }): BrainDeliveryPhase {
    if (!session.active) {
        return 'queued'
    }
    return session.thinking ? 'pending_consume' : 'consuming'
}

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null, store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        engine.noteResumeClientEvent(sessionId, 'messages-get')

        const parsed = querySchema.safeParse(c.req.query())
        const limit = parsed.success ? (parsed.data.limit ?? 200) : 200
        const beforeSeq = parsed.success ? (parsed.data.beforeSeq ?? null) : null
        return c.json(await engine.getMessagesPage(sessionId, { limit, beforeSeq }))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const body = await c.req.json().catch(() => null)
        const parsed = sendMessageBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const sentFrom = parsed.data.sentFrom || 'webapp'
        const isBrainSession = session.metadata?.source === 'brain'
        if (!session.active && !isBrainSession) {
            return c.json({ error: 'Session is inactive' }, 409)
        }
        engine.noteResumeClientEvent(sessionId, 'message-post', { sentFrom })

        const acceptedAt = Date.now()
        const brainDelivery = isBrainSession
            ? {
                phase: getBrainDeliveryPhase(session),
                acceptedAt,
            }
            : undefined
        const baseMeta = brainDelivery ? { brainDelivery } : undefined

        const outcome = await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            sentFrom: sentFrom as 'webapp' | 'telegram-bot',
            meta: mergeMessageMeta(c.get('identityActor'), baseMeta),
        })

        return c.json({
            ok: true,
            sessionId,
            status: outcome.status,
            ...(outcome.status === 'queued'
                ? {
                    queue: outcome.queue,
                    queueDepth: outcome.queueDepth,
                }
                : {}),
            ...(brainDelivery ? { brainDelivery } : {}),
        })
    })

    // Get message count for a session
    app.get('/sessions/:id/messages/count', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const count = await engine.getMessageCount(sessionResult.sessionId)
        return c.json({ count })
    })

    // Clear messages for a session, keeping the most recent N messages
    // If compact=true and session is active, send /compact command first to preserve context
    app.delete('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => ({}))
        const parsed = clearMessagesBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const keepCount = parsed.data.keepCount ?? 30
        const shouldCompact = parsed.data.compact ?? false

        // If compact requested and session is active, send /compact command first
        if (shouldCompact) {
            const session = engine.getSession(sessionResult.sessionId)
            if (session && session.active) {
                await engine.sendMessage(sessionResult.sessionId, {
                    text: '/compact',
                    sentFrom: 'webapp'
                })
            }
        }

        const result = await engine.clearSessionMessages(sessionResult.sessionId, keepCount)
        return c.json({ ok: true, ...result, compacted: shouldCompact })
    })

    return app
}
