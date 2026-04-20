import { afterEach, describe, expect, it } from 'bun:test'
import { handleAiTaskDispatcher } from './aiTaskDispatcher'
import type { WorkerContext } from '../types'

// Fixed test time: 2026-04-20T09:05:00.000Z (Monday)
const MONDAY_905_MS = new Date('2026-04-20T09:05:00.000Z').getTime()

type PoolCall = { sql: string; params: unknown[] }
type BossCall = { queue: string; payload: unknown; options: Record<string, unknown> }

function makeScheduleRow(opts: {
    id: string
    cron: string
    recurring?: boolean
    nextFireAt?: number | null
    machineId?: string
    namespace?: string
    agent?: string
    mode?: string | null
}): Record<string, unknown> {
    return {
        id: opts.id,
        namespace: opts.namespace ?? 'test-ns',
        machine_id: opts.machineId ?? 'machine-1',
        label: null,
        cron_expr: opts.cron,
        payload_prompt: 'test prompt',
        directory: '/tmp/test',
        agent: opts.agent ?? 'claude',
        mode: opts.mode ?? null,
        model: null,
        recurring: opts.recurring ?? true,
        enabled: true,
        created_at: MONDAY_905_MS - 1000,
        created_by_session_id: null,
        last_fire_at: null,
        next_fire_at: opts.nextFireAt ?? null,
        last_run_status: null,
        consecutive_failures: 0,
    }
}

function makeTestHarness(scheduleRows: Record<string, unknown>[], nowMs: number) {
    const poolCalls: PoolCall[] = []
    const bossCalls: BossCall[] = []

    const pool = {
        query: async (sql: string, params: unknown[] = []) => {
            poolCalls.push({ sql: sql.trim(), params })

            if (sql.includes('SELECT') && sql.includes('ai_task_schedules')) {
                return { rows: scheduleRows, rowCount: scheduleRows.length }
            }

            if (sql.includes('INSERT INTO ai_task_runs')) {
                return {
                    rows: [{
                        id: params[0],
                        schedule_id: params[1] ?? null,
                        machine_id: params[2],
                        namespace: params[3],
                        status: params[4],
                        started_at: params[5],
                        metadata: null,
                        session_id: null,
                        subsession_id: null,
                        finished_at: null,
                        error: null,
                    }],
                    rowCount: 1,
                }
            }

            return { rows: [], rowCount: 1 }
        },
    }

    const boss = {
        send: async (queue: string, payload: unknown, options: Record<string, unknown>) => {
            bossCalls.push({ queue, payload: payload as unknown, options })
            return 'job-id'
        },
    }

    const ctx = {
        pool,
        boss,
        config: {
            bossSchema: 'yr_boss',
            aiTaskTimeoutMs: 1_800_000,
        },
        worker: { host: 'test-host', version: '0.1.0-test' },
        sessionStore: {} as WorkerContext['sessionStore'],
        summaryStore: {} as WorkerContext['summaryStore'],
        runStore: {} as WorkerContext['runStore'],
        deepseekClient: {} as WorkerContext['deepseekClient'],
    } as unknown as WorkerContext

    const origDateNow = Date.now
    Date.now = () => nowMs

    return {
        ctx,
        poolCalls,
        bossCalls,
        restore: () => { Date.now = origDateNow },
        getInsertRunCalls: () => poolCalls.filter(c => c.sql.includes('INSERT INTO ai_task_runs')),
        getUpdateNextFireAtCalls: () =>
            poolCalls.filter(c => c.sql.includes('next_fire_at') && !c.sql.includes('SELECT')),
        getDisableScheduleCalls: () =>
            poolCalls.filter(c => c.sql.includes('enabled = FALSE')),
    }
}

// Belt-and-suspenders: restore Date.now if a test forgets
const origDateNowGlobal = Date.now
afterEach(() => {
    Date.now = origDateNowGlobal
})

describe('handleAiTaskDispatcher', () => {
    it('fires "* * * * *" at the current minute', async () => {
        const scheduleId = 'sched-every-minute'
        const row = makeScheduleRow({ id: scheduleId, cron: '* * * * *', recurring: true })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.getInsertRunCalls()).toHaveLength(1)
        expect(harness.bossCalls).toHaveLength(1)
        expect(harness.bossCalls[0]?.queue).toBe('ai-task')

        // singletonKey format: aitask:{scheduleId}:{minute ISO slice}
        const opts = harness.bossCalls[0]?.options as { singletonKey: string }
        expect(opts.singletonKey).toBe(`aitask:${scheduleId}:2026-04-20T09:05`)
    })

    it('does NOT fire "0 9 * * 1" at 09:05 (wrong minute)', async () => {
        const row = makeScheduleRow({ id: 'sched-mon-9am', cron: '0 9 * * 1', recurring: true })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.getInsertRunCalls()).toHaveLength(0)
        expect(harness.bossCalls).toHaveLength(0)
    })

    it('fires one-shot (+) schedule when nextFireAt is in the past', async () => {
        const scheduleId = 'sched-oneshot-past'
        const pastFireAt = MONDAY_905_MS - 60_000
        const row = makeScheduleRow({
            id: scheduleId,
            cron: '+5m',
            recurring: false,
            nextFireAt: pastFireAt,
        })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.getInsertRunCalls()).toHaveLength(1)
        expect(harness.bossCalls).toHaveLength(1)
    })

    it('does NOT fire one-shot (+) when nextFireAt is in the future', async () => {
        const futureFireAt = MONDAY_905_MS + 10_000_000
        const row = makeScheduleRow({
            id: 'sched-oneshot-future',
            cron: '+1h',
            recurring: false,
            nextFireAt: futureFireAt,
        })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.getInsertRunCalls()).toHaveLength(0)
        expect(harness.bossCalls).toHaveLength(0)
    })

    it('calls updateScheduleNextFireAt (not disable) for recurring=true after firing', async () => {
        const scheduleId = 'sched-recurring-true'
        const row = makeScheduleRow({ id: scheduleId, cron: '* * * * *', recurring: true })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.getInsertRunCalls()).toHaveLength(1)
        expect(harness.getUpdateNextFireAtCalls()).toHaveLength(1)
        expect(harness.getDisableScheduleCalls()).toHaveLength(0)

        // next fire at should be the following minute
        const updateCall = harness.getUpdateNextFireAtCalls()[0]!
        const nextFireAt = updateCall.params[0] as number
        expect(nextFireAt).toBe(MONDAY_905_MS + 60_000)
        expect(updateCall.params[1]).toBe(scheduleId)
    })

    it('calls disableSchedule (not updateNextFireAt) for recurring=false after firing', async () => {
        const scheduleId = 'sched-recurring-false'
        const pastFireAt = MONDAY_905_MS - 1_000
        const row = makeScheduleRow({ id: scheduleId, cron: '+1m', recurring: false, nextFireAt: pastFireAt })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.getInsertRunCalls()).toHaveLength(1)
        expect(harness.getDisableScheduleCalls()).toHaveLength(1)
        expect(harness.getUpdateNextFireAtCalls()).toHaveLength(0)

        const disableCall = harness.getDisableScheduleCalls()[0]!
        expect(disableCall.params).toContain(scheduleId)
    })

    it('passes correct payload fields to boss.send', async () => {
        const scheduleId = 'sched-payload-check'
        const row = makeScheduleRow({
            id: scheduleId,
            cron: '* * * * *',
            recurring: true,
            agent: 'codex',
            mode: 'gpt-5',
            machineId: 'machine-x',
            namespace: 'ns-x',
        })
        const harness = makeTestHarness([row], MONDAY_905_MS)

        try {
            await handleAiTaskDispatcher(null, harness.ctx)
        } finally {
            harness.restore()
        }

        expect(harness.bossCalls).toHaveLength(1)
        const bossPayload = harness.bossCalls[0]?.payload as Record<string, unknown>
        expect(bossPayload.scheduleId).toBe(scheduleId)
        expect(bossPayload.agent).toBe('codex')
        expect(bossPayload.machineId).toBe('machine-x')
        expect(typeof bossPayload.runId).toBe('string')
        expect(bossPayload.prompt).toBe('test prompt')
    })
})
