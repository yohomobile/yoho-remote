import { describe, expect, it } from 'bun:test'
import { RunStore } from './runStore'

describe('RunStore', () => {
    it('writes org_id and uses org_id for cached L1 lookup', async () => {
        const queries: Array<{ sql: string; params: unknown[] }> = []
        const pool = {
            query: async (sql: string, params: unknown[]) => {
                queries.push({ sql, params })
                return { rows: [] }
            },
        }
        const store = new RunStore(pool as never)

        await store.insert({
            sessionId: 'session-1',
            namespace: 'legacy-ns',
            orgId: 'org-a',
            level: 1,
            status: 'success',
        })
        await store.getLatestCachedL1Result('org-a', 'session-1', 10, 'summarize-turn', 1)

        expect(queries[0]?.sql).toContain('org_id')
        expect(queries[0]?.params[3]).toBe('org-a')
        expect(queries[1]?.sql).toContain('WHERE org_id = $1')
        expect(queries[1]?.params[0]).toBe('org-a')
    })
})
