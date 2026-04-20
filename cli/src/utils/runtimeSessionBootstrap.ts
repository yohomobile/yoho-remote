import type { ApiClient } from '@/api/api'
import type { AgentState, Metadata, Session } from '@/api/types'
import { logger } from '@/ui/logger'

export function buildReservedSessionLoadScope(mainSessionId?: string | null): { mainSessionId: string } | undefined {
    const trimmed = mainSessionId?.trim()
    if (!trimmed) {
        return undefined
    }
    return { mainSessionId: trimmed }
}

export async function loadOrCreateRuntimeSession(args: {
    api: Pick<ApiClient, 'getSession' | 'getOrCreateSession'>
    tag: string
    metadata: Metadata
    state: AgentState | null
    yohoRemoteSessionId?: string | null
    mainSessionId?: string | null
    logPrefix: string
}): Promise<Session> {
    const reservedSessionId = args.yohoRemoteSessionId?.trim() || null
    const loadScope = buildReservedSessionLoadScope(args.mainSessionId)

    if (reservedSessionId) {
        logger.debug(`${args.logPrefix} Attempting to load reserved session ${reservedSessionId}`, {
            mainSessionId: loadScope?.mainSessionId ?? null,
        })
        try {
            const session = await args.api.getSession(reservedSessionId, loadScope)
            logger.debug(`${args.logPrefix} Session loaded: ${session.id}`)
            return session
        } catch (error) {
            logger.debug(`${args.logPrefix} Failed to load session ${reservedSessionId}, creating new one`, error)
        }
    }

    const session = await args.api.getOrCreateSession({
        tag: args.tag,
        metadata: args.metadata,
        state: args.state,
    })
    logger.debug(`${args.logPrefix} Session created via fallback/new bootstrap: ${session.id}`, {
        reservedSessionId,
        mainSessionId: loadScope?.mainSessionId ?? null,
    })
    return session
}
