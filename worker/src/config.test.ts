import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'

const baseEnv: NodeJS.ProcessEnv = {
    PG_HOST: 'db.example',
    PG_PORT: '5432',
    PG_USER: 'yoho',
    PG_PASSWORD: '',
    PG_DATABASE: 'yoho_remote',
    PG_BOSS_SCHEMA: 'yr_boss',
    DEEPSEEK_API_KEY: 'secret',
    YOHO_WORKER_INTERNAL_TOKEN: 'worker-token',
}

describe('loadConfig', () => {
    test('requires explicit PG env instead of localhost/postgres defaults', () => {
        expect(() => loadConfig({
            ...baseEnv,
            PG_HOST: undefined,
        })).toThrow('PG_HOST is required')

        expect(() => loadConfig({
            ...baseEnv,
            PG_BOSS_SCHEMA: undefined,
        })).toThrow('PG_BOSS_SCHEMA is required')
    })

    test('accepts explicit config and preserves empty PG password when intentionally provided', () => {
        const config = loadConfig(baseEnv)

        expect(config.pg.host).toBe('db.example')
        expect(config.pg.port).toBe(5432)
        expect(config.pg.user).toBe('yoho')
        expect(config.pg.password).toBe('')
        expect(config.pg.database).toBe('yoho_remote')
        expect(config.bossSchema).toBe('yr_boss')
        expect(config.pg.connectionString).toBe('postgres://yoho:@db.example:5432/yoho_remote')
        expect(config.health).toEqual({
            host: '127.0.0.1',
            port: 0,
        })
        expect(config.yohoMemory).toEqual({
            enabled: true,
            url: 'http://127.0.0.1:3100',
            token: '',
            writeL1: true,
            writeL2: true,
            writeL3: true,
            saveSkillFromL2: true,
            saveSkillFromL3: true,
            requestTimeoutMs: 5000,
        })
        expect(config.summarizeTurnQueue).toEqual({
            retryLimit: 4,
            retryDelaySeconds: 15,
            retryBackoff: true,
            retryDelayMaxSeconds: 300,
        })
    })

    test('allows explicit summarize-turn retry/backoff tuning', () => {
        const config = loadConfig({
            ...baseEnv,
            SUMMARIZE_TURN_RETRY_LIMIT: '6',
            SUMMARIZE_TURN_RETRY_DELAY_SECONDS: '20',
            SUMMARIZE_TURN_RETRY_BACKOFF: 'false',
            SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS: '120',
        })

        expect(config.summarizeTurnQueue).toEqual({
            retryLimit: 6,
            retryDelaySeconds: 20,
            retryBackoff: false,
            retryDelayMaxSeconds: 120,
        })
    })

    test('allows enabling worker health endpoint explicitly', () => {
        const config = loadConfig({
            ...baseEnv,
            WORKER_HEALTH_HOST: '0.0.0.0',
            WORKER_HEALTH_PORT: '3102',
        })

        expect(config.health).toEqual({
            host: '0.0.0.0',
            port: 3102,
        })
    })

    test('allows tuning yoho-memory integration', () => {
        const config = loadConfig({
            ...baseEnv,
            YOHO_MEMORY_URL: 'http://127.0.0.1:3100/',
            YOHO_MEMORY_HTTP_AUTH_TOKEN: ' memory-token ',
            YOHO_MEMORY_INTEGRATION_ENABLED: 'false',
            YOHO_MEMORY_WRITE_L1: 'false',
            YOHO_MEMORY_WRITE_L2: 'true',
            YOHO_MEMORY_WRITE_L3: '0',
            YOHO_SKILL_SAVE_FROM_L2: 'yes',
            YOHO_SKILL_SAVE_FROM_L3: 'off',
            YOHO_MEMORY_REQUEST_TIMEOUT_MS: '2500',
        })

        expect(config.yohoMemory).toEqual({
            enabled: false,
            url: 'http://127.0.0.1:3100',
            token: 'memory-token',
            writeL1: false,
            writeL2: true,
            writeL3: false,
            saveSkillFromL2: true,
            saveSkillFromL3: false,
            requestTimeoutMs: 2500,
        })
    })
})
