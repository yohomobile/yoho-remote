/**
 * Phase 4 E2E Integration Tests
 *
 * Covers the full AI task pipeline end-to-end:
 *  1. Cron trigger:  dispatcher fires * * * * * → pending run + boss job + updated next_fire_at
 *  2. One-shot:      recurring=false fires once → pending run + schedule disabled
 *  3. aiTask handler: fetch-mocked session API → DB run status = succeeded
 *  4. HTTP route:    /api/internal/worker/schedule-task auth + schema + DB insert (claude + codex)
 *  5. singletonKey:  same minute/runId → same key used by sendAiTaskRun
 *
 * Uses real PostgreSQL (yoho_remote) + mock PgBoss + mock fetch.
 * All test data scoped to TEST_MACHINE_ID and cleaned up in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Hono } from 'hono'
import type PgBoss from 'pg-boss'
import { AI_TASK_RUN_QUEUE } from '../../src/boss'
import { AiTaskStore } from '../../src/db/aiTaskStore'
import { handleAiTaskDispatcher } from '../../src/handlers/aiTaskDispatcher'
import { handleAiTask, type AiTaskPayload } from '../../src/handlers/aiTask'
import { sendAiTaskRun } from '../../src/jobs/aiTask'
import {
    AI_TASK_SCHEDULES_DDL,
    AI_TASK_RUNS_DDL,
    AI_TASK_INDEXES_DDL,
} from '../../../server/src/store/ai-tasks-ddl'
import { createWorkerMcpRoutes } from '../../../server/src/web/routes/worker-mcp'
import { internalAuthMiddleware } from '../../../server/src/web/middleware/internal-auth'
import type { WorkerContext } from '../../src/types'

// ---------------------------------------------------------------------------
// DB config (same as phase1-e2e.test.ts)
// ---------------------------------------------------------------------------

const DB_CONFIG = {
    host: '101.100.174.21',
    port: 5432,
    user: 'guang',
    password: 'Root,./000000',
    database: 'yoho_remote',
    ssl: false as const,
}

// Test-run-scoped constants — unique per run to avoid collisions
const TEST_RUN_SUFFIX = randomUUID().slice(0, 8)
const TEST_TOKEN = 'test-worker-token-phase4-e2e'
const TEST_MACHINE_ID = `test-machine-p4-${TEST_RUN_SUFFIX}`
const TEST_NAMESPACE = `test-ns-p4-${TEST_RUN_SUFFIX}`
const TEST_DIRECTORY = '/tmp/test-phase4-e2e'

let pool: Pool
let store: AiTaskStore

// ---------------------------------------------------------------------------
// Helpers: mock boss
// ---------------------------------------------------------------------------

type SentJob = {
    queueName: string
    payload: unknown
    options?: Record<string, unknown>
}

function makeMockBoss(): { boss: PgBoss; sentJobs: SentJob[] } {
    const sentJobs: SentJob[] = []
    const boss = {
        send: async (
            queueName: string,
            payload: unknown,
            options?: Record<string, unknown>,
        ) => {
            sentJobs.push({ queueName, payload, options })
            return `job-${sentJobs.length}`
        },
    } as unknown as PgBoss
    return { boss, sentJobs }
}

// ---------------------------------------------------------------------------
// Helpers: WorkerContext
// ---------------------------------------------------------------------------

function makeCtx(boss: PgBoss, yohoRemoteInternalUrl = 'http://localhost:9999'): WorkerContext {
    return {
        config: {
            pg: {
                host: '',
                port: 5432,
                user: '',
                password: '',
                database: '',
                ssl: false as const,
                connectionString: '',
            },
            bossSchema: 'yr_boss',
            workerConcurrency: 1,
            summarizationRunRetentionMs: 0,
            l2SegmentThreshold: 5,
            catchupIntervalMs: 3_600_000,
            yohoRemoteInternalUrl,
            workerInternalToken: TEST_TOKEN,
            aiTaskTimeoutMs: 30_000,
            summarizeTurnQueue: {
                retryLimit: 0,
                retryDelaySeconds: 0,
                retryBackoff: false,
                retryDelayMaxSeconds: 0,
            },
            summarizeSegmentQueue: {
                retryLimit: 0,
                retryDelaySeconds: 0,
                retryBackoff: false,
                retryDelayMaxSeconds: 0,
            },
            summarizeSessionQueue: {
                retryLimit: 0,
                retryDelaySeconds: 0,
                retryBackoff: false,
                retryDelayMaxSeconds: 0,
            },
            deepseek: {
                apiKey: 'test',
                baseUrl: 'http://localhost',
                model: 'deepseek-chat',
                timeoutMs: 5_000,
            },
        } as WorkerContext['config'],
        worker: { host: 'test-worker', version: '0.0.0-test' },
        pool,
        boss,
        sessionStore: null as unknown as WorkerContext['sessionStore'],
        summaryStore: null as unknown as WorkerContext['summaryStore'],
        runStore: null as unknown as WorkerContext['runStore'],
        deepseekClient: null as unknown as WorkerContext['deepseekClient'],
        memoryClient: null,
    }
}

// ---------------------------------------------------------------------------
// Helpers: DB shortcuts
// ---------------------------------------------------------------------------

async function insertSchedule(opts: {
    cron: string
    recurring: boolean
    nextFireAt?: number | null
}): Promise<string> {
    const s = await store.createSchedule({
        namespace: TEST_NAMESPACE,
        machineId: TEST_MACHINE_ID,
        cron: opts.cron,
        prompt: 'Phase 4 E2E test prompt — automated task',
        directory: TEST_DIRECTORY,
        agent: 'claude',
        recurring: opts.recurring,
        nextFireAt: opts.nextFireAt ?? null,
    })
    return s.id
}

// ---------------------------------------------------------------------------
// Helpers: mock store for HTTP scenario
// The route casts store to PostgresStore to call getPool(), so we provide it.
// ---------------------------------------------------------------------------

function makeMockStore(p: Pool) {
    return {
        getProjects: async (_machineId: string | null) => [
            {
                id: 'proj-e2e',
                machineId: TEST_MACHINE_ID,
                path: TEST_DIRECTORY,
                name: 'TestProject',
                orgId: TEST_NAMESPACE,
            },
        ],
        getMachine: async (_id: string) => ({
            id: TEST_MACHINE_ID,
            namespace: TEST_NAMESPACE,
            orgId: TEST_NAMESPACE,
        }),
        // cast target for (store as PostgresStore).getPool()
        getPool: () => p,
    }
}

// ---------------------------------------------------------------------------
// Helpers: test HTTP app (inner routes + auth middleware)
// ---------------------------------------------------------------------------

function makeTestApp(p: Pool) {
    const app = new Hono()
    app.use('/api/internal/*', internalAuthMiddleware(TEST_TOKEN))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.route('/api/internal', createWorkerMcpRoutes(() => null, makeMockStore(p) as any))
    return app
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
    pool = new Pool({
        ...DB_CONFIG,
        max: 5,
        idleTimeoutMillis: 15_000,
        connectionTimeoutMillis: 8_000,
    })
    await pool.query('SELECT 1') // connection warm-up

    // Idempotent DDL — safe to run even if tables already exist
    await pool.query(AI_TASK_SCHEDULES_DDL)
    await pool.query(AI_TASK_RUNS_DDL)
    await pool.query(AI_TASK_INDEXES_DDL)

    store = new AiTaskStore(pool)
})

afterAll(async () => {
    // Scoped cleanup: all test data uses TEST_MACHINE_ID
    await pool.query('DELETE FROM ai_task_runs WHERE machine_id = $1', [TEST_MACHINE_ID])
    await pool.query('DELETE FROM ai_task_schedules WHERE machine_id = $1', [TEST_MACHINE_ID])
    await pool.end()
})

// ===========================================================================
// SCENARIO 1: Cron trigger (every minute)
// ===========================================================================

describe('Scenario 1: Cron trigger (every-minute schedule)', () => {
    it(
        'dispatcher fires * * * * * → pending run inserted + AI_TASK_RUN boss job + next_fire_at updated',
        async () => {
            const scheduleId = await insertSchedule({ cron: '* * * * *', recurring: true })

            const { boss, sentJobs } = makeMockBoss()
            await handleAiTaskDispatcher(null, makeCtx(boss))

            // ── runs ──────────────────────────────────────────────────────
            const runs = await store.listRuns(scheduleId)
            expect(runs.length).toBeGreaterThanOrEqual(1)
            const myRun = runs[0]!
            expect(myRun.scheduleId).toBe(scheduleId)
            expect(myRun.status).toBe('pending')
            expect(myRun.machineId).toBe(TEST_MACHINE_ID)

            // ── boss job ──────────────────────────────────────────────────
            const myJob = sentJobs.find(
                j =>
                    j.queueName === AI_TASK_RUN_QUEUE &&
                    (j.payload as AiTaskPayload).scheduleId === scheduleId,
            )
            expect(myJob).toBeDefined()
            const singletonKey = (myJob!.options as { singletonKey?: string })?.singletonKey
            expect(singletonKey).toMatch(/^aitask:/)

            // ── next_fire_at updated to a future timestamp ────────────────
            const updated = await store.getSchedule(scheduleId)
            expect(updated).not.toBeNull()
            expect(updated!.nextFireAt).not.toBeNull()
            expect(updated!.nextFireAt!).toBeGreaterThan(Date.now())
        },
    )
})

// ===========================================================================
// SCENARIO 2: One-shot (recurring=false, nextFireAt in the past)
// ===========================================================================

describe('Scenario 2: One-shot schedule (recurring=false, nextFireAt=past)', () => {
    it(
        'dispatcher fires once → pending run inserted + schedule disabled',
        async () => {
            // cron starts with '+' → isOneShotDelay() = true
            // next_fire_at is 1 s in the past → schedule.nextFireAt <= now → fires
            const scheduleId = await insertSchedule({
                cron: '+60000',
                recurring: false,
                nextFireAt: Date.now() - 1_000,
            })

            const { boss, sentJobs } = makeMockBoss()
            await handleAiTaskDispatcher(null, makeCtx(boss))

            // ── runs ──────────────────────────────────────────────────────
            const runs = await store.listRuns(scheduleId)
            expect(runs).toHaveLength(1)
            expect(runs[0]!.status).toBe('pending')
            expect(runs[0]!.scheduleId).toBe(scheduleId)

            // ── boss job ──────────────────────────────────────────────────
            const myJob = sentJobs.find(
                j =>
                    j.queueName === AI_TASK_RUN_QUEUE &&
                    (j.payload as AiTaskPayload).scheduleId === scheduleId,
            )
            expect(myJob).toBeDefined()

            // ── schedule disabled ─────────────────────────────────────────
            const sched = await store.getSchedule(scheduleId)
            expect(sched).not.toBeNull()
            expect(sched!.enabled).toBe(false)
        },
    )
})

// ===========================================================================
// SCENARIO 3: aiTask handler with mocked fetch → status = succeeded
// Note: POLL_INTERVAL_MS is 5000ms (hardcoded in handler), so this test
// takes ~5 seconds intentionally.
// ===========================================================================

describe('Scenario 3: aiTask handler (mocked HTTP → succeeded)', () => {
    it(
        'find-or-create + send + status=idle → DB run status becomes succeeded',
        async () => {
            // Pre-insert schedule + pending run (dispatcher normally does this)
            const scheduleId = await insertSchedule({ cron: '* * * * *', recurring: true })
            const run = await store.insertRun({
                scheduleId,
                machineId: TEST_MACHINE_ID,
                namespace: TEST_NAMESPACE,
                status: 'pending',
            })
            const runId = run.id

            const payload: AiTaskPayload = {
                scheduleId,
                runId,
                prompt: 'Phase 4 E2E handler test',
                directory: TEST_DIRECTORY,
                agent: 'claude',
                mode: null,
                machineId: TEST_MACHINE_ID,
            }

            // ── mock global fetch ─────────────────────────────────────────
            const callLog: string[] = []
            const originalFetch = globalThis.fetch
            globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
                const u = url.toString()
                callLog.push(u)

                if (u.includes('/session/find-or-create')) {
                    return new Response(
                        JSON.stringify({ sessionId: 'fake-session-e2e-1' }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    )
                }
                if (u.includes('/session/send')) {
                    return new Response(
                        JSON.stringify({ ok: true }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    )
                }
                if (u.includes('/session/status')) {
                    // Return executing=false so the handler exits on first poll
                    return new Response(
                        JSON.stringify({ status: 'idle', executing: false }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    )
                }
                throw new Error(`Unexpected fetch call: ${u}`)
            }

            try {
                const { boss } = makeMockBoss()
                await handleAiTask(payload, makeCtx(boss, 'http://internal-server.test'))
            } finally {
                globalThis.fetch = originalFetch
            }

            // ── DB assertions ─────────────────────────────────────────────
            const r = await pool.query(
                'SELECT status, subsession_id, finished_at FROM ai_task_runs WHERE id = $1',
                [runId],
            )
            expect(r.rows).toHaveLength(1)
            const row = r.rows[0] as Record<string, unknown>
            expect(row.status).toBe('succeeded')
            expect(row.subsession_id).toBe('fake-session-e2e-1')
            expect(row.finished_at).not.toBeNull()

            // ── all 3 API endpoints called ────────────────────────────────
            expect(callLog.some(u => u.includes('/session/find-or-create'))).toBe(true)
            expect(callLog.some(u => u.includes('/session/send'))).toBe(true)
            expect(callLog.some(u => u.includes('/session/status'))).toBe(true)
        },
        15_000, // 15 s timeout: poll interval is 5000 ms
    )
})

// ===========================================================================
// SCENARIO 4: HTTP /api/internal/worker/schedule-task
// ===========================================================================

describe('Scenario 4: HTTP /api/internal/worker/schedule-task', () => {
    it('no X-Worker-Token header → 401', async () => {
        const app = makeTestApp(pool)
        const res = await app.request('/api/internal/worker/schedule-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cronOrDelay: '* * * * *',
                prompt: 'test',
                directory: TEST_DIRECTORY,
                recurring: true,
                agent: 'claude',
                machineId: TEST_MACHINE_ID,
            }),
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error: string }
        expect(body.error).toBe('unauthorized')
    })

    it('wrong X-Worker-Token → 401', async () => {
        const app = makeTestApp(pool)
        const res = await app.request('/api/internal/worker/schedule-task', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Token': 'wrong-token-intentional',
            },
            body: JSON.stringify({
                cronOrDelay: '* * * * *',
                prompt: 'test',
                directory: TEST_DIRECTORY,
                recurring: true,
                agent: 'claude',
                machineId: TEST_MACHINE_ID,
            }),
        })
        expect(res.status).toBe(401)
    })

    it('correct token + invalid body → 400', async () => {
        const app = makeTestApp(pool)
        const res = await app.request('/api/internal/worker/schedule-task', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Token': TEST_TOKEN,
            },
            body: JSON.stringify({ totally: 'wrong' }),
        })
        expect(res.status).toBe(400)
    })

    it('correct token + unregistered directory → 400 directory_not_registered', async () => {
        const app = makeTestApp(pool)
        const res = await app.request('/api/internal/worker/schedule-task', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Token': TEST_TOKEN,
            },
            body: JSON.stringify({
                cronOrDelay: '* * * * *',
                prompt: 'test',
                directory: '/not/registered/at/all',
                recurring: true,
                agent: 'claude',
                machineId: TEST_MACHINE_ID,
            }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as { error: string }
        expect(body.error).toBe('directory_not_registered')
    })

    it('correct token + valid body (agent=claude) → 200 + schedule in DB', async () => {
        const app = makeTestApp(pool)
        const res = await app.request('/api/internal/worker/schedule-task', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Token': TEST_TOKEN,
            },
            body: JSON.stringify({
                cronOrDelay: '* * * * *',
                prompt: 'Automated E2E test — claude agent',
                directory: TEST_DIRECTORY,
                recurring: true,
                agent: 'claude',
                machineId: TEST_MACHINE_ID,
            }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { scheduleId: string; status: string; nextFireAt: string | null }
        expect(body.status).toBe('registered')
        expect(typeof body.scheduleId).toBe('string')
        expect(body.scheduleId.length).toBeGreaterThan(0)

        // Schedule must exist in DB with correct fields
        const dbRow = await pool.query(
            'SELECT agent, recurring, machine_id, cron_expr FROM ai_task_schedules WHERE id = $1',
            [body.scheduleId],
        )
        expect(dbRow.rows).toHaveLength(1)
        const row = dbRow.rows[0] as Record<string, unknown>
        expect(row.agent).toBe('claude')
        expect(row.recurring).toBe(true)
        expect(row.machine_id).toBe(TEST_MACHINE_ID)
        expect(row.cron_expr).toBe('* * * * *')
    })

    it('correct token + valid body (agent=codex, recurring=false) → 200 + schedule in DB', async () => {
        const app = makeTestApp(pool)
        const res = await app.request('/api/internal/worker/schedule-task', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Worker-Token': TEST_TOKEN,
            },
            body: JSON.stringify({
                cronOrDelay: '0 9 * * 1',
                prompt: 'Automated E2E test — codex agent',
                directory: TEST_DIRECTORY,
                recurring: false,
                agent: 'codex',
                machineId: TEST_MACHINE_ID,
            }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { scheduleId: string }

        const dbRow = await pool.query(
            'SELECT agent, recurring FROM ai_task_schedules WHERE id = $1',
            [body.scheduleId],
        )
        expect(dbRow.rows).toHaveLength(1)
        const row = dbRow.rows[0] as Record<string, unknown>
        expect(row.agent).toBe('codex')
        expect(row.recurring).toBe(false)
    })
})

// ===========================================================================
// SCENARIO 5: singletonKey dedup
// ===========================================================================

describe('Scenario 5: singletonKey dedup', () => {
    it('sendAiTaskRun called twice with same runId → both use aitaskrun:{runId} key', async () => {
        const { boss, sentJobs } = makeMockBoss()
        const runId = randomUUID()
        const scheduleId = randomUUID()

        const payload: AiTaskPayload = {
            scheduleId,
            runId,
            prompt: 'dedup test',
            directory: TEST_DIRECTORY,
            agent: 'claude',
            mode: null,
            machineId: TEST_MACHINE_ID,
        }

        // WorkerConfig subset required by sendAiTaskRun
        const config = { aiTaskTimeoutMs: 30_000 } as WorkerContext['config']

        await sendAiTaskRun(boss, payload, config)
        await sendAiTaskRun(boss, payload, config)

        expect(sentJobs).toHaveLength(2)

        const key0 = (sentJobs[0]!.options as { singletonKey?: string })?.singletonKey
        const key1 = (sentJobs[1]!.options as { singletonKey?: string })?.singletonKey

        expect(key0).toBe(`aitaskrun:${runId}`)
        expect(key1).toBe(`aitaskrun:${runId}`)
        expect(key0).toBe(key1)
    })

    it('dispatcher invoked twice after next_fire_at advances → second call does not redispatch', async () => {
        const scheduleId = await insertSchedule({ cron: '* * * * *', recurring: true })

        const { boss: boss1, sentJobs: jobs1 } = makeMockBoss()
        await handleAiTaskDispatcher(null, makeCtx(boss1))

        const { boss: boss2, sentJobs: jobs2 } = makeMockBoss()
        await handleAiTaskDispatcher(null, makeCtx(boss2))

        // Find jobs for our specific schedule from each dispatch
        const job1 = jobs1.find(
            j => (j.payload as AiTaskPayload).scheduleId === scheduleId,
        )

        expect(job1).toBeDefined()

        const key1 = (job1!.options as { singletonKey?: string })?.singletonKey

        expect(key1).toMatch(/^aitask:.+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
        expect(jobs2.some(j => (j.payload as AiTaskPayload).scheduleId === scheduleId)).toBe(false)
    })
})
