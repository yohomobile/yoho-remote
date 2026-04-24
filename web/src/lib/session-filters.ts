export type ArchiveFilter = 'active' | 'archive'
export type OwnerFilter = 'mine' | 'brain' | 'orchestrator' | 'automation' | 'others'

export type SessionListSearch = {
    archive?: ArchiveFilter
    owner?: OwnerFilter
}

export type NewSessionKind = 'brain' | 'orchestrator'

export type NewSessionSearch = SessionListSearch & {
    kind?: NewSessionKind
}

export type OwnerFilterAvailability = {
    viewOthersSessions?: boolean
    hasBrainSessions: boolean
    hasOrchestratorSessions: boolean
    hasAutomationSessions: boolean
}

export const DEFAULT_SESSION_LIST_SEARCH: Readonly<{
    archive: ArchiveFilter
    owner: OwnerFilter
}> = {
    archive: 'active',
    owner: 'mine',
}

export function validateSessionListSearch(search: Record<string, unknown>): SessionListSearch {
    const archive = search.archive === 'archive' ? 'archive' : undefined
    const owner = typeof search.owner === 'string' && ['mine', 'brain', 'orchestrator', 'automation', 'others'].includes(search.owner)
        ? search.owner as OwnerFilter
        : undefined

    return {
        archive,
        owner,
    }
}

export function validateNewSessionSearch(search: Record<string, unknown>): NewSessionSearch {
    const base = validateSessionListSearch(search)
    const kind = search.kind === 'brain' || search.kind === 'orchestrator'
        ? search.kind as NewSessionKind
        : undefined

    return {
        ...base,
        kind,
    }
}

export function normalizeOwnerFilter(owner: OwnerFilter, availability: OwnerFilterAvailability): OwnerFilter {
    if (owner === 'others' && availability.viewOthersSessions !== true) {
        return DEFAULT_SESSION_LIST_SEARCH.owner
    }
    if (owner === 'brain' && !availability.hasBrainSessions) {
        return DEFAULT_SESSION_LIST_SEARCH.owner
    }
    if (owner === 'orchestrator' && !availability.hasOrchestratorSessions) {
        return DEFAULT_SESSION_LIST_SEARCH.owner
    }
    if (owner === 'automation' && !availability.hasAutomationSessions) {
        return DEFAULT_SESSION_LIST_SEARCH.owner
    }
    return owner
}
