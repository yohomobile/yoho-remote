import { hostname } from 'node:os'
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import packageJson from '../package.json'
import { QUEUE } from './boss'
import { loadConfig } from './config'
import { RunStore } from './db/runStore'
import { ensureWorkerSchema } from './db/schema'
import { SessionStore } from './db/sessionStore'
import { SummaryStore } from './db/summaryStore'
import { registerWorkerJobs } from './jobs/core'
import { workerJobDefinitions } from './jobs/summarizeTurn'
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
    await registerWorkerJobs(boss, ctx, workerJobDefinitions)

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
