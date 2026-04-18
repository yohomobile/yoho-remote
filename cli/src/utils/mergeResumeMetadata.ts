import type { Metadata } from '@/api/types'

export function mergeResumeMetadata(current: Metadata, incoming: Metadata): Metadata {
    const merged = { ...current } as Metadata

    for (const [key, value] of Object.entries(incoming)) {
        if (value !== undefined) {
            ;(merged as Record<string, unknown>)[key] = value
        }
    }

    merged.summary = current.summary ?? incoming.summary
    merged.claudeSessionId = current.claudeSessionId ?? incoming.claudeSessionId
    merged.codexSessionId = current.codexSessionId ?? incoming.codexSessionId

    return merged
}
