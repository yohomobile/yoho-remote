function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type ResumeSpawnMetadata = {
    source?: string
    caller?: string
    mainSessionId?: string
    brainPreferences?: Record<string, unknown>
}

export function extractResumeSpawnMetadata(metadata: unknown): ResumeSpawnMetadata {
    if (!isRecord(metadata)) {
        return {}
    }

    const source = asNonEmptyString(metadata.source)
    const caller = asNonEmptyString(metadata.caller)
    const mainSessionId = asNonEmptyString(metadata.mainSessionId)
    const brainPreferences = isRecord(metadata.brainPreferences)
        ? { ...metadata.brainPreferences }
        : undefined

    return {
        ...(source ? { source } : {}),
        ...(caller ? { caller } : {}),
        ...(mainSessionId ? { mainSessionId } : {}),
        ...(brainPreferences ? { brainPreferences } : {}),
    }
}
