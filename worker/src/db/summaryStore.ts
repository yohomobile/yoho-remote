import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

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
}
