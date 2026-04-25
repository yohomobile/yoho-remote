import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import {
    flushSessionsListInvalidation,
    scheduleSessionsListInvalidation,
} from './sessions-invalidation'

function makeInstrumentedClient(): { client: QueryClient; tracker: { calls: number } } {
    const client = new QueryClient()
    const tracker = { calls: 0 }
    const original = client.invalidateQueries.bind(client)
    client.invalidateQueries = ((filters: unknown) => {
        tracker.calls += 1
        return original(filters as Parameters<typeof original>[0])
    }) as typeof client.invalidateQueries
    return { client, tracker }
}

describe('sessions-invalidation throttle', () => {
    test('coalesces a burst of scheduled invalidations into a single refetch', async () => {
        const { client, tracker } = makeInstrumentedClient()
        for (let i = 0; i < 30; i++) {
            scheduleSessionsListInvalidation(client)
        }
        expect(tracker.calls).toBe(0) // still debounced

        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(tracker.calls).toBe(1)
    })

    test('flush bypasses the throttle for caller-mandated immediate invalidation', () => {
        const { client, tracker } = makeInstrumentedClient()
        scheduleSessionsListInvalidation(client)
        scheduleSessionsListInvalidation(client)
        expect(tracker.calls).toBe(0)

        flushSessionsListInvalidation(client)
        expect(tracker.calls).toBe(1)
    })

    test('second burst after cooldown produces a second refetch', async () => {
        const { client, tracker } = makeInstrumentedClient()
        scheduleSessionsListInvalidation(client)
        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(tracker.calls).toBe(1)

        scheduleSessionsListInvalidation(client)
        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(tracker.calls).toBe(2)
    })
})
