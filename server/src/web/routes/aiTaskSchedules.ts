import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore } from '../../store'
import { PostgresStore } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import {
    aiTaskScheduleCreateSchema,
    parseCronOrDelay,
    serializeAiTaskScheduleRow,
} from './aiTaskScheduleShared'

type RouteContext = Context<WebAppEnv>

const patchScheduleSchema = z.object({
    label: z.string().max(200).nullable().optional(),
    prompt: z.string().min(1).max(4000).optional(),
    systemPrompt: z.string().max(8000).nullable().optional(),
    tags: z.array(z.string().max(64)).max(20).nullable().optional(),
    permissionMode: z.string().max(64).nullable().optional(),
    enabled: z.boolean().optional(),
})

const listQuerySchema = z.object({
    machineId: z.string().min(1).optional(),
    includeDisabled: z.boolean().optional(),
    mine: z.boolean().optional(),
    tag: z.string().max(64).optional(),
})

function parseBoolQuery(value: string | undefined): boolean | undefined {
    if (value == null) return undefined
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    return undefined
}

function orgIdsFor(c: RouteContext): string[] {
    const orgs = (c.get('orgs') ?? []) as Array<{ id: string }>
    return orgs.map(o => o.id)
}

export function createAiTaskSchedulesRoutes(
    getSyncEngine: () => SyncEngine | null,
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/ai-task-schedules', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const body = await c.req.json().catch(() => null)
        const parsed = aiTaskScheduleCreateSchema.extend({
            machineId: z.string().min(1),
            createdBySessionId: z.string().min(1).optional(),
        }).safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400)

        const {
            cronOrDelay, prompt, directory, recurring,
            label, agent, mode,
            systemPrompt, tags, permissionMode,
            machineId, createdBySessionId,
        } = parsed.data

        const cronResult = parseCronOrDelay(cronOrDelay)
        if (!cronResult.ok) return c.json({ error: cronResult.error }, 400)
        if (cronResult.kind === 'delay' && recurring) {
            return c.json({ error: 'delay_requires_non_recurring' }, 400)
        }

        const projects = await store.getProjects(machineId)
        const project = projects.find(p => p.path === directory)
        if (!project) return c.json({ error: 'directory_not_registered' }, 400)

        const engine = getSyncEngine()
        let orgId: string | null = null
        if (engine) {
            const machine = engine.getMachines().find(m => m.id === machineId)
            if (machine) orgId = machine.orgId ?? null
        }
        if (!orgId) {
            const storedMachine = await store.getMachine(machineId).catch(() => null)
            if (storedMachine) orgId = storedMachine.orgId ?? null
        }
        if (!orgId) return c.json({ error: 'org_not_resolved' }, 400)

        const callerOrgIds = orgIdsFor(c)
        if (!callerOrgIds.includes(orgId)) {
            return c.json({ error: 'forbidden_org' }, 403)
        }

        const pool = (store as PostgresStore).getPool()
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM ai_task_schedules WHERE machine_id = $1 AND enabled = true',
            [machineId]
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
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
                id, orgId, machineId, label ?? null,
                cronResult.normalizedCron, prompt, directory, agent, mode ?? null,
                recurring, true, now, cronResult.nextFireAt ?? null,
                createdBySessionId ?? null,
                systemPrompt ?? null, tags ?? null, email, permissionMode ?? null,
            ]
        )

        const row = await pool.query('SELECT * FROM ai_task_schedules WHERE id = $1', [id])
        return c.json({ schedule: serializeAiTaskScheduleRow(row.rows[0]) }, 201)
    })

    app.get('/ai-task-schedules', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const q = c.req.query()
        const parsed = listQuerySchema.safeParse({
            machineId: q.machineId,
            includeDisabled: parseBoolQuery(q.includeDisabled),
            mine: parseBoolQuery(q.mine),
            tag: q.tag,
        })
        if (!parsed.success) return c.json({ error: 'invalid_query' }, 400)

        const callerOrgIds = orgIdsFor(c)
        if (callerOrgIds.length === 0) return c.json({ schedules: [] })

        const conditions: string[] = ['namespace = ANY($1)']
        const params: unknown[] = [callerOrgIds]

        if (parsed.data.machineId) {
            params.push(parsed.data.machineId)
            conditions.push(`machine_id = $${params.length}`)
        }
        if (!parsed.data.includeDisabled) {
            conditions.push('enabled = true')
        }
        if (parsed.data.mine) {
            params.push(email)
            conditions.push(`owner_email = $${params.length}`)
        }
        if (parsed.data.tag) {
            params.push(parsed.data.tag)
            conditions.push(`$${params.length} = ANY(tags)`)
        }

        const pool = (store as PostgresStore).getPool()
        const result = await pool.query(
            `SELECT * FROM ai_task_schedules WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
            params
        )
        const schedules = (result.rows as Record<string, unknown>[]).map(serializeAiTaskScheduleRow)
        return c.json({ schedules })
    })

    app.get('/ai-task-schedules/:id', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const id = c.req.param('id')
        const callerOrgIds = orgIdsFor(c)
        if (callerOrgIds.length === 0) return c.json({ error: 'not_found' }, 404)

        const pool = (store as PostgresStore).getPool()
        const scheduleRes = await pool.query(
            `SELECT * FROM ai_task_schedules WHERE id = $1 AND namespace = ANY($2) LIMIT 1`,
            [id, callerOrgIds]
        )
        const row = scheduleRes.rows[0] as Record<string, unknown> | undefined
        if (!row) return c.json({ error: 'not_found' }, 404)

        const runsRes = await pool.query(
            `SELECT id, schedule_id, session_id, subsession_id, machine_id, status, started_at, finished_at, error
             FROM ai_task_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT 20`,
            [id]
        )

        return c.json({
            schedule: serializeAiTaskScheduleRow(row),
            runs: runsRes.rows.map((r: Record<string, unknown>) => ({
                runId: String(r.id),
                scheduleId: r.schedule_id != null ? String(r.schedule_id) : null,
                sessionId: r.session_id != null ? String(r.session_id) : null,
                subsessionId: r.subsession_id != null ? String(r.subsession_id) : null,
                machineId: String(r.machine_id),
                status: String(r.status),
                startedAt: r.started_at != null ? new Date(Number(r.started_at)).toISOString() : null,
                finishedAt: r.finished_at != null ? new Date(Number(r.finished_at)).toISOString() : null,
                error: r.error != null ? String(r.error) : null,
            })),
        })
    })

    async function canMutate(
        c: RouteContext,
        scheduleRow: Record<string, unknown>
    ): Promise<boolean> {
        const email = c.get('email')
        if (!email) return false
        const orgId = String(scheduleRow.namespace)
        const callerOrgs = (c.get('orgs') ?? []) as Array<{ id: string; role: string }>
        const myOrg = callerOrgs.find(o => o.id === orgId)
        if (!myOrg) return false
        if (String(scheduleRow.owner_email ?? '') === email) return true
        return ['owner', 'admin'].includes(myOrg.role)
    }

    app.patch('/ai-task-schedules/:id', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const id = c.req.param('id')
        const pool = (store as PostgresStore).getPool()
        const existing = await pool.query('SELECT * FROM ai_task_schedules WHERE id = $1 LIMIT 1', [id])
        const row = existing.rows[0] as Record<string, unknown> | undefined
        if (!row) return c.json({ error: 'not_found' }, 404)
        if (!(await canMutate(c, row))) return c.json({ error: 'forbidden' }, 403)

        const body = await c.req.json().catch(() => null)
        const parsed = patchScheduleSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        if (Object.keys(parsed.data).length === 0) {
            return c.json({ error: 'empty_patch' }, 400)
        }

        const setClauses: string[] = []
        const params: unknown[] = []
        for (const [k, v] of Object.entries(parsed.data)) {
            if (v === undefined) continue
            const column = k === 'prompt' ? 'payload_prompt'
                : k === 'systemPrompt' ? 'system_prompt'
                : k === 'permissionMode' ? 'permission_mode'
                : k
            params.push(v)
            setClauses.push(`${column} = $${params.length}`)
        }
        params.push(id)
        await pool.query(
            `UPDATE ai_task_schedules SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
            params
        )
        const updated = await pool.query('SELECT * FROM ai_task_schedules WHERE id = $1', [id])
        return c.json({ schedule: serializeAiTaskScheduleRow(updated.rows[0]) })
    })

    app.delete('/ai-task-schedules/:id', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const id = c.req.param('id')
        const pool = (store as PostgresStore).getPool()
        const existing = await pool.query('SELECT * FROM ai_task_schedules WHERE id = $1 LIMIT 1', [id])
        const row = existing.rows[0] as Record<string, unknown> | undefined
        if (!row) return c.json({ error: 'not_found' }, 404)
        if (!(await canMutate(c, row))) return c.json({ error: 'forbidden' }, 403)

        await pool.query('UPDATE ai_task_schedules SET enabled = false WHERE id = $1', [id])
        return c.json({ ok: true })
    })

    return app
}
