import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// Minimum gap between two actual `queryClient.invalidateQueries({ queryKey: sessions })`
// calls. Within this window additional requests are coalesced into a single trailing-edge
// invalidation, so a burst of SSE events (e.g. 30 sessions reconnecting after a server
// restart) produces at most one `/api/sessions` refetch instead of 30 sequential ones.
//
// 拉到 3000ms 是因为 /api/sessions 在用户量大时响应可达 4MB+,持续高频 invalidate 会让
// fetch 在 stream 中反复被 abort 取消,永远拿不完整响应(2026-04-25 实测)。
const SESSIONS_INVALIDATE_MIN_INTERVAL_MS = 3000

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
    // [DEBUG-2026-04-25] 排查 /api/sessions 高频刷新:打印每次 schedule 的调用源
    console.warn('[schedule-sessions-invalidate] called by:\n' + (new Error().stack || '(no stack)'))
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
