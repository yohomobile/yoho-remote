// DDL fragments for the unified Approvals Engine (Phase 3 unification).
//
// Architecture:
//   - `approvals`              — master row per candidate (cross-domain queryable)
//   - `approval_audits`        — generic decision/transition log
//   - `approval_payload_*`     — per-domain typed payload (1:1 with approvals.id)
//
// Mirrors what `PostgresStore.initSchema()` runs inline so worker integration
// tests and migration tooling can ensure the tables exist without booting the
// full server schema. Add a new payload table when introducing a new approval
// domain — never widen this master table with domain-specific columns.

export const APPROVALS_DDL = `
    CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decided_at BIGINT,
        decision_reason TEXT,
        expires_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_subject_unique
        ON approvals(namespace, org_id, domain, subject_key);
    CREATE INDEX IF NOT EXISTS idx_approvals_org_status
        ON approvals(org_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_domain_status
        ON approvals(org_id, domain, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_expires
        ON approvals(status, expires_at)
        WHERE status = 'pending' AND expires_at IS NOT NULL;
`

export const APPROVAL_AUDITS_DDL = `
    CREATE TABLE IF NOT EXISTS approval_audits (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        action TEXT NOT NULL,
        prior_status TEXT,
        new_status TEXT,
        actor_email TEXT,
        actor_role TEXT,
        reason TEXT,
        payload_snapshot JSONB,
        created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_audits_approval
        ON approval_audits(approval_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approval_audits_scope
        ON approval_audits(org_id, domain, created_at DESC);
`

// Domain payload: identity merge candidate (Phase 3A migration target).
// FK targets that may disappear use ON DELETE SET NULL so audit history
// survives reconciliation.
export const APPROVAL_PAYLOAD_IDENTITY_DDL = `
    CREATE TABLE IF NOT EXISTS approval_payload_identity (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
        candidate_person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
        score REAL NOT NULL,
        auto_action TEXT NOT NULL DEFAULT 'review',
        risk_flags JSONB NOT NULL DEFAULT '[]',
        evidence JSONB NOT NULL DEFAULT '[]',
        matcher_version TEXT NOT NULL,
        suppress_until BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_payload_identity_identity
        ON approval_payload_identity(identity_id);
`

// Domain payload: team-shared memory candidate (Phase 3B).
export const APPROVAL_PAYLOAD_TEAM_MEMORY_DDL = `
    CREATE TABLE IF NOT EXISTS approval_payload_team_memory (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        proposed_by_person_id TEXT,
        proposed_by_email TEXT,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        session_id TEXT,
        memory_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_payload_team_memory_proposed_by
        ON approval_payload_team_memory(proposed_by_email);
`

// Domain payload: observation hypothesis (Phase 3F).
export const APPROVAL_PAYLOAD_OBSERVATION_DDL = `
    CREATE TABLE IF NOT EXISTS approval_payload_observation (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        subject_person_id TEXT,
        subject_email TEXT,
        hypothesis_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        detector_version TEXT NOT NULL,
        confidence DOUBLE PRECISION,
        signals JSONB NOT NULL DEFAULT '[]',
        suggested_patch JSONB,
        promoted_communication_plan_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_payload_observation_subject
        ON approval_payload_observation(subject_person_id);
`

// Domain payload: memory conflict candidate (Phase 3C).
export const APPROVAL_PAYLOAD_MEMORY_CONFLICT_DDL = `
    CREATE TABLE IF NOT EXISTS approval_payload_memory_conflict (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        summary TEXT NOT NULL,
        entries JSONB NOT NULL DEFAULT '[]',
        evidence JSONB,
        detector_version TEXT NOT NULL,
        resolution TEXT
    );
`

export const APPROVALS_ALL_DDL = [
    APPROVALS_DDL,
    APPROVAL_AUDITS_DDL,
    APPROVAL_PAYLOAD_IDENTITY_DDL,
    APPROVAL_PAYLOAD_TEAM_MEMORY_DDL,
    APPROVAL_PAYLOAD_OBSERVATION_DDL,
    APPROVAL_PAYLOAD_MEMORY_CONFLICT_DDL,
].join('\n')
