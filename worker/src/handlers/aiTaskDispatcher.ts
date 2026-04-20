import { randomUUID } from 'node:crypto'
import cronParser from 'cron-parser'
import { AiTaskStore } from '../db/aiTaskStore'
import type { AiTaskPayload } from './aiTask'
import { sendAiTaskRun } from '../jobs/aiTask'
import type { WorkerContext } from '../types'
import type { WorkerConfig } from '../config'

// Path 1 extends WorkerConfig with aiTaskTimeoutMs
type AiTaskDispatcherConfig = WorkerConfig & { aiTaskTimeoutMs: number }

function floorToMinute(ms: number): Date {
    return new Date(Math.floor(ms / 60_000) * 60_000)
}

function minuteSingletonKey(scheduleId: string, minuteDate: Date): string {
    const iso = minuteDate.toISOString().slice(0, 16) // "2026-04-20T09:05"
    return `aitask:${scheduleId}:${iso}`
}

function cronFiresAtMinute(expr: string, minuteStart: Date): boolean {
    try {
        const interval = cronParser.parseExpression(expr, {
            currentDate: new Date(minuteStart.getTime() - 1),
            utc: true,
        })
        return interval.next().getTime() === minuteStart.getTime()
    } catch {
        return false
    }
}

function computeNextFireAt(expr: string, after: Date): number | null {
    try {
        const interval = cronParser.parseExpression(expr, {
            currentDate: after,
            utc: true,
        })
        return interval.next().getTime()
    } catch {
        return null
    }
}

function isOneShotDelay(cron: string): boolean {
    return cron.startsWith('+')
}

export async function handleAiTaskDispatcher(
    _data: unknown,
    ctx: WorkerContext,
): Promise<void> {
    const store = new AiTaskStore(ctx.pool)
    const now = Date.now()
    const minuteStart = floorToMinute(now)
    const config = ctx.config as AiTaskDispatcherConfig

    let schedules: Awaited<ReturnType<typeof store.listEnabledSchedules>>
    try {
        schedules = await store.listEnabledSchedules()
    } catch (err) {
        console.error('[aiTaskDispatcher] failed to list schedules:', err)
        return
    }

    for (const schedule of schedules) {
        try {
            const shouldFire = isOneShotDelay(schedule.cron)
                ? schedule.nextFireAt != null && schedule.nextFireAt <= now
                : cronFiresAtMinute(schedule.cron, minuteStart)

            if (!shouldFire) continue

            const runId = randomUUID()

            await store.insertRun({
                id: runId,
                scheduleId: schedule.id,
                machineId: schedule.machineId,
                namespace: schedule.namespace,
                status: 'pending',
                startedAt: now,
            })

            const payload: AiTaskPayload = {
                scheduleId: schedule.id,
                runId,
                prompt: schedule.prompt,
                directory: schedule.directory,
                agent: schedule.agent as 'claude' | 'codex',
                mode: schedule.model ?? null,
                machineId: schedule.machineId,
            }

            await sendAiTaskRun(
                ctx.boss,
                payload,
                config,
                minuteSingletonKey(schedule.id, minuteStart),
            )

            if (schedule.recurring) {
                const next = computeNextFireAt(schedule.cron, minuteStart)
                if (next != null) {
                    await store.updateScheduleNextFireAt(schedule.id, next)
                }
            } else {
                await store.disableSchedule(schedule.id)
            }
        } catch (err) {
            console.error(
                `[aiTaskDispatcher] failed for scheduleId=${schedule.id}:`,
                err,
            )
        }
    }
}
