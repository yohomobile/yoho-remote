import { isLicenseTermination } from '@/lib/license'
import type { Session, SessionSummary, SessionsResponse } from '@/types/api'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getBrainChildMainSessionId(metadata: Session['metadata']): string | undefined {
    if (!metadata || metadata.source !== 'brain-child' || typeof metadata.mainSessionId !== 'string') {
        return undefined
    }
    return metadata.mainSessionId
}

export type SessionStatusUpdateData = {
    active?: boolean
    activeAt?: number
    reconnecting?: boolean
    lastMessageAt?: number | null
    thinking?: boolean
    wasThinking?: boolean
    permissionMode?: string
    modelMode?: string
    modelReasoningEffort?: string
    fastMode?: boolean
    activeMonitors?: Session['activeMonitors']
    activeMonitorCount?: number
    terminationReason?: string
    sid?: string
}

export type SessionNotificationState = {
    active?: boolean
    thinking?: boolean
    terminationReason?: string | null
}

export type SessionCompletionNotificationKind = 'license-terminated' | 'task-completed'

export function shouldSuppressNotificationWithoutPreviousState(options: {
    previousState: SessionNotificationState | null | undefined
    baselineReady: boolean
    lastConnectAt: number
    replayGuardMs: number
    now?: number
}): boolean {
    const {
        previousState,
        baselineReady,
        lastConnectAt,
        replayGuardMs,
        now = Date.now(),
    } = options

    if (previousState) {
        return false
    }
    if (!baselineReady) {
        return true
    }
    if (lastConnectAt <= 0) {
        return false
    }
    return now - lastConnectAt < replayGuardMs
}

export function hasSessionStatusFields(data: SessionStatusUpdateData | null): boolean {
    if (!data) return false

    return (
        data.active !== undefined ||
        data.activeAt !== undefined ||
        data.reconnecting !== undefined ||
        data.lastMessageAt !== undefined ||
        data.thinking !== undefined ||
        data.wasThinking !== undefined ||
        data.permissionMode !== undefined ||
        data.modelMode !== undefined ||
        data.modelReasoningEffort !== undefined ||
        data.fastMode !== undefined ||
        data.activeMonitors !== undefined ||
        data.activeMonitorCount !== undefined ||
        data.terminationReason !== undefined
    )
}

export function toSessionNotificationState(
    session: Pick<Session, 'active' | 'thinking' | 'terminationReason'>
        | Pick<SessionSummary, 'active' | 'thinking' | 'terminationReason'>
        | null
        | undefined
): SessionNotificationState | null {
    if (!session) return null
    return {
        active: session.active,
        thinking: session.thinking,
        terminationReason: session.terminationReason ?? null,
    }
}

export function mergeSessionNotificationState(
    previousState: SessionNotificationState | null | undefined,
    data: SessionStatusUpdateData | null
): SessionNotificationState | null {
    if (!data) {
        return previousState ?? null
    }
    return {
        active: data.active !== undefined ? data.active : previousState?.active,
        thinking: data.thinking !== undefined ? data.thinking : previousState?.thinking,
        terminationReason: data.terminationReason !== undefined ? data.terminationReason : (previousState?.terminationReason ?? null),
    }
}

export function getSessionCompletionNotificationKind(options: {
    previousState: SessionNotificationState | null | undefined
    data: SessionStatusUpdateData | null
    suppressWithoutPreviousState?: boolean
}): SessionCompletionNotificationKind | null {
    const { previousState, data, suppressWithoutPreviousState = false } = options
    if (!data) return null

    const nextState = mergeSessionNotificationState(previousState, data)
    if (!nextState) return null

    if (!previousState && suppressWithoutPreviousState) {
        return null
    }

    if (
        nextState.active === false
        && isLicenseTermination(nextState.terminationReason)
        && (
            previousState?.active !== false
            || previousState?.terminationReason !== nextState.terminationReason
        )
    ) {
        return 'license-terminated'
    }

    if (
        data.wasThinking
        && data.thinking === false
        && (
            previousState?.thinking === true
            || !previousState
        )
    ) {
        return 'task-completed'
    }

    return null
}

export function isSidOnlySessionRefreshHint(data: unknown): data is { sid: string } {
    return isObject(data)
        && typeof data.sid === 'string'
        && Object.keys(data).every((key) => key === 'sid')
}

export function isFullSessionPayload(data: unknown, sessionId: string): data is Record<string, unknown> {
    if (!isObject(data)) return false
    if (data.id !== sessionId) return false
    if (typeof data.createdAt !== 'number' || typeof data.updatedAt !== 'number') return false
    if (typeof data.active !== 'boolean' || typeof data.thinking !== 'boolean') return false

    return data.metadataVersion !== undefined
        || data.agentStateVersion !== undefined
        || data.metadata !== undefined
        || data.agentState !== undefined
        || data.todos !== undefined
}

export function toSessionFromSsePayload(data: Record<string, unknown>): Session {
    return {
        id: data.id as string,
        createdAt: data.createdAt as number,
        updatedAt: data.updatedAt as number,
        ...((typeof data.lastMessageAt === 'number' || data.lastMessageAt === null) && { lastMessageAt: data.lastMessageAt as number | null }),
        active: data.active as boolean,
        ...(typeof data.reconnecting === 'boolean' && { reconnecting: data.reconnecting }),
        thinking: data.thinking as boolean,
        metadata: (isObject(data.metadata) || data.metadata === null)
            ? data.metadata as Session['metadata']
            : null,
        agentState: (isObject(data.agentState) || data.agentState === null)
            ? data.agentState as Session['agentState']
            : null,
        ...(typeof data.createdBy === 'string' && { createdBy: data.createdBy }),
        ...(Array.isArray(data.todos) && { todos: data.todos as Session['todos'] }),
        ...(typeof data.permissionMode === 'string' && { permissionMode: data.permissionMode as Session['permissionMode'] }),
        ...(typeof data.modelMode === 'string' && { modelMode: data.modelMode as Session['modelMode'] }),
        ...(typeof data.modelReasoningEffort === 'string' && { modelReasoningEffort: data.modelReasoningEffort as Session['modelReasoningEffort'] }),
        ...(typeof data.fastMode === 'boolean' && { fastMode: data.fastMode }),
        ...(Array.isArray(data.activeMonitors) && { activeMonitors: data.activeMonitors as Session['activeMonitors'] }),
        ...(typeof data.terminationReason === 'string' && { terminationReason: data.terminationReason }),
    }
}

function toSessionSummaryMetadata(
    metadata: Session['metadata']
): SessionSummary['metadata'] {
    if (!metadata) return null

    return {
        ...(typeof metadata.name === 'string' && { name: metadata.name }),
        path: metadata.path,
        ...(typeof metadata.machineId === 'string' && { machineId: metadata.machineId }),
        ...(getBrainChildMainSessionId(metadata) !== undefined && { mainSessionId: getBrainChildMainSessionId(metadata) }),
        ...(metadata.summary?.text ? { summary: { text: metadata.summary.text } } : {}),
        ...(metadata.flavor !== undefined && { flavor: metadata.flavor ?? null }),
        ...(typeof metadata.runtimeAgent === 'string' && { runtimeAgent: metadata.runtimeAgent }),
        ...(typeof metadata.runtimeModel === 'string' && { runtimeModel: metadata.runtimeModel }),
        ...(typeof metadata.runtimeModelReasoningEffort === 'string' && { runtimeModelReasoningEffort: metadata.runtimeModelReasoningEffort }),
        ...(metadata.worktree && typeof metadata.worktree.basePath === 'string' && typeof metadata.worktree.branch === 'string' && typeof metadata.worktree.name === 'string'
            ? { worktree: metadata.worktree }
            : {}),
        ...(typeof metadata.source === 'string' && { source: metadata.source }),
        ...(typeof metadata.lifecycleState === 'string' && { lifecycleState: metadata.lifecycleState }),
        ...(typeof metadata.lifecycleStateSince === 'number' && { lifecycleStateSince: metadata.lifecycleStateSince }),
        ...(typeof metadata.archivedBy === 'string' && { archivedBy: metadata.archivedBy }),
        ...(typeof metadata.archiveReason === 'string' && { archiveReason: metadata.archiveReason }),
        ...(metadata.selfSystemEnabled === true && { selfSystemEnabled: true }),
        ...(typeof metadata.selfProfileId === 'string' && { selfProfileId: metadata.selfProfileId }),
        ...(typeof metadata.selfProfileName === 'string' && { selfProfileName: metadata.selfProfileName }),
        ...(metadata.selfProfileResolved === true && { selfProfileResolved: true }),
        ...(metadata.selfMemoryProvider === 'yoho-memory' || metadata.selfMemoryProvider === 'none'
            ? { selfMemoryProvider: metadata.selfMemoryProvider }
            : {}),
        ...(metadata.selfMemoryAttached === true && { selfMemoryAttached: true }),
        ...(metadata.selfMemoryStatus === 'disabled'
            || metadata.selfMemoryStatus === 'skipped'
            || metadata.selfMemoryStatus === 'attached'
            || metadata.selfMemoryStatus === 'empty'
            || metadata.selfMemoryStatus === 'error'
            ? { selfMemoryStatus: metadata.selfMemoryStatus }
            : {}),
    }
}

export function toSessionSummaryFromSsePayload(data: Record<string, unknown>): SessionSummary {
    const session = toSessionFromSsePayload(data)
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0
    const todoProgress = session.todos?.length
        ? {
            completed: session.todos.filter((item) => item.status === 'completed').length,
            total: session.todos.length,
        }
        : null

    return {
        id: session.id,
        createdAt: session.createdAt,
        active: session.active,
        ...(typeof session.reconnecting === 'boolean' && { reconnecting: session.reconnecting }),
        activeAt: typeof data.activeAt === 'number' ? data.activeAt : session.updatedAt,
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt ?? null,
        ...(typeof session.createdBy === 'string' && { createdBy: session.createdBy }),
        metadata: toSessionSummaryMetadata(session.metadata),
        todoProgress,
        pendingRequestsCount,
        thinking: session.thinking,
        ...(typeof session.modelMode === 'string' && { modelMode: session.modelMode }),
        ...(typeof session.modelReasoningEffort === 'string' && { modelReasoningEffort: session.modelReasoningEffort }),
        ...(typeof session.fastMode === 'boolean' && { fastMode: session.fastMode }),
        ...(typeof data.activeMonitorCount === 'number'
            ? { activeMonitorCount: data.activeMonitorCount }
            : Array.isArray(data.activeMonitors)
                ? { activeMonitorCount: data.activeMonitors.length }
                : {}),
        ...(typeof session.terminationReason === 'string' && { terminationReason: session.terminationReason }),
    }
}

export function upsertSessionSummary(
    previous: SessionsResponse | undefined,
    nextSession: SessionSummary
): SessionsResponse {
    if (!previous?.sessions) {
        return { sessions: [nextSession] }
    }

    const existingIndex = previous.sessions.findIndex((session) => session.id === nextSession.id)
    if (existingIndex === -1) {
        return {
            ...previous,
            sessions: [nextSession, ...previous.sessions],
        }
    }

    const sessions = [...previous.sessions]
    sessions[existingIndex] = {
        ...sessions[existingIndex],
        ...nextSession,
    }

    return {
        ...previous,
        sessions,
    }
}

export function applySessionSummaryStatusUpdate(
    previous: SessionsResponse | undefined,
    sessionId: string,
    data: SessionStatusUpdateData | null
): SessionsResponse | undefined {
    if (!previous?.sessions || !data) {
        return previous
    }

    const target = previous.sessions.find((session) => session.id === sessionId)
    if (!target) {
        return previous
    }

    const hasChange =
        (data.active !== undefined && data.active !== target.active) ||
        (data.activeAt !== undefined && data.activeAt !== target.activeAt) ||
        (data.reconnecting !== undefined && data.reconnecting !== target.reconnecting) ||
        (data.lastMessageAt !== undefined && data.lastMessageAt !== target.lastMessageAt) ||
        (data.thinking !== undefined && data.thinking !== target.thinking) ||
        (data.modelMode !== undefined && data.modelMode !== target.modelMode) ||
        (data.modelReasoningEffort !== undefined && data.modelReasoningEffort !== target.modelReasoningEffort) ||
        (data.fastMode !== undefined && data.fastMode !== target.fastMode) ||
        (data.activeMonitorCount !== undefined && data.activeMonitorCount !== target.activeMonitorCount) ||
        (data.terminationReason !== undefined && data.terminationReason !== target.terminationReason)

    if (!hasChange) {
        return previous
    }

    return {
        ...previous,
        sessions: previous.sessions.map((session) =>
            session.id === sessionId
                ? {
                    ...session,
                    ...(data.active !== undefined && { active: data.active }),
                    ...(data.activeAt !== undefined && { activeAt: data.activeAt }),
                    ...(data.reconnecting !== undefined && { reconnecting: data.reconnecting }),
                    ...(data.lastMessageAt !== undefined && { lastMessageAt: data.lastMessageAt ?? null }),
                    ...(data.thinking !== undefined && { thinking: data.thinking }),
                    ...(data.modelMode !== undefined && { modelMode: data.modelMode as SessionSummary['modelMode'] }),
                    ...(data.modelReasoningEffort !== undefined && { modelReasoningEffort: data.modelReasoningEffort as SessionSummary['modelReasoningEffort'] }),
                    ...(data.fastMode !== undefined && { fastMode: data.fastMode }),
                    ...(data.activeMonitorCount !== undefined && { activeMonitorCount: data.activeMonitorCount }),
                    ...(data.terminationReason !== undefined && { terminationReason: data.terminationReason }),
                }
                : session
        )
    }
}
