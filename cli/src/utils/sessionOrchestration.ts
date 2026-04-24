type SessionOrchestrationProfile = {
    key: string
    parentSource: string
    childSource: string
}

const SESSION_ORCHESTRATION_PROFILES = [
    {
        key: 'brain',
        parentSource: 'brain',
        childSource: 'brain-child',
    },
    {
        key: 'orchestrator',
        parentSource: 'orchestrator',
        childSource: 'orchestrator-child',
    },
] as const satisfies readonly SessionOrchestrationProfile[]

function normalizeSource(source: string | null | undefined): string | null {
    if (typeof source !== 'string') {
        return null
    }

    const trimmed = source.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : null
}

function getSessionOrchestrationProfileBySource(source: string | null | undefined): SessionOrchestrationProfile | null {
    const normalized = normalizeSource(source)
    if (!normalized) {
        return null
    }

    for (const profile of SESSION_ORCHESTRATION_PROFILES) {
        if (profile.parentSource === normalized || profile.childSource === normalized) {
            return profile
        }
    }

    return null
}

export function isSessionOrchestrationParentSource(source: string | null | undefined): boolean {
    return getSessionOrchestrationProfileBySource(source)?.parentSource === normalizeSource(source)
}

export function isSessionOrchestrationChildSource(source: string | null | undefined): boolean {
    return getSessionOrchestrationProfileBySource(source)?.childSource === normalizeSource(source)
}

export function getSessionOrchestrationChildSourceForParentSource(source: string | null | undefined): string | undefined {
    const profile = getSessionOrchestrationProfileBySource(source)
    if (!profile || profile.parentSource !== normalizeSource(source)) {
        return undefined
    }
    return profile.childSource
}
