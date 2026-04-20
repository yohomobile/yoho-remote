import type { Session, SessionSummary } from '@/types/api'
import type { ArchiveFilter } from '@/lib/session-filters'

type SessionWithSource = Pick<Session, 'metadata'> | Pick<SessionSummary, 'metadata'>
type SessionWithArchiveState = Pick<Session, 'active' | 'metadata'> | Pick<SessionSummary, 'active' | 'metadata'>

export function isBrainChildSession(session: SessionWithSource): boolean {
    return session.metadata?.source === 'brain-child'
}

export function isArchivedSession(session: SessionWithArchiveState): boolean {
    return session.metadata?.lifecycleState === 'archived'
}

export function matchesArchiveFilter(
    session: SessionWithArchiveState,
    archiveFilter: ArchiveFilter
): boolean {
    const archived = isArchivedSession(session)
    if (archiveFilter === 'archive') {
        return archived || !session.active
    }
    return !archived && session.active
}

export function canQueueMessagesWhenInactive(session: SessionWithSource): boolean {
    return session.metadata?.source === 'brain'
}

export function shouldShowSessionComposer(session: SessionWithSource): boolean {
    return !isBrainChildSession(session)
}

export function isIdleBrainChildSession(
    session: Pick<SessionSummary, 'active' | 'pendingRequestsCount' | 'metadata'>,
    isThinking: boolean
): boolean {
    return isBrainChildSession(session)
        && session.active
        && session.pendingRequestsCount === 0
        && !isThinking
}
