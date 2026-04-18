import type { Session, SessionSummary } from '@/types/api'

type SessionWithSource = Pick<Session, 'metadata'> | Pick<SessionSummary, 'metadata'>

export function isBrainChildSession(session: SessionWithSource): boolean {
    return session.metadata?.source === 'brain-child'
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
