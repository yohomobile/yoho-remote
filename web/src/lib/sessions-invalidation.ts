import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// Minimum gap between two actual `queryClient.invalidateQueries({ queryKey: sessions })`
// calls. Within this window additional requests are coalesced into a single trailing-edge
// invalidation, so a burst of SSE events (e.g. 30 sessions reconnecting after a server
// restart) produces at most one `/api/sessions` refetch instead of 30 sequential ones.
const SESSIONS_INVALIDATE_MIN_INTERVAL_MS = 500

type InvalidatorState = {
    pendingTimer: ReturnType<typeof setTimeout> | null
    lastInvokedAt: number
}

const stateByClient = new WeakMap<QueryClient, InvalidatorState>()

function getState(queryClient: QueryClient): InvalidatorState {
    let state = stateByClient.get(queryClient)
    if (!state) {
        state = { pendingTimer: null, lastInvokedAt: 0 }
        stateByClient.set(queryClient, state)
    }
    return state
}

export function scheduleSessionsListInvalidation(queryClient: QueryClient): void {
    const state = getState(queryClient)
    if (state.pendingTimer) return
    const now = Date.now()
    const waitMs = Math.max(0, SESSIONS_INVALIDATE_MIN_INTERVAL_MS - (now - state.lastInvokedAt))
    state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null
        state.lastInvokedAt = Date.now()
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }, waitMs)
}

// Used by tests and by the rare caller that needs immediate invalidation (mutation
// success paths where staleness matters for the very next render). SSE-driven paths
// should always use the throttled variant above.
export function flushSessionsListInvalidation(queryClient: QueryClient): void {
    const state = getState(queryClient)
    if (state.pendingTimer) {
        clearTimeout(state.pendingTimer)
        state.pendingTimer = null
    }
    state.lastInvokedAt = Date.now()
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
}
