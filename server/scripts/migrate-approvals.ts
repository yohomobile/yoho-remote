#!/usr/bin/env bun
// One-shot migration script: copies data from the four legacy candidate
// tables (person_identity_candidates / team_memory_candidates /
// observation_candidates / memory_conflict_candidates) into the unified
// `approvals` + `approval_payload_*` schema.
//
// Idempotent: reruns are safe because INSERT rows use deterministic ids
// derived from the legacy candidate id (approval_id = `mig_<domain>_<legacy_id>`).
// Audit rows follow the same pattern. Existing rows are skipped.
//
// Usage:
//   bun run server/scripts/migrate-approvals.ts                 # dry-run (prints counts)
//   bun run server/scripts/migrate-approvals.ts --commit        # actually write
//
// The script does NOT drop the legacy tables. Keep them around read-only
// until the new flow has been validated in prod; a follow-up migration should
// DROP them once no code paths read from them.

import { Pool } from 'pg'

type LegacyCandidate = Record<string, any>

const COMMIT = process.argv.includes('--commit')

async function main() {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('DATABASE_URL not set')
        process.exit(1)
    }
    const pool = new Pool({ connectionString })

    const stats = {
        identity: { seen: 0, inserted: 0, skipped: 0 },
        team_memory: { seen: 0, inserted: 0, skipped: 0 },
        observation: { seen: 0, inserted: 0, skipped: 0 },
        memory_conflict: { seen: 0, inserted: 0, skipped: 0 },
    }

    await migrateIdentity(pool, stats.identity)
    await migrateTeamMemory(pool, stats.team_memory)
    await migrateObservation(pool, stats.observation)
    await migrateMemoryConflict(pool, stats.memory_conflict)

    console.log('\n=== Migration summary ===')
    for (const [domain, s] of Object.entries(stats)) {
        console.log(`  ${domain.padEnd(18)} seen=${s.seen}  inserted=${s.inserted}  skipped=${s.skipped}`)
    }
    if (!COMMIT) {
        console.log('\nDRY-RUN. Re-run with --commit to write.')
    }
    await pool.end()
}

function mapStatus(legacy: string | null | undefined): string {
    const s = (legacy || 'pending').toLowerCase()
    // Legacy status vocab across domains — map into master statuses.
    switch (s) {
        case 'open': return 'pending'
        case 'pending': return 'pending'
        case 'confirmed':
        case 'approved':
        case 'resolved': return 'approved'
        case 'rejected': return 'rejected'
        case 'dismissed': return 'dismissed'
        case 'expired': return 'expired'
        case 'superseded': return 'approved'
        default: return 'pending'
    }
}

async function migrateIdentity(pool: Pool, stats: { seen: number; inserted: number; skipped: number }) {
    const result = await pool.query(`SELECT * FROM person_identity_candidates`)
    for (const row of result.rows as LegacyCandidate[]) {
        stats.seen++
        const approvalId = `mig_identity_${row.id}`
        const subjectKey = `id:${row.identity_id}:${row.candidate_person_id ?? 'new'}`
        const inserted = await upsertApprovalRow(pool, {
            id: approvalId,
            namespace: row.namespace,
            orgId: row.org_id,
            domain: 'identity',
            subjectKind: 'identity_candidate',
            subjectKey,
            status: mapStatus(row.status),
            decidedBy: row.decided_by,
            decidedAt: row.decided_at,
            decisionReason: row.decision_reason,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        })
        if (!inserted) { stats.skipped++; continue }
        await upsertPayload(pool, 'approval_payload_identity', approvalId, {
            identity_id: row.identity_id,
            candidate_person_id: row.candidate_person_id,
            score: row.score,
            auto_action: row.auto_action,
            risk_flags: row.risk_flags,
            evidence: row.evidence,
            matcher_version: row.matcher_version,
            suppress_until: row.suppress_until,
        })
        stats.inserted++
    }
}

async function migrateTeamMemory(pool: Pool, stats: { seen: number; inserted: number; skipped: number }) {
    const result = await pool.query(`SELECT * FROM team_memory_candidates`)
    for (const row of result.rows as LegacyCandidate[]) {
        stats.seen++
        const approvalId = `mig_team_memory_${row.id}`
        const subjectKey = row.memory_ref ? `tm:ref:${row.memory_ref}` : `tm:legacy:${row.id}`
        const inserted = await upsertApprovalRow(pool, {
            id: approvalId,
            namespace: row.namespace,
            orgId: row.org_id,
            domain: 'team_memory',
            subjectKind: 'memory_proposal',
            subjectKey,
            status: mapStatus(row.status),
            decidedBy: row.decided_by,
            decidedAt: row.decided_at,
            decisionReason: row.decision_reason,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        })
        if (!inserted) { stats.skipped++; continue }
        await upsertPayload(pool, 'approval_payload_team_memory', approvalId, {
            proposed_by_person_id: row.proposed_by_person_id,
            proposed_by_email: row.proposed_by_email,
            scope: row.scope,
            content: row.content,
            source: row.source,
            session_id: row.session_id,
            memory_ref: row.memory_ref,
        })
        stats.inserted++
    }
}

async function migrateObservation(pool: Pool, stats: { seen: number; inserted: number; skipped: number }) {
    const result = await pool.query(`SELECT * FROM observation_candidates`)
    for (const row of result.rows as LegacyCandidate[]) {
        stats.seen++
        const approvalId = `mig_observation_${row.id}`
        const subject = row.subject_person_id || row.subject_email || 'unknown'
        const subjectKey = `obs:${subject}:${row.hypothesis_key}`
        const inserted = await upsertApprovalRow(pool, {
            id: approvalId,
            namespace: row.namespace,
            orgId: row.org_id,
            domain: 'observation',
            subjectKind: 'person_hypothesis',
            subjectKey,
            status: mapStatus(row.status),
            decidedBy: row.decided_by,
            decidedAt: row.decided_at,
            decisionReason: row.decision_reason,
            expiresAt: row.expires_at,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        })
        if (!inserted) { stats.skipped++; continue }
        await upsertPayload(pool, 'approval_payload_observation', approvalId, {
            subject_person_id: row.subject_person_id,
            subject_email: row.subject_email,
            hypothesis_key: row.hypothesis_key,
            summary: row.summary,
            detail: row.detail,
            detector_version: row.detector_version,
            confidence: row.confidence,
            signals: row.signals,
            suggested_patch: row.suggested_patch,
            promoted_communication_plan_id: row.promoted_communication_plan_id,
        })
        stats.inserted++
    }
}

async function migrateMemoryConflict(pool: Pool, stats: { seen: number; inserted: number; skipped: number }) {
    const result = await pool.query(`SELECT * FROM memory_conflict_candidates`)
    for (const row of result.rows as LegacyCandidate[]) {
        stats.seen++
        const approvalId = `mig_memory_conflict_${row.id}`
        const inserted = await upsertApprovalRow(pool, {
            id: approvalId,
            namespace: row.namespace,
            orgId: row.org_id,
            domain: 'memory_conflict',
            subjectKind: 'conflict_subject',
            subjectKey: row.subject_key,
            status: mapStatus(row.status),
            decidedBy: row.decided_by,
            decidedAt: row.decided_at,
            decisionReason: row.decision_reason,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        })
        if (!inserted) { stats.skipped++; continue }
        await upsertPayload(pool, 'approval_payload_memory_conflict', approvalId, {
            scope: row.scope,
            summary: row.summary,
            entries: row.entries,
            evidence: row.evidence,
            detector_version: row.detector_version,
            resolution: row.resolution,
        })
        stats.inserted++
    }
}

async function upsertApprovalRow(pool: Pool, data: {
    id: string
    namespace: string
    orgId: string | null
    domain: string
    subjectKind: string
    subjectKey: string
    status: string
    decidedBy?: string | null
    decidedAt?: number | null
    decisionReason?: string | null
    expiresAt?: number | null
    createdAt: number
    updatedAt: number
}): Promise<boolean> {
    if (!data.orgId) return false // new schema requires org_id NOT NULL
    if (!COMMIT) return true
    const result = await pool.query(
        `INSERT INTO approvals
         (id, namespace, org_id, domain, subject_kind, subject_key,
          status, decided_by, decided_at, decision_reason, expires_at,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
            data.id, data.namespace, data.orgId, data.domain, data.subjectKind, data.subjectKey,
            data.status, data.decidedBy ?? null, data.decidedAt ?? null, data.decisionReason ?? null,
            data.expiresAt ?? null, data.createdAt, data.updatedAt,
        ],
    )
    return (result.rowCount ?? 0) > 0
}

async function upsertPayload(pool: Pool, table: string, approvalId: string, payload: Record<string, unknown>) {
    if (!COMMIT) return
    const keys = Object.keys(payload)
    const cols = ['approval_id', ...keys]
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    const values = [approvalId, ...keys.map((k) => {
        const v = payload[k]
        if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v)
        return v
    })]
    await pool.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (approval_id) DO NOTHING`,
        values,
    )
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
