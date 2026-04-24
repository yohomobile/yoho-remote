import { parseBrainSessionPreferences } from './brain/brainSessionPreferences'
import {
    getAllSessionOrchestrationReservedMetadataKeys,
    getAllSessionOrchestrationSources,
    getReservedSessionMetadataKeysForSource,
    getSessionOrchestrationParentSessionId,
    hasSessionOrchestrationMetadata,
    isSessionOrchestrationChildSource,
} from './sessionOrchestrationPolicy'

const EXACT_SESSION_SOURCES = new Set([
    ...getAllSessionOrchestrationSources(),
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

    if (isSessionOrchestrationChildSource(source) && !mainSessionId) {
        return `${source} sessions require mainSessionId`
    }

    // Keep the legacy Brain-specific error text for compatibility with current callers.
    if (!source && hasSessionOrchestrationMetadata(metadata)) {
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
    if (getReservedSessionMetadataKeysForSource(source).includes('brainPreferences') && metadata.brainPreferences !== undefined) {
        if (parseBrainSessionPreferences(metadata.brainPreferences) === null) {
            return 'Invalid brainPreferences in session metadata'
        }
    }

    return null
}

export function getBrainChildMainSessionId(metadata: unknown): string | undefined {
    return getSessionOrchestrationParentSessionId(metadata, 'brain-child')
}

const ARCHIVE_STAMP_FIELDS = ['lifecycleState', 'lifecycleStateSince', 'archivedBy', 'archiveReason'] as const

export function isProtectedArchivedSession(metadata: unknown): boolean {
    if (!isRecord(metadata)) {
        return false
    }
    if (metadata.lifecycleState !== 'archived') {
        return false
    }
    const archivedBy = asNonEmptyString(metadata.archivedBy)
    if (!archivedBy) {
        return false
    }
    return archivedBy !== 'cli'
}

export type ArchiveProtectionResult<T> = {
    metadata: T
    preserved: boolean
}

export function applyArchiveProtectionOnReplace(
    currentMetadata: unknown,
    nextMetadata: unknown
): ArchiveProtectionResult<unknown> {
    if (!isProtectedArchivedSession(currentMetadata) || !isRecord(nextMetadata)) {
        return { metadata: nextMetadata, preserved: false }
    }
    const current = currentMetadata as Record<string, unknown>
    const merged: Record<string, unknown> = { ...nextMetadata }
    const nextLifecycle = nextMetadata.lifecycleState
    const preservingBecauseUnarchive = nextLifecycle !== 'archived'
    merged.lifecycleState = 'archived'
    if (preservingBecauseUnarchive && current.lifecycleStateSince !== undefined) {
        merged.lifecycleStateSince = current.lifecycleStateSince
    }
    if (current.archivedBy !== undefined) {
        merged.archivedBy = current.archivedBy
    }
    if (current.archiveReason !== undefined) {
        merged.archiveReason = current.archiveReason
    }
    return { metadata: merged, preserved: preservingBecauseUnarchive }
}

export function applyArchiveProtectionOnPatch(
    currentMetadata: unknown,
    patch: unknown
): ArchiveProtectionResult<Record<string, unknown>> {
    const asRecordPatch = isRecord(patch) ? { ...patch } : {}
    if (!isProtectedArchivedSession(currentMetadata) || !isRecord(patch)) {
        return { metadata: asRecordPatch, preserved: false }
    }
    const touchesArchive = ARCHIVE_STAMP_FIELDS.some((field) => hasOwn(asRecordPatch, field))
    if (!touchesArchive) {
        return { metadata: asRecordPatch, preserved: false }
    }
    if (asRecordPatch.lifecycleState === 'archived') {
        return { metadata: asRecordPatch, preserved: false }
    }
    for (const field of ARCHIVE_STAMP_FIELDS) {
        delete asRecordPatch[field]
    }
    return { metadata: asRecordPatch, preserved: true }
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

    if (isSessionOrchestrationChildSource(source)) {
        return normalized
    }

    delete normalized.mainSessionId

    const reservedMetadataKeys = new Set(getReservedSessionMetadataKeysForSource(source))
    for (const key of getAllSessionOrchestrationReservedMetadataKeys()) {
        if (!reservedMetadataKeys.has(key)) {
            delete normalized[key]
        }
    }

    return normalized
}
