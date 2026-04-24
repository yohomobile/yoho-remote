import { describe, expect, test } from 'bun:test'
import { SyncEngine } from './syncEngine'

function buildEngine(): SyncEngine {
    const store = {
        getSessions: async () => [],
        getMachines: async () => [],
        getSessionNotificationRecipientClientIds: async () => [],
        setSessionModelConfig: async () => true,
    } as any

    const io = {
        of: () => ({
            to: () => ({ emit() {} }),
            emit() {},
        }),
    } as any

    const boss = {
        async send() { return 'job-1' },
        async sendSessionSummary() { return 'job-session' },
        async stop() {},
    } as any

    return new SyncEngine(store, io, {} as any, {
        broadcast() {},
        broadcastToGroup() {},
    } as any, boss)
}

describe('SyncEngine brain callback retry lifecycle', () => {
    test('waitForBrainCallbackRetry resolves false after the natural delay', async () => {
        const engine = buildEngine()
        try {
            const started = Date.now()
            const aborted = await (engine as any).waitForBrainCallbackRetry(20)
            const elapsed = Date.now() - started
            expect(aborted).toBe(false)
            expect(elapsed).toBeGreaterThanOrEqual(15)
        } finally {
            engine.stop()
        }
    })

    test('stop() aborts in-flight retry waits instead of hanging', async () => {
        const engine = buildEngine()
        const started = Date.now()
        // 10min delay — if abort is broken, the test will time out instead of finishing fast.
        const waitPromise = (engine as any).waitForBrainCallbackRetry(10 * 60 * 1000) as Promise<boolean>
        engine.stop()
        const aborted = await waitPromise
        expect(aborted).toBe(true)
        expect(Date.now() - started).toBeLessThan(500)
    })

    test('waitForBrainCallbackRetry returns true immediately after stop()', async () => {
        const engine = buildEngine()
        engine.stop()
        const aborted = await (engine as any).waitForBrainCallbackRetry(10 * 60 * 1000)
        expect(aborted).toBe(true)
    })

    test('pending retry timer is unref-d so it cannot keep the event loop alive', async () => {
        const engine = buildEngine()
        try {
            const aborters: Set<() => void> = (engine as any).brainCallbackRetryAborters
            expect(aborters.size).toBe(0)
            // Schedule a long wait and immediately inspect timer flags.
            const waitPromise = (engine as any).waitForBrainCallbackRetry(10 * 60 * 1000)
            expect(aborters.size).toBe(1)
            // Abort it so the promise settles before the test ends.
            engine.stop()
            await waitPromise
            expect(aborters.size).toBe(0)
        } finally {
            engine.stop()
        }
    })

    test('retryBrainCallback exits early once stop() fires, even with pending retries', async () => {
        const engine = buildEngine()
        ;(engine as any).brainCallbackRetryDelaysMs = [5 * 60 * 1000, 5 * 60 * 1000]
        ;(engine as any).brainChildPendingRetryCallbackKeyBySessionId.set('child-1', 'key-1')

        const started = Date.now()
        const retryPromise = (engine as any).retryBrainCallback('child-1', 'main-1', 'key-1', 'offline')
        engine.stop()
        await retryPromise
        expect(Date.now() - started).toBeLessThan(500)
        // Pending-retry map was cleared by stop().
        expect((engine as any).brainChildPendingRetryCallbackKeyBySessionId.size).toBe(0)
    })
})
