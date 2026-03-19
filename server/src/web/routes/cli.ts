import { Hono } from 'hono'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configuration, getConfiguration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import {
    getActiveAccount,
    selectBestAccount,
    migrateDefaultAccount,
} from '../../claude-accounts/accountsService'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const createOrLoadSessionSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional()
})

const createOrLoadMachineSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    daemonState: z.unknown().nullable().optional()
})

const cliSendMessageSchema = z.object({
    text: z.string().min(1),
    sentFrom: z.string().optional()
})

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

type CliEnv = {
    Variables: {
        namespace: string
    }
}

function resolveSessionForNamespace(
    engine: SyncEngine,
    sessionId: string,
    namespace: string
): { ok: true; session: Session } | { ok: false; status: 403 | 404; error: string } {
    const session = engine.getSessionByNamespace(sessionId, namespace)
    if (session) {
        return { ok: true, session }
    }
    if (engine.getSession(sessionId)) {
        return { ok: false, status: 403, error: 'Session access denied' }
    }
    return { ok: false, status: 404, error: 'Session not found' }
}

function resolveMachineForNamespace(
    engine: SyncEngine,
    machineId: string,
    namespace: string
): { ok: true; machine: Machine } | { ok: false; status: 403 | 404; error: string } {
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (machine) {
        return { ok: true, machine }
    }
    if (engine.getMachine(machineId)) {
        return { ok: false, status: 403, error: 'Machine access denied' }
    }
    return { ok: false, status: 404, error: 'Machine not found' }
}

export function createCliRoutes(
    getSyncEngine: () => SyncEngine | null,
    getSseManager?: () => SSEManager | null
): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    app.use('*', async (c, next) => {
        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }

        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }

        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !safeCompareStrings(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', parsedToken.namespace)
        return await next()
    })

    app.post('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadSessionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const session = await engine.getOrCreateSession(parsed.data.tag, parsed.data.metadata, parsed.data.agentState ?? null, namespace)
        return c.json({ session })
    })

    app.get('/sessions/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? 200
        const afterSeq = parsed.data.afterSeq ?? 0
        const messages = await engine.getMessagesAfter(sessionId, { afterSeq, limit })
        return c.json({ messages })
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = cliSendMessageSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            sentFrom: (parsed.data.sentFrom || 'webapp') as 'webapp' | 'telegram-bot'
        })
        return c.json({ ok: true })
    })

    app.post('/machines', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadMachineSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const existing = engine.getMachine(parsed.data.id)
        if (existing && existing.namespace !== namespace) {
            return c.json({ error: 'Machine access denied' }, 403)
        }
        const machine = await engine.getOrCreateMachine(parsed.data.id, parsed.data.metadata, parsed.data.daemonState ?? null, namespace)
        return c.json({ machine })
    })

    app.get('/machines/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ machine: resolved.machine })
    })

    // Server uploads - allow CLI to fetch images uploaded via web
    app.get('/server-uploads/:sessionId/:filename', (c) => {
        const sessionId = c.req.param('sessionId')
        const filename = c.req.param('filename')

        try {
            const config = getConfiguration()
            const filePath = join(config.dataDir, 'uploads', sessionId, filename)

            if (!existsSync(filePath)) {
                return c.json({ error: 'File not found' }, 404)
            }

            const buffer = readFileSync(filePath)

            // Infer MIME type from filename
            const ext = filename.split('.').pop()?.toLowerCase() ?? ''
            const imageMimeTypes: Record<string, string> = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml',
                'bmp': 'image/bmp',
                'ico': 'image/x-icon',
                'heic': 'image/heic',
                'heif': 'image/heif'
            }
            const contentType = imageMimeTypes[ext] ?? 'application/octet-stream'

            return new Response(buffer, {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length.toString(),
                    'Cache-Control': 'public, max-age=31536000, immutable'
                }
            })
        } catch (error) {
            console.error('[cli/server-uploads] read error:', error)
            return c.json({ error: 'Failed to read file' }, 500)
        }
    })

    // Claude 多账号：获取当前活跃账号
    app.get('/claude-accounts/active', async (c) => {
        try {
            const account = await getActiveAccount()
            if (!account) {
                const migrated = await migrateDefaultAccount()
                if (migrated) {
                    return c.json({ account: migrated })
                }
                return c.json({ account: null })
            }
            return c.json({ account })
        } catch (error: any) {
            return c.json({ error: error.message || 'Failed to get active account' }, 500)
        }
    })

    // Claude 多账号：智能选择最优账号（负载平衡）
    app.get('/claude-accounts/select-best', async (c) => {
        try {
            const selection = await selectBestAccount()
            if (!selection) {
                const migrated = await migrateDefaultAccount()
                if (migrated) {
                    return c.json({ account: migrated, usage: null, reason: 'fallback_lowest', timestamp: Date.now() })
                }
                return c.json({ account: null, reason: 'no_accounts', timestamp: Date.now() })
            }

            return c.json({
                account: selection.account,
                usage: selection.usage ? {
                    fiveHour: selection.usage.fiveHour,
                    sevenDay: selection.usage.sevenDay,
                } : null,
                reason: selection.reason,
                timestamp: Date.now()
            })
        } catch (error: any) {
            return c.json({ error: error.message || 'Failed to select best account' }, 500)
        }
    })

    return app
}
