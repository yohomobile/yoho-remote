import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import { PostgresStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import {
    aiTaskScheduleCreateWithMachineSchema as scheduleTaskSchema,
    parseCronOrDelay,
    serializeAiTaskScheduleRow,
} from './aiTaskScheduleShared'

const findOrCreateSchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex']),
    machineId: z.string().optional(),
    modelMode: z.string().optional(),
    codexModel: z.string().optional(),
    permissionMode: z.string().optional(),
    mainSessionId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    callbackOnFailureOnly: z.boolean().optional(),
    scheduleId: z.string().min(1).optional(),
    label: z.string().max(200).optional(),
    automationSystemPrompt: z.string().max(8000).optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
    ownerEmail: z.string().email().optional(),
})

const listSchedulesInternalSchema = z.object({
    machineId: z.string().min(1),
    includeDisabled: z.boolean().optional(),
})

const cancelScheduleInternalSchema = z.object({
    scheduleId: z.string().min(1),
    machineId: z.string().min(1),
})

const sessionSendSchema = z.object({
    sessionId: z.string().min(1),
    message: z.string().min(1),
    localId: z.string().min(1).optional(),
    appendSystemPrompt: z.string().max(8000).optional(),
})

const sessionIdSchema = z.object({
    sessionId: z.string().min(1),
})

type MessageLocalIdLookupStore = {
    getMessageByLocalId?: (sessionId: string, localId: string) => Promise<unknown | null>
}

async function hasPersistedMessageLocalId(
    store: IStore,
    sessionId: string,
    localId: string,
): Promise<boolean> {
    const lookup = (store as MessageLocalIdLookupStore).getMessageByLocalId
    if (!lookup) return false
    const message = await lookup.call(store, sessionId, localId)
    return message != null
}

export function createWorkerMcpRoutes(
    getSyncEngine: () => SyncEngine | null,
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/worker/schedule-task', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = scheduleTaskSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const {
            cronOrDelay,
            prompt,
            directory,
            recurring,
            label,
            agent,
            mode,
            machineId,
            createdBySessionId,
            systemPrompt,
            tags,
            ownerEmail,
            permissionMode,
        } = parsed.data

        const cronResult = parseCronOrDelay(cronOrDelay)
        if (!cronResult.ok) return c.json({ error: cronResult.error }, 400)
        if (cronResult.kind === 'delay' && recurring) {
            return c.json({ error: 'delay_requires_non_recurring' }, 400)
        }

        // Validate directory is a registered project
        const projects = await store.getProjects(machineId ?? null)
        const project = projects.find(p => p.path === directory)
        if (!project) return c.json({ error: 'directory_not_registered' }, 400)

        // Resolve machine & orgId from engine (online) or store (offline).
        // The namespace column semantically stores orgId.
        const engine = getSyncEngine()
        const resolvedMachineId = machineId ?? project.machineId ?? ''
        if (!resolvedMachineId) return c.json({ error: 'machine_not_resolved' }, 400)

        let orgId: string | null = null
        if (engine) {
            const machine = engine.getMachines().find(m => m.id === resolvedMachineId)
            if (machine) orgId = machine.orgId ?? null
        }
        if (!orgId) {
            const storedMachine = await store.getMachine(resolvedMachineId).catch(() => null)
            if (storedMachine) orgId = storedMachine.orgId ?? null
        }
        if (!orgId) return c.json({ error: 'org_not_resolved' }, 400)

        // Enforce quota: max 20 enabled schedules per machine
        const pool = (store as PostgresStore).getPool()
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM ai_task_schedules WHERE machine_id = $1 AND enabled = true',
            [resolvedMachineId]
        )
        if (parseInt(countResult.rows[0].count) >= 20) {
            return c.json({ error: 'quota_exceeded' }, 429)
        }

        const id = randomUUID()
        const now = Date.now()
        await pool.query(
            `INSERT INTO ai_task_schedules
                (id, namespace, machine_id, label, cron_expr, payload_prompt, directory, agent, mode, recurring, enabled, created_at, next_fire_at, created_by_session_id,
                 system_prompt, tags, owner_email, permission_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
            [
                id, orgId, resolvedMachineId, label ?? null,
                cronResult.normalizedCron, prompt, directory, agent, mode ?? null,
                recurring, true, now, cronResult.nextFireAt ?? null,
                createdBySessionId ?? null,
                systemPrompt ?? null, tags ?? null, ownerEmail ?? null, permissionMode ?? null,
            ]
        )

        return c.json({
            scheduleId: id,
            nextFireAt: cronResult.nextFireAt ? new Date(cronResult.nextFireAt).toISOString() : null,
            status: 'registered',
        })
    })

    app.post('/worker/list-schedules', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = listSchedulesInternalSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const pool = (store as PostgresStore).getPool()
        const conditions: string[] = ['machine_id = $1']
        const params: unknown[] = [parsed.data.machineId]
        if (!parsed.data.includeDisabled) {
            conditions.push('enabled = true')
        }

        const where = `WHERE ${conditions.join(' AND ')}`
        const result = await pool.query(
            `SELECT id, machine_id, label, cron_expr, payload_prompt, recurring, directory, agent, mode, enabled, created_at, next_fire_at, last_fire_at, last_run_status,
                    system_prompt, tags, owner_email, permission_mode, created_by_session_id
             FROM ai_task_schedules ${where} ORDER BY created_at DESC`,
            params
        )

        const schedules = (result.rows as Record<string, unknown>[]).map(serializeAiTaskScheduleRow)

        return c.json({ schedules })
    })

    app.post('/worker/cancel-schedule', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = cancelScheduleInternalSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const pool = (store as PostgresStore).getPool()
        const result = await pool.query(
            'UPDATE ai_task_schedules SET enabled = false WHERE id = $1 AND machine_id = $2 RETURNING id',
            [parsed.data.scheduleId, parsed.data.machineId]
        )
        if (result.rows.length === 0) return c.json({ error: 'schedule_not_found' }, 404)
        return c.json({ ok: true })
    })

    app.post('/session/find-or-create', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = findOrCreateSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const {
            directory,
            agent,
            machineId,
            modelMode,
            codexModel,
            permissionMode,
            mainSessionId,
            source,
            callbackOnFailureOnly,
            scheduleId,
            label,
            automationSystemPrompt,
            tags,
            ownerEmail,
        } = parsed.data

        const machines = engine.getMachines()
        const machine = machineId
            ? machines.find(m => m.id === machineId)
            : machines.find(m => m.active)

        if (!machine) return c.json({ error: 'machine_not_found' }, 404)
        if (!machine.orgId) return c.json({ error: 'org_not_resolved' }, 400)

        // Resolve the session source — fall back to a neutral worker-task tag so legacy
        // callers (no mainSessionId) keep the previous behaviour. Only orchestrator-child
        // sessions get the creator-session link wired up.
        const resolvedSource = source ?? (mainSessionId ? 'orchestrator-child' : 'worker-ai-task')

        // Look for an existing active session on this machine with matching directory and agent.
        // Scope by orgId — namespace is kept only for backwards-compat on older rows.
        // Always filter by source so worker sessions never accidentally reuse a user's
        // interactive session (e.g. webapp/cli). When mainSessionId is provided, also
        // require the candidate to be attached to the same creator session.
        const sessions = engine.getSessionsByOrg(machine.orgId)
        const existing = sessions.find(s => {
            if (!s.active) return false
            if (s.metadata?.machineId !== machine.id) return false
            if (s.metadata?.path !== directory) return false
            if ((s.metadata?.runtimeAgent ?? 'claude') !== agent) return false
            const meta = s.metadata as Record<string, unknown> | null
            if (meta?.source !== resolvedSource) return false
            if (mainSessionId) {
                if (meta?.mainSessionId !== mainSessionId) return false
            }
            return true
        })
        const automationMetadataPatch: Record<string, unknown> = {}
        if (scheduleId) automationMetadataPatch.scheduleId = scheduleId
        if (label) automationMetadataPatch.label = label
        if (automationSystemPrompt) automationMetadataPatch.automationSystemPrompt = automationSystemPrompt
        if (tags && tags.length > 0) automationMetadataPatch.tags = tags
        if (ownerEmail) automationMetadataPatch.ownerEmail = ownerEmail

        async function applyMetadataPatch(sessionId: string, patch: Record<string, unknown>) {
            if (Object.keys(patch).length === 0) return
            await store.patchSessionMetadata(sessionId, patch, machine!.orgId!).catch((error: unknown) => {
                console.warn(`[worker-mcp] Failed to patch session metadata on ${sessionId}:`, error)
            })
            const sess = engine!.getSession(sessionId)
            if (sess) {
                const meta = (sess.metadata as Record<string, unknown> | null) ?? {}
                sess.metadata = { ...meta, ...patch } as unknown as typeof sess.metadata
            }
        }

        if (existing) {
            // Keep the suppression flag + automation fields in sync for reused sessions;
            // recurring schedules may toggle these independently of whether the session
            // needed spawning.
            const patch: Record<string, unknown> = { ...automationMetadataPatch }
            if (callbackOnFailureOnly !== undefined) {
                patch.callbackOnFailureOnly = callbackOnFailureOnly
            }
            await applyMetadataPatch(existing.id, patch)
            return c.json({ sessionId: existing.id })
        }

        const spawnResult = await engine.spawnSession(machine.id, directory, agent, false, {
            permissionMode: (permissionMode ?? 'safe-yolo') as Session['permissionMode'],
            modelMode: modelMode as Session['modelMode'] | undefined,
            codexModel: codexModel ?? undefined,
            source: resolvedSource,
            mainSessionId,
        })
        if (spawnResult.type === 'error') return c.json({ error: spawnResult.message }, 502)

        // Persist callbackOnFailureOnly + automation fields after spawn completes so the
        // syncEngine sees them before the first task-complete event for the new session.
        const spawnPatch: Record<string, unknown> = { ...automationMetadataPatch }
        if (callbackOnFailureOnly !== undefined) {
            spawnPatch.callbackOnFailureOnly = callbackOnFailureOnly
        }
        await applyMetadataPatch(spawnResult.sessionId, spawnPatch)

        return c.json({ sessionId: spawnResult.sessionId })
    })

    app.post('/session/trigger-callback', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = sessionIdSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const result = await engine.triggerChildCallback(parsed.data.sessionId)
        if (!result.ok) {
            const status = result.reason === 'session_not_found' ? 404 : 400
            return c.json({ error: result.reason }, status)
        }
        return c.json({ ok: true })
    })

    app.post('/session/send', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = sessionSendSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const session = engine.getSession(parsed.data.sessionId)
        if (!session) return c.json({ error: 'session_not_found' }, 404)

        const requestLocalId = parsed.data.localId ?? randomUUID()
        const duplicateOutcome = engine.getSendOutcomeForCachedLocalId(
            parsed.data.sessionId,
            requestLocalId,
        )
        if (duplicateOutcome) {
            return c.json({ ok: true, deduped: true, status: duplicateOutcome.status })
        }
        if (await hasPersistedMessageLocalId(store, parsed.data.sessionId, requestLocalId)) {
            return c.json({ ok: true, deduped: true, status: 'delivered' })
        }

        const sendMeta: Record<string, unknown> = {}
        if (parsed.data.appendSystemPrompt) {
            sendMeta.appendSystemPrompt = parsed.data.appendSystemPrompt
        }

        await engine.sendMessage(parsed.data.sessionId, {
            text: parsed.data.message,
            localId: requestLocalId,
            sentFrom: 'worker-ai-task',
            meta: Object.keys(sendMeta).length > 0 ? sendMeta : undefined,
        })
        return c.json({ ok: true })
    })

    app.post('/session/status', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = sessionIdSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const session = engine.getSession(parsed.data.sessionId)
        if (!session) return c.json({ error: 'session_not_found' }, 404)

        return c.json({
            status: session.active ? 'active' : 'inactive',
            executing: session.thinking ?? false,
        })
    })

    app.post('/session/stop', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = sessionIdSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const session = engine.getSession(parsed.data.sessionId)
        if (!session) return c.json({ error: 'session_not_found' }, 404)

        await engine.terminateSessionProcess(parsed.data.sessionId)
        return c.json({ ok: true })
    })

    return app
}
