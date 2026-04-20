import type { Pool } from 'pg'
import {
    SESSION_SUMMARIES_DDL,
    SUMMARIZATION_RUNS_DDL,
} from '../../../server/src/store/session-summaries-ddl'

export async function ensureWorkerSchema(pool: Pool): Promise<void> {
    await pool.query(SESSION_SUMMARIES_DDL)
    await pool.query(SUMMARIZATION_RUNS_DDL)
}
