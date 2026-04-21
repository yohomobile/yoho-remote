import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '../src/fixtures'

const execFileAsync = promisify(execFile)

const requiredPgEnv = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE', 'PG_BOSS_SCHEMA']

test.describe('P0 worker fake DeepSeek smoke', () => {
    test('runs the existing fake DeepSeek worker smoke when Postgres env is available', async ({ e2eEnv }) => {
        const missing = requiredPgEnv.filter(name => (process.env[name] ?? '').trim() === '')
        test.skip(
            missing.length > 0,
            `worker fake DeepSeek smoke needs Postgres env: ${missing.join(', ')}`
        )

        const { stdout } = await execFileAsync('bun', ['run', 'smoke:fake-deepseek'], {
            cwd: e2eEnv.rootDir,
            env: {
                ...process.env,
                SMOKE_DEEPSEEK_MODE: 'fake',
                SMOKE_ALLOW_DB_WRITE: 'true',
                SMOKE_SESSION_ID: `${e2eEnv.runId}-deepseek`,
                SMOKE_NAMESPACE: `${e2eEnv.runId}-deepseek`,
                SMOKE_TIMEOUT_MS: process.env.SMOKE_TIMEOUT_MS ?? '30000',
            },
            timeout: 45_000,
            maxBuffer: 1024 * 1024,
        })

        expect(stdout).toContain('fake DeepSeek')
        expect(stdout).toContain('smoke')
    })
})
