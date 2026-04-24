import { parseExpression } from 'cron-parser'
import { z } from 'zod'

export const aiTaskScheduleCreateSchema = z.object({
    cronOrDelay: z.string().min(1),
    prompt: z.string().min(1).max(4000),
    directory: z.string().min(1),
    recurring: z.boolean(),
    label: z.string().max(200).optional(),
    agent: z.enum(['claude', 'codex']),
    mode: z.string().min(1).max(200).optional(),
})

export const aiTaskScheduleCreateWithMachineSchema = aiTaskScheduleCreateSchema.extend({
    machineId: z.string().min(1).optional(),
    // Optional creator session id — when set, the dispatched worker session
    // attaches as an orchestrator-child so brain-child callbacks work.
    createdBySessionId: z.string().min(1).optional(),
})

export const aiTaskScheduleListSchema = z.object({
    includeDisabled: z.boolean().optional(),
})

export const aiTaskScheduleListWithMachineSchema = aiTaskScheduleListSchema.extend({
    machineId: z.string().min(1).optional(),
})

export const aiTaskScheduleCancelSchema = z.object({
    scheduleId: z.string().min(1),
})

export type ParsedCron =
    | { ok: true; normalizedCron: string; nextFireAt: number | null; kind: 'cron' | 'delay' }
    | { ok: false; error: string }

function cronNextFireAt(expr: string): number | null {
    try {
        return parseExpression(expr, { tz: 'UTC' }).next().toDate().getTime()
    } catch {
        return null
    }
}

function parseIso8601DurationMs(value: string): number | null {
    const match = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
    if (!match) return null
    const ms = (parseInt(match[1] ?? '0', 10) * 86400
        + parseInt(match[2] ?? '0', 10) * 3600
        + parseInt(match[3] ?? '0', 10) * 60
        + parseInt(match[4] ?? '0', 10)) * 1000
    return ms > 0 ? ms : null
}

export function parseCronOrDelay(value: string): ParsedCron {
    if (value.startsWith('P')) {
        const ms = parseIso8601DurationMs(value)
        if (ms === null) return { ok: false, error: 'invalid_iso8601_duration' }
        return {
            ok: true,
            normalizedCron: `+${ms}`,
            nextFireAt: Date.now() + ms,
            kind: 'delay',
        }
    }

    const next = cronNextFireAt(value)
    if (next === null) return { ok: false, error: 'invalid_cron' }
    return {
        ok: true,
        normalizedCron: value,
        nextFireAt: next,
        kind: 'cron',
    }
}

function asOptionalString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function asOptionalNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function toIsoOrNull(value: unknown): string | null {
    const numberValue = asOptionalNumber(value)
    return numberValue != null ? new Date(numberValue).toISOString() : null
}

export function serializeAiTaskScheduleRow(row: Record<string, unknown>) {
    return {
        scheduleId: String(row.id),
        machineId: asOptionalString(row.machine_id),
        label: asOptionalString(row.label),
        cron: String(row.cron_expr),
        prompt: asOptionalString(row.payload_prompt),
        recurring: Boolean(row.recurring),
        directory: String(row.directory),
        agent: String(row.agent),
        mode: asOptionalString(row.mode),
        enabled: Boolean(row.enabled),
        createdAt: toIsoOrNull(row.created_at),
        nextFireAt: toIsoOrNull(row.next_fire_at),
        lastRunAt: toIsoOrNull(row.last_fire_at),
        lastRunStatus: asOptionalString(row.last_run_status),
    }
}
