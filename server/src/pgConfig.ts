function parseNumber(value: string, label: string): number {
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

export type RequiredPgConfig = {
    host: string
    port: number
    user: string
    password: string
    database: string
    sslEnabled: boolean
    bossSchema: string
}

export function loadRequiredPgConfig(env: NodeJS.ProcessEnv = process.env): RequiredPgConfig {
    return {
        host: readRequiredEnv(env, 'PG_HOST'),
        port: parseNumber(readRequiredEnv(env, 'PG_PORT'), 'PG_PORT'),
        user: readRequiredEnv(env, 'PG_USER'),
        password: readRequiredEnv(env, 'PG_PASSWORD', { allowEmpty: true }),
        database: readRequiredEnv(env, 'PG_DATABASE'),
        sslEnabled: parseBoolean(env.PG_SSL, false),
        bossSchema: readRequiredEnv(env, 'PG_BOSS_SCHEMA'),
    }
}
