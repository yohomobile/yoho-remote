import { describe, expect, it } from 'bun:test'
import { ensureWorkerSchema } from './schema'
import type { Pool } from 'pg'

function makePool(options: {
    sessionExistsOnAttempt: number  // 1-indexed: on which query the sessions table appears
    queryError?: Error
}) {
    let pollCount = 0
    let totalQueries = 0
    const pool = {
        query: async (sql: string) => {
            totalQueries += 1
            if (options.queryError) throw options.queryError
            if (sql.includes('information_schema.tables')) {
                pollCount += 1
                return { rowCount: pollCount >= options.sessionExistsOnAttempt ? 1 : 0, rows: [] }
            }
            return { rowCount: 0, rows: [] }
        },
        getPollCount: () => pollCount,
        getTotalQueries: () => totalQueries,
    }
    return pool
}

describe('ensureWorkerSchema', () => {
    it('runs DDL immediately when sessions table already exists', async () => {
        const pool = makePool({ sessionExistsOnAttempt: 1 })

        await ensureWorkerSchema(pool as unknown as Pool)

        // 1 sessions poll + 2 DDL queries
        expect(pool.getPollCount()).toBe(1)
        expect(pool.getTotalQueries()).toBe(3)
    })

    it('polls until sessions table appears then runs DDL', async () => {
        const pool = makePool({ sessionExistsOnAttempt: 3 })

        // Override POLL_INTERVAL_MS by patching setTimeout via bun:test timers is not straightforward
        // here we rely on actual timers being fast enough. Use a custom override approach:
        const origSetTimeout = globalThis.setTimeout
        // Accelerate polling by replacing setTimeout with immediate execution
        ;(globalThis as any).setTimeout = (fn: () => void, _ms: number) => origSetTimeout(fn, 0)

        try {
            await ensureWorkerSchema(pool as unknown as Pool)
        } finally {
            ;(globalThis as any).setTimeout = origSetTimeout
        }

        expect(pool.getPollCount()).toBe(3)
        // 3 polls + 2 DDL queries
        expect(pool.getTotalQueries()).toBe(5)
    })
})
