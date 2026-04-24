export const AI_TASK_SCHEDULES_DDL = `
    CREATE TABLE IF NOT EXISTS ai_task_schedules (
        id                    TEXT PRIMARY KEY,
        namespace             TEXT NOT NULL,
        machine_id            TEXT NOT NULL,
        label                 TEXT,
        cron_expr             TEXT NOT NULL,
        payload_prompt        TEXT NOT NULL,
        directory             TEXT NOT NULL,
        agent                 TEXT NOT NULL DEFAULT 'claude',
        mode                  TEXT,
        model                 TEXT,
        recurring             BOOLEAN NOT NULL DEFAULT TRUE,
        enabled               BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            BIGINT NOT NULL,
        created_by_session_id TEXT,
        last_fire_at          BIGINT,
        next_fire_at          BIGINT,
        last_run_status       TEXT,
        consecutive_failures  INT NOT NULL DEFAULT 0
    );
    ALTER TABLE ai_task_schedules ADD COLUMN IF NOT EXISTS system_prompt   TEXT;
    ALTER TABLE ai_task_schedules ADD COLUMN IF NOT EXISTS tags            TEXT[];
    ALTER TABLE ai_task_schedules ADD COLUMN IF NOT EXISTS owner_email     TEXT;
    ALTER TABLE ai_task_schedules ADD COLUMN IF NOT EXISTS permission_mode TEXT;
    COMMENT ON COLUMN ai_task_schedules.namespace IS 'Semantically stores orgId. Column name kept for historical reasons; renaming deferred to a dedicated migration PR.';
`

export const AI_TASK_RUNS_DDL = `
    CREATE TABLE IF NOT EXISTS ai_task_runs (
        id            TEXT PRIMARY KEY,
        schedule_id   TEXT REFERENCES ai_task_schedules(id) ON DELETE SET NULL,
        session_id    TEXT,
        subsession_id TEXT,
        machine_id    TEXT NOT NULL,
        namespace     TEXT NOT NULL,
        status        TEXT NOT NULL,
        started_at    BIGINT NOT NULL,
        finished_at   BIGINT,
        error         TEXT,
        metadata      JSONB
    );
    COMMENT ON COLUMN ai_task_runs.namespace IS 'Semantically stores orgId. Column name kept for historical reasons; renaming deferred to a dedicated migration PR.';
`

export const AI_TASK_INDEXES_DDL = `
    CREATE INDEX IF NOT EXISTS idx_ats_machine_enabled ON ai_task_schedules(machine_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_ats_namespace_enabled ON ai_task_schedules(namespace, enabled);
    CREATE INDEX IF NOT EXISTS idx_ats_owner_email ON ai_task_schedules(owner_email);
    CREATE INDEX IF NOT EXISTS idx_atr_schedule ON ai_task_runs(schedule_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_atr_namespace ON ai_task_runs(namespace, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_atr_status ON ai_task_runs(status)
        WHERE status NOT IN ('succeeded', 'failed', 'timeout', 'deduped');
`
