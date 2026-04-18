import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParamWithShareCheck, requireSyncEngine } from './guards'

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

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = sendMessageBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const sentFrom = parsed.data.sentFrom || 'webapp'

        await engine.sendMessage(sessionId, { text: parsed.data.text, localId: parsed.data.localId, sentFrom: sentFrom as 'webapp' | 'telegram-bot' })
        return c.json({ ok: true })
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
