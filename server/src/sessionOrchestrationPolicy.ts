type SessionOrchestrationProfile = {
    key: string
    parentSource: string
    childSource: string
    reservedMetadataKeys: readonly string[]
}

type SessionOrchestrationProfileMatch = {
    profile: SessionOrchestrationProfile
    role: 'parent' | 'child'
}

const SESSION_ORCHESTRATION_PROFILES = [
    {
        key: 'brain',
        parentSource: 'brain',
        childSource: 'brain-child',
        reservedMetadataKeys: ['brainPreferences'],
    },
    {
        key: 'orchestrator',
        parentSource: 'orchestrator',
        childSource: 'orchestrator-child',
        reservedMetadataKeys: [],
    },
] as const satisfies readonly SessionOrchestrationProfile[]

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

function normalizeSource(source: unknown): string | null {
    if (typeof source !== 'string') {
        return null
    }

    const trimmed = source.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : null
}

function getSessionOrchestrationProfileMatch(source: string | null | undefined): SessionOrchestrationProfileMatch | null {
    const normalized = normalizeSource(source)
    if (!normalized) {
        return null
    }

    for (const profile of SESSION_ORCHESTRATION_PROFILES) {
        if (profile.parentSource === normalized) {
            return { profile, role: 'parent' }
        }
        if (profile.childSource === normalized) {
            return { profile, role: 'child' }
        }
    }

    return null
}

export function getSessionOrchestrationProfileBySource(source: string | null | undefined): SessionOrchestrationProfile | null {
    return getSessionOrchestrationProfileMatch(source)?.profile ?? null
}

export function getAllSessionOrchestrationSources(): string[] {
    return SESSION_ORCHESTRATION_PROFILES.flatMap((profile) => [profile.parentSource, profile.childSource])
}

export function getAllSessionOrchestrationParentSources(): string[] {
    return SESSION_ORCHESTRATION_PROFILES.map((profile) => profile.parentSource)
}

export function getAllSessionOrchestrationChildSources(): string[] {
    return SESSION_ORCHESTRATION_PROFILES.map((profile) => profile.childSource)
}

export function getAllSessionOrchestrationReservedMetadataKeys(): string[] {
    return [...new Set(SESSION_ORCHESTRATION_PROFILES.flatMap((profile) => profile.reservedMetadataKeys))]
}

export function isSessionOrchestrationParentSource(source: string | null | undefined, parentSource?: string): boolean {
    const match = getSessionOrchestrationProfileMatch(source)
    if (!match || match.role !== 'parent') {
        return false
    }
    return parentSource ? match.profile.parentSource === normalizeSource(parentSource) : true
}

export function isSessionOrchestrationChildSource(source: string | null | undefined, childSource?: string): boolean {
    const match = getSessionOrchestrationProfileMatch(source)
    if (!match || match.role !== 'child') {
        return false
    }
    return childSource ? match.profile.childSource === normalizeSource(childSource) : true
}

export function hasSessionOrchestrationMetadata(metadata: unknown): boolean {
    if (!isRecord(metadata)) {
        return false
    }

    if (asNonEmptyString(metadata.mainSessionId)) {
        return true
    }

    return getAllSessionOrchestrationReservedMetadataKeys().some((key) => Object.prototype.hasOwnProperty.call(metadata, key))
}

export function getReservedSessionMetadataKeysForSource(source: string | null | undefined): string[] {
    const match = getSessionOrchestrationProfileMatch(source)
    return match ? [...match.profile.reservedMetadataKeys] : []
}

export function getSessionOrchestrationChildSourceForParentSource(parentSource: string | null | undefined): string | undefined {
    const match = getSessionOrchestrationProfileMatch(parentSource)
    if (!match || match.role !== 'parent') {
        return undefined
    }
    return match.profile.childSource
}

export function getSessionOrchestrationParentSourceForChildSource(childSource: string | null | undefined): string | undefined {
    const match = getSessionOrchestrationProfileMatch(childSource)
    if (!match || match.role !== 'child') {
        return undefined
    }
    return match.profile.parentSource
}

export function getSessionOrchestrationParentSessionId(metadata: unknown, childSource?: string): string | undefined {
    if (!isRecord(metadata)) {
        return undefined
    }

    const source = normalizeSource(metadata.source)
    if (!isSessionOrchestrationChildSource(source, childSource)) {
        return undefined
    }

    return asNonEmptyString(metadata.mainSessionId) ?? undefined
}

export function isSessionOrchestrationParentChildSourcePair(
    parentSource: string | null | undefined,
    childSource: string | null | undefined,
): boolean {
    const profile = getSessionOrchestrationProfileBySource(parentSource)
    return Boolean(profile && profile.childSource === normalizeSource(childSource))
}

export function isSessionOrchestrationParentMetadata(metadata: unknown, parentSource?: string): boolean {
    if (!isRecord(metadata)) {
        return false
    }

    return isSessionOrchestrationParentSource(normalizeSource(metadata.source), parentSource)
}

export function isSessionOrchestrationChildMetadata(metadata: unknown, childSource?: string): boolean {
    if (!isRecord(metadata)) {
        return false
    }

    return isSessionOrchestrationChildSource(normalizeSource(metadata.source), childSource)
}

export function isSessionOrchestrationChildForParent(
    metadata: unknown,
    parentSessionId: string,
    childSource?: string,
): boolean {
    return getSessionOrchestrationParentSessionId(metadata, childSource) === parentSessionId
}

export function isSessionOrchestrationChildForParentMetadata(
    childMetadata: unknown,
    parentMetadata: unknown,
    parentSessionId: string,
): boolean {
    if (!isRecord(parentMetadata)) {
        return false
    }

    const parentSource = normalizeSource(parentMetadata.source)
    const childSource = getSessionOrchestrationChildSourceForParentSource(parentSource)
    if (!childSource) {
        return false
    }

    return isSessionOrchestrationChildForParent(childMetadata, parentSessionId, childSource)
}
