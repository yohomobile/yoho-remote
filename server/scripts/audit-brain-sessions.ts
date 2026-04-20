#!/usr/bin/env bun

import { auditBrainSessions } from '../src/brain/brainSessionAudit'
import { loadRequiredPgConfig } from '../src/pgConfig'
import { PostgresStore } from '../src/store/postgres'

type Options = {
    namespace: string | null
    format: 'text' | 'json'
    limit: number
    help: boolean
}

function printUsage(): void {
    console.log(`Usage:
  bun run scripts/audit-brain-sessions.ts [options]

Read-only dry-run audit for persisted brain / brain-child session rows.
It scans session store records and reports:
  - invalid brainPreferences metadata
  - dirty / legacy permissionMode values
  - inactive candidates that look safe to auto-fix later
  - active sessions that must stay blocked from any offline auto-fix manifest

The JSON report is intended as review input for a manually curated manifest.
It includes audit-time target snapshots for safe fixes, but this script never writes data.

Options:
  --namespace=<name>     Only scan one namespace
  --format=<text|json>   Output format (default: text)
  --limit=<n>            Max rows shown per section in text mode (default: 20)
  --help, -h             Show this help
`)
}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        namespace: null,
        format: 'text',
        limit: 20,
        help: false,
    }

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            options.help = true
            continue
        }
        if (arg.startsWith('--namespace=')) {
            options.namespace = arg.slice('--namespace='.length).trim() || null
            continue
        }
        if (arg.startsWith('--format=')) {
            const format = arg.slice('--format='.length).trim()
            if (format !== 'text' && format !== 'json') {
                throw new Error(`Unsupported --format value: ${format}`)
            }
            options.format = format
            continue
        }
        if (arg.startsWith('--limit=')) {
            const limit = Number(arg.slice('--limit='.length))
            if (!Number.isInteger(limit) || limit < 1) {
                throw new Error('--limit must be a positive integer')
            }
            options.limit = limit
            continue
        }

        throw new Error(`Unknown argument: ${arg}`)
    }

    return options
}

function renderLocation(input: {
    namespace: string
    source: string
    flavor: string | null
    path: string | null
    machineId: string | null
}): string {
    const parts = [
        `ns=${input.namespace}`,
        `source=${input.source}`,
        `flavor=${input.flavor ?? 'unknown'}`,
    ]
    if (input.machineId) {
        parts.push(`machine=${input.machineId}`)
    }
    if (input.path) {
        parts.push(`path=${input.path}`)
    }
    return parts.join(' ')
}

function printSection<T>(
    title: string,
    items: readonly T[],
    limit: number,
    render: (item: T) => string[]
): void {
    console.log('')
    console.log(`${title}: ${items.length}`)
    if (items.length === 0) {
        console.log('  (none)')
        return
    }

    for (const item of items.slice(0, limit)) {
        for (const line of render(item)) {
            console.log(line)
        }
    }

    if (items.length > limit) {
        console.log(`  ... 还有 ${items.length - limit} 条未展示`)
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printUsage()
        return
    }

    const pgConfig = loadRequiredPgConfig()
    const store = await PostgresStore.create({
        host: pgConfig.host,
        port: pgConfig.port,
        user: pgConfig.user,
        password: pgConfig.password,
        database: pgConfig.database,
        ssl: pgConfig.sslEnabled,
        bossSchema: pgConfig.bossSchema,
    })

    try {
        const sessions = options.namespace
            ? await store.getSessionsByNamespace(options.namespace)
            : await store.getSessions()
        const report = auditBrainSessions(sessions)

        if (options.format === 'json') {
            console.log(JSON.stringify({
                mode: 'dry-run',
                namespace: options.namespace,
                report,
            }, null, 2))
            return
        }

        console.log('Brain Session Audit')
        console.log(`Mode: dry-run (read-only)`)
        console.log(`Namespace: ${options.namespace ?? 'ALL'}`)
        console.log(`GeneratedAt: ${new Date(report.generatedAt).toISOString()}`)
        console.log(`Scanned: total=${report.summary.totalSessions}, brain=${report.summary.brainSessions}, brain-child=${report.summary.brainChildSessions}`)
        console.log(`Issues: invalidBrainPreferences=${report.summary.invalidBrainPreferences}, dirtyPermissionModes=${report.summary.dirtyPermissionModes}, autoFixable=${report.summary.autoFixable}, blockedByActive=${report.summary.blockedByActive}`)

        printSection('Invalid brainPreferences', report.invalidBrainPreferences, options.limit, (item) => {
            const lines = [
                `  - ${item.sessionId} ${renderLocation(item)}`,
                `    reason=${item.reason}`,
            ]
            if (item.mainSessionId) {
                lines.push(`    mainSessionId=${item.mainSessionId}`)
            }
            if (item.autoFix?.kind === 'copy-parent-brainPreferences') {
                lines.push(`    suggestedFix=copy parent brainPreferences from ${item.autoFix.parentSessionId}`)
            }
            return lines
        })

        printSection('Dirty permissionMode', report.dirtyPermissionModes, options.limit, (item) => {
            const lines = [
                `  - ${item.sessionId} ${renderLocation(item)}`,
                `    stored=${item.storedPermissionMode} normalized=${item.normalizedPermissionMode ?? 'null'}`,
                `    reason=${item.reason}`,
            ]
            if (item.autoFix?.kind === 'normalize-permissionMode') {
                lines.push(`    suggestedFix=set permissionMode=${item.autoFix.nextPermissionMode}`)
            }
            return lines
        })

        printSection('Potential auto-fix candidates', report.autoFixable, options.limit, (item) => {
            const fix = item.fix.kind === 'copy-parent-brainPreferences'
                ? `replace brainPreferences with audit-time snapshot from ${item.fix.parentSessionId}`
                : `set permissionMode=${item.fix.nextPermissionMode}`
            return [
                `  - ${item.sessionId} ns=${item.namespace} source=${item.source} issue=${item.issue}`,
                `    expectedUpdatedAt=${item.updatedAt}`,
                `    fix=${fix}`,
            ]
        })

        printSection('Blocked active sessions', report.blockedAutoFixable, options.limit, (item) => {
            const fix = item.fix.kind === 'copy-parent-brainPreferences'
                ? `replace brainPreferences with audit-time snapshot from ${item.fix.parentSessionId}`
                : `set permissionMode=${item.fix.nextPermissionMode}`
            return [
                `  - ${item.sessionId} ns=${item.namespace} source=${item.source} issue=${item.issue}`,
                `    expectedUpdatedAt=${item.updatedAt}`,
                `    blockedReason=${item.blockedReason}`,
                `    proposedFix=${fix}`,
            ]
        })
    } finally {
        await store.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
