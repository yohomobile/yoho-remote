import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export type AiTaskRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'deduped'

export type AiTaskSchedule = {
    id: string
    namespace: string
    machineId: string
    label: string | null
    cron: string
    prompt: string
    directory: string
    agent: string
    mode: string | null
    model: string | null
    recurring: boolean
    enabled: boolean
    createdAt: number
    createdBySessionId: string | null
    lastFireAt: number | null
    nextFireAt: number | null
    lastRunStatus: string | null
    consecutiveFailures: number
}

export type AiTaskRun = {
    id: string
    scheduleId: string | null
    sessionId: string | null
    subsessionId: string | null
    machineId: string
    namespace: string
    status: AiTaskRunStatus
    startedAt: number
    finishedAt: number | null
    error: string | null
    metadata: Record<string, unknown> | null
}

export type CreateScheduleInput = {
    namespace: string
    machineId: string
    label?: string | null
    cron: string
    prompt: string
    directory: string
    agent: string
    mode?: string | null
    model?: string | null
    recurring: boolean
    createdBySessionId?: string | null
    nextFireAt?: number | null
}

export type InsertRunInput = {
    id?: string
    scheduleId?: string | null
    machineId: string
    namespace: string
    status?: AiTaskRunStatus
    startedAt?: number
    metadata?: Record<string, unknown> | null
}

export type UpdateRunResultInput = {
    status: AiTaskRunStatus
    finishedAt: number
    subsessionId?: string | null
    error?: string | null
}

export type AiTaskRunMetadataPatch = Record<string, unknown>

function rowToSchedule(row: Record<string, unknown>): AiTaskSchedule {
    return {
        id: String(row.id),
        namespace: String(row.namespace),
        machineId: String(row.machine_id),
        label: row.label != null ? String(row.label) : null,
        cron: String(row.cron_expr),
        prompt: String(row.payload_prompt),
        directory: String(row.directory),
        agent: String(row.agent),
        mode: row.mode != null ? String(row.mode) : null,
        model: row.model != null ? String(row.model) : null,
        recurring: Boolean(row.recurring),
        enabled: Boolean(row.enabled),
        createdAt: Number(row.created_at),
        createdBySessionId: row.created_by_session_id != null ? String(row.created_by_session_id) : null,
        lastFireAt: row.last_fire_at != null ? Number(row.last_fire_at) : null,
        nextFireAt: row.next_fire_at != null ? Number(row.next_fire_at) : null,
        lastRunStatus: row.last_run_status != null ? String(row.last_run_status) : null,
        consecutiveFailures: Number(row.consecutive_failures ?? 0),
    }
}

function rowToRun(row: Record<string, unknown>): AiTaskRun {
    return {
        id: String(row.id),
        scheduleId: row.schedule_id != null ? String(row.schedule_id) : null,
        sessionId: row.session_id != null ? String(row.session_id) : null,
        subsessionId: row.subsession_id != null ? String(row.subsession_id) : null,
        machineId: String(row.machine_id),
        namespace: String(row.namespace),
        status: row.status as AiTaskRunStatus,
        startedAt: Number(row.started_at),
        finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
        error: row.error != null ? String(row.error) : null,
        metadata: row.metadata != null ? (row.metadata as Record<string, unknown>) : null,
    }
}

export class AiTaskStore {
    constructor(private readonly pool: Pool) {}

    async listEnabledSchedules(machineId?: string): Promise<AiTaskSchedule[]> {
        if (machineId != null) {
            const result = await this.pool.query(
                `SELECT * FROM ai_task_schedules WHERE machine_id = $1 AND enabled = TRUE ORDER BY created_at ASC`,
                [machineId]
            )
            return (result.rows as Record<string, unknown>[]).map(rowToSchedule)
        }
        const result = await this.pool.query(
            `SELECT * FROM ai_task_schedules WHERE enabled = TRUE ORDER BY created_at ASC`
        )
        return (result.rows as Record<string, unknown>[]).map(rowToSchedule)
    }

    async getSchedule(id: string): Promise<AiTaskSchedule | null> {
        const result = await this.pool.query(
            `SELECT * FROM ai_task_schedules WHERE id = $1 LIMIT 1`,
            [id]
        )
        const row = result.rows[0] as Record<string, unknown> | undefined
        return row ? rowToSchedule(row) : null
    }

    async createSchedule(input: CreateScheduleInput): Promise<AiTaskSchedule> {
        const id = randomUUID()
        const now = Date.now()
        const result = await this.pool.query(
            `INSERT INTO ai_task_schedules (
                id, namespace, machine_id, label, cron_expr, payload_prompt,
                directory, agent, mode, model, recurring, enabled,
                created_at, created_by_session_id, next_fire_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            RETURNING *`,
            [
                id,
                input.namespace,
                input.machineId,
                input.label ?? null,
                input.cron,
                input.prompt,
                input.directory,
                input.agent,
                input.mode ?? null,
                input.model ?? null,
                input.recurring,
                true,
                now,
                input.createdBySessionId ?? null,
                input.nextFireAt ?? null,
            ]
        )
        return rowToSchedule(result.rows[0] as Record<string, unknown>)
    }

    async updateScheduleNextFireAt(
        id: string,
        nextFireAt: number | null,
        lastFireAt?: number
    ): Promise<void> {
        if (lastFireAt != null) {
            await this.pool.query(
                `UPDATE ai_task_schedules SET next_fire_at = $1, last_fire_at = $2 WHERE id = $3`,
                [nextFireAt, lastFireAt, id]
            )
        } else {
            await this.pool.query(
                `UPDATE ai_task_schedules SET next_fire_at = $1 WHERE id = $2`,
                [nextFireAt, id]
            )
        }
    }

    async updateScheduleRunResult(
        id: string,
        status: string,
        consecutiveFailures: number
    ): Promise<void> {
        await this.pool.query(
            `UPDATE ai_task_schedules
             SET last_run_status = $1, consecutive_failures = $2
             WHERE id = $3`,
            [status, consecutiveFailures, id]
        )
    }

    async disableSchedule(id: string, lastFireAt?: number): Promise<void> {
        if (lastFireAt != null) {
            await this.pool.query(
                `UPDATE ai_task_schedules SET enabled = FALSE, last_fire_at = $1 WHERE id = $2`,
                [lastFireAt, id]
            )
            return
        }
        await this.pool.query(
            `UPDATE ai_task_schedules SET enabled = FALSE WHERE id = $1`,
            [id]
        )
    }

    async insertRun(input: InsertRunInput): Promise<AiTaskRun> {
        const id = input.id ?? randomUUID()
        const startedAt = input.startedAt ?? Date.now()
        const status = input.status ?? 'pending'
        const result = await this.pool.query(
            `INSERT INTO ai_task_runs (
                id, schedule_id, machine_id, namespace, status, started_at, metadata
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *`,
            [
                id,
                input.scheduleId ?? null,
                input.machineId,
                input.namespace,
                status,
                startedAt,
                input.metadata ? JSON.stringify(input.metadata) : null,
            ]
        )
        return rowToRun(result.rows[0] as Record<string, unknown>)
    }

    async getRun(id: string): Promise<AiTaskRun | null> {
        const result = await this.pool.query(
            `SELECT * FROM ai_task_runs WHERE id = $1 LIMIT 1`,
            [id]
        )
        const row = result.rows[0] as Record<string, unknown> | undefined
        return row ? rowToRun(row) : null
    }

    async updateRunSession(
        id: string,
        sessionId: string,
        metadataPatch: AiTaskRunMetadataPatch = {}
    ): Promise<void> {
        await this.pool.query(
            `UPDATE ai_task_runs
             SET subsession_id = $1,
                 metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
             WHERE id = $3`,
            [sessionId, JSON.stringify(metadataPatch), id]
        )
    }

    async mergeRunMetadata(
        id: string,
        metadataPatch: AiTaskRunMetadataPatch
    ): Promise<void> {
        await this.pool.query(
            `UPDATE ai_task_runs
             SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
             WHERE id = $2`,
            [JSON.stringify(metadataPatch), id]
        )
    }

    async updateRunStatus(
        id: string,
        status: AiTaskRunStatus,
        startedAt?: number
    ): Promise<void> {
        if (startedAt != null) {
            await this.pool.query(
                `UPDATE ai_task_runs SET status = $1, started_at = $2 WHERE id = $3`,
                [status, startedAt, id]
            )
        } else {
            await this.pool.query(
                `UPDATE ai_task_runs SET status = $1 WHERE id = $2`,
                [status, id]
            )
        }
    }

    async updateRunResult(id: string, result: UpdateRunResultInput): Promise<void> {
        await this.pool.query(
            `UPDATE ai_task_runs
             SET status = $1, finished_at = $2, subsession_id = $3, error = $4
             WHERE id = $5`,
            [result.status, result.finishedAt, result.subsessionId ?? null, result.error ?? null, id]
        )
    }

    async listRuns(scheduleId: string, limit = 20): Promise<AiTaskRun[]> {
        const result = await this.pool.query(
            `SELECT * FROM ai_task_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT $2`,
            [scheduleId, limit]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToRun)
    }
}
