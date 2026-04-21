import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type E2ERuntimeEnv = {
    runId: string
    rootDir: string
    e2eDir: string
    artifactsDir: string
    webPort: number
    mockApiPort: number
    webBaseUrl: string
    mockApiUrl: string
    cliApiToken: string
    keycloakRealm: string
    keycloakClientId: string
    keycloakClientSecret: string
    dbSchema: string
}

export function ensureE2ERunId(): string {
    if (!process.env.E2E_RUN_ID) {
        process.env.E2E_RUN_ID = `e2e-${Date.now()}`
    }
    return process.env.E2E_RUN_ID
}

function parsePort(value: string | undefined, fallback: number): number {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function getE2EEnv(): E2ERuntimeEnv {
    const rootDir = resolve(import.meta.dir, '..', '..')
    const e2eDir = resolve(rootDir, 'e2e')
    const runId = ensureE2ERunId()
    const webPort = parsePort(process.env.E2E_WEB_PORT, 46100)
    const mockApiPort = parsePort(process.env.E2E_MOCK_API_PORT, 46101)
    const artifactsDir = process.env.E2E_ARTIFACTS_DIR || join(e2eDir, 'artifacts', runId)

    return {
        runId,
        rootDir,
        e2eDir,
        artifactsDir,
        webPort,
        mockApiPort,
        webBaseUrl: process.env.E2E_WEB_BASE_URL || `http://127.0.0.1:${webPort}`,
        mockApiUrl: process.env.E2E_MOCK_API_URL || `http://127.0.0.1:${mockApiPort}`,
        cliApiToken: process.env.E2E_CLI_API_TOKEN || 'e2e-cli-token',
        keycloakRealm: process.env.E2E_KEYCLOAK_REALM || 'yoho',
        keycloakClientId: process.env.E2E_KEYCLOAK_CLIENT_ID || 'yoho-remote',
        keycloakClientSecret: process.env.E2E_KEYCLOAK_CLIENT_SECRET || 'e2e-client-secret',
        dbSchema: process.env.E2E_DB_SCHEMA || `e2e_${runId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
    }
}

export function writeE2EEnvFile(env: E2ERuntimeEnv): void {
    mkdirSync(env.artifactsDir, { recursive: true })
    writeFileSync(
        join(env.artifactsDir, 'env.json'),
        `${JSON.stringify(env, null, 4)}\n`
    )
}
