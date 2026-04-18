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
})

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
    summarizeTurnQueue: {
        retryLimit: number
        retryDelaySeconds: number
        retryBackoff: boolean
        retryDelayMaxSeconds: number
    }
    deepseek: {
        apiKey: string
        baseUrl: string
        model: string
        timeoutMs: number
    }
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
        summarizeTurnQueue: {
            retryLimit: summarizeTurnRetryLimit,
            retryDelaySeconds: summarizeTurnRetryDelaySeconds,
            retryBackoff: summarizeTurnRetryBackoff,
            retryDelayMaxSeconds: summarizeTurnRetryDelayMaxSeconds,
        },
        deepseek: {
            apiKey: parsed.DEEPSEEK_API_KEY,
            baseUrl: stripTrailingSlash(parsed.DEEPSEEK_BASE_URL),
            model: parsed.DEEPSEEK_MODEL,
            timeoutMs,
        },
    }
}
