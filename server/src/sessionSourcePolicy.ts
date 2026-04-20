import { parseBrainSessionPreferences } from './brain/brainSessionPreferences'

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key)
}

export function normalizeSessionSource(source: unknown): string | null {
    if (typeof source !== 'string') {
        return null
    }

    const trimmed = source.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : null
}

export function getSessionSourceFromMetadata(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') {
        return null
    }

    const source = (metadata as Record<string, unknown>).source
    return normalizeSessionSource(source)
}

export function isSupportedSessionSource(source: string | null | undefined): boolean {
    const normalized = normalizeSessionSource(source)
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

export function getSessionMetadataInvariantError(metadata: unknown): string | null {
    if (!isRecord(metadata)) {
        return null
    }

    const source = getSessionSourceFromMetadata(metadata)
    const mainSessionId = asNonEmptyString(metadata.mainSessionId)
    const hasBrainPreferences = hasOwn(metadata, 'brainPreferences')

    if (source === 'brain-child' && !mainSessionId) {
        return 'brain-child sessions require mainSessionId'
    }

    if (!source && (mainSessionId || hasBrainPreferences)) {
        return 'brain-linked metadata requires source=brain or source=brain-child'
    }

    return null
}

export function getSessionMetadataPersistenceError(metadata: unknown): string | null {
    const invariantError = getSessionMetadataInvariantError(metadata)
    if (invariantError) {
        return invariantError
    }
    if (!isRecord(metadata)) {
        return null
    }

    const source = getSessionSourceFromMetadata(metadata)
    if ((source === 'brain' || source === 'brain-child') && metadata.brainPreferences !== undefined) {
        if (parseBrainSessionPreferences(metadata.brainPreferences) === null) {
            return 'Invalid brainPreferences in session metadata'
        }
    }

    return null
}

export function getBrainChildMainSessionId(metadata: unknown): string | undefined {
    if (!isRecord(metadata)) {
        return undefined
    }
    if (getSessionSourceFromMetadata(metadata) !== 'brain-child') {
        return undefined
    }

    return asNonEmptyString(metadata.mainSessionId) ?? undefined
}

export function normalizeSessionMetadataInvariants(metadata: unknown): unknown {
    if (!isRecord(metadata)) {
        return metadata
    }

    const normalized = { ...metadata }
    const source = getSessionSourceFromMetadata(normalized)

    if (source) {
        normalized.source = source
    } else {
        delete normalized.source
    }

    if (source === 'brain-child') {
        return normalized
    }

    delete normalized.mainSessionId

    if (source !== 'brain') {
        delete normalized.brainPreferences
    }

    return normalized
}
