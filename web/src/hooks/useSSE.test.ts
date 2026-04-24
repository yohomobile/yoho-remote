import { describe, expect, test } from 'bun:test'
import { buildSseSubscriptionKey, invalidateSessionCachesForSidOnlyUpdate } from './useSSE'
import { queryKeys } from '@/lib/query-keys'

describe('useSSE sid-only update cache invalidation', () => {
    test('invalidates both sessions list and session detail caches', () => {
        const calls: Array<readonly unknown[]> = []
        const queryClient = {
            invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
                calls.push(queryKey)
                return Promise.resolve()
            }
        }

        invalidateSessionCachesForSidOnlyUpdate(queryClient, 'brain-child-1')

        expect(calls).toEqual([
            queryKeys.sessions,
            queryKeys.session('brain-child-1'),
        ])
    })

    test('includes orgId in the subscription key so org switches reconnect SSE', () => {
        expect(buildSseSubscriptionKey({
            all: true,
            orgId: 'org-a',
        })).not.toBe(buildSseSubscriptionKey({
            all: true,
            orgId: 'org-b',
        }))
    })
})
