import { describe, expect, test } from 'bun:test'
import { invalidateSessionCachesForSidOnlyUpdate } from './useSSE'
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
})
