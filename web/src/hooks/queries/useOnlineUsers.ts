import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { OnlineUser } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useOnlineUsers(api: ApiClient | null, orgId: string | null | undefined): {
    users: OnlineUser[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.onlineUsers(orgId ?? ''),
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (!orgId) {
                throw new Error('orgId unavailable')
            }
            return await api.getOnlineUsers(orgId)
        },
        enabled: Boolean(api && orgId),
    })

    return {
        users: query.data?.users ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load online users' : null,
        refetch: query.refetch,
    }
}
