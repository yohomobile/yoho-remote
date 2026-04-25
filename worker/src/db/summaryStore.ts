import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { StoredL1Summary, StoredL2Summary } from '../types'

export type InsertL1SummaryInput = {
    sessionId: string
    namespace: string
    orgId: string
    seqStart: number
    seqEnd: number
    summary: string
    metadata: Record<string, unknown>
}

export type InsertL2SummaryInput = {
    sessionId: string
    namespace: string
    orgId: string
    seqStart: number | null
    seqEnd: number | null
    summary: string
    metadata: Record<string, unknown>
}

export type InsertSummaryResult = {
    id: string | null
    inserted: boolean
}

function asString(v: unknown): string | null {
    return typeof v === 'string' ? v : null
}

function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return []
    return v.filter((item): item is string => typeof item === 'string')
}

function rowToL1(row: Record<string, unknown>): StoredL1Summary {
    const meta = (row.metadata && typeof row.metadata === 'object')
        ? row.metadata as Record<string, unknown>
        : {}
    return {
        id: String(row.id),
        seqStart: row.seq_start != null ? Number(row.seq_start) : null,
        seqEnd: row.seq_end != null ? Number(row.seq_end) : null,
        summary: String(row.summary),
        topic: asString(meta.topic),
        tools: asStringArray(meta.tools),
        entities: asStringArray(meta.entities),
    }
}

function rowToL2(row: Record<string, unknown>): StoredL2Summary {
    const meta = (row.metadata && typeof row.metadata === 'object')
        ? row.metadata as Record<string, unknown>
        : {}
    return {
        id: String(row.id),
        seqStart: row.seq_start != null ? Number(row.seq_start) : null,
        seqEnd: row.seq_end != null ? Number(row.seq_end) : null,
        summary: String(row.summary),
        topic: asString(meta.topic),
        tools: asStringArray(meta.tools),
        entities: asStringArray(meta.entities),
    }
}

async function releaseSessionLock(client: PoolClient, lockKey: string): Promise<void> {
    try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
    } finally {
        client.release()
    }
}

export class SummaryStore {
    constructor(private readonly pool: Pool) {}

    async tryAcquireSessionLock(
        orgId: string,
        sessionId: string,
        scope: string
    ): Promise<(() => Promise<void>) | null> {
        const client = await this.pool.connect()
        const lockKey = `session-summary:${scope}:${orgId}:${sessionId}`
        let locked = false
        try {
            const result = await client.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
                [lockKey]
            )
            locked = result.rows[0]?.locked === true
            if (!locked) {
                client.release()
                return null
            }
            return async () => {
                await releaseSessionLock(client, lockKey)
            }
        } catch (error) {
            client.release()
            throw error
        }
    }

    async insertL1(input: InsertL1SummaryInput): Promise<InsertSummaryResult> {
        const id = randomUUID()
        const createdAt = Date.now()
        const result = await this.pool.query(
            `INSERT INTO session_summaries (
                id, session_id, namespace, org_id, level, seq_start, seq_end, summary, metadata, created_at
            )
            VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9)
            ON CONFLICT (org_id, session_id, level, seq_start) WHERE level IN (1, 2)
            DO NOTHING
            RETURNING id`,
            [
                id,
                input.sessionId,
                input.namespace,
                input.orgId,
                input.seqStart,
                input.seqEnd,
                input.summary,
                input.metadata,
                createdAt,
            ]
        )

        const insertedId = result.rows[0]?.id as string | undefined
        return insertedId
            ? { id: insertedId, inserted: true }
            : { id: null, inserted: false }
    }

    async insertL2(input: InsertL2SummaryInput): Promise<InsertSummaryResult> {
        const id = randomUUID()
        const createdAt = Date.now()
        const result = await this.pool.query(
            `INSERT INTO session_summaries (
                id, session_id, namespace, org_id, level, seq_start, seq_end, summary, metadata, created_at
            )
            VALUES ($1, $2, $3, $4, 2, $5, $6, $7, $8, $9)
            ON CONFLICT (org_id, session_id, level, seq_start) WHERE level IN (1, 2)
            DO NOTHING
            RETURNING id`,
            [
                id,
                input.sessionId,
                input.namespace,
                input.orgId,
                input.seqStart,
                input.seqEnd,
                input.summary,
                input.metadata,
                createdAt,
            ]
        )

        const insertedId = result.rows[0]?.id as string | undefined
        return insertedId
            ? { id: insertedId, inserted: true }
            : { id: null, inserted: false }
    }

    async countUnassignedL1(orgId: string, sessionId: string): Promise<number> {
        const result = await this.pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM session_summaries
             WHERE org_id = $1 AND session_id = $2 AND level = 1 AND parent_id IS NULL`,
            [orgId, sessionId]
        )
        return Number(result.rows[0]?.cnt ?? 0)
    }

    async getUnassignedL1Summaries(orgId: string, sessionId: string): Promise<StoredL1Summary[]> {
        const result = await this.pool.query(
            `SELECT id, seq_start, seq_end, summary, metadata
             FROM session_summaries
             WHERE org_id = $1 AND session_id = $2 AND level = 1 AND parent_id IS NULL
             ORDER BY seq_start ASC NULLS LAST, created_at ASC`,
            [orgId, sessionId]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToL1)
    }

    // Atomically insert L2 and mark the supplied L1 ids as segmented.
    // Uses a transaction + UPSERT so that on retry the existing L2 id is
    // returned and the mark step is always re-executed — preventing orphan L1s
    // even if the mark step failed on a prior attempt.
    async insertL2AndMarkL1s(
        input: {
            sessionId: string
            namespace: string
            orgId: string
            seqStart: number | null
            seqEnd: number | null
            summary: string
            metadata: Record<string, unknown>
        },
        l1Ids: string[]
    ): Promise<{ id: string }> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const id = randomUUID()
            const createdAt = Date.now()
            let l2Id: string

            if (input.seqStart != null) {
                // UPSERT: on conflict return the existing row's id so the mark
                // step can still run even on a retry after a previous partial failure.
                const result = await client.query<{ id: string }>(
                    `INSERT INTO session_summaries (
                        id, session_id, namespace, org_id, level, seq_start, seq_end, summary, metadata, created_at
                    )
                    VALUES ($1, $2, $3, $4, 2, $5, $6, $7, $8, $9)
                    ON CONFLICT (org_id, session_id, level, seq_start) WHERE level IN (1, 2)
                    DO UPDATE SET id = session_summaries.id
                    RETURNING id`,
                    [id, input.sessionId, input.namespace, input.orgId, input.seqStart, input.seqEnd,
                        input.summary, input.metadata, createdAt]
                )
                l2Id = String(result.rows[0]!.id)
            } else {
                // No dedup key: unconditional insert
                await client.query(
                    `INSERT INTO session_summaries (
                        id, session_id, namespace, org_id, level, seq_start, seq_end, summary, metadata, created_at
                    )
                    VALUES ($1, $2, $3, $4, 2, NULL, NULL, $5, $6, $7)`,
                    [id, input.sessionId, input.namespace, input.orgId, input.summary, input.metadata, createdAt]
                )
                l2Id = id
            }

            if (l1Ids.length > 0) {
                await client.query(
                    `UPDATE session_summaries SET parent_id = $1
                     WHERE org_id = $2 AND id = ANY($3::text[]) AND level = 1`,
                    [l2Id, input.orgId, l1Ids]
                )
            }

            await client.query('COMMIT')
            return { id: l2Id }
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }

    async getSegmentSummaries(orgId: string, sessionId: string): Promise<StoredL2Summary[]> {
        const result = await this.pool.query(
            `SELECT id, seq_start, seq_end, summary, metadata
             FROM session_summaries
             WHERE org_id = $1 AND session_id = $2 AND level = 2
             ORDER BY seq_start ASC NULLS LAST, created_at ASC`,
            [orgId, sessionId]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToL2)
    }

    async getTurnSummaries(orgId: string, sessionId: string): Promise<StoredL1Summary[]> {
        const result = await this.pool.query(
            `SELECT id, seq_start, seq_end, summary, metadata
             FROM session_summaries
             WHERE org_id = $1 AND session_id = $2 AND level = 1
             ORDER BY seq_start ASC NULLS LAST, created_at ASC`,
            [orgId, sessionId]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToL1)
    }

    async upsertL3(input: {
        sessionId: string
        namespace: string
        orgId: string
        summary: string
        metadata: Record<string, unknown>
    }): Promise<{ id: string }> {
        const id = randomUUID()
        const createdAt = Date.now()
        const result = await this.pool.query(
            `INSERT INTO session_summaries (id, session_id, namespace, org_id, level, summary, metadata, created_at)
             VALUES ($1, $2, $3, $4, 3, $5, $6, $7)
             ON CONFLICT (org_id, session_id) WHERE level = 3
             DO UPDATE SET
                 summary = EXCLUDED.summary,
                 metadata = EXCLUDED.metadata,
                 created_at = EXCLUDED.created_at
             RETURNING id`,
            [id, input.sessionId, input.namespace, input.orgId, input.summary, input.metadata, createdAt]
        )
        return { id: String(result.rows[0]?.id ?? id) }
    }
}
