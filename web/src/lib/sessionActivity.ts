import type { SessionSummary } from '@/types/api'

export function isIdleBrainChildSession(
    session: Pick<SessionSummary, 'active' | 'pendingRequestsCount' | 'metadata'>,
    isThinking: boolean
): boolean {
    return session.metadata?.source === 'brain-child'
        && session.active
        && session.pendingRequestsCount === 0
        && !isThinking
}
