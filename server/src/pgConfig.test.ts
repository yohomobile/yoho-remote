import { describe, expect, test } from 'bun:test'
import { loadRequiredPgConfig } from './pgConfig'

describe('loadRequiredPgConfig', () => {
    test('loads explicit postgres env without falling back to localhost defaults', () => {
        const config = loadRequiredPgConfig({
            PG_HOST: 'db.example',
            PG_PORT: '5433',
            PG_USER: 'yoho',
            PG_PASSWORD: '',
            PG_DATABASE: 'yoho_remote',
            PG_SSL: 'true',
            PG_BOSS_SCHEMA: 'yr_boss',
        })

        expect(config).toEqual({
            host: 'db.example',
            port: 5433,
            user: 'yoho',
            password: '',
            database: 'yoho_remote',
            sslEnabled: true,
            bossSchema: 'yr_boss',
        })
    })

    test('fails closed when PG connection env is missing', () => {
        expect(() => loadRequiredPgConfig({
            PG_PORT: '5432',
            PG_USER: 'yoho',
            PG_PASSWORD: 'secret',
            PG_DATABASE: 'yoho_remote',
            PG_BOSS_SCHEMA: 'yr_boss',
        })).toThrow('PG_HOST is required')
    })

    test('fails closed when PG_BOSS_SCHEMA is missing', () => {
        expect(() => loadRequiredPgConfig({
            PG_HOST: 'db.example',
            PG_PORT: '5432',
            PG_USER: 'yoho',
            PG_PASSWORD: 'secret',
            PG_DATABASE: 'yoho_remote',
        })).toThrow('PG_BOSS_SCHEMA is required')
    })
})
