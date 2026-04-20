import type { Pool } from 'pg'
import {
    SESSION_SUMMARIES_DDL,
    SUMMARIZATION_RUNS_DDL,
} from '../../../server/src/store/session-summaries-ddl'

const POLL_INTERVAL_MS = 3_000
const SESSIONS_WAIT_TIMEOUT_MS = 60_000

export async function ensureWorkerSchema(pool: Pool): Promise<void> {
    const deadline = Date.now() + SESSIONS_WAIT_TIMEOUT_MS
    while (true) {
        const result = await pool.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sessions'`
        )
        if (result.rowCount && result.rowCount > 0) break
        if (Date.now() >= deadline) {
            throw new Error('[Worker] sessions table not found after 60s — start yoho-remote server first')
        }
        console.warn('[Worker] sessions table not found, retrying in 3s...')
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    await pool.query(SESSION_SUMMARIES_DDL)
    await pool.query(SUMMARIZATION_RUNS_DDL)
}
