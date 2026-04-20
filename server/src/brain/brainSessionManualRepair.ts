import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { parseBrainSessionPreferences, type BrainSessionPreferences } from './brainSessionPreferences'
import { getSessionSourceFromMetadata } from '../sessionSourcePolicy'
import { normalizeSessionPermissionMode, type SessionPermissionMode } from '../sessionPermissionMode'
import type { IStore } from '../store/interface'
import type { StoredSession } from '../store/types'

const SetBrainPreferencesManifestItemSchema = z.object({
    sessionId: z.string().min(1),
    namespace: z.string().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    action: z.literal('set-brainPreferences'),
    brainPreferences: z.unknown().optional(),
    copyFromSessionId: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
    const provided = Number(Boolean(value.brainPreferences)) + Number(Boolean(value.copyFromSessionId))
    if (provided !== 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'set-brainPreferences 必须且只能提供 brainPreferences 或 copyFromSessionId 其中之一',
            path: ['brainPreferences'],
        })
    }
})

const SetPermissionModeManifestItemSchema = z.object({
    sessionId: z.string().min(1),
    namespace: z.string().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    action: z.literal('set-permissionMode'),
    permissionMode: z.string().min(1),
})

const BrainSessionManualRepairManifestSchema = z.object({
    version: z.literal(1),
    items: z.array(z.union([
        SetBrainPreferencesManifestItemSchema,
        SetPermissionModeManifestItemSchema,
    ])).min(1),
})

export type BrainSessionManualRepairManifest = z.infer<typeof BrainSessionManualRepairManifestSchema>
export type BrainSessionManualRepairManifestItem = BrainSessionManualRepairManifest['items'][number]

export type BrainSessionManualRepairFieldDiff =
    | {
        field: 'brainPreferences'
        before: unknown
        after: BrainSessionPreferences
    }
    | {
        field: 'permissionMode'
        before: string | null
        after: SessionPermissionMode
    }

type PlannedChangeBase = {
    manifestIndex: number
    sessionId: string
    namespace: string
    source: 'brain' | 'brain-child'
    reason: string | null
    beforeSession: StoredSession
    diff: BrainSessionManualRepairFieldDiff
}

export type SetBrainPreferencesPlannedChange = PlannedChangeBase & {
    action: 'set-brainPreferences'
    brainPreferences: BrainSessionPreferences
    copyFromSessionId: string | null
}

export type SetPermissionModePlannedChange = PlannedChangeBase & {
    action: 'set-permissionMode'
    permissionMode: SessionPermissionMode
}

export type BrainSessionManualRepairPlannedChange =
    | SetBrainPreferencesPlannedChange
    | SetPermissionModePlannedChange

export type BrainSessionManualRepairSkippedItem = {
    manifestIndex: number
    sessionId: string
    namespace: string
    reason: string
}

export type BrainSessionManualRepairRejectedItem = {
    manifestIndex: number
    sessionId: string | null
    reason: string
}

export type BrainSessionManualRepairPlan = {
    generatedAt: number
    manifestVersion: number
    summary: {
        manifestItems: number
        plannedWrites: number
        skippedActive: number
        skippedNoop: number
        rejected: number
    }
    planned: BrainSessionManualRepairPlannedChange[]
    skippedActive: BrainSessionManualRepairSkippedItem[]
    skippedNoop: BrainSessionManualRepairSkippedItem[]
    rejected: BrainSessionManualRepairRejectedItem[]
}

export type BrainSessionManualRepairSnapshot = {
    generatedAt: number
    manifestVersion: number
    summary: BrainSessionManualRepairPlan['summary']
    planned: Array<{
        manifestIndex: number
        sessionId: string
        namespace: string
        source: 'brain' | 'brain-child'
        action: BrainSessionManualRepairPlannedChange['action']
        reason: string | null
        diff: BrainSessionManualRepairFieldDiff
        beforeSession: StoredSession
    }>
}

export type BrainSessionManualRepairApplySkippedItem = {
    manifestIndex: number
    sessionId: string
    namespace: string
    reason: string
}

export type BrainSessionManualRepairApplyFailedItem = {
    manifestIndex: number
    sessionId: string
    namespace: string
    reason: string
}

export type BrainSessionManualRepairApplyResult = {
    applied: Array<{
        manifestIndex: number
        sessionId: string
        namespace: string
        action: BrainSessionManualRepairPlannedChange['action']
    }>
    skippedActive: BrainSessionManualRepairApplySkippedItem[]
    skippedDrifted: BrainSessionManualRepairApplySkippedItem[]
    failed: BrainSessionManualRepairApplyFailedItem[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as Record<string, unknown>
}

function extractBrainSource(session: StoredSession): 'brain' | 'brain-child' | null {
    const metadata = asRecord(session.metadata)
    const source = getSessionSourceFromMetadata(metadata)
    return source === 'brain' || source === 'brain-child' ? source : null
}

function getBrainPreferencesValue(session: StoredSession): unknown {
    const metadata = asRecord(session.metadata)
    return metadata?.brainPreferences
}

function getValidBrainPreferencesFromSession(session: StoredSession | undefined): BrainSessionPreferences | null {
    if (!session) {
        return null
    }
    return parseBrainSessionPreferences(getBrainPreferencesValue(session))
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right)
}

export function parseBrainSessionManualRepairManifest(value: unknown): BrainSessionManualRepairManifest | null {
    const parsed = BrainSessionManualRepairManifestSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return parsed.data
}

export function buildBrainSessionManualRepairPlan(
    sessions: readonly StoredSession[],
    manifest: BrainSessionManualRepairManifest
): BrainSessionManualRepairPlan {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    const planned: BrainSessionManualRepairPlannedChange[] = []
    const skippedActive: BrainSessionManualRepairSkippedItem[] = []
    const skippedNoop: BrainSessionManualRepairSkippedItem[] = []
    const rejected: BrainSessionManualRepairRejectedItem[] = []

    for (const [manifestIndex, item] of manifest.items.entries()) {
        const session = sessionsById.get(item.sessionId)
        if (!session) {
            rejected.push({
                manifestIndex,
                sessionId: item.sessionId,
                reason: 'session 不存在于当前 store 扫描结果中',
            })
            continue
        }

        if (item.namespace && item.namespace !== session.namespace) {
            rejected.push({
                manifestIndex,
                sessionId: item.sessionId,
                reason: `manifest namespace=${item.namespace} 与 session namespace=${session.namespace} 不匹配`,
            })
            continue
        }

        const source = extractBrainSource(session)
        if (!source) {
            rejected.push({
                manifestIndex,
                sessionId: item.sessionId,
                reason: '只允许修复 metadata.source=brain 或 brain-child 的会话',
            })
            continue
        }

        if (session.active) {
            skippedActive.push({
                manifestIndex,
                sessionId: session.id,
                namespace: session.namespace,
                reason: 'active 会话永远跳过',
            })
            continue
        }

        const metadata = asRecord(session.metadata)
        const reason = item.reason ?? null

        if (item.action === 'set-brainPreferences') {
            const copyFromSessionId = item.copyFromSessionId
            const nextBrainPreferences = item.brainPreferences !== undefined
                ? parseBrainSessionPreferences(item.brainPreferences)
                : copyFromSessionId
                    ? getValidBrainPreferencesFromSession(sessionsById.get(copyFromSessionId))
                    : null

            if (!nextBrainPreferences) {
                rejected.push({
                    manifestIndex,
                    sessionId: item.sessionId,
                    reason: copyFromSessionId
                        ? `copyFromSessionId=${copyFromSessionId} 没有可用的有效 brainPreferences`
                        : 'brainPreferences 不符合当前 schema',
                })
                continue
            }

            const beforeValue = metadata?.brainPreferences
            if (sameJsonValue(beforeValue, nextBrainPreferences)) {
                skippedNoop.push({
                    manifestIndex,
                    sessionId: session.id,
                    namespace: session.namespace,
                    reason: 'brainPreferences 已经与目标值一致',
                })
                continue
            }

            planned.push({
                manifestIndex,
                sessionId: session.id,
                namespace: session.namespace,
                source,
                action: 'set-brainPreferences',
                reason,
                beforeSession: session,
                brainPreferences: nextBrainPreferences,
                copyFromSessionId: copyFromSessionId ?? null,
                diff: {
                    field: 'brainPreferences',
                    before: beforeValue,
                    after: nextBrainPreferences,
                },
            })
            continue
        }

        const normalized = normalizeSessionPermissionMode({
            flavor: metadata?.flavor,
            permissionMode: item.permissionMode,
            metadata,
        })
        if (normalized !== item.permissionMode) {
            rejected.push({
                manifestIndex,
                sessionId: item.sessionId,
                reason: `permissionMode=${item.permissionMode} 不符合当前 flavor/schema 约束`,
            })
            continue
        }

        if (session.permissionMode === item.permissionMode) {
            skippedNoop.push({
                manifestIndex,
                sessionId: session.id,
                namespace: session.namespace,
                reason: 'permissionMode 已经与目标值一致',
            })
            continue
        }

        planned.push({
            manifestIndex,
            sessionId: session.id,
            namespace: session.namespace,
            source,
            action: 'set-permissionMode',
            reason,
            beforeSession: session,
            permissionMode: item.permissionMode,
            diff: {
                field: 'permissionMode',
                before: session.permissionMode,
                after: item.permissionMode,
            },
        })
    }

    return {
        generatedAt: Date.now(),
        manifestVersion: manifest.version,
        summary: {
            manifestItems: manifest.items.length,
            plannedWrites: planned.length,
            skippedActive: skippedActive.length,
            skippedNoop: skippedNoop.length,
            rejected: rejected.length,
        },
        planned,
        skippedActive,
        skippedNoop,
        rejected,
    }
}

export function buildBrainSessionManualRepairSnapshot(
    plan: BrainSessionManualRepairPlan
): BrainSessionManualRepairSnapshot {
    return {
        generatedAt: Date.now(),
        manifestVersion: plan.manifestVersion,
        summary: plan.summary,
        planned: plan.planned.map((item) => ({
            manifestIndex: item.manifestIndex,
            sessionId: item.sessionId,
            namespace: item.namespace,
            source: item.source,
            action: item.action,
            reason: item.reason,
            diff: item.diff,
            beforeSession: item.beforeSession,
        })),
    }
}

export async function applyBrainSessionManualRepairs(
    store: IStore,
    plan: BrainSessionManualRepairPlan
): Promise<BrainSessionManualRepairApplyResult> {
    const applied: BrainSessionManualRepairApplyResult['applied'] = []
    const skippedActive: BrainSessionManualRepairApplySkippedItem[] = []
    const skippedDrifted: BrainSessionManualRepairApplySkippedItem[] = []
    const failed: BrainSessionManualRepairApplyFailedItem[] = []

    for (const item of plan.planned) {
        const current = await store.getSession(item.sessionId)
        if (!current || current.namespace !== item.namespace) {
            failed.push({
                manifestIndex: item.manifestIndex,
                sessionId: item.sessionId,
                namespace: item.namespace,
                reason: 'apply 前重新读取失败，session 不存在或 namespace 已变化',
            })
            continue
        }

        if (current.active) {
            skippedActive.push({
                manifestIndex: item.manifestIndex,
                sessionId: item.sessionId,
                namespace: item.namespace,
                reason: 'apply 前发现 session 变为 active，已跳过',
            })
            continue
        }

        const source = extractBrainSource(current)
        if (!source) {
            skippedDrifted.push({
                manifestIndex: item.manifestIndex,
                sessionId: item.sessionId,
                namespace: item.namespace,
                reason: 'apply 前发现 session source 已不再属于 brain / brain-child',
            })
            continue
        }

        if (item.action === 'set-brainPreferences') {
            const currentValue = getBrainPreferencesValue(current)
            const beforeValue = getBrainPreferencesValue(item.beforeSession)
            if (!sameJsonValue(currentValue, beforeValue)) {
                skippedDrifted.push({
                    manifestIndex: item.manifestIndex,
                    sessionId: item.sessionId,
                    namespace: item.namespace,
                    reason: 'apply 前发现 brainPreferences 已发生漂移，已跳过',
                })
                continue
            }

            if (!parseBrainSessionPreferences(item.brainPreferences)) {
                failed.push({
                    manifestIndex: item.manifestIndex,
                    sessionId: item.sessionId,
                    namespace: item.namespace,
                    reason: 'apply 前重新校验 brainPreferences 失败',
                })
                continue
            }

            const success = await store.patchSessionMetadata(
                item.sessionId,
                { brainPreferences: item.brainPreferences },
                item.namespace
            )
            if (!success) {
                failed.push({
                    manifestIndex: item.manifestIndex,
                    sessionId: item.sessionId,
                    namespace: item.namespace,
                    reason: 'patchSessionMetadata 返回 false',
                })
                continue
            }
        } else {
            if (current.permissionMode !== item.beforeSession.permissionMode) {
                skippedDrifted.push({
                    manifestIndex: item.manifestIndex,
                    sessionId: item.sessionId,
                    namespace: item.namespace,
                    reason: 'apply 前发现 permissionMode 已发生漂移，已跳过',
                })
                continue
            }

            const currentMetadata = asRecord(current.metadata)
            const normalized = normalizeSessionPermissionMode({
                flavor: currentMetadata?.flavor,
                permissionMode: item.permissionMode,
                metadata: currentMetadata,
            })
            if (normalized !== item.permissionMode) {
                failed.push({
                    manifestIndex: item.manifestIndex,
                    sessionId: item.sessionId,
                    namespace: item.namespace,
                    reason: 'apply 前重新校验 permissionMode 失败',
                })
                continue
            }

            const success = await store.setSessionModelConfig(
                item.sessionId,
                { permissionMode: item.permissionMode },
                item.namespace
            )
            if (!success) {
                failed.push({
                    manifestIndex: item.manifestIndex,
                    sessionId: item.sessionId,
                    namespace: item.namespace,
                    reason: 'setSessionModelConfig 返回 false',
                })
                continue
            }
        }

        applied.push({
            manifestIndex: item.manifestIndex,
            sessionId: item.sessionId,
            namespace: item.namespace,
            action: item.action,
        })
    }

    return {
        applied,
        skippedActive,
        skippedDrifted,
        failed,
    }
}
