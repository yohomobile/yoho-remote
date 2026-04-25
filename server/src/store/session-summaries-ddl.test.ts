import { describe, expect, it } from 'bun:test'
import { SESSION_SUMMARIES_DDL, SUMMARIZATION_RUNS_DDL } from './session-summaries-ddl'

describe('session summary DDL', () => {
    it('includes L2 claim columns and org-scoped run indexes', () => {
        expect(SESSION_SUMMARIES_DDL).toContain('segment_batch_id TEXT')
        expect(SESSION_SUMMARIES_DDL).toContain('claimed_at BIGINT')
        expect(SESSION_SUMMARIES_DDL).toContain('claim_expires_at BIGINT')
        expect(SESSION_SUMMARIES_DDL).toContain('WHERE level = 1')
        expect(SUMMARIZATION_RUNS_DDL).toContain('org_id TEXT')
        expect(SUMMARIZATION_RUNS_DDL).toContain('idx_sr_org_session')
        expect(SUMMARIZATION_RUNS_DDL).toContain('idx_sr_org_created')
    })
})
