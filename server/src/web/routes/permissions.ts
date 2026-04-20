import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParamWithShareCheck, requireSyncEngine } from './guards'
import { validatePermissionModeForSessionFlavor } from './sessionConfigPolicy'

const decisionSchema = z.enum(['approved', 'approved_for_session', 'denied', 'abort'])

const approveBodySchema = z.object({
    mode: z.enum(['bypassPermissions']).optional(),
    allowTools: z.array(z.string()).optional(),
    decision: decisionSchema.optional(),
    answers: z.record(z.string(), z.array(z.string())).optional()
})

const denyBodySchema = z.object({
    decision: decisionSchema.optional()
})

export function createPermissionsRoutes(getSyncEngine: () => SyncEngine | null, store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/permissions/:requestId/approve', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const json = await c.req.json().catch(() => null)
        const parsed = approveBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const requests = session.agentState?.requests ?? null
        if (!requests || !requests[requestId]) {
            console.warn(`[permissions] approve before request state sync`, {
                sessionId,
                requestId,
                availableRequestIds: requests ? Object.keys(requests) : [],
                hasAgentState: !!session.agentState,
            })
        }

        const mode = parsed.data.mode
        const allowTools = parsed.data.allowTools
        const decision = parsed.data.decision
        const answers = parsed.data.answers
        let modeRoutedVia: 'session-config' | 'legacy-permission-rpc' | null = null

        console.log(`[permissions] approve`, {
            sessionId,
            requestId,
            tool: requests?.[requestId]?.tool ?? null,
            hasAnswers: !!answers,
        })

        // Compatibility facade:
        // keep legacy approve endpoint, but route permissionMode through
        // session config control-plane path whenever available.
        let legacyMode: typeof mode | undefined
        if (mode !== undefined) {
            const permissionModeValidation = validatePermissionModeForSessionFlavor(session.metadata?.flavor, mode)
            if (!permissionModeValidation.ok) {
                return c.json({ error: permissionModeValidation.error }, 400)
            }
            try {
                const applied = await engine.applySessionConfig(sessionId, { permissionMode: mode })
                if (applied.permissionMode !== undefined) {
                    modeRoutedVia = 'session-config'
                }
            } catch (error) {
                // Keep old endpoint behavior as fallback when runtime side is not yet upgraded.
                legacyMode = mode
                modeRoutedVia = 'legacy-permission-rpc'
                console.warn(`[permissions] session config fallback to legacy permission rpc`, {
                    sessionId,
                    requestId,
                    mode,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }

        await engine.approvePermission(sessionId, requestId, legacyMode, allowTools, decision, answers)
        return c.json(modeRoutedVia ? { ok: true, modeRoutedVia } : { ok: true })
    })

    app.post('/sessions/:id/permissions/:requestId/deny', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const requestId = c.req.param('requestId')

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const { sessionId, session } = sessionResult

        const requests = session.agentState?.requests ?? null
        if (!requests || !requests[requestId]) {
            console.warn(`[permissions] deny before request state sync`, {
                sessionId,
                requestId,
                availableRequestIds: requests ? Object.keys(requests) : [],
                hasAgentState: !!session.agentState,
            })
        }

        const json = await c.req.json().catch(() => null)
        const parsed = denyBodySchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.denyPermission(sessionId, requestId, parsed.data.decision)
        return c.json({ ok: true })
    })

    return app
}
