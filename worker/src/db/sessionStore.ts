import type { Pool } from 'pg'
import { isTurnStartUserMessage } from '../extract/messageExtractor'
import type { DbMessage, SessionSnapshot } from '../types'

const TURN_SCAN_BATCH_SIZE = 200

function toDbMessage(row: Record<string, unknown>): DbMessage {
    return {
        id: String(row.id),
        seq: Number(row.seq),
        content: row.content,
        createdAt: Number(row.created_at),
    }
}

export class SessionStore {
    constructor(private readonly pool: Pool) {}

    async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
        const result = await this.pool.query(
            `SELECT id, namespace, thinking
             FROM sessions
             WHERE id = $1
             LIMIT 1`,
            [sessionId]
        )

        const row = result.rows[0] as Record<string, unknown> | undefined
        if (!row) {
            return null
        }

        return {
            id: String(row.id),
            namespace: String(row.namespace),
            thinking: Boolean(row.thinking),
        }
    }

    async getTurnMessages(sessionId: string, userSeq: number): Promise<DbMessage[]> {
        const collected: DbMessage[] = []
        let afterSeq = userSeq - 1

        while (true) {
            const result = await this.pool.query(
                `SELECT id, seq, content, created_at
                 FROM messages
                 WHERE session_id = $1 AND seq > $2
                 ORDER BY seq ASC, created_at ASC
                 LIMIT $3`,
                [sessionId, afterSeq, TURN_SCAN_BATCH_SIZE]
            )

            if (result.rows.length === 0) {
                break
            }

            for (const row of result.rows as Record<string, unknown>[]) {
                const message = toDbMessage(row)
                if (message.seq < userSeq) {
                    continue
                }
                if (collected.length > 0 && isTurnStartUserMessage(message.content)) {
                    return collected
                }
                collected.push(message)
            }

            afterSeq = Number(result.rows[result.rows.length - 1]?.seq ?? afterSeq)
            if (result.rows.length < TURN_SCAN_BATCH_SIZE) {
                break
            }
        }

        return collected
    }
}
