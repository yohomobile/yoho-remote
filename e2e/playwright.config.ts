import { defineConfig, devices } from '@playwright/test'
import { ensureE2ERunId, getE2EEnv } from './src/env'

ensureE2ERunId()
const env = getE2EEnv()
const reuseExistingServer = process.env.E2E_REUSE_EXISTING_SERVER === '1'
    || process.env.E2E_REUSE_EXISTING_SERVER === 'true'

export default defineConfig({
    testDir: './tests',
    outputDir: './test-results',
    globalSetup: './src/globalSetup.ts',
    globalTeardown: './src/globalTeardown.ts',
    timeout: 45_000,
    expect: {
        timeout: 10_000,
    },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: [
        ['list'],
        ['html', { outputFolder: './playwright-report', open: 'never' }],
        ['json', { outputFile: './artifacts/results.json' }],
        ['junit', { outputFile: './artifacts/results.xml' }],
    ],
    use: {
        baseURL: env.webBaseUrl,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    webServer: [
        {
            command: 'bun run mock:api',
            cwd: env.e2eDir,
            url: `${env.mockApiUrl}/__health`,
            reuseExistingServer,
            timeout: 20_000,
            env: {
                ...process.env,
                E2E_RUN_ID: env.runId,
                E2E_MOCK_API_PORT: String(env.mockApiPort),
                E2E_MOCK_API_URL: env.mockApiUrl,
                E2E_CLI_API_TOKEN: env.cliApiToken,
                E2E_KEYCLOAK_REALM: env.keycloakRealm,
                E2E_KEYCLOAK_CLIENT_ID: env.keycloakClientId,
                E2E_KEYCLOAK_CLIENT_SECRET: env.keycloakClientSecret,
                E2E_ARTIFACTS_DIR: env.artifactsDir,
                E2E_DB_SCHEMA: env.dbSchema,
            },
        },
        {
            command: `bun run dev --host 127.0.0.1 --port ${env.webPort}`,
            cwd: `${env.rootDir}/web`,
            url: env.webBaseUrl,
            reuseExistingServer,
            timeout: 30_000,
            env: {
                ...process.env,
                BROWSER: 'none',
            },
        },
    ],
    projects: [
        {
            name: 'chromium-smoke',
            use: {
                ...devices['Desktop Chrome'],
                channel: process.env.E2E_CHROME_CHANNEL || undefined,
            },
            testMatch: /.*\.smoke\.spec\.ts/,
        },
        {
            name: 'chromium-full',
            use: {
                ...devices['Desktop Chrome'],
                channel: process.env.E2E_CHROME_CHANNEL || undefined,
            },
        },
    ],
})
