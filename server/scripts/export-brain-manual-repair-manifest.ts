#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBrainSessionPreferences } from '../src/brain/brainSessionPreferences'
import { loadRequiredPgConfig } from '../src/pgConfig'
import { PostgresStore } from '../src/store/postgres'
import type { StoredSession } from '../src/store/types'

type Options = {
    namespace: string | null
    format: 'json'
    output: string | null
    envFile: string | null
    help: boolean
}

type ManifestItem = {
    sessionId: string
    namespace: string
    source: 'brain' | 'brain-child'
    flavor: 'claude' | 'codex' | null
    mainSessionId: string | null
    machineId: string | null
    createdAt: number
    updatedAt: number
    activeAt: number | null
    lastMessageAt: number | null
    nativeResumeSessionId: string | null
    permissionMode: string | null
    modelMode: string | null
    modelReasoningEffort: string | null
    hasParentSession: boolean
    parentSessionExists: boolean
    parentSessionActive: boolean | null
    parentSessionLastMessageAt: number | null
    referenceCompleteParentBrainPreferences: boolean
    referenceCompleteSiblingCount: number
    referenceCompleteChildCount: number
    hasAnyReferenceSource: boolean
    hasTokenSourceId: boolean
    hasBrainTokenSourceIds: boolean
    suggestedManualConfirmationFields: string[]
}

type ManifestSummary = {
    targetSessions: number
    bySourceFlavor: Array<{
        source: 'brain' | 'brain-child'
        flavor: 'claude' | 'codex' | 'unknown'
        count: number
    }>
    byParentState: Array<{
        source: 'brain' | 'brain-child'
        flavor: 'claude' | 'codex' | 'unknown'
        hasParentSession: boolean
        parentSessionExists: boolean
        referenceCompleteParentBrainPreferences: boolean
        count: number
    }>
    byReferenceAvailability: Array<{
        source: 'brain' | 'brain-child'
        flavor: 'claude' | 'codex' | 'unknown'
        hasAnyReferenceSource: boolean
        count: number
    }>
}

type Manifest = {
    generatedAt: string
    mode: 'read-only'
    criteria: {
        sourceIn: ['brain', 'brain-child']
        inactiveOnly: true
        resumeCandidateOnly: true
        missingBrainPreferencesOnly: true
    }
    dataSource: {
        type: 'postgres'
        host: string
        port: number
        database: string
        namespace: string | null
    }
    summary: ManifestSummary
    items: ManifestItem[]
}

function printUsage(): void {
    console.log(`Usage:
  bun run scripts/export-brain-manual-repair-manifest.ts [options]

Export a read-only manual repair manifest for persisted brain / brain-child
sessions that match all of:
  - inactive
  - have a native resume id
  - metadata.brainPreferences is completely missing

Options:
  --namespace=<name>     Only scan one namespace
  --output=<path>        Write JSON manifest to this file
  --env-file=<path>      Load env vars from a dotenv-style file before connecting
  --format=json          Output format (default: json)
  --help, -h             Show this help
`)
}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        namespace: null,
        format: 'json',
        output: null,
        envFile: null,
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
        if (arg.startsWith('--output=')) {
            options.output = arg.slice('--output='.length).trim() || null
            continue
        }
        if (arg.startsWith('--env-file=')) {
            options.envFile = arg.slice('--env-file='.length).trim() || null
            continue
        }
        if (arg.startsWith('--format=')) {
            const format = arg.slice('--format='.length).trim()
            if (format !== 'json') {
                throw new Error(`Unsupported --format value: ${format}`)
            }
            options.format = format
            continue
        }

        throw new Error(`Unknown argument: ${arg}`)
    }

    return options
}

function loadEnvFileIfPresent(path: string): void {
    if (!existsSync(path)) {
        return
    }

    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) {
            continue
        }
        const index = line.indexOf('=')
        if (index < 0) {
            continue
        }
        const key = line.slice(0, index).trim()
        const value = line.slice(index + 1)
        if (process.env[key] == null || process.env[key] === '') {
            process.env[key] = value
        }
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function hasOwn(record: Record<string, unknown> | null, key: string): boolean {
    if (!record) {
        return false
    }
    return Object.prototype.hasOwnProperty.call(record, key)
}

function getFlavor(metadata: Record<string, unknown> | null): 'claude' | 'codex' | null {
    const flavor = asNonEmptyString(metadata?.flavor)
    return flavor === 'claude' || flavor === 'codex' ? flavor : null
}

function getSource(metadata: Record<string, unknown> | null): 'brain' | 'brain-child' | null {
    const source = asNonEmptyString(metadata?.source)
    return source === 'brain' || source === 'brain-child' ? source : null
}

function getNativeResumeSessionId(metadata: Record<string, unknown> | null): string | null {
    const flavor = getFlavor(metadata)
    if (flavor === 'claude') {
        return asNonEmptyString(metadata?.claudeSessionId)
    }
    if (flavor === 'codex') {
        return asNonEmptyString(metadata?.codexSessionId)
    }
    return null
}

function hasCompleteBrainPreferences(metadata: Record<string, unknown> | null): boolean {
    if (!metadata || !hasOwn(metadata, 'brainPreferences')) {
        return false
    }
    return parseBrainSessionPreferences(metadata.brainPreferences) !== null
}

function hasMissingBrainPreferences(metadata: Record<string, unknown> | null): boolean {
    return !hasOwn(metadata, 'brainPreferences')
}

function hasTokenSourceId(metadata: Record<string, unknown> | null): boolean {
    return Boolean(asNonEmptyString(metadata?.tokenSourceId))
}

function hasBrainTokenSourceIds(metadata: Record<string, unknown> | null): boolean {
    const record = asRecord(metadata?.brainTokenSourceIds)
    return Boolean(asNonEmptyString(record?.claude) || asNonEmptyString(record?.codex))
}

function buildSuggestedManualConfirmationFields(source: 'brain' | 'brain-child'): string[] {
    const fields = [
        'brainPreferences.machineSelection.mode',
        'brainPreferences.machineSelection.machineId',
        'brainPreferences.childModels.claude.allowed',
        'brainPreferences.childModels.claude.defaultModel',
        'brainPreferences.childModels.codex.allowed',
        'brainPreferences.childModels.codex.defaultModel',
    ]

    if (source === 'brain-child') {
        fields.unshift('确认是否应直接继承父 brain 的 brainPreferences')
    }

    return fields
}

function summarizeCounts<T>(
    items: readonly T[],
    buildKey: (item: T) => string
): Array<{ key: string; count: number }> {
    const counts = new Map<string, number>()
    for (const item of items) {
        const key = buildKey(item)
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function buildManifestSummary(items: readonly ManifestItem[]): ManifestSummary {
    const bySourceFlavor = summarizeCounts(
        items,
        (item) => `${item.source}|${item.flavor ?? 'unknown'}`
    ).map((entry) => {
        const [source, flavor] = entry.key.split('|')
        return {
            source: source as 'brain' | 'brain-child',
            flavor: flavor as 'claude' | 'codex' | 'unknown',
            count: entry.count,
        }
    })

    const byParentState = summarizeCounts(
        items,
        (item) => `${item.source}|${item.flavor ?? 'unknown'}|${item.hasParentSession}|${item.parentSessionExists}|${item.referenceCompleteParentBrainPreferences}`
    ).map((entry) => {
        const [source, flavor, hasParentSession, parentSessionExists, referenceCompleteParentBrainPreferences] = entry.key.split('|')
        return {
            source: source as 'brain' | 'brain-child',
            flavor: flavor as 'claude' | 'codex' | 'unknown',
            hasParentSession: hasParentSession === 'true',
            parentSessionExists: parentSessionExists === 'true',
            referenceCompleteParentBrainPreferences: referenceCompleteParentBrainPreferences === 'true',
            count: entry.count,
        }
    })

    const byReferenceAvailability = summarizeCounts(
        items,
        (item) => `${item.source}|${item.flavor ?? 'unknown'}|${item.hasAnyReferenceSource}`
    ).map((entry) => {
        const [source, flavor, hasAnyReferenceSource] = entry.key.split('|')
        return {
            source: source as 'brain' | 'brain-child',
            flavor: flavor as 'claude' | 'codex' | 'unknown',
            hasAnyReferenceSource: hasAnyReferenceSource === 'true',
            count: entry.count,
        }
    })

    return {
        targetSessions: items.length,
        bySourceFlavor,
        byParentState,
        byReferenceAvailability,
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printUsage()
        return
    }

    const scriptDir = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(scriptDir, '../..')
    loadEnvFileIfPresent(options.envFile ?? join(repoRoot, '.env'))

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

        const scannedSessions = sessions.filter((session) => {
            const metadata = asRecord(session.metadata)
            return getSource(metadata) !== null
        })
        const sessionsById = new Map(scannedSessions.map((session) => [session.id, session]))
        const childrenByMainSessionId = new Map<string, StoredSession[]>()

        for (const session of scannedSessions) {
            const metadata = asRecord(session.metadata)
            const mainSessionId = asNonEmptyString(metadata?.mainSessionId)
            if (!mainSessionId) {
                continue
            }
            const bucket = childrenByMainSessionId.get(mainSessionId) ?? []
            bucket.push(session)
            childrenByMainSessionId.set(mainSessionId, bucket)
        }

        const items: ManifestItem[] = scannedSessions
            .filter((session) => {
                const metadata = asRecord(session.metadata)
                return !session.active
                    && hasMissingBrainPreferences(metadata)
                    && getNativeResumeSessionId(metadata) !== null
            })
            .map((session) => {
                const metadata = asRecord(session.metadata)
                const source = getSource(metadata)!
                const flavor = getFlavor(metadata)
                const mainSessionId = asNonEmptyString(metadata?.mainSessionId)
                const parentSession = mainSessionId ? sessionsById.get(mainSessionId) ?? null : null
                const parentMetadata = asRecord(parentSession?.metadata)
                const siblingSessions = mainSessionId
                    ? (childrenByMainSessionId.get(mainSessionId) ?? []).filter((item) => item.id !== session.id)
                    : []
                const childSessions = source === 'brain'
                    ? (childrenByMainSessionId.get(session.id) ?? [])
                    : []

                const referenceCompleteSiblingCount = siblingSessions
                    .filter((item) => hasCompleteBrainPreferences(asRecord(item.metadata)))
                    .length
                const referenceCompleteChildCount = childSessions
                    .filter((item) => hasCompleteBrainPreferences(asRecord(item.metadata)))
                    .length
                const referenceCompleteParentBrainPreferences = hasCompleteBrainPreferences(parentMetadata)

                return {
                    sessionId: session.id,
                    namespace: session.namespace,
                    source,
                    flavor,
                    mainSessionId,
                    machineId: session.machineId ?? asNonEmptyString(metadata?.machineId),
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    activeAt: session.activeAt,
                    lastMessageAt: session.lastMessageAt,
                    nativeResumeSessionId: getNativeResumeSessionId(metadata),
                    permissionMode: session.permissionMode,
                    modelMode: session.modelMode,
                    modelReasoningEffort: session.modelReasoningEffort,
                    hasParentSession: Boolean(mainSessionId),
                    parentSessionExists: Boolean(parentSession),
                    parentSessionActive: parentSession ? parentSession.active : null,
                    parentSessionLastMessageAt: parentSession?.lastMessageAt ?? null,
                    referenceCompleteParentBrainPreferences,
                    referenceCompleteSiblingCount,
                    referenceCompleteChildCount,
                    hasAnyReferenceSource: referenceCompleteParentBrainPreferences
                        || referenceCompleteSiblingCount > 0
                        || referenceCompleteChildCount > 0,
                    hasTokenSourceId: hasTokenSourceId(metadata),
                    hasBrainTokenSourceIds: hasBrainTokenSourceIds(metadata),
                    suggestedManualConfirmationFields: buildSuggestedManualConfirmationFields(source),
                }
            })
            .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))

        const manifest: Manifest = {
            generatedAt: new Date().toISOString(),
            mode: 'read-only',
            criteria: {
                sourceIn: ['brain', 'brain-child'],
                inactiveOnly: true,
                resumeCandidateOnly: true,
                missingBrainPreferencesOnly: true,
            },
            dataSource: {
                type: 'postgres',
                host: pgConfig.host,
                port: pgConfig.port,
                database: pgConfig.database,
                namespace: options.namespace,
            },
            summary: buildManifestSummary(items),
            items,
        }

        const payload = JSON.stringify(manifest, null, 2)
        if (options.output) {
            writeFileSync(options.output, payload)
            console.log(`Wrote read-only manifest to ${options.output}`)
            console.log(`Items: ${items.length}`)
            return
        }

        console.log(payload)
    } finally {
        await store.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(1)
})
