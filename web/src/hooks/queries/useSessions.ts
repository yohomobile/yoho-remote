import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessions(api: ApiClient | null, orgId?: string | null): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: [...queryKeys.sessions, orgId ?? 'all'],
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const t0 = performance.now()
            console.warn('[useSessions queryFn] start orgId=', orgId)
            try {
                const res = await api.getSessions(orgId)
                console.warn(
                    `[useSessions queryFn] done orgId=${orgId} ` +
                    `count=${res.sessions?.length} ` +
                    `tookMs=${Math.round(performance.now() - t0)}`
                )
                return res
            } catch (e) {
                console.warn(
                    `[useSessions queryFn] threw orgId=${orgId} ` +
                    `tookMs=${Math.round(performance.now() - t0)} ` +
                    `err=${(e as Error)?.message}`
                )
                throw e
            }
        },
        enabled: Boolean(api),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
