export type ArchiveFilter = 'active' | 'archive'
export type OwnerFilter = 'mine' | 'openclaw' | 'brain' | 'others'

export type SessionListSearch = {
    archive?: ArchiveFilter
    owner?: OwnerFilter
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
    const owner = typeof search.owner === 'string' && ['mine', 'openclaw', 'brain', 'others'].includes(search.owner)
        ? search.owner as OwnerFilter
        : undefined

    return {
        archive,
        owner,
    }
}
