import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let cliPath: string
try {
    cliPath = require.resolve('@playwright/test/cli')
} catch {
    console.error(
        [
            'Unable to resolve @playwright/test from the e2e workspace.',
            'Run `bun install` from the repository root before running E2E tests.',
            'This launcher intentionally does not fall back to any system `playwright` command.',
        ].join('\n')
    )
    process.exit(1)
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
})

if (result.error) {
    console.error(result.error.message)
    process.exit(1)
}

process.exit(result.status ?? 1)
