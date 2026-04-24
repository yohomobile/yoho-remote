import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine, requireRequestedOrgId, requireSessionWithShareCheck } from './guards'

function parseOptionalId(value: string | undefined): string | null {
    if (!value) {
        return null
    }
    return value.trim() ? value : null
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) {
        return false
    }
    return value === 'true' || value === '1'
}

export function createEventsRoutes(
    getSseManager: () => SSEManager | null,
    getSyncEngine: () => SyncEngine | null,
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/events', async (c) => {
        const manager = getSseManager()
        if (!manager) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const query = c.req.query()
        const all = parseBoolean(query.all)
        const sessionId = parseOptionalId(query.sessionId)
        const machineId = parseOptionalId(query.machineId)
        const subscriptionId = randomUUID()
        const email = c.get('email')
        // Read clientId and deviceType from query params (sent by frontend)
        const clientId = parseOptionalId(query.clientId) ?? undefined
        const deviceType = parseOptionalId(query.deviceType) ?? undefined
        let orgId: string | null = null

        if (sessionId || machineId) {
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not connected' }, 503)
            }
            if (sessionId) {
                const sessionResult = await requireSessionWithShareCheck(c, engine, store, sessionId)
                if (sessionResult instanceof Response) {
                    return sessionResult
                }
                orgId = sessionResult.orgId ?? null
                engine.noteResumeClientEvent(sessionId, 'sse-connect', { clientId, deviceType })
            }
            if (machineId) {
                const requestedOrgId = requireRequestedOrgId(c)
                if (requestedOrgId instanceof Response) {
                    return requestedOrgId
                }
                const machine = requireMachine(c, engine, machineId)
                if (machine instanceof Response) {
                    return machine
                }
                if (machine.orgId !== requestedOrgId) {
                    return c.json({ error: 'Machine access denied' }, 403)
                }
                orgId = requestedOrgId
            }
        } else {
            const requestedOrgId = requireRequestedOrgId(c)
            if (requestedOrgId instanceof Response) {
                return requestedOrgId
            }
            orgId = requestedOrgId
        }

        if (!orgId) {
            return c.json({ error: 'orgId is required' }, 400)
        }

        return streamSSE(c, async (stream) => {
            manager.subscribe({
                id: subscriptionId,
                orgId,
                all,
                sessionId,
                machineId,
                email,
                clientId,
                deviceType,
                send: (event) => stream.writeSSE({ data: JSON.stringify(event) }),
                sendHeartbeat: async () => {
                    await stream.write(': heartbeat\n\n')
                }
            })

            await new Promise<void>((resolve) => {
                const done = () => resolve()
                c.req.raw.signal.addEventListener('abort', done, { once: true })
                stream.onAbort(done)
            })

            manager.unsubscribe(subscriptionId)
        })
    })

    return app
}
