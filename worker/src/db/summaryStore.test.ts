import { describe, expect, it } from 'bun:test'
import { SummaryStore } from './summaryStore'

describe('SummaryStore L2 claims', () => {
    it('claims L1 rows with FOR UPDATE SKIP LOCKED and a fixed limit', async () => {
        const queries: Array<{ sql: string; params?: unknown[] }> = []
        const client = {
            query: async (sql: string, params?: unknown[]) => {
                queries.push({ sql, params })
                if (sql.includes('RETURNING ss.id')) {
                    return {
                        rows: [
                            { id: 'l1-a', seq_start: 10, seq_end: 15, summary: 'A', metadata: { topic: 'A' } },
                            { id: 'l1-b', seq_start: 20, seq_end: 25, summary: 'B', metadata: { topic: 'B' } },
                        ],
                    }
                }
                return { rows: [] }
            },
            release: () => {},
        }
        const pool = {
            connect: async () => client,
        }
        const store = new SummaryStore(pool as never)

        const batch = await store.claimUnassignedL1ForSegment('org-a', 'session-a', 5, 600_000)
        const claimQuery = queries.find(query => query.sql.includes('FOR UPDATE SKIP LOCKED'))

        expect(batch.summaries.map(summary => summary.id)).toEqual(['l1-a', 'l1-b'])
        expect(batch.batchId).toBeString()
        expect(claimQuery?.sql).toContain('LIMIT $4')
        expect(claimQuery?.params?.[0]).toBe('org-a')
        expect(claimQuery?.params?.[1]).toBe('session-a')
        expect(claimQuery?.params?.[3]).toBe(5)
        expect(queries.map(query => query.sql)).toContain('BEGIN')
        expect(queries.map(query => query.sql)).toContain('COMMIT')
    })
})

    it('rejects L2 insert when claimed L1 rows are no longer owned by the batch', async () => {
        const queries: string[] = []
        const client = {
            query: async (sql: string) => {
                queries.push(sql)
                if (sql.includes('INSERT INTO session_summaries') && sql.includes('RETURNING id')) {
                    return { rows: [{ id: 'l2-existing' }], rowCount: 1 }
                }
                if (sql.includes('UPDATE session_summaries') && sql.includes('parent_id')) {
                    return { rows: [], rowCount: 0 }
                }
                return { rows: [], rowCount: 0 }
            },
            release: () => {},
        }
        const pool = { connect: async () => client }
        const store = new SummaryStore(pool as never)

        await expect(store.insertL2AndMarkClaimedL1s({
            sessionId: 'session-a',
            namespace: 'org-a',
            orgId: 'org-a',
            seqStart: 10,
            seqEnd: 20,
            summary: 'Segment',
            metadata: {},
            batchId: 'batch-lost',
        }, ['l1-a', 'l1-b'])).rejects.toThrow('L2 claim lost before mark')

        expect(queries).toContain('ROLLBACK')
        expect(queries).not.toContain('COMMIT')
    })
