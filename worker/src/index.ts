import { hostname } from 'node:os'
import { Pool } from 'pg'
import { PgBoss, type JobWithMetadata } from 'pg-boss'
import packageJson from '../package.json'
import { QUEUE, summarizeTurnPayloadSchema } from './boss'
import { loadConfig } from './config'
import { RunStore } from './db/runStore'
import { ensureWorkerSchema } from './db/schema'
import { SessionStore } from './db/sessionStore'
import { SummaryStore } from './db/summaryStore'
import { handleSummarizeTurn } from './handlers/summarizeTurn'
import { DeepSeekClient } from './llm/deepseek'
import type { WorkerContext } from './types'

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

    const queueOptions = {
        retryLimit: config.summarizeTurnQueue.retryLimit,
        retryDelay: config.summarizeTurnQueue.retryDelaySeconds,
        retryBackoff: config.summarizeTurnQueue.retryBackoff,
        retryDelayMax: config.summarizeTurnQueue.retryDelayMaxSeconds,
    }

    await boss.start()
    await boss.createQueue(QUEUE.SUMMARIZE_TURN, queueOptions)
    await boss.updateQueue(QUEUE.SUMMARIZE_TURN, queueOptions)
    await boss.work(QUEUE.SUMMARIZE_TURN, {
        batchSize: 1,
        localConcurrency: config.workerConcurrency,
        includeMetadata: true,
    }, async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) {
            const parsed = summarizeTurnPayloadSchema.safeParse(job.data)
            if (!parsed.success) {
                console.error('[Worker] Invalid summarize-turn payload:', parsed.error.flatten())
                continue
            }
            await handleSummarizeTurn(parsed.data, job, ctx)
        }
    })

    console.log(
        '[Worker] Started.'
        + ` queue=${QUEUE.SUMMARIZE_TURN}`
        + ` schema=${config.bossSchema}`
        + ` host=${worker.host}`
        + ` version=${worker.version}`
        + ` retryLimit=${queueOptions.retryLimit}`
        + ` retryDelay=${queueOptions.retryDelay}s`
        + ` retryBackoff=${queueOptions.retryBackoff}`
        + ` retryDelayMax=${queueOptions.retryDelayMax}s`
    )

    let shuttingDown = false
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return
        }
        shuttingDown = true
        clearInterval(pruneTimer)
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
