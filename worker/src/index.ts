import { hostname } from 'node:os'
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import packageJson from '../package.json'
import { QUEUE, AI_TASK_DISPATCH_QUEUE, AI_TASK_RUN_QUEUE } from './boss'
import { loadConfig } from './config'
import { RunStore } from './db/runStore'
import { ensureWorkerSchema } from './db/schema'
import { SessionStore } from './db/sessionStore'
import { SummaryStore } from './db/summaryStore'
import { enqueueSegmentIfNeeded } from './handlers/summarizeSegment'
import { handleAiTask, aiTaskPayloadSchema } from './handlers/aiTask'
import { handleAiTaskDispatcher } from './handlers/aiTaskDispatcher'
import { registerWorkerJobs } from './jobs/core'
import { workerJobDefinitions } from './jobs/summarizeTurn'
import { DeepSeekClient } from './llm/deepseek'
import type { WorkerContext } from './types'
import {
    AI_TASK_SCHEDULES_DDL,
    AI_TASK_RUNS_DDL,
    AI_TASK_INDEXES_DDL,
} from '../../server/src/store/ai-tasks-ddl'

const CATCHUP_ORPHAN_AGE_MS = 10 * 60 * 1000 // 10 minutes

async function runCatchup(ctx: WorkerContext): Promise<void> {
    try {
        const cutoff = Date.now() - CATCHUP_ORPHAN_AGE_MS
        const result = await ctx.pool.query(
            `SELECT session_id, namespace, COUNT(*)::int AS cnt
             FROM session_summaries
             WHERE level = 1 AND parent_id IS NULL AND created_at < $1
             GROUP BY session_id, namespace
             HAVING COUNT(*) >= $2`,
            [cutoff, ctx.config.l2SegmentThreshold]
        )
        const rows = result.rows as Array<{ session_id: string; namespace: string; cnt: number }>
        if (rows.length === 0) return

        console.log(`[Worker] catch-up: ${rows.length} session(s) with orphaned L1s`)
        for (const row of rows) {
            await enqueueSegmentIfNeeded(
                row.session_id,
                row.namespace,
                ctx,
                ctx.config.l2SegmentThreshold
            ).catch((err: unknown) => {
                console.error(`[Worker] catch-up enqueue failed for session ${row.session_id}:`, err)
            })
        }
    } catch (err) {
        console.error('[Worker] catch-up scan failed:', err)
    }
}

async function main(): Promise<void> {
    const config = loadConfig()
    const worker = {
        host: hostname(),
        version: packageJson.version,
    }
    const pool = new Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
        ssl: config.pg.ssl,
        max: Math.max(4, config.workerConcurrency + 2),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 30_000,
    })

    await ensureWorkerSchema(pool)
    await pool.query(AI_TASK_SCHEDULES_DDL)
    await pool.query(AI_TASK_RUNS_DDL)
    await pool.query(AI_TASK_INDEXES_DDL)

    const boss = new PgBoss({
        connectionString: config.pg.connectionString,
        schema: config.bossSchema,
        ssl: config.pg.ssl,
    })

    const ctx: WorkerContext = {
        config,
        worker,
        pool,
        boss,
        sessionStore: new SessionStore(pool),
        summaryStore: new SummaryStore(pool),
        runStore: new RunStore(pool),
        deepseekClient: new DeepSeekClient(config.deepseek),
    }

    const prune = async (): Promise<void> => {
        const deleted = await ctx.runStore.pruneOlderThan(Date.now() - config.summarizationRunRetentionMs)
        if (deleted > 0) {
            console.log(`[Worker] Pruned ${deleted} summarization_runs rows`)
        }
    }

    await prune()
    const pruneTimer = setInterval(() => {
        prune().catch((error: unknown) => {
            console.error('[Worker] Failed to prune summarization_runs:', error)
        })
    }, 24 * 60 * 60 * 1000)

    await boss.start()
    await registerWorkerJobs(boss, ctx, workerJobDefinitions)

    // Register AI task handlers
    await boss.createQueue(AI_TASK_DISPATCH_QUEUE, { retentionSeconds: 86_400 })
    await boss.createQueue(AI_TASK_RUN_QUEUE, {
        retryLimit: 2,
        retryDelay: 60,
        retryBackoff: false,
        retentionSeconds: 7 * 86_400,
    })

    await boss.work(AI_TASK_DISPATCH_QUEUE, async (jobs) => {
        for (const job of jobs) {
            await handleAiTaskDispatcher(job.data, ctx).catch((err: unknown) => {
                console.error('[Worker] aiTaskDispatcher error:', err)
            })
        }
    })

    await boss.work(AI_TASK_RUN_QUEUE, async (jobs) => {
        for (const job of jobs) {
            const parsed = aiTaskPayloadSchema.safeParse(job.data)
            if (!parsed.success) {
                console.error('[Worker] Invalid aiTask payload:', parsed.error.flatten())
                continue
            }
            await handleAiTask(parsed.data, ctx).catch((err: unknown) => {
                console.error('[Worker] aiTask handler error:', err)
                throw err
            })
        }
    })

    await boss.schedule(AI_TASK_DISPATCH_QUEUE, '* * * * *', {}, { retryLimit: 0 })

    // Run catch-up scan on startup then on interval
    void runCatchup(ctx)
    const catchupTimer = setInterval(() => {
        void runCatchup(ctx)
    }, config.catchupIntervalMs)

    const queueNames = workerJobDefinitions.map(d => d.queueName).join(', ')
    console.log(
        `[Worker] Started. queues=[${queueNames}]`
        + ` schema=${config.bossSchema}`
        + ` host=${worker.host}`
        + ` version=${worker.version}`
        + ` concurrency=${config.workerConcurrency}`
        + ` l2Threshold=${config.l2SegmentThreshold}`
    )

    let shuttingDown = false
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return
        }
        shuttingDown = true
        clearInterval(pruneTimer)
        clearInterval(catchupTimer)
        console.log(`[Worker] Shutting down on ${signal}`)
        await boss.stop().catch((error: unknown) => {
            console.error('[Worker] Failed to stop pg-boss:', error)
        })
        await pool.end().catch((error: unknown) => {
            console.error('[Worker] Failed to close postgres pool:', error)
        })
        process.exit(0)
    }

    process.on('SIGINT', () => {
        void shutdown('SIGINT')
    })
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM')
    })
}

main().catch((error: unknown) => {
    console.error('[Worker] Fatal startup error:', error)
    process.exit(1)
})
