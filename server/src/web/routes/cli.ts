import { Hono } from 'hono'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configuration, getConfiguration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import type { SSEManager } from '../../sse/sseManager'
import { serializeMachine, sortMachinesForDisplay } from './machinePayload'

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

const brainSpawnSchema = z.object({
    machineId: z.string().min(1),
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'opencode']).default('claude'),
    modelMode: z.enum(['default', 'sonnet', 'opus']).optional(),
    source: z.string().default('brain-child'),
    mainSessionId: z.string().optional(),
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
    getSseManager?: () => SSEManager | null,
    store?: import('../../store/interface').IStore,
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

    // List online machines
    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const namespace = c.get('namespace')
        const machines = sortMachinesForDisplay(engine.getMachinesByNamespace(namespace))
        return c.json({
            machines: machines.map(serializeMachine)
        })
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

    // Feishu chat messages: query persisted messages for a chat
    app.get('/feishu/chat-messages', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const chatId = c.req.query('chatId')
        if (!chatId) {
            return c.json({ error: 'chatId is required' }, 400)
        }
        const limit = Math.min(Number(c.req.query('limit') || '50'), 200)
        const before = c.req.query('before') ? Number(c.req.query('before')) : undefined

        try {
            const messages = await store.getFeishuChatMessages(chatId, limit, before)
            return c.json({ messages })
        } catch (err: any) {
            return c.json({ error: err.message || 'Failed to query messages' }, 500)
        }
    })

    // Brain: spawn a child session
    app.post('/brain/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = brainSpawnSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        const namespace = c.get('namespace')
        const machineResolved = resolveMachineForNamespace(engine, parsed.data.machineId, namespace)
        if (!machineResolved.ok) {
            return c.json({ error: machineResolved.error }, machineResolved.status)
        }
        if (!machineResolved.machine.active) {
            return c.json({ error: 'Machine is offline' }, 503)
        }

        const result = await engine.spawnSession(
            parsed.data.machineId,
            parsed.data.directory,
            parsed.data.agent as any,
            true,     // yolo
            'simple',
            undefined,
            {
                source: parsed.data.source,
                mainSessionId: parsed.data.mainSessionId,
                permissionMode: 'bypassPermissions',
                modelMode: parsed.data.modelMode as any,
            }
        )

        // Inherit org_id from main (brain) session
        if (result.type === 'success' && parsed.data.mainSessionId && store) {
            const mainSession = await store.getSession(parsed.data.mainSessionId)
            if (mainSession?.orgId) {
                await store.setSessionOrgId(result.sessionId, mainSession.orgId, namespace)
            }
        }

        return c.json(result)
    })

    // Brain: list all sessions in namespace
    app.get('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const namespace = c.get('namespace')
        const includeOffline = c.req.query('includeOffline') === 'true'
        const allSessions = engine.getSessionsByNamespace(namespace)
        const sessions = includeOffline ? allSessions : allSessions.filter(s => s.active)
        const summaries = sessions.map(s => ({
            id: s.id,
            active: s.active,
            activeAt: s.activeAt,
            thinking: s.thinking ?? false,
            modelMode: s.modelMode ?? 'default',
            pendingRequestsCount: s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0,
            metadata: s.metadata ? {
                path: s.metadata.path,
                source: s.metadata.source,
                machineId: s.metadata.machineId,
                flavor: s.metadata.flavor,
                summary: s.metadata.summary,
                mainSessionId: (s.metadata as any).mainSessionId,
                brainSummary: (s.metadata as any).brainSummary,
            } : null,
        }))
        return c.json({ sessions: summaries })
    })

    // Brain: delete a session
    app.delete('/sessions/:id', async (c) => {
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
        const deleted = await engine.deleteSession(sessionId, { terminateSession: true, force: true })
        return c.json({ ok: deleted })
    })

    // Brain: patch metadata on a child session
    const patchMetadataSchema = z.object({
        brainSummary: z.string().max(2000).optional(),
        summary: z.object({
            text: z.string().max(500),
            updatedAt: z.number().optional(),
        }).optional(),
    })

    app.patch('/sessions/:id/metadata', async (c) => {
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
        const parsed = patchMetadataSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = await engine.patchSessionMetadata(sessionId, parsed.data)
        if (!result.ok) {
            return c.json({ error: result.error }, 500)
        }

        return c.json({ ok: true })
    })

    // Brain: set session modelMode
    const setModelModeSchema = z.object({
        modelMode: z.enum(['default', 'sonnet', 'opus']),
    })

    app.patch('/sessions/:id/model-mode', async (c) => {
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
        const parsed = setModelModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        await engine.setModelMode(sessionId, parsed.data.modelMode as any)
        return c.json({ ok: true })
    })

    // ==================== Project CRUD ====================

    const addProjectSchema = z.object({
        name: z.string().min(1).max(100),
        path: z.string().min(1).max(500),
        description: z.string().max(500).optional(),
        machineId: z.string().nullable().optional()
    })

    const updateProjectSchema = z.object({
        name: z.string().min(1).max(100),
        path: z.string().min(1).max(500),
        description: z.string().max(500).optional(),
        machineId: z.string().nullable().optional()
    })

    // Helper: resolve orgId from sessionId
    async function resolveOrgId(sessionId: string | undefined): Promise<string | null> {
        if (!sessionId || !store) return null
        const session = await store.getSession(sessionId)
        return session?.orgId ?? null
    }

    // List org-shared projects (query: machineId, sessionId). machineId is accepted for compatibility only.
    app.get('/projects', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const sessionId = c.req.query('sessionId')
        const orgId = await resolveOrgId(sessionId)
        const projects = await store.getProjects(undefined, orgId)
        return c.json({ projects })
    })

    // Create org-shared project (query: sessionId, body: name, path, description?, machineId?)
    app.post('/projects', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const json = await c.req.json().catch(() => null)
        const parsed = addProjectSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid project data' }, 400)

        const sessionId = c.req.query('sessionId')
        const orgId = await resolveOrgId(sessionId)
        const project = await store.addProject(
            parsed.data.name,
            parsed.data.path,
            parsed.data.description,
            parsed.data.machineId,
            orgId
        )
        if (!project) return c.json({ error: 'Failed to add project. Path may already exist.' }, 400)

        const projects = await store.getProjects(undefined, orgId)
        return c.json({ ok: true, project, projects })
    })

    // Update org-shared project (param: id, query: sessionId, body: name, path, description?, machineId?)
    app.put('/projects/:id', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const id = c.req.param('id')
        const json = await c.req.json().catch(() => null)
        const parsed = updateProjectSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid project data' }, 400)
        const sessionId = c.req.query('sessionId')
        const orgId = await resolveOrgId(sessionId)

        const project = await store.updateProject(
            id,
            parsed.data.name,
            parsed.data.path,
            parsed.data.description,
            parsed.data.machineId,
            orgId
        )
        if (!project) return c.json({ error: 'Project not found or path already exists' }, 404)

        const projects = await store.getProjects(undefined, orgId)
        return c.json({ ok: true, project, projects })
    })

    // Delete project (param: id, query: sessionId)
    app.delete('/projects/:id', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const id = c.req.param('id')
        const success = await store.removeProject(id)
        if (!success) return c.json({ error: 'Project not found' }, 404)

        const sessionId = c.req.query('sessionId')
        const orgId = await resolveOrgId(sessionId)
        const projects = await store.getProjects(undefined, orgId)
        return c.json({ ok: true, projects })
    })

    // Brain: get session status with token stats
    app.get('/sessions/:id/status', async (c) => {
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

        const session = resolved.session
        const messageCount = await engine.getMessageCount(sessionId)
        const lastUsage = await engine.getLastUsageForSession(sessionId)

        return c.json({
            active: session.active,
            thinking: session.thinking ?? false,
            messageCount,
            lastUsage,
            modelMode: session.modelMode ?? 'default',
            metadata: session.metadata ? {
                path: session.metadata.path,
                summary: session.metadata.summary,
                brainSummary: (session.metadata as any).brainSummary,
            } : null,
        })
    })

    return app
}
