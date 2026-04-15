const EXACT_SESSION_SOURCES = new Set([
    'brain',
    'brain-child',
    'external-api',
    'manual',
    'webapp',
])

const PREFIX_SESSION_SOURCES = [
    'automation:',
    'bot:',
    'script:',
]

export function getSessionSourceFromMetadata(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') {
        return null
    }

    const source = (metadata as Record<string, unknown>).source
    return typeof source === 'string' ? source : null
}

export function isSupportedSessionSource(source: string | null | undefined): boolean {
    const normalized = source?.trim().toLowerCase()
    if (!normalized) {
        return true
    }
    if (EXACT_SESSION_SOURCES.has(normalized)) {
        return true
    }
    if (normalized.endsWith('_repair')) {
        return true
    }
    return PREFIX_SESSION_SOURCES.some((prefix) => normalized.startsWith(prefix))
}

export function getUnsupportedSessionSourceError(source: string | null | undefined): string {
    const normalized = source?.trim() || 'unknown'
    return `Session source "${normalized}" is not supported`
}
