#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadRequiredPgConfig } from '../src/pgConfig'
import { PostgresStore } from '../src/store/postgres'
import type { StoredSession } from '../src/store/types'

type ExportManifestItem = {
    sessionId: string
    namespace: string
    source: 'brain' | 'brain-child'
    flavor: 'claude' | 'codex' | null
    machineId: string | null
    createdAt: number
    updatedAt: number
    hasTokenSourceId: boolean
    hasBrainTokenSourceIds: boolean
}

type ExportManifest = {
    generatedAt: string
    items: ExportManifestItem[]
}

type Confidence = 'high' | 'medium' | 'low'

type SuggestedClaudeModels = {
    allowed: ('sonnet' | 'opus' | 'opus-4-7')[]
    defaultModel: 'sonnet' | 'opus' | 'opus-4-7'
}

type SuggestionEntry = {
    sessionId: string
    confidence: Confidence
    basis: string[]
    unresolved: string[]
    session: {
        createdAt: number
        updatedAt: number
        createdBy: string | null
        host: string | null
        version: string | null
        machineId: string | null
        summary: string | null
        runtimeModel: string | null
        childCount: number
    }
    candidate: {
        machineSelection: {
            mode: 'auto' | 'manual' | null
            machineId: string | null
        }
        childModels: {
            claude: SuggestedClaudeModels | null
            codex: null
        }
    }
    observedChildren: Array<{
        sessionId: string
        flavor: string | null
        modelMode: string | null
        runtimeModel: string | null
        summary: string | null
    }>
    cohort: {
        host: string | null
        version: string | null
        targetCount: number
        sessionsWithClaudeChildEvidence: number
        observedClaudeFamilies: string[]
    }
}

type SuggestionReport = {
    generatedAt: string
    sourceManifest: string
    selection: {
        source: 'brain'
        flavor: 'claude'
        batchSize: number
    }
    summary: {
        high: number
        medium: number
        low: number
    }
    suggestions: SuggestionEntry[]
}

type SessionMeta = Record<string, unknown>

const BRAIN_PREFERENCES_INTRO_VERSION = 'v2026.04.14.0219'

function asRecord(value: unknown): SessionMeta | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as SessionMeta
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function readManifest(path: string): ExportManifest {
    return JSON.parse(readFileSync(path, 'utf8')) as ExportManifest
}

function getMeta(session: StoredSession): SessionMeta | null {
    return asRecord(session.metadata)
}

function getSummaryText(meta: SessionMeta | null): string | null {
    const summary = asRecord(meta?.summary)
    return asNonEmptyString(summary?.text)
}

function normalizeClaudeFamily(modelMode: string | null, runtimeModel: string | null): 'sonnet' | 'opus' | 'opus-4-7' | null {
    const raw = `${modelMode ?? ''} ${runtimeModel ?? ''}`.toLowerCase()
    if (!raw.trim()) {
        return null
    }
    if (raw.includes('opus-4-7')) {
        return 'opus-4-7'
    }
    if (raw.includes('opus')) {
        return 'opus'
    }
    if (raw.includes('sonnet')) {
        return 'sonnet'
    }
    return null
}

function compareClaudeFamilies(
    left: 'sonnet' | 'opus' | 'opus-4-7',
    right: 'sonnet' | 'opus' | 'opus-4-7',
): number {
    const order = ['sonnet', 'opus', 'opus-4-7'] as const
    return order.indexOf(left) - order.indexOf(right)
}

function inferMachineSelectionMode(session: StoredSession): {
    mode: 'auto' | 'manual' | null
    confidence: Confidence
    basis: string[]
} {
    const meta = getMeta(session)
    const summary = getSummaryText(meta)
    const version = asNonEmptyString(meta?.version)
    const createdBy = asNonEmptyString(session.createdBy)
    const path = asNonEmptyString(meta?.path)
    const startedBy = asNonEmptyString(meta?.startedBy)
    const isPostPreferencesVersion = Boolean(
        version && version >= BRAIN_PREFERENCES_INTRO_VERSION,
    )
    const basis: string[] = []

    if (startedBy === 'daemon') {
        basis.push('startedBy=daemon')
    }
    if (path?.endsWith('/brain-workspace')) {
        basis.push('path 指向固定 brain-workspace')
    }
    if (summary?.startsWith('飞书')) {
        basis.push(`summary 表示 Feishu Brain 自动创建: ${summary}`)
    }
    if (!createdBy) {
        basis.push('createdBy 为空，更接近 bot/daemon 自动创建')
    } else {
        basis.push(`createdBy=${createdBy}`)
    }
    if (version && version < BRAIN_PREFERENCES_INTRO_VERSION) {
        basis.push(`version=${version} 早于 brainPreferences 引入版本`)
        return {
            mode: 'auto',
            confidence: 'high',
            basis,
        }
    }
    if (version && isPostPreferencesVersion) {
        basis.push(`version=${version} 已晚于 brainPreferences 引入版本`)
    }
    if (summary?.startsWith('飞书')) {
        return {
            mode: 'auto',
            confidence: 'high',
            basis,
        }
    }
    if (!createdBy && startedBy === 'daemon' && path?.endsWith('/brain-workspace')) {
        return {
            mode: 'auto',
            confidence: isPostPreferencesVersion ? 'medium' : 'high',
            basis,
        }
    }
    if (startedBy === 'daemon' && path?.endsWith('/brain-workspace')) {
        if (isPostPreferencesVersion) {
            basis.push('post-feature 缺失 brainPreferences 属于异常，不能仅凭 daemon/path 推断 auto')
            return {
                mode: null,
                confidence: 'low',
                basis,
            }
        }
        return {
            mode: 'auto',
            confidence: 'medium',
            basis,
        }
    }
    return {
        mode: null,
        confidence: 'low',
        basis,
    }
}

function inferClaudeChildModels(args: {
    directChildren: StoredSession[]
    cohortChildren: StoredSession[]
}): {
    suggestion: SuggestedClaudeModels | null
    confidence: Confidence | null
    basis: string[]
} {
    const summarize = (children: StoredSession[]) => {
        const counts = new Map<'sonnet' | 'opus' | 'opus-4-7', number>()
        for (const child of children) {
            const meta = getMeta(child)
            const family = normalizeClaudeFamily(
                asNonEmptyString(child.modelMode),
                asNonEmptyString(meta?.runtimeModel),
            )
            if (!family) {
                continue
            }
            counts.set(family, (counts.get(family) ?? 0) + 1)
        }
        const families = [...counts.keys()].sort(compareClaudeFamilies)
        const defaultModel = [...counts.entries()].sort((left, right) => {
            if (right[1] !== left[1]) {
                return right[1] - left[1]
            }
            return compareClaudeFamilies(left[0], right[0])
        })[0]?.[0] ?? null
        return { counts, families, defaultModel }
    }

    const direct = summarize(args.directChildren)
    if (direct.families.length > 0 && direct.defaultModel) {
        return {
            suggestion: {
                allowed: direct.families,
                defaultModel: direct.defaultModel,
            },
            confidence: args.directChildren.length >= 2 ? 'high' : 'medium',
            basis: [
                `直接关联 child 会话 ${args.directChildren.length} 条`,
                `观察到的 Claude child 模型族: ${direct.families.join(', ')}`,
                `最常见 child 模型族: ${direct.defaultModel}`,
            ],
        }
    }

    const cohort = summarize(args.cohortChildren)
    if (cohort.families.length > 0 && cohort.defaultModel) {
        if (args.cohortChildren.length < 3) {
            return {
                suggestion: null,
                confidence: null,
                basis: [
                    `同 cohort child 证据仅 ${args.cohortChildren.length} 条，低于建议阈值，Claude childModels 留空`,
                ],
            }
        }
        return {
            suggestion: {
                allowed: cohort.families,
                defaultModel: cohort.defaultModel,
            },
            confidence: args.cohortChildren.length >= 3 ? 'medium' : 'low',
            basis: [
                `同 host/version cohort 的其他 brain 共有 ${args.cohortChildren.length} 条 child 证据`,
                `cohort 观察到的 Claude child 模型族: ${cohort.families.join(', ')}`,
                `cohort 最常见 child 模型族: ${cohort.defaultModel}`,
            ],
        }
    }

    return {
        suggestion: null,
        confidence: null,
        basis: [],
    }
}

function compareConfidence(left: Confidence, right: Confidence): number {
    const order: Confidence[] = ['low', 'medium', 'high']
    return order.indexOf(left) - order.indexOf(right)
}

async function main(): Promise<void> {
    const manifestPath = resolve(process.cwd(), 'data/brain-manual-repair-manifest.default.json')
    const outputPath = resolve(process.cwd(), 'data/brain-claude-batch-a-suggestions.default.json')
    const manifest = readManifest(manifestPath)
    const targetItems = manifest.items.filter((item) => item.source === 'brain' && item.flavor === 'claude')
    const targetIds = new Set(targetItems.map((item) => item.sessionId))

    const store = await PostgresStore.create(loadRequiredPgConfig())
    try {
        const sessions = await store.getSessionsByNamespace('default')
        const sessionsById = new Map(sessions.map((session) => [session.id, session]))
        const targets = targetItems
            .map((item) => sessionsById.get(item.sessionId))
            .filter((session): session is StoredSession => Boolean(session))

        const cohortTargets = new Map<string, StoredSession[]>()
        for (const session of targets) {
            const meta = getMeta(session)
            const key = `${asNonEmptyString(meta?.host) ?? 'unknown'}|${asNonEmptyString(meta?.version) ?? 'unknown'}`
            cohortTargets.set(key, [...(cohortTargets.get(key) ?? []), session])
        }

        const suggestions: SuggestionEntry[] = targets.map((session) => {
            const meta = getMeta(session)
            const host = asNonEmptyString(meta?.host)
            const version = asNonEmptyString(meta?.version)
            const machineId = asNonEmptyString(meta?.machineId) ?? targetItems.find((item) => item.sessionId === session.id)?.machineId ?? null
            const directChildren = sessions.filter((candidate) => {
                const candidateMeta = getMeta(candidate)
                return asNonEmptyString(candidateMeta?.mainSessionId) === session.id
            })
            const cohortKey = `${host ?? 'unknown'}|${version ?? 'unknown'}`
            const peerSessions = (cohortTargets.get(cohortKey) ?? []).filter((candidate) => candidate.id !== session.id)
            const cohortChildren = peerSessions.flatMap((peer) => sessions.filter((candidate) => {
                const candidateMeta = getMeta(candidate)
                return asNonEmptyString(candidateMeta?.mainSessionId) === peer.id
            }))

            const machineInference = inferMachineSelectionMode(session)
            const claudeInference = inferClaudeChildModels({
                directChildren: directChildren.filter((child) => asNonEmptyString(getMeta(child)?.flavor) === 'claude'),
                cohortChildren: cohortChildren.filter((child) => asNonEmptyString(getMeta(child)?.flavor) === 'claude'),
            })

            const overallConfidence = (() => {
                if (claudeInference.confidence && compareConfidence(claudeInference.confidence, machineInference.confidence) > 0) {
                    return claudeInference.confidence
                }
                if (machineInference.confidence === 'high' && claudeInference.confidence === 'high') {
                    return 'high'
                }
                if (machineInference.confidence === 'high' || claudeInference.confidence === 'medium') {
                    return 'medium'
                }
                return machineInference.confidence
            })()

            const unresolved: string[] = []
            if (!machineInference.mode) {
                unresolved.push('machineSelection.mode')
            }
            if (!machineId) {
                unresolved.push('machineSelection.machineId')
            }
            if (!claudeInference.suggestion) {
                unresolved.push('childModels.claude.allowed')
                unresolved.push('childModels.claude.defaultModel')
            }
            unresolved.push('childModels.codex.allowed')
            unresolved.push('childModels.codex.defaultModel')

            if (!targetItems.find((item) => item.sessionId === session.id)?.hasTokenSourceId) {
                unresolved.push('codex token source / local capability 无稳定线索')
            }

            const basis = [
                ...machineInference.basis,
                ...claudeInference.basis,
            ]
            if (directChildren.length === 0) {
                basis.push('无直接 child 会话证据')
            }
            if (!targetItems.find((item) => item.sessionId === session.id)?.hasTokenSourceId) {
                basis.push('metadata.tokenSourceId 缺失')
            }
            if (!targetItems.find((item) => item.sessionId === session.id)?.hasBrainTokenSourceIds) {
                basis.push('metadata.brainTokenSourceIds 缺失')
            }

            return {
                sessionId: session.id,
                confidence: overallConfidence,
                basis,
                unresolved: [...new Set(unresolved)],
                session: {
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    createdBy: asNonEmptyString(session.createdBy),
                    host,
                    version,
                    machineId,
                    summary: getSummaryText(meta),
                    runtimeModel: asNonEmptyString(meta?.runtimeModel),
                    childCount: directChildren.length,
                },
                candidate: {
                    machineSelection: {
                        mode: machineInference.mode,
                        machineId,
                    },
                    childModels: {
                        claude: claudeInference.suggestion,
                        codex: null,
                    },
                },
                observedChildren: directChildren.map((child) => {
                    const childMeta = getMeta(child)
                    return {
                        sessionId: child.id,
                        flavor: asNonEmptyString(childMeta?.flavor),
                        modelMode: asNonEmptyString(child.modelMode),
                        runtimeModel: asNonEmptyString(childMeta?.runtimeModel),
                        summary: getSummaryText(childMeta),
                    }
                }),
                cohort: {
                    host,
                    version,
                    targetCount: (cohortTargets.get(cohortKey) ?? []).length,
                    sessionsWithClaudeChildEvidence: peerSessions.filter((peer) => sessions.some((candidate) => {
                        const candidateMeta = getMeta(candidate)
                        return asNonEmptyString(candidateMeta?.mainSessionId) === peer.id
                            && asNonEmptyString(candidateMeta?.flavor) === 'claude'
                    })).length,
                    observedClaudeFamilies: [...new Set(cohortChildren.map((child) => normalizeClaudeFamily(
                        asNonEmptyString(child.modelMode),
                        asNonEmptyString(getMeta(child)?.runtimeModel),
                    )).filter((family): family is 'sonnet' | 'opus' | 'opus-4-7' => Boolean(family)))].sort(compareClaudeFamilies),
                },
            }
        }).sort((left, right) => {
            const confidenceCompare = compareConfidence(right.confidence, left.confidence)
            if (confidenceCompare !== 0) {
                return confidenceCompare
            }
            return left.session.createdAt - right.session.createdAt
        })

        const report: SuggestionReport = {
            generatedAt: new Date().toISOString(),
            sourceManifest: manifestPath,
            selection: {
                source: 'brain',
                flavor: 'claude',
                batchSize: suggestions.length,
            },
            summary: {
                high: suggestions.filter((item) => item.confidence === 'high').length,
                medium: suggestions.filter((item) => item.confidence === 'medium').length,
                low: suggestions.filter((item) => item.confidence === 'low').length,
            },
            suggestions,
        }

        writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
        console.log(`Wrote ${suggestions.length} suggestions to ${outputPath}`)
        console.log(JSON.stringify(report.summary, null, 2))
    } finally {
        await store.close()
    }
}

void main()
