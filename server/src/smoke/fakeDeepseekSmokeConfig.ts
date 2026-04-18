import { loadRequiredPgConfig, type RequiredPgConfig } from '../pgConfig'

export type SmokeConfig = {
    pg: RequiredPgConfig & {
        ssl: false | { rejectUnauthorized: false }
    }
    fakePort: number
    sessionId: string
    namespace: string
    workerConcurrency: number
    deepseekMode: 'fake' | 'real'
    deepseekBaseUrl: string
    deepseekApiKey: string
    deepseekTimeoutMs: number
}

export const HELP_TEXT = `
用途:
  启动 summarize-turn smoke/precheck，拉起 worker，使用 server publisher 发送 summarize-turn，
  然后轮询 PostgreSQL 中的 summarization_runs / session_summaries，验证成功路径。

执行入口:
  bun run smoke:fake-deepseek

必需环境变量:
  PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE / PG_BOSS_SCHEMA
                        不再提供默认值，必须显式指定目标库和 queue schema
  SMOKE_ALLOW_DB_WRITE  必需；true/false。未显式确认前拒绝任何写库动作
  PG_SSL                可选，true/false
  SMOKE_DEEPSEEK_MODE   fake / real，默认 fake

真实 DeepSeek 模式额外需要:
  DEEPSEEK_API_KEY
  DEEPSEEK_BASE_URL     可选，默认 https://api.deepseek.com

可选环境变量:
  SMOKE_ALLOW_UNSAFE_DB_TARGET
                        仅在目标名明显像 production/default（例如 schema=pgboss）时使用
  SMOKE_FAKE_DEEPSEEK_PORT
                        仅 fake 模式使用；默认 0，自动分配可用端口
  SMOKE_SESSION_ID      默认 smoke-<mode>-deepseek-<timestamp>
  SMOKE_NAMESPACE       默认 smoke-<mode>-deepseek-<timestamp>
  SMOKE_WORKER_CONCURRENCY
                        默认 1
  SMOKE_DEEPSEEK_TIMEOUT_MS
                        fake 模式默认 5000，real 模式默认 60000

等价命令行开关:
  --allow-db-write
  --allow-unsafe-db-target

启动顺序:
  1. fake 模式启 fake DeepSeek；real 模式直连真实 DeepSeek
  2. 用同一组 PG / PG_BOSS_SCHEMA 启 worker
  3. 写入 smoke session + 2 条 turn 消息
  4. 用 createSummarizeTurnQueuePublisher 发送 summarize-turn
  5. 轮询 summarization_runs / session_summaries 验证

成功验证点:
  - summarization_runs 最新一条为 status=success
  - session_summaries 写入 level=1, seq_start=userSeq 的摘要
  - fake 模式下 fake DeepSeek 至少收到 1 次 /chat/completions 请求
`.trim()

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

function parseDeepSeekMode(value: string | undefined): 'fake' | 'real' {
    const normalized = value?.trim().toLowerCase() || 'fake'
    if (normalized === 'fake' || normalized === 'real') {
        return normalized
    }
    throw new Error(`Invalid SMOKE_DEEPSEEK_MODE: ${value}`)
}

function hasFlag(argv: string[], flag: string): boolean {
    return argv.includes(flag)
}

function looksProductionLike(value: string): boolean {
    return /(^|[^a-z])(prod|production|live|primary)([^a-z]|$)/i.test(value)
}

function collectUnsafeTargetReasons(config: RequiredPgConfig): string[] {
    const reasons: string[] = []
    const database = config.database.trim().toLowerCase()
    const schema = config.bossSchema.trim().toLowerCase()

    if (database === 'postgres' || database === 'template0' || database === 'template1') {
        reasons.push(`PG_DATABASE=${config.database}`)
    }
    if (schema === 'pgboss') {
        reasons.push(`PG_BOSS_SCHEMA=${config.bossSchema}`)
    }
    if (looksProductionLike(database)) {
        reasons.push(`PG_DATABASE looks production-like (${config.database})`)
    }
    if (looksProductionLike(schema)) {
        reasons.push(`PG_BOSS_SCHEMA looks production-like (${config.bossSchema})`)
    }

    return reasons
}

export function loadFakeDeepseekSmokeConfig(
    env: NodeJS.ProcessEnv = process.env,
    argv: string[] = process.argv
): SmokeConfig {
    const pgConfig = loadRequiredPgConfig(env)
    const allowDbWrite = parseBoolean(env.SMOKE_ALLOW_DB_WRITE, false) || hasFlag(argv, '--allow-db-write')
    if (!allowDbWrite) {
        throw new Error(
            'fakeDeepseekSmoke refuses to write to PostgreSQL without SMOKE_ALLOW_DB_WRITE=true or --allow-db-write'
        )
    }

    const unsafeReasons = collectUnsafeTargetReasons(pgConfig)
    const allowUnsafeTarget = parseBoolean(env.SMOKE_ALLOW_UNSAFE_DB_TARGET, false) || hasFlag(argv, '--allow-unsafe-db-target')
    if (unsafeReasons.length > 0 && !allowUnsafeTarget) {
        throw new Error(
            `fakeDeepseekSmoke refuses unsafe target (${unsafeReasons.join(', ')}). ` +
            'Use an isolated smoke schema/database or re-run with SMOKE_ALLOW_UNSAFE_DB_TARGET=true / --allow-unsafe-db-target after explicit confirmation.'
        )
    }

    const deepseekMode = parseDeepSeekMode(env.SMOKE_DEEPSEEK_MODE)
    const runId = `${deepseekMode}-deepseek-${Date.now()}`
    const deepseekApiKey = deepseekMode === 'real'
        ? env.DEEPSEEK_API_KEY?.trim() || ''
        : 'fake-deepseek-smoke'
    const deepseekTimeoutMs = Math.max(
        5_000,
        parseNumber(env.SMOKE_DEEPSEEK_TIMEOUT_MS, deepseekMode === 'real' ? 60_000 : 5_000, 'SMOKE_DEEPSEEK_TIMEOUT_MS')
    )
    if (deepseekMode === 'real' && deepseekApiKey.length === 0) {
        throw new Error('DEEPSEEK_API_KEY is required when SMOKE_DEEPSEEK_MODE=real')
    }

    return {
        pg: {
            ...pgConfig,
            ssl: pgConfig.sslEnabled ? { rejectUnauthorized: false } : false,
        },
        fakePort: parseNumber(env.SMOKE_FAKE_DEEPSEEK_PORT, 0, 'SMOKE_FAKE_DEEPSEEK_PORT'),
        sessionId: env.SMOKE_SESSION_ID?.trim() || `smoke-${runId}-session`,
        namespace: env.SMOKE_NAMESPACE?.trim() || `smoke-${runId}`,
        workerConcurrency: Math.max(1, parseNumber(env.SMOKE_WORKER_CONCURRENCY, 1, 'SMOKE_WORKER_CONCURRENCY')),
        deepseekMode,
        deepseekBaseUrl: env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
        deepseekApiKey,
        deepseekTimeoutMs,
    }
}
