import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { parseExpression } from 'cron-parser'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import { PostgresStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

// Returns next fire timestamp (ms) for a 5-field cron, or null on failure.
function cronNextFireAt(expr: string): number | null {
    try {
        return parseExpression(expr, { tz: 'UTC' }).next().toDate().getTime()
    } catch {
        return null
    }
}

// Parses ISO 8601 duration like "PT30M", "PT1H30M" into milliseconds.
function parseIso8601DurationMs(value: string): number | null {
    const m = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
    if (!m) return null
    const ms = (parseInt(m[1] ?? '0') * 86400
        + parseInt(m[2] ?? '0') * 3600
        + parseInt(m[3] ?? '0') * 60
        + parseInt(m[4] ?? '0')) * 1000
    return ms > 0 ? ms : null
}

type ParsedCron =
    | { ok: true; normalizedCron: string; nextFireAt: number | null }
    | { ok: false; error: string }

function parseCronOrDelay(value: string): ParsedCron {
    if (value.startsWith('P')) {
        const ms = parseIso8601DurationMs(value)
        if (ms === null) return { ok: false, error: 'invalid_iso8601_duration' }
        return { ok: true, normalizedCron: `+${ms}`, nextFireAt: Date.now() + ms }
    }
    const next = cronNextFireAt(value)
    if (next === null) return { ok: false, error: 'invalid_cron' }
    return { ok: true, normalizedCron: value, nextFireAt: next }
}

const scheduleTaskSchema = z.object({
    cronOrDelay: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    directory: z.string().min(1),
    recurring: z.boolean(),
    label: z.string().optional(),
    agent: z.enum(['claude', 'codex']),
    mode: z.string().optional(),
    machineId: z.string().optional(),
})

const listSchedulesSchema = z.object({
    includeDisabled: z.boolean().optional(),
    machineId: z.string().optional(),
})

const cancelScheduleSchema = z.object({
    scheduleId: z.string().min(1),
})

const findOrCreateSchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex']),
    machineId: z.string().optional(),
    modelMode: z.string().optional(),
    codexModel: z.string().optional(),
    permissionMode: z.string().optional(),
})

const sessionSendSchema = z.object({
    sessionId: z.string().min(1),
    message: z.string().min(1),
})

const sessionIdSchema = z.object({
    sessionId: z.string().min(1),
})

export function createWorkerMcpRoutes(
    getSyncEngine: () => SyncEngine | null,
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/worker/schedule-task', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = scheduleTaskSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const { cronOrDelay, prompt, directory, recurring, label, agent, mode, machineId } = parsed.data

        const cronResult = parseCronOrDelay(cronOrDelay)
        if (!cronResult.ok) return c.json({ error: cronResult.error }, 400)

        // Validate directory is a registered project
        const projects = await store.getProjects(machineId ?? null)
        const project = projects.find(p => p.path === directory)
        if (!project) return c.json({ error: 'directory_not_registered' }, 400)

        // Resolve namespace from engine (online machine) or store (offline)
        const engine = getSyncEngine()
        const resolvedMachineId = machineId ?? project.machineId ?? ''
        let namespace = 'default'
        if (engine) {
            const machine = engine.getMachines().find(m => m.id === resolvedMachineId)
            if (machine) namespace = machine.namespace
        }
        if (namespace === 'default' && resolvedMachineId) {
            const storedMachine = await store.getMachine(resolvedMachineId).catch(() => null)
            if (storedMachine) namespace = storedMachine.namespace
        }

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
                (id, namespace, machine_id, label, cron_expr, payload_prompt, directory, agent, mode, recurring, enabled, created_at, next_fire_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
                id, namespace, resolvedMachineId, label ?? null,
                cronResult.normalizedCron, prompt, directory, agent, mode ?? null,
                recurring, true, now, cronResult.nextFireAt ?? null,
            ]
        )

        return c.json({
            scheduleId: id,
            nextFireAt: cronResult.nextFireAt ? new Date(cronResult.nextFireAt).toISOString() : null,
            status: 'registered',
        })
    })

    app.post('/worker/list-schedules', async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const parsed = listSchedulesSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const pool = (store as PostgresStore).getPool()
        const conditions: string[] = []
        const params: unknown[] = []
        let idx = 1

        if (!parsed.data.includeDisabled) {
            conditions.push('enabled = true')
        }
        if (parsed.data.machineId) {
            conditions.push(`machine_id = $${idx++}`)
            params.push(parsed.data.machineId)
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
        const result = await pool.query(
            `SELECT id, label, cron_expr, recurring, directory, agent, enabled, created_at, next_fire_at, last_fire_at, last_run_status
             FROM ai_task_schedules ${where} ORDER BY created_at DESC`,
            params
        )

        const schedules = result.rows.map(row => ({
            scheduleId: row.id as string,
            label: row.label as string | null,
            cron: row.cron_expr as string,
            recurring: row.recurring as boolean,
            directory: row.directory as string,
            agent: row.agent as string,
            enabled: row.enabled as boolean,
            createdAt: new Date(Number(row.created_at)).toISOString(),
            nextFireAt: row.next_fire_at ? new Date(Number(row.next_fire_at)).toISOString() : null,
            lastRunAt: row.last_fire_at ? new Date(Number(row.last_fire_at)).toISOString() : null,
            lastRunStatus: row.last_run_status as string | null,
        }))

        return c.json({ schedules })
    })

    app.post('/worker/cancel-schedule', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = cancelScheduleSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const pool = (store as PostgresStore).getPool()
        const result = await pool.query(
            'UPDATE ai_task_schedules SET enabled = false WHERE id = $1 RETURNING id, enabled',
            [parsed.data.scheduleId]
        )
        if (result.rows.length === 0) return c.json({ error: 'schedule_not_found' }, 404)
        if (!result.rows[0].enabled) {
            // already disabled before our update — still ok, idempotent
        }
        return c.json({ ok: true })
    })

    app.post('/session/find-or-create', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = findOrCreateSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const { directory, agent, machineId, modelMode, codexModel, permissionMode } = parsed.data

        const machines = engine.getMachines()
        const machine = machineId
            ? machines.find(m => m.id === machineId)
            : machines.find(m => m.active)

        if (!machine) return c.json({ error: 'machine_not_found' }, 404)

        // Look for an existing active session on this machine with matching directory and agent
        const sessions = engine.getSessionsByNamespace(machine.namespace)
        const existing = sessions.find(s =>
            s.active &&
            s.metadata?.machineId === machine.id &&
            s.metadata?.path === directory &&
            (s.metadata?.runtimeAgent ?? 'claude') === agent
        )
        if (existing) return c.json({ sessionId: existing.id })

        const spawnResult = await engine.spawnSession(machine.id, directory, agent, false, {
            permissionMode: (permissionMode ?? 'safe-yolo') as Session['permissionMode'],
            modelMode: modelMode as Session['modelMode'] | undefined,
            codexModel: codexModel ?? undefined,
            source: 'worker-ai-task',
        })
        if (spawnResult.type === 'error') return c.json({ error: spawnResult.message }, 502)
        return c.json({ sessionId: spawnResult.sessionId })
    })

    app.post('/session/send', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'not_connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = sessionSendSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

        const session = engine.getSession(parsed.data.sessionId)
        if (!session) return c.json({ error: 'session_not_found' }, 404)

        await engine.sendMessage(parsed.data.sessionId, {
            text: parsed.data.message,
            localId: randomUUID(),
            sentFrom: 'worker-ai-task',
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
