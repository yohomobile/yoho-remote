import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { getE2EEnv } from './env'

export default async function globalTeardown(_config: FullConfig): Promise<void> {
    const env = getE2EEnv()
    mkdirSync(env.artifactsDir, { recursive: true })
    appendFileSync(
        join(env.artifactsDir, 'teardown.log'),
        `teardown completed for ${env.runId} at ${new Date().toISOString()}\n`
    )
}
