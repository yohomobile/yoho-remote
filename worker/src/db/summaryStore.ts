import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { StoredL1Summary, StoredL2Summary } from '../types'

export type InsertL1SummaryInput = {
    sessionId: string
    namespace: string
    seqStart: number
    seqEnd: number
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

export class SummaryStore {
    constructor(private readonly pool: Pool) {}

    async insertL1(input: InsertL1SummaryInput): Promise<InsertSummaryResult> {
        const id = randomUUID()
        const createdAt = Date.now()
        const result = await this.pool.query(
            `INSERT INTO session_summaries (
                id, session_id, namespace, level, seq_start, seq_end, summary, metadata, created_at
            )
            VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)
            ON CONFLICT (session_id, level, seq_start) WHERE level IN (1, 2)
            DO NOTHING
            RETURNING id`,
            [
                id,
                input.sessionId,
                input.namespace,
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

    async countUnassignedL1(sessionId: string): Promise<number> {
        const result = await this.pool.query(
            `SELECT COUNT(*)::int AS cnt
             FROM session_summaries
             WHERE session_id = $1 AND level = 1 AND parent_id IS NULL`,
            [sessionId]
        )
        return Number(result.rows[0]?.cnt ?? 0)
    }

    async getUnassignedL1Summaries(sessionId: string): Promise<StoredL1Summary[]> {
        const result = await this.pool.query(
            `SELECT id, seq_start, seq_end, summary, metadata
             FROM session_summaries
             WHERE session_id = $1 AND level = 1 AND parent_id IS NULL
             ORDER BY seq_start ASC NULLS LAST, created_at ASC`,
            [sessionId]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToL1)
    }

    async insertL2(input: {
        sessionId: string
        namespace: string
        seqStart: number | null
        seqEnd: number | null
        summary: string
        metadata: Record<string, unknown>
    }): Promise<InsertSummaryResult> {
        const id = randomUUID()
        const createdAt = Date.now()

        if (input.seqStart != null) {
            const result = await this.pool.query(
                `INSERT INTO session_summaries (
                    id, session_id, namespace, level, seq_start, seq_end, summary, metadata, created_at
                )
                VALUES ($1, $2, $3, 2, $4, $5, $6, $7, $8)
                ON CONFLICT (session_id, level, seq_start) WHERE level IN (1, 2)
                DO NOTHING
                RETURNING id`,
                [id, input.sessionId, input.namespace, input.seqStart, input.seqEnd,
                    input.summary, input.metadata, createdAt]
            )
            const insertedId = result.rows[0]?.id as string | undefined
            return insertedId
                ? { id: insertedId, inserted: true }
                : { id: null, inserted: false }
        }

        // No seq_start: unconditional insert (no dedup key)
        await this.pool.query(
            `INSERT INTO session_summaries (
                id, session_id, namespace, level, seq_start, seq_end, summary, metadata, created_at
            )
            VALUES ($1, $2, $3, 2, NULL, NULL, $4, $5, $6)`,
            [id, input.sessionId, input.namespace, input.summary, input.metadata, createdAt]
        )
        return { id, inserted: true }
    }

    async markL1sAsSegmented(l1Ids: string[], l2Id: string): Promise<void> {
        if (l1Ids.length === 0) return
        await this.pool.query(
            `UPDATE session_summaries SET parent_id = $1 WHERE id = ANY($2::text[]) AND level = 1`,
            [l2Id, l1Ids]
        )
    }

    async getSegmentSummaries(sessionId: string): Promise<StoredL2Summary[]> {
        const result = await this.pool.query(
            `SELECT id, seq_start, seq_end, summary, metadata
             FROM session_summaries
             WHERE session_id = $1 AND level = 2
             ORDER BY seq_start ASC NULLS LAST, created_at ASC`,
            [sessionId]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToL2)
    }

    async getTurnSummaries(sessionId: string): Promise<StoredL1Summary[]> {
        const result = await this.pool.query(
            `SELECT id, seq_start, seq_end, summary, metadata
             FROM session_summaries
             WHERE session_id = $1 AND level = 1
             ORDER BY seq_start ASC NULLS LAST, created_at ASC`,
            [sessionId]
        )
        return (result.rows as Record<string, unknown>[]).map(rowToL1)
    }

    async upsertL3(input: {
        sessionId: string
        namespace: string
        summary: string
        metadata: Record<string, unknown>
    }): Promise<{ id: string }> {
        const id = randomUUID()
        const createdAt = Date.now()
        const result = await this.pool.query(
            `INSERT INTO session_summaries (id, session_id, namespace, level, summary, metadata, created_at)
             VALUES ($1, $2, $3, 3, $4, $5, $6)
             ON CONFLICT (session_id) WHERE level = 3
             DO UPDATE SET
                 summary = EXCLUDED.summary,
                 metadata = EXCLUDED.metadata,
                 created_at = EXCLUDED.created_at
             RETURNING id`,
            [id, input.sessionId, input.namespace, input.summary, input.metadata, createdAt]
        )
        return { id: String(result.rows[0]?.id ?? id) }
    }
}
