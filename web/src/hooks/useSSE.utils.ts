import type { Session } from '@/types/api'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

export type SessionStatusUpdateData = {
    active?: boolean
    activeAt?: number
    thinking?: boolean
    wasThinking?: boolean
    permissionMode?: string
    modelMode?: string
    modelReasoningEffort?: string
    fastMode?: boolean
    terminationReason?: string
    sid?: string
}

export function hasSessionStatusFields(data: SessionStatusUpdateData | null): boolean {
    if (!data) return false

    return (
        data.active !== undefined ||
        data.activeAt !== undefined ||
        data.thinking !== undefined ||
        data.wasThinking !== undefined ||
        data.permissionMode !== undefined ||
        data.modelMode !== undefined ||
        data.modelReasoningEffort !== undefined ||
        data.fastMode !== undefined ||
        data.terminationReason !== undefined
    )
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
        active: data.active as boolean,
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
        ...(typeof data.terminationReason === 'string' && { terminationReason: data.terminationReason }),
    }
}
