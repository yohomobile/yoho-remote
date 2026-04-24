import type { Session, SessionSummary } from '@/types/api'
import type { ArchiveFilter } from '@/lib/session-filters'
import {
    isSessionOrchestrationChildSource,
    isSessionOrchestrationParentSource,
} from '@/lib/sessionOrchestration'

type SessionWithSource = Pick<Session, 'metadata'> | Pick<SessionSummary, 'metadata'>
type SessionWithReconnectState = Pick<Session, 'active' | 'reconnecting' | 'metadata'> | Pick<SessionSummary, 'active' | 'reconnecting' | 'metadata'>

export function isBrainChildSession(session: SessionWithSource): boolean {
    return isSessionOrchestrationChildSource(session.metadata?.source)
}

export function isArchivedSession(session: SessionWithReconnectState): boolean {
    return session.metadata?.lifecycleState === 'archived'
}

export function isSessionReconnecting(session: SessionWithReconnectState): boolean {
    return session.reconnecting === true
}

export function isSessionVisibleInActiveList(session: SessionWithReconnectState): boolean {
    return session.active || isSessionReconnecting(session)
}

export function matchesArchiveFilter(
    session: SessionWithReconnectState,
    archiveFilter: ArchiveFilter
): boolean {
    const archived = isArchivedSession(session)
    if (archiveFilter === 'archive') {
        return archived || !isSessionVisibleInActiveList(session)
    }
    return !archived && isSessionVisibleInActiveList(session)
}

export function canQueueMessagesWhenInactive(session: SessionWithSource): boolean {
    return isSessionOrchestrationParentSource(session.metadata?.source)
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
