// DDL fragments for Phase 3C memory conflict tables.
// Mirrors what `PostgresStore.initSchema()` runs inline so that worker
// integration tests (and any future migration tooling) can guarantee the
// tables exist without booting the full server schema.

export const MEMORY_CONFLICT_CANDIDATES_DDL = `
    CREATE TABLE IF NOT EXISTS memory_conflict_candidates (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        org_id TEXT,
        scope TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        entries JSONB NOT NULL DEFAULT '[]',
        evidence JSONB,
        detector_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        resolution TEXT,
        decided_by TEXT,
        decided_at BIGINT,
        decision_reason TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_conflict_candidates_scope
        ON memory_conflict_candidates(namespace, org_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_conflict_candidates_subject
        ON memory_conflict_candidates(namespace, COALESCE(org_id, ''), scope, subject_key);
`

export const MEMORY_CONFLICT_AUDITS_DDL = `
    CREATE TABLE IF NOT EXISTS memory_conflict_audits (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        org_id TEXT,
        candidate_id TEXT NOT NULL REFERENCES memory_conflict_candidates(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        prior_status TEXT,
        new_status TEXT,
        resolution TEXT,
        actor_email TEXT,
        reason TEXT,
        payload JSONB,
        created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_conflict_audits_candidate
        ON memory_conflict_audits(candidate_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_conflict_audits_scope
        ON memory_conflict_audits(namespace, org_id, created_at DESC);
`
