#!/usr/bin/env bun

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
    applyBrainSessionManualRepairs,
    buildBrainSessionManualRepairPlan,
    buildBrainSessionManualRepairSnapshot,
    parseBrainSessionManualRepairManifest,
    type BrainSessionManualRepairFieldDiff,
} from '../src/brain/brainSessionManualRepair'
import { loadRequiredPgConfig } from '../src/pgConfig'
import { PostgresStore } from '../src/store/postgres'

type Options = {
    manifestPath: string | null
    apply: boolean
    format: 'text' | 'json'
    limit: number
    snapshotFile: string | null
    help: boolean
}

function printUsage(): void {
    console.log(`Usage:
  bun run scripts/repair-brain-sessions.ts --manifest=<path> [options]

Offline manual repair runner for confirmed brain / brain-child manifests.

Guardrails:
  - default dry-run
  - only writes with --apply
  - always skips active sessions
  - validates every change against current schema before writing
  - writes a before-change snapshot JSON before any apply
  - does not restart any service

Manifest schema (version 1):
  {
    "version": 1,
    "items": [
      {
        "sessionId": "brain-child-1",
        "action": "set-brainPreferences",
        "copyFromSessionId": "brain-parent-1"
      },
      {
        "sessionId": "brain-child-2",
        "action": "set-permissionMode",
        "permissionMode": "yolo"
      }
    ]
  }

Options:
  --manifest=<path>      Required manifest file path
  --apply                Apply writes to the store
  --snapshot-file=<path> Override snapshot output path used by --apply
  --format=<text|json>   Output format (default: text)
  --limit=<n>            Max rows shown per section in text mode (default: 20)
  --help, -h             Show this help
`)
}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        manifestPath: null,
        apply: false,
        format: 'text',
        limit: 20,
        snapshotFile: null,
        help: false,
    }

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            options.help = true
            continue
        }
        if (arg === '--apply') {
            options.apply = true
            continue
        }
        if (arg.startsWith('--manifest=')) {
            options.manifestPath = arg.slice('--manifest='.length).trim() || null
            continue
        }
        if (arg.startsWith('--snapshot-file=')) {
            options.snapshotFile = arg.slice('--snapshot-file='.length).trim() || null
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

function formatPrettyJson(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? 'null'
}

function renderDiff(diff: BrainSessionManualRepairFieldDiff): string[] {
    return [
        `    field=${diff.field}`,
        `    before=${formatPrettyJson(diff.before)}`,
        `    after=${formatPrettyJson(diff.after)}`,
    ]
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

function buildDefaultSnapshotPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return resolve(process.cwd(), 'tmp', 'brain-session-manual-repair-snapshots', `brain-session-manual-repair-${stamp}.json`)
}

async function ensureSnapshotPathWritable(snapshotPath: string): Promise<void> {
    try {
        await access(snapshotPath)
        throw new Error(`Snapshot file already exists: ${snapshotPath}`)
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
        if (code !== 'ENOENT') {
            throw error
        }
    }
    await mkdir(dirname(snapshotPath), { recursive: true })
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printUsage()
        return
    }
    if (!options.manifestPath) {
        throw new Error('Missing required --manifest=<path>')
    }

    const manifestPath = resolve(options.manifestPath)
    const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    const manifest = parseBrainSessionManualRepairManifest(rawManifest)
    if (!manifest) {
        throw new Error('Manifest does not match schema version 1')
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
        const sessions = await store.getSessions()
        const plan = buildBrainSessionManualRepairPlan(sessions, manifest)
        const guardrails = {
            requiresManifest: true,
            defaultDryRun: true,
            requiresApplyFlag: true,
            alwaysSkipActive: true,
            validateAgainstCurrentSchema: true,
            restartServices: false,
        }

        if (options.format === 'text') {
            console.log('Brain Session Manual Repair')
            console.log(`Mode: ${options.apply ? 'apply' : 'dry-run'}`)
            console.log(`Manifest: ${manifestPath}`)
            console.log('Guardrails: manifest-required=true dry-run-by-default=true apply-flag-required=true skip-active=true validate-before-write=true restart=false')
            console.log(`Summary: planned=${plan.summary.plannedWrites} skippedActive=${plan.summary.skippedActive} skippedNoop=${plan.summary.skippedNoop} rejected=${plan.summary.rejected}`)

            printSection('Planned changes', plan.planned, options.limit, (item) => {
                const lines = [
                    `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace} source=${item.source} action=${item.action}`,
                ]
                if (item.reason) {
                    lines.push(`    reason=${item.reason}`)
                }
                if (item.action === 'set-brainPreferences' && item.copyFromSessionId) {
                    lines.push(`    copyFromSessionId=${item.copyFromSessionId}`)
                }
                lines.push(...renderDiff(item.diff))
                return lines
            })

            printSection('Skipped active', plan.skippedActive, options.limit, (item) => [
                `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace}`,
                `    reason=${item.reason}`,
            ])

            printSection('Skipped no-op', plan.skippedNoop, options.limit, (item) => [
                `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace}`,
                `    reason=${item.reason}`,
            ])

            printSection('Rejected manifest items', plan.rejected, options.limit, (item) => [
                `  - [${item.manifestIndex}] session=${item.sessionId ?? 'unknown'}`,
                `    reason=${item.reason}`,
            ])
        }

        if (plan.rejected.length > 0) {
            if (options.format === 'json') {
                console.log(JSON.stringify({
                    mode: options.apply ? 'apply' : 'dry-run',
                    guardrails,
                    manifestPath,
                    plan,
                    error: 'Manifest contains rejected items; fix the manifest before applying',
                }, null, 2))
            }
            process.exitCode = 1
            return
        }

        if (!options.apply) {
            if (options.format === 'json') {
                console.log(JSON.stringify({
                    mode: 'dry-run',
                    guardrails,
                    manifestPath,
                    plan,
                }, null, 2))
            }
            return
        }

        if (plan.planned.length === 0) {
            if (options.format === 'json') {
                console.log(JSON.stringify({
                    mode: 'apply',
                    guardrails,
                    manifestPath,
                    plan,
                    snapshotPath: null,
                    result: null,
                }, null, 2))
                return
            }
            if (options.format === 'text') {
                console.log('')
                console.log('No eligible writes. No snapshot created. No data changed.')
            }
            return
        }

        const snapshotPath = options.snapshotFile
            ? resolve(options.snapshotFile)
            : buildDefaultSnapshotPath()
        await ensureSnapshotPathWritable(snapshotPath)
        const snapshot = buildBrainSessionManualRepairSnapshot(plan)
        await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

        const result = await applyBrainSessionManualRepairs(store, plan)

        if (options.format === 'json') {
            console.log(JSON.stringify({
                mode: 'apply',
                guardrails,
                manifestPath,
                plan,
                snapshotPath,
                result,
            }, null, 2))
            return
        }

        console.log('')
        console.log(`Snapshot: ${snapshotPath}`)
        console.log(`Apply result: applied=${result.applied.length} skippedActive=${result.skippedActive.length} skippedDrifted=${result.skippedDrifted.length} failed=${result.failed.length}`)

        printSection('Applied', result.applied, options.limit, (item) => [
            `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace} action=${item.action}`,
        ])

        printSection('Apply skipped active', result.skippedActive, options.limit, (item) => [
            `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace}`,
            `    reason=${item.reason}`,
        ])

        printSection('Apply skipped drifted', result.skippedDrifted, options.limit, (item) => [
            `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace}`,
            `    reason=${item.reason}`,
        ])

        printSection('Apply failed', result.failed, options.limit, (item) => [
            `  - [${item.manifestIndex}] session=${item.sessionId} ns=${item.namespace}`,
            `    reason=${item.reason}`,
        ])
    } finally {
        await store.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
