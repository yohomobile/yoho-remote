import { z } from 'zod'

function parseNumber(value: string | undefined, fallback: number, label: string): number {
    if (value == null || value.trim() === '') {
        return fallback
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric env ${label}: ${value}`)
    }
    return parsed
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value.trim() === '') {
        return fallback
    }
    return new Set(['1', 'true', 'yes', 'on', 'require']).has(value.trim().toLowerCase())
}

function stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '')
}

function readRequiredEnv(
    env: NodeJS.ProcessEnv,
    name: string,
    options: { allowEmpty?: boolean } = {}
): string {
    const value = env[name]
    if (value == null) {
        throw new Error(`${name} is required`)
    }

    if (options.allowEmpty) {
        return value
    }

    const trimmed = value.trim()
    if (trimmed === '') {
        throw new Error(`${name} is required`)
    }
    return trimmed
}

function buildConnectionString(input: {
    host: string
    port: number
    user: string
    password: string
    database: string
}): string {
    const encodedUser = encodeURIComponent(input.user)
    const encodedPassword = encodeURIComponent(input.password)
    return `postgres://${encodedUser}:${encodedPassword}@${input.host}:${input.port}/${input.database}`
}

const envSchema = z.object({
    PG_SSL: z.string().optional(),
    YOHO_REMOTE_INTERNAL_URL: z.string().default('http://localhost:3000'),
    YOHO_WORKER_INTERNAL_TOKEN: z.string().min(1, 'YOHO_WORKER_INTERNAL_TOKEN is required'),
    AI_TASK_TIMEOUT_MS: z.string().optional(),
    DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY is required'),
    DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),
    DEEPSEEK_MODEL: z.literal('deepseek-chat').default('deepseek-chat'),
    DEEPSEEK_TIMEOUT_MS: z.string().optional(),
    WORKER_CONCURRENCY: z.string().optional(),
    SUMMARIZATION_RUN_RETENTION_DAYS: z.string().optional(),
    SUMMARIZE_TURN_RETRY_LIMIT: z.string().optional(),
    SUMMARIZE_TURN_RETRY_DELAY_SECONDS: z.string().optional(),
    SUMMARIZE_TURN_RETRY_BACKOFF: z.string().optional(),
    SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS: z.string().optional(),
    SUMMARIZE_SEGMENT_RETRY_LIMIT: z.string().optional(),
    SUMMARIZE_SEGMENT_RETRY_DELAY_SECONDS: z.string().optional(),
    SUMMARIZE_SEGMENT_RETRY_BACKOFF: z.string().optional(),
    SUMMARIZE_SEGMENT_RETRY_DELAY_MAX_SECONDS: z.string().optional(),
    SUMMARIZE_SESSION_RETRY_LIMIT: z.string().optional(),
    SUMMARIZE_SESSION_RETRY_DELAY_SECONDS: z.string().optional(),
    SUMMARIZE_SESSION_RETRY_BACKOFF: z.string().optional(),
    SUMMARIZE_SESSION_RETRY_DELAY_MAX_SECONDS: z.string().optional(),
    L2_SEGMENT_THRESHOLD: z.string().optional(),
    CATCHUP_INTERVAL_MS: z.string().optional(),
})

type QueueConfig = {
    retryLimit: number
    retryDelaySeconds: number
    retryBackoff: boolean
    retryDelayMaxSeconds: number
}

export type WorkerConfig = {
    pg: {
        host: string
        port: number
        user: string
        password: string
        database: string
        ssl: false | { rejectUnauthorized: false }
        connectionString: string
    }
    bossSchema: string
    workerConcurrency: number
    summarizationRunRetentionMs: number
    l2SegmentThreshold: number
    catchupIntervalMs: number
    summarizeTurnQueue: QueueConfig
    summarizeSegmentQueue: QueueConfig
    summarizeSessionQueue: QueueConfig
    deepseek: {
        apiKey: string
        baseUrl: string
        model: string
        timeoutMs: number
    }
    yohoRemoteInternalUrl: string
    workerInternalToken: string
    aiTaskTimeoutMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
    const parsed = envSchema.parse(env)
    const pgHost = readRequiredEnv(env, 'PG_HOST')
    const pgPort = parseNumber(readRequiredEnv(env, 'PG_PORT'), 5432, 'PG_PORT')
    const pgUser = readRequiredEnv(env, 'PG_USER')
    const pgPassword = readRequiredEnv(env, 'PG_PASSWORD', { allowEmpty: true })
    const pgDatabase = readRequiredEnv(env, 'PG_DATABASE')
    const pgBossSchema = readRequiredEnv(env, 'PG_BOSS_SCHEMA')
    const workerConcurrency = Math.max(1, parseNumber(parsed.WORKER_CONCURRENCY, 1, 'WORKER_CONCURRENCY'))
    const retentionDays = Math.max(1, parseNumber(parsed.SUMMARIZATION_RUN_RETENTION_DAYS, 30, 'SUMMARIZATION_RUN_RETENTION_DAYS'))
    const timeoutMs = Math.max(5_000, parseNumber(parsed.DEEPSEEK_TIMEOUT_MS, 60_000, 'DEEPSEEK_TIMEOUT_MS'))
    const sslEnabled = parseBoolean(parsed.PG_SSL, false)
    const summarizeTurnRetryLimit = Math.max(0, parseNumber(parsed.SUMMARIZE_TURN_RETRY_LIMIT, 4, 'SUMMARIZE_TURN_RETRY_LIMIT'))
    const summarizeTurnRetryDelaySeconds = Math.max(
        0,
        parseNumber(parsed.SUMMARIZE_TURN_RETRY_DELAY_SECONDS, 15, 'SUMMARIZE_TURN_RETRY_DELAY_SECONDS')
    )
    const summarizeTurnRetryDelayMaxSeconds = Math.max(
        0,
        parseNumber(parsed.SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS, 300, 'SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS')
    )
    const summarizeTurnRetryBackoff = parseBoolean(parsed.SUMMARIZE_TURN_RETRY_BACKOFF, true)

    const summarizeSegmentRetryLimit = Math.max(0, parseNumber(parsed.SUMMARIZE_SEGMENT_RETRY_LIMIT, 4, 'SUMMARIZE_SEGMENT_RETRY_LIMIT'))
    const summarizeSegmentRetryDelaySeconds = Math.max(0, parseNumber(parsed.SUMMARIZE_SEGMENT_RETRY_DELAY_SECONDS, 30, 'SUMMARIZE_SEGMENT_RETRY_DELAY_SECONDS'))
    const summarizeSegmentRetryDelayMaxSeconds = Math.max(0, parseNumber(parsed.SUMMARIZE_SEGMENT_RETRY_DELAY_MAX_SECONDS, 600, 'SUMMARIZE_SEGMENT_RETRY_DELAY_MAX_SECONDS'))
    const summarizeSegmentRetryBackoff = parseBoolean(parsed.SUMMARIZE_SEGMENT_RETRY_BACKOFF, true)

    const summarizeSessionRetryLimit = Math.max(0, parseNumber(parsed.SUMMARIZE_SESSION_RETRY_LIMIT, 3, 'SUMMARIZE_SESSION_RETRY_LIMIT'))
    const summarizeSessionRetryDelaySeconds = Math.max(0, parseNumber(parsed.SUMMARIZE_SESSION_RETRY_DELAY_SECONDS, 60, 'SUMMARIZE_SESSION_RETRY_DELAY_SECONDS'))
    const summarizeSessionRetryDelayMaxSeconds = Math.max(0, parseNumber(parsed.SUMMARIZE_SESSION_RETRY_DELAY_MAX_SECONDS, 900, 'SUMMARIZE_SESSION_RETRY_DELAY_MAX_SECONDS'))
    const summarizeSessionRetryBackoff = parseBoolean(parsed.SUMMARIZE_SESSION_RETRY_BACKOFF, true)

    const l2SegmentThreshold = Math.max(2, parseNumber(parsed.L2_SEGMENT_THRESHOLD, 5, 'L2_SEGMENT_THRESHOLD'))
    const catchupIntervalMs = Math.max(60_000, parseNumber(parsed.CATCHUP_INTERVAL_MS, 3_600_000, 'CATCHUP_INTERVAL_MS'))
    const aiTaskTimeoutMs = Math.max(60_000, parseNumber(parsed.AI_TASK_TIMEOUT_MS, 30 * 60 * 1_000, 'AI_TASK_TIMEOUT_MS'))

    const pg = {
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        ssl: sslEnabled ? { rejectUnauthorized: false as const } : false as const,
        connectionString: buildConnectionString({
            host: pgHost,
            port: pgPort,
            user: pgUser,
            password: pgPassword,
            database: pgDatabase,
        }),
    }

    return {
        pg,
        bossSchema: pgBossSchema,
        workerConcurrency,
        summarizationRunRetentionMs: retentionDays * 24 * 60 * 60 * 1000,
        l2SegmentThreshold,
        catchupIntervalMs,
        yohoRemoteInternalUrl: stripTrailingSlash(parsed.YOHO_REMOTE_INTERNAL_URL),
        workerInternalToken: parsed.YOHO_WORKER_INTERNAL_TOKEN,
        aiTaskTimeoutMs,
        summarizeTurnQueue: {
            retryLimit: summarizeTurnRetryLimit,
            retryDelaySeconds: summarizeTurnRetryDelaySeconds,
            retryBackoff: summarizeTurnRetryBackoff,
            retryDelayMaxSeconds: summarizeTurnRetryDelayMaxSeconds,
        },
        summarizeSegmentQueue: {
            retryLimit: summarizeSegmentRetryLimit,
            retryDelaySeconds: summarizeSegmentRetryDelaySeconds,
            retryBackoff: summarizeSegmentRetryBackoff,
            retryDelayMaxSeconds: summarizeSegmentRetryDelayMaxSeconds,
        },
        summarizeSessionQueue: {
            retryLimit: summarizeSessionRetryLimit,
            retryDelaySeconds: summarizeSessionRetryDelaySeconds,
            retryBackoff: summarizeSessionRetryBackoff,
            retryDelayMaxSeconds: summarizeSessionRetryDelayMaxSeconds,
        },
        deepseek: {
            apiKey: parsed.DEEPSEEK_API_KEY,
            baseUrl: stripTrailingSlash(parsed.DEEPSEEK_BASE_URL),
            model: parsed.DEEPSEEK_MODEL,
            timeoutMs,
        },
    }
}
