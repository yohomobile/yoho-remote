import type { Metadata } from './types'

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export function buildBrainChildScopeQuery(opts?: { mainSessionId?: string }): string {
    const mainSessionId = asNonEmptyString(opts?.mainSessionId)
    if (!mainSessionId) {
        return ''
    }
    const params = new URLSearchParams()
    params.set('mainSessionId', mainSessionId)
    return `?${params.toString()}`
}

export function getBrainChildScopeParamsFromMetadata(
    metadata: Metadata | null | undefined
): { mainSessionId: string } | undefined {
    if (!metadata || metadata.source !== 'brain-child') {
        return undefined
    }
    const mainSessionId = asNonEmptyString(metadata.mainSessionId)
    if (!mainSessionId) {
        return undefined
    }
    return { mainSessionId }
}
