import { normalizeSessionPermissionMode, type SessionPermissionMode } from '../sessionPermissionMode'
import { getSessionSourceFromMetadata } from '../sessionSourcePolicy'
import type { StoredSession } from '../store/types'
import { parseBrainSessionPreferences, type BrainSessionPreferences } from './brainSessionPreferences'

export type AuditedBrainSessionSource = 'brain' | 'brain-child'

export type BrainSessionAuditIssueKind =
    | 'invalid-brainPreferences'
    | 'dirty-permissionMode'

export type BrainSessionAuditAutoFix =
    | {
        kind: 'copy-parent-brainPreferences'
        parentSessionId: string
        nextBrainPreferences: BrainSessionPreferences
    }
    | {
        kind: 'normalize-permissionMode'
        nextPermissionMode: SessionPermissionMode
    }

export type BrainSessionAutoFixCandidate = {
    sessionId: string
    namespace: string
    source: AuditedBrainSessionSource
    issue: BrainSessionAuditIssueKind
    active: false
    updatedAt: number
    fix: BrainSessionAuditAutoFix
}

export type BrainSessionBlockedAutoFixCandidate = {
    sessionId: string
    namespace: string
    source: AuditedBrainSessionSource
    issue: BrainSessionAuditIssueKind
    active: true
    updatedAt: number
    blockedReason: 'session-active'
    fix: BrainSessionAuditAutoFix
}

type BrainSessionAuditIssueBase = {
    sessionId: string
    namespace: string
    source: AuditedBrainSessionSource
    flavor: string | null
    path: string | null
    machineId: string | null
    mainSessionId: string | null
    active: boolean
    updatedAt: number
}

export type InvalidBrainPreferencesIssue = BrainSessionAuditIssueBase & {
    issue: 'invalid-brainPreferences'
    reason: string
    autoFix: BrainSessionAuditAutoFix | null
}

export type DirtyPermissionModeIssue = BrainSessionAuditIssueBase & {
    issue: 'dirty-permissionMode'
    storedPermissionMode: string
    normalizedPermissionMode: SessionPermissionMode | null
    reason: string
    autoFix: BrainSessionAuditAutoFix | null
}

export type BrainSessionAuditReport = {
    generatedAt: number
    summary: {
        totalSessions: number
        scannedBrainSessions: number
        brainSessions: number
        brainChildSessions: number
        invalidBrainPreferences: number
        dirtyPermissionModes: number
        autoFixable: number
        blockedByActive: number
    }
    invalidBrainPreferences: InvalidBrainPreferencesIssue[]
    dirtyPermissionModes: DirtyPermissionModeIssue[]
    autoFixable: BrainSessionAutoFixCandidate[]
    blockedAutoFixable: BrainSessionBlockedAutoFixCandidate[]
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

function getAuditedSource(metadata: Record<string, unknown> | null): AuditedBrainSessionSource | null {
    const source = getSessionSourceFromMetadata(metadata)
    return source === 'brain' || source === 'brain-child' ? source : null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key)
}

function buildIssueBase(
    session: StoredSession,
    metadata: Record<string, unknown> | null,
    source: AuditedBrainSessionSource
): BrainSessionAuditIssueBase {
    return {
        sessionId: session.id,
        namespace: session.namespace,
        source,
        flavor: asNonEmptyString(metadata?.flavor),
        path: asNonEmptyString(metadata?.path),
        machineId: session.machineId ?? asNonEmptyString(metadata?.machineId),
        mainSessionId: source === 'brain-child' ? asNonEmptyString(metadata?.mainSessionId) : null,
        active: session.active,
        updatedAt: session.updatedAt,
    }
}

function resolveBrainPreferencesFix(
    parentSessionId: string | null,
    sessionsById: Map<string, StoredSession>
): BrainSessionAuditAutoFix | null {
    if (!parentSessionId) {
        return null
    }

    const parentSession = sessionsById.get(parentSessionId)
    const parentMetadata = asRecord(parentSession?.metadata)
    if (!parentMetadata || !hasOwn(parentMetadata, 'brainPreferences')) {
        return null
    }

    const parentPreferences = parseBrainSessionPreferences(parentMetadata.brainPreferences)
    if (!parentPreferences) {
        return null
    }

    return {
        kind: 'copy-parent-brainPreferences',
        parentSessionId,
        nextBrainPreferences: parentPreferences,
    }
}

function pushAutoFixCandidate(args: {
    issueBase: BrainSessionAuditIssueBase
    issue: BrainSessionAuditIssueKind
    fix: BrainSessionAuditAutoFix
    autoFixable: BrainSessionAutoFixCandidate[]
    blockedAutoFixable: BrainSessionBlockedAutoFixCandidate[]
}): void {
    if (args.issueBase.active) {
        args.blockedAutoFixable.push({
            sessionId: args.issueBase.sessionId,
            namespace: args.issueBase.namespace,
            source: args.issueBase.source,
            issue: args.issue,
            active: true,
            updatedAt: args.issueBase.updatedAt,
            blockedReason: 'session-active',
            fix: args.fix,
        })
        return
    }

    args.autoFixable.push({
        sessionId: args.issueBase.sessionId,
        namespace: args.issueBase.namespace,
        source: args.issueBase.source,
        issue: args.issue,
        active: false,
        updatedAt: args.issueBase.updatedAt,
        fix: args.fix,
    })
}

function describeDirtyPermissionMode(
    flavor: string | null,
    storedPermissionMode: string,
    normalizedPermissionMode: SessionPermissionMode | null,
    metadata: Record<string, unknown> | null
): string {
    if (
        flavor === 'codex'
        && storedPermissionMode.trim() === 'bypassPermissions'
        && metadata?.yolo === true
        && normalizedPermissionMode === 'yolo'
    ) {
        return '旧版 Codex/Brain 会话曾把 bypassPermissions 落库，但运行时实际等价于 yolo，可安全归一化'
    }

    if (normalizedPermissionMode) {
        return `permissionMode 可归一化为 ${normalizedPermissionMode}`
    }

    return 'permissionMode 与当前 flavor 约束不兼容，无法安全自动归一化'
}

export function auditBrainSessions(sessions: readonly StoredSession[]): BrainSessionAuditReport {
    const generatedAt = Date.now()
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    const invalidBrainPreferences: InvalidBrainPreferencesIssue[] = []
    const dirtyPermissionModes: DirtyPermissionModeIssue[] = []
    const autoFixable: BrainSessionAutoFixCandidate[] = []
    const blockedAutoFixable: BrainSessionBlockedAutoFixCandidate[] = []
    let scannedBrainSessions = 0
    let brainSessions = 0
    let brainChildSessions = 0

    for (const session of sessions) {
        const metadata = asRecord(session.metadata)
        const source = getAuditedSource(metadata)
        if (!source) {
            continue
        }

        scannedBrainSessions += 1
        if (source === 'brain') {
            brainSessions += 1
        } else {
            brainChildSessions += 1
        }

        const issueBase = buildIssueBase(session, metadata, source)

        if (metadata && hasOwn(metadata, 'brainPreferences')) {
            const parsedBrainPreferences = parseBrainSessionPreferences(metadata.brainPreferences)
            if (!parsedBrainPreferences) {
                const autoFix = source === 'brain-child'
                    ? resolveBrainPreferencesFix(issueBase.mainSessionId, sessionsById)
                    : null
                invalidBrainPreferences.push({
                    ...issueBase,
                    issue: 'invalid-brainPreferences',
                    reason: 'brainPreferences 字段存在，但不符合当前 schema',
                    autoFix,
                })
                if (autoFix) {
                    pushAutoFixCandidate({
                        issueBase,
                        issue: 'invalid-brainPreferences',
                        fix: autoFix,
                        autoFixable,
                        blockedAutoFixable,
                    })
                }
            }
        }

        if (typeof session.permissionMode === 'string') {
            const normalizedPermissionMode = normalizeSessionPermissionMode({
                flavor: metadata?.flavor,
                permissionMode: session.permissionMode,
                metadata,
            }) ?? null

            if (normalizedPermissionMode !== session.permissionMode) {
                const autoFix = normalizedPermissionMode
                    ? {
                        kind: 'normalize-permissionMode' as const,
                        nextPermissionMode: normalizedPermissionMode,
                    }
                    : null
                dirtyPermissionModes.push({
                    ...issueBase,
                    issue: 'dirty-permissionMode',
                    storedPermissionMode: session.permissionMode,
                    normalizedPermissionMode,
                    reason: describeDirtyPermissionMode(
                        issueBase.flavor,
                        session.permissionMode,
                        normalizedPermissionMode,
                        metadata
                    ),
                    autoFix,
                })
                if (autoFix) {
                    pushAutoFixCandidate({
                        issueBase,
                        issue: 'dirty-permissionMode',
                        fix: autoFix,
                        autoFixable,
                        blockedAutoFixable,
                    })
                }
            }
        }
    }

    return {
        generatedAt,
        summary: {
            totalSessions: sessions.length,
            scannedBrainSessions,
            brainSessions,
            brainChildSessions,
            invalidBrainPreferences: invalidBrainPreferences.length,
            dirtyPermissionModes: dirtyPermissionModes.length,
            autoFixable: autoFixable.length,
            blockedByActive: blockedAutoFixable.length,
        },
        invalidBrainPreferences,
        dirtyPermissionModes,
        autoFixable,
        blockedAutoFixable,
    }
}
