import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Pool } from 'pg'
import {
    AI_TASK_SCHEDULES_DDL,
    AI_TASK_RUNS_DDL,
} from '../../../server/src/store/ai-tasks-ddl'
import { AiTaskStore } from './aiTaskStore'

const DB_CONFIG = {
    host: '101.100.174.21',
    port: 5432,
    user: 'guang',
    password: 'Root,./000000',
    database: 'yoho_remote',
    ssl: false as const,
}

let pool: Pool
let store: AiTaskStore
const createdScheduleIds: string[] = []
const createdRunIds: string[] = []

beforeAll(async () => {
    pool = new Pool(DB_CONFIG)
    await pool.query(AI_TASK_SCHEDULES_DDL)
    await pool.query(AI_TASK_RUNS_DDL)
    store = new AiTaskStore(pool)
})

afterAll(async () => {
    if (createdRunIds.length > 0) {
        await pool.query(
            `DELETE FROM ai_task_runs WHERE id = ANY($1::text[])`,
            [createdRunIds]
        )
    }
    if (createdScheduleIds.length > 0) {
        await pool.query(
            `DELETE FROM ai_task_schedules WHERE id = ANY($1::text[])`,
            [createdScheduleIds]
        )
    }
    await pool.end()
})

function trackSchedule(id: string): string {
    createdScheduleIds.push(id)
    return id
}

function trackRun(id: string): string {
    createdRunIds.push(id)
    return id
}

const BASE_SCHEDULE = {
    namespace: 'test-unit-ns',
    machineId: 'test-machine',
    cron: '* * * * *',
    prompt: 'unit test prompt',
    directory: '/tmp/unit-test',
    agent: 'claude',
    recurring: true,
}

describe('AiTaskStore (real pg)', () => {
    describe('createSchedule', () => {
        it('writes and reads back data correctly', async () => {
            const sched = await store.createSchedule({
                ...BASE_SCHEDULE,
                cron: '1 2 * * *',
                label: 'test-label',
                mode: 'sonnet',
                model: 'claude-3',
            })
            trackSchedule(sched.id)

            expect(sched.id).toBeString()
            expect(sched.namespace).toBe('test-unit-ns')
            expect(sched.machineId).toBe('test-machine')
            expect(sched.cron).toBe('1 2 * * *')
            expect(sched.prompt).toBe('unit test prompt')
            expect(sched.directory).toBe('/tmp/unit-test')
            expect(sched.agent).toBe('claude')
            expect(sched.label).toBe('test-label')
            expect(sched.mode).toBe('sonnet')
            expect(sched.model).toBe('claude-3')
            expect(sched.recurring).toBe(true)
            expect(sched.enabled).toBe(true)
            expect(sched.consecutiveFailures).toBe(0)
            expect(typeof sched.createdAt).toBe('number')
            expect(sched.nextFireAt).toBeNull()
            expect(sched.lastFireAt).toBeNull()
        })
    })

    describe('listEnabledSchedules', () => {
        it('excludes disabled schedules', async () => {
            const enabled = await store.createSchedule({ ...BASE_SCHEDULE, cron: '3 0 * * *' })
            trackSchedule(enabled.id)

            const disabled = await store.createSchedule({ ...BASE_SCHEDULE, cron: '4 0 * * *' })
            trackSchedule(disabled.id)

            await store.disableSchedule(disabled.id)

            const list = await store.listEnabledSchedules()
            const ids = list.map(s => s.id)
            expect(ids).toContain(enabled.id)
            expect(ids).not.toContain(disabled.id)
        })

        it('filters by machineId when provided', async () => {
            const schedA = await store.createSchedule({
                ...BASE_SCHEDULE,
                machineId: 'machine-filter-A',
                cron: '5 0 * * *',
            })
            trackSchedule(schedA.id)

            const schedB = await store.createSchedule({
                ...BASE_SCHEDULE,
                machineId: 'machine-filter-B',
                cron: '6 0 * * *',
            })
            trackSchedule(schedB.id)

            const listA = await store.listEnabledSchedules('machine-filter-A')
            const idsA = listA.map(s => s.id)
            expect(idsA).toContain(schedA.id)
            expect(idsA).not.toContain(schedB.id)
        })
    })

    describe('updateScheduleNextFireAt', () => {
        it('updates nextFireAt', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '7 0 * * *' })
            trackSchedule(sched.id)

            const nextTime = Date.now() + 60_000
            await store.updateScheduleNextFireAt(sched.id, nextTime)

            const updated = await store.getSchedule(sched.id)
            expect(updated?.nextFireAt).toBe(nextTime)
        })

        it('also updates lastFireAt when provided', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '8 0 * * *' })
            trackSchedule(sched.id)

            const nextTime = Date.now() + 120_000
            const lastTime = Date.now()
            await store.updateScheduleNextFireAt(sched.id, nextTime, lastTime)

            const updated = await store.getSchedule(sched.id)
            expect(updated?.nextFireAt).toBe(nextTime)
            expect(updated?.lastFireAt).toBe(lastTime)
        })
    })

    describe('disableSchedule', () => {
        it('sets enabled to false', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '9 0 * * *' })
            trackSchedule(sched.id)

            expect(sched.enabled).toBe(true)
            await store.disableSchedule(sched.id)

            const updated = await store.getSchedule(sched.id)
            expect(updated?.enabled).toBe(false)
        })
    })

    describe('insertRun', () => {
        it('writes run with pending status', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '10 0 * * *' })
            trackSchedule(sched.id)

            const run = await store.insertRun({
                scheduleId: sched.id,
                machineId: 'test-machine',
                namespace: 'test-unit-ns',
            })
            trackRun(run.id)

            expect(run.status).toBe('pending')
            expect(run.scheduleId).toBe(sched.id)
            expect(run.machineId).toBe('test-machine')
            expect(run.namespace).toBe('test-unit-ns')
            expect(run.finishedAt).toBeNull()
            expect(run.error).toBeNull()
            expect(run.subsessionId).toBeNull()
        })
    })

    describe('updateRunStatus', () => {
        it('transitions pending → running with startedAt', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '11 0 * * *' })
            trackSchedule(sched.id)

            const run = await store.insertRun({
                scheduleId: sched.id,
                machineId: 'test-machine',
                namespace: 'test-unit-ns',
            })
            trackRun(run.id)

            const startedAt = Date.now()
            await store.updateRunStatus(run.id, 'running', startedAt)

            const runs = await store.listRuns(sched.id)
            const updated = runs.find(r => r.id === run.id)
            expect(updated?.status).toBe('running')
            expect(updated?.startedAt).toBe(startedAt)
        })
    })

    describe('updateRunResult', () => {
        it('writes finishedAt, subsessionId on success', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '12 0 * * *' })
            trackSchedule(sched.id)

            const run = await store.insertRun({
                scheduleId: sched.id,
                machineId: 'test-machine',
                namespace: 'test-unit-ns',
            })
            trackRun(run.id)

            const finishedAt = Date.now()
            await store.updateRunResult(run.id, {
                status: 'succeeded',
                finishedAt,
                subsessionId: 'sess-xyz',
                error: null,
            })

            const runs = await store.listRuns(sched.id)
            const updated = runs.find(r => r.id === run.id)
            expect(updated?.status).toBe('succeeded')
            expect(updated?.finishedAt).toBe(finishedAt)
            expect(updated?.subsessionId).toBe('sess-xyz')
            expect(updated?.error).toBeNull()
        })

        it('records error on failure', async () => {
            const sched = await store.createSchedule({ ...BASE_SCHEDULE, cron: '13 0 * * *' })
            trackSchedule(sched.id)

            const run = await store.insertRun({
                scheduleId: sched.id,
                machineId: 'test-machine',
                namespace: 'test-unit-ns',
            })
            trackRun(run.id)

            await store.updateRunResult(run.id, {
                status: 'failed',
                finishedAt: Date.now(),
                error: 'something went wrong',
            })

            const runs = await store.listRuns(sched.id)
            const updated = runs.find(r => r.id === run.id)
            expect(updated?.status).toBe('failed')
            expect(updated?.error).toBe('something went wrong')
        })
    })

    describe('listRuns', () => {
        it('filters by scheduleId and respects limit', async () => {
            const schedA = await store.createSchedule({ ...BASE_SCHEDULE, cron: '14 0 * * *' })
            trackSchedule(schedA.id)
            const schedB = await store.createSchedule({ ...BASE_SCHEDULE, cron: '15 0 * * *' })
            trackSchedule(schedB.id)

            const base = Date.now()
            for (let i = 0; i < 3; i++) {
                const r = await store.insertRun({
                    scheduleId: schedA.id,
                    machineId: 'test-machine',
                    namespace: 'test-unit-ns',
                    startedAt: base + i,
                })
                trackRun(r.id)
            }

            const rB = await store.insertRun({
                scheduleId: schedB.id,
                machineId: 'test-machine',
                namespace: 'test-unit-ns',
            })
            trackRun(rB.id)

            const runsA = await store.listRuns(schedA.id, 2)
            expect(runsA).toHaveLength(2)
            expect(runsA.every(r => r.scheduleId === schedA.id)).toBe(true)

            const runsAAll = await store.listRuns(schedA.id, 20)
            expect(runsAAll).toHaveLength(3)

            const runsB = await store.listRuns(schedB.id)
            expect(runsB).toHaveLength(1)
            expect(runsB[0]?.scheduleId).toBe(schedB.id)
        })
    })
})
