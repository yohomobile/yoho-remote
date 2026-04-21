import type { FullConfig } from '@playwright/test'
import { getE2EEnv, writeE2EEnvFile } from './env'

export default async function globalSetup(_config: FullConfig): Promise<void> {
    const env = getE2EEnv()

    process.env.E2E_RUN_ID = env.runId
    process.env.E2E_WEB_PORT = String(env.webPort)
    process.env.E2E_MOCK_API_PORT = String(env.mockApiPort)
    process.env.E2E_WEB_BASE_URL = env.webBaseUrl
    process.env.E2E_MOCK_API_URL = env.mockApiUrl
    process.env.E2E_ARTIFACTS_DIR = env.artifactsDir
    process.env.E2E_CLI_API_TOKEN = env.cliApiToken
    process.env.E2E_DB_SCHEMA = env.dbSchema

    writeE2EEnvFile(env)
}
