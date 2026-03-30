import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useMachines(api: ApiClient | null, enabled: boolean, orgId?: string | null): {
    machines: Machine[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: [...queryKeys.machines, orgId ?? 'all'],
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getMachines(orgId ?? undefined)
        },
        enabled: Boolean(api && enabled),
    })

    return {
        machines: query.data?.machines ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load machines' : null,
        refetch: query.refetch,
    }
}
