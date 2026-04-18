import { describe, expect, test } from 'bun:test'
import { loadFakeDeepseekSmokeConfig } from './fakeDeepseekSmokeConfig'

const baseEnv: NodeJS.ProcessEnv = {
    PG_HOST: 'db.example',
    PG_PORT: '5432',
    PG_USER: 'yoho',
    PG_PASSWORD: 'secret',
    PG_DATABASE: 'yoho_remote',
    PG_BOSS_SCHEMA: 'pgboss_smoke',
    SMOKE_ALLOW_DB_WRITE: 'true',
}

describe('loadFakeDeepseekSmokeConfig', () => {
    test('refuses to write unless db write is explicitly confirmed', () => {
        expect(() => loadFakeDeepseekSmokeConfig({
            ...baseEnv,
            SMOKE_ALLOW_DB_WRITE: undefined,
        }, ['bun', 'fakeDeepseekSmoke.ts'])).toThrow('SMOKE_ALLOW_DB_WRITE=true or --allow-db-write')
    })

    test('rejects unsafe default/production-like targets unless explicitly overridden', () => {
        expect(() => loadFakeDeepseekSmokeConfig({
            ...baseEnv,
            PG_BOSS_SCHEMA: 'pgboss',
        }, ['bun', 'fakeDeepseekSmoke.ts'])).toThrow('SMOKE_ALLOW_UNSAFE_DB_TARGET=true / --allow-unsafe-db-target')
    })

    test('accepts explicit safe target config', () => {
        const config = loadFakeDeepseekSmokeConfig(baseEnv, ['bun', 'fakeDeepseekSmoke.ts'])

        expect(config.pg.host).toBe('db.example')
        expect(config.pg.database).toBe('yoho_remote')
        expect(config.pg.bossSchema).toBe('pgboss_smoke')
        expect(config.sessionId.startsWith('smoke-fake-deepseek-')).toBe(true)
        expect(config.namespace.startsWith('smoke-fake-deepseek-')).toBe(true)
    })
})
