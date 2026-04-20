export const SESSION_SUMMARIES_DDL = `
    CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        level SMALLINT NOT NULL,
        seq_start INTEGER,
        seq_end INTEGER,
        parent_id TEXT REFERENCES session_summaries(id) ON DELETE SET NULL,
        summary TEXT NOT NULL,
        metadata JSONB,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_dedup
        ON session_summaries(session_id, level, seq_start) WHERE level IN (1, 2);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_l3_unique
        ON session_summaries(session_id) WHERE level = 3;

    CREATE INDEX IF NOT EXISTS idx_ss_session_level ON session_summaries(session_id, level);
    CREATE INDEX IF NOT EXISTS idx_ss_created ON session_summaries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ss_namespace_level_created
        ON session_summaries(namespace, level, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ss_metadata_skills
        ON session_summaries USING GIN ((metadata->'skill_refs'));
`

export const SUMMARIZATION_RUNS_DDL = `
    CREATE TABLE IF NOT EXISTS summarization_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        level SMALLINT NOT NULL,
        job_id TEXT,
        job_name TEXT,
        job_family TEXT,
        job_version INTEGER,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        tokens_in INTEGER,
        tokens_out INTEGER,
        worker_host TEXT,
        worker_version TEXT,
        queue_schema TEXT,
        retry_count INTEGER,
        retry_limit INTEGER,
        cache_hit BOOLEAN,
        provider_name TEXT,
        provider_model TEXT,
        provider_status INTEGER,
        provider_request_id TEXT,
        provider_finish_reason TEXT,
        error_code TEXT,
        error TEXT,
        metadata JSONB,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS job_name TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS job_family TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS job_version INTEGER;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS worker_host TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS worker_version TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS queue_schema TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS retry_count INTEGER;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS retry_limit INTEGER;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS provider_name TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS provider_model TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS provider_status INTEGER;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS provider_request_id TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS provider_finish_reason TEXT;
    ALTER TABLE summarization_runs ADD COLUMN IF NOT EXISTS error_code TEXT;

    CREATE INDEX IF NOT EXISTS idx_sr_session ON summarization_runs(session_id, level);
    CREATE INDEX IF NOT EXISTS idx_sr_status ON summarization_runs(status) WHERE status != 'success';
    CREATE INDEX IF NOT EXISTS idx_sr_created ON summarization_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sr_namespace_created
        ON summarization_runs(namespace, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sr_job_created
        ON summarization_runs(job_name, created_at DESC) WHERE job_name IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sr_idempotency_key
        ON summarization_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sr_provider_request_id
        ON summarization_runs(provider_request_id) WHERE provider_request_id IS NOT NULL;
`
