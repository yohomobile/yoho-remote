export const SUMMARIZE_TURN_QUEUE_NAME = 'summarize-turn'
export const SUMMARIZE_TURN_JOB_VERSION = 1 as const

export const SUMMARIZE_SESSION_QUEUE_NAME = 'summarize-session'
export const SUMMARIZE_SESSION_JOB_VERSION = 1 as const

export type SummarizeTurnJobPayload = {
    sessionId: string
    namespace: string
    userSeq: number
    scheduledAtMs: number
}

export type SummarizeTurnJobData = {
    version: typeof SUMMARIZE_TURN_JOB_VERSION
    idempotencyKey: string
    payload: SummarizeTurnJobPayload
}

export type SummarizeSessionJobPayload = {
    sessionId: string
    namespace: string
    scheduledAtMs: number
}

export type SummarizeSessionJobData = {
    version: typeof SUMMARIZE_SESSION_JOB_VERSION
    idempotencyKey: string
    payload: SummarizeSessionJobPayload
}

type QueueOptions = {
    retryLimit?: number
    retryDelay?: number
    retryBackoff?: boolean
    retryDelayMax?: number
}

type SendOptions = {
    singletonKey?: string
    startAfter?: number  // seconds to delay before the job becomes available
}

export interface SummarizeTurnQueuePublisher {
    send(
        queueName: string,
        payload: SummarizeTurnJobData,
        options?: SendOptions
    ): Promise<unknown>
    sendSessionSummary(
        sessionId: string,
        namespace: string,
    ): Promise<unknown>
    stop(): Promise<void>
}

export type SummarizeTurnQueuePgConfig = {
    host: string
    port: number
    user: string
    password: string
    database: string
    ssl?: boolean | { rejectUnauthorized?: boolean }
    bossSchema: string
}

type PgBossLike = {
    start(): Promise<void>
    stop(): Promise<void>
    createQueue(queueName: string, options?: QueueOptions): Promise<unknown>
    updateQueue(queueName: string, options?: QueueOptions): Promise<unknown>
    send(
        queueName: string,
        payload: SummarizeTurnJobData,
        options?: SendOptions
    ): Promise<unknown>
}

type PgBossConstructor = new (
    connection: string | Record<string, unknown>,
    config?: Record<string, unknown>
) => PgBossLike

const PG_BOSS_MODULE_NAME = 'pg-boss'
const DEFAULT_RETRY_LIMIT = 4
const DEFAULT_RETRY_DELAY_SECONDS = 15
const DEFAULT_RETRY_BACKOFF = true
const DEFAULT_RETRY_DELAY_MAX_SECONDS = 300

function parseNumber(value: string | undefined, fallback: number, label: string): number {
    if (value == null || value.trim() === '') {
        return fallback
    }

    const parsed = Number(value)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid numeric env ${label}: ${value}`)
    }

    return parsed
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value.trim() === '') {
        return fallback
    }

    return new Set(['1', 'true', 'yes', 'on']).has(value.trim().toLowerCase())
}

function getSummarizeTurnQueueOptions(env: NodeJS.ProcessEnv = process.env): QueueOptions {
    return {
        retryLimit: parseNumber(env.SUMMARIZE_TURN_RETRY_LIMIT, DEFAULT_RETRY_LIMIT, 'SUMMARIZE_TURN_RETRY_LIMIT'),
        retryDelay: parseNumber(env.SUMMARIZE_TURN_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS, 'SUMMARIZE_TURN_RETRY_DELAY_SECONDS'),
        retryBackoff: parseBoolean(env.SUMMARIZE_TURN_RETRY_BACKOFF, DEFAULT_RETRY_BACKOFF),
        retryDelayMax: parseNumber(
            env.SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS,
            DEFAULT_RETRY_DELAY_MAX_SECONDS,
            'SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS'
        ),
    }
}

function buildConnectionString(config: SummarizeTurnQueuePgConfig): string {
    const url = new URL(`postgres://${config.host}:${config.port}/${config.database}`)
    url.username = config.user
    url.password = config.password
    if (config.ssl) {
        url.searchParams.set('sslmode', 'require')
    }
    return url.toString()
}

export async function createSummarizeTurnQueuePublisher(
    config: SummarizeTurnQueuePgConfig
): Promise<SummarizeTurnQueuePublisher | null> {
    let importedModule: unknown
    try {
        importedModule = await import(PG_BOSS_MODULE_NAME)
    } catch (error) {
        console.warn('[Server] summarize-turn queue disabled: pg-boss not available', error)
        return null
    }

    const PgBoss = (
        (importedModule as { PgBoss?: PgBossConstructor }).PgBoss
        ?? (importedModule as { default?: PgBossConstructor }).default
        ?? importedModule
    ) as PgBossConstructor

    if (typeof PgBoss !== 'function') {
        console.warn('[Server] summarize-turn queue disabled: invalid pg-boss export')
        return null
    }

    try {
        const queueOptions = getSummarizeTurnQueueOptions()
        const boss = new PgBoss({
            connectionString: buildConnectionString(config),
            schema: config.bossSchema,
            ssl: config.ssl,
        })
        await boss.start()
        await boss.createQueue(SUMMARIZE_TURN_QUEUE_NAME, queueOptions)
        await boss.updateQueue(SUMMARIZE_TURN_QUEUE_NAME, queueOptions)
        // Pre-create the session summary queue so enqueue never races with worker startup
        const sessionQueueOptions: QueueOptions = { retryLimit: 3, retryDelay: 60, retryBackoff: true, retryDelayMax: 900 }
        await boss.createQueue(SUMMARIZE_SESSION_QUEUE_NAME, sessionQueueOptions).catch(() => {})
        console.log(
            '[Server] summarize-turn queue publisher: enabled'
            + ` (schema=${config.bossSchema}, retryLimit=${queueOptions.retryLimit}, retryDelay=${queueOptions.retryDelay}s,`
            + ` retryBackoff=${queueOptions.retryBackoff}, retryDelayMax=${queueOptions.retryDelayMax}s)`
        )
        return {
            send(queueName, payload, options) {
                return boss.send(queueName, payload, options)
            },
            sendSessionSummary(sessionId: string, namespace: string) {
                const singletonKey = `session:${sessionId}`
                const data: SummarizeSessionJobData = {
                    version: SUMMARIZE_SESSION_JOB_VERSION,
                    idempotencyKey: singletonKey,
                    payload: { sessionId, namespace, scheduledAtMs: Date.now() },
                }
                // Delay 30s so the last in-flight L1 job has time to write
                // before L3 runs (mirrors the +3s turn-enqueue pattern).
                return boss.send(SUMMARIZE_SESSION_QUEUE_NAME, data as unknown as SummarizeTurnJobData, {
                    singletonKey,
                    startAfter: 30,
                })
            },
            stop() {
                return boss.stop()
            }
        }
    } catch (error) {
        console.warn('[Server] summarize-turn queue disabled: failed to start pg-boss publisher', error)
        return null
    }
}
