import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionViewer } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessionViewers(
    api: ApiClient | null,
    orgId: string | null | undefined,
    sessionId: string | null,
): SessionViewer[] {
    // Query online users - uses same key as useOnlineUsers so data is shared
    const { data } = useQuery({
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
        staleTime: Infinity,
    })

    return useMemo(() => {
        if (!sessionId || !data?.users) {
            return []
        }
        return data.users
            .filter(user => user.sessionId === sessionId)
            .map(user => ({
                email: user.email,
                clientId: user.clientId,
                deviceType: user.deviceType
            }))
    }, [sessionId, data?.users])
}
