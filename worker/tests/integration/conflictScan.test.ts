/**
 * Phase 3C Conflict Scan integration test.
 *
 * Real PostgreSQL (yoho_remote) — same pattern as phase4-e2e.test.ts.
 * Each run uses a unique namespace so it does not collide with concurrent runs
 * or with production data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { scanForConflicts, CONFLICT_DETECTOR_VERSION } from '../../src/handlers/conflictScan'
import {
    MEMORY_CONFLICT_CANDIDATES_DDL,
    MEMORY_CONFLICT_AUDITS_DDL,
} from '../../../server/src/store/memory-conflict-ddl'

const DB_CONFIG = {
    host: '101.100.174.21',
    port: 5432,
    user: 'guang',
    password: 'Root,./000000',
    database: 'yoho_remote',
    ssl: false as const,
}

const TEST_NS = `test-conflict-scan-${randomUUID().slice(0, 8)}`
const TEST_PERSON = `person-${randomUUID().slice(0, 8)}`
let pool: Pool

async function insertObservation(input: {
    id?: string
    namespace?: string
    orgId?: string | null
    subjectPersonId: string
    hypothesisKey: string
    summary: string
    status?: string
    createdAt?: number
}): Promise<string> {
    const id = input.id ?? randomUUID()
    const now = input.createdAt ?? Date.now()
    await pool.query(
        `INSERT INTO observation_candidates (
            id, namespace, org_id, subject_person_id, subject_email,
            hypothesis_key, summary, detail, detector_version, confidence,
            signals, suggested_patch, status, created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, NULL, $5, $6, NULL, 'test-detector-v1', NULL,
            '[]'::jsonb, NULL, $7, $8, $8
        )`,
        [
            id,
            input.namespace ?? TEST_NS,
            input.orgId ?? null,
            input.subjectPersonId,
            input.hypothesisKey,
            input.summary,
            input.status ?? 'pending',
            now,
        ],
    )
    return id
}

async function insertTeamMemoryCandidate(input: {
    id?: string
    namespace?: string
    orgId?: string | null
    memoryRef: string
    content: string
    proposedByEmail?: string | null
    status?: string
    createdAt?: number
}): Promise<string> {
    const id = input.id ?? randomUUID()
    const now = input.createdAt ?? Date.now()
    await pool.query(
        `INSERT INTO team_memory_candidates (
            id, namespace, org_id, proposed_by_person_id, proposed_by_email,
            scope, content, source, session_id, status, memory_ref, created_at, updated_at
        ) VALUES (
            $1, $2, $3, NULL, $4, 'team', $5, NULL, NULL, $6, $7, $8, $8
        )`,
        [
            id,
            input.namespace ?? TEST_NS,
            input.orgId ?? null,
            input.proposedByEmail ?? null,
            input.content,
            input.status ?? 'pending',
            input.memoryRef,
            now,
        ],
    )
    return id
}

async function listConflicts(scope?: 'personal' | 'team'): Promise<
    Array<{ id: string; scope: string; subject_key: string; entries: unknown }>
> {
    if (scope) {
        const r = await pool.query(
            `SELECT id, scope, subject_key, entries
             FROM memory_conflict_candidates
             WHERE namespace = $1 AND scope = $2`,
            [TEST_NS, scope],
        )
        return r.rows
    }
    const r = await pool.query(
        `SELECT id, scope, subject_key, entries
         FROM memory_conflict_candidates
         WHERE namespace = $1`,
        [TEST_NS],
    )
    return r.rows
}

beforeAll(async () => {
    pool = new Pool(DB_CONFIG)
    await pool.query('SELECT 1')
    // Phase 3C tables (FK-free copies for test isolation).
    await pool.query(MEMORY_CONFLICT_CANDIDATES_DDL)
    await pool.query(MEMORY_CONFLICT_AUDITS_DDL)
    // Source tables the scan reads from. Test variants drop FK on org_id so the
    // worker test does not require the full server schema.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS observation_candidates (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL,
            org_id TEXT,
            subject_person_id TEXT,
            subject_email TEXT,
            hypothesis_key TEXT NOT NULL,
            summary TEXT NOT NULL,
            detail TEXT,
            detector_version TEXT NOT NULL,
            confidence DOUBLE PRECISION,
            signals JSONB NOT NULL DEFAULT '[]',
            suggested_patch JSONB,
            status TEXT NOT NULL DEFAULT 'pending',
            decided_by TEXT,
            decided_at BIGINT,
            decision_reason TEXT,
            promoted_communication_plan_id TEXT,
            expires_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        );
    `)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS team_memory_candidates (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL,
            org_id TEXT,
            proposed_by_person_id TEXT,
            proposed_by_email TEXT,
            scope TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT,
            session_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            decided_by TEXT,
            decided_at BIGINT,
            decision_reason TEXT,
            memory_ref TEXT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        );
    `)
})

afterAll(async () => {
    if (!pool) return
    await pool.query('DELETE FROM memory_conflict_audits WHERE namespace = $1', [TEST_NS])
    await pool.query('DELETE FROM memory_conflict_candidates WHERE namespace = $1', [TEST_NS])
    await pool.query('DELETE FROM observation_candidates WHERE namespace = $1', [TEST_NS])
    await pool.query('DELETE FROM team_memory_candidates WHERE namespace = $1', [TEST_NS])
    await pool.end()
})

describe('Phase 3C scanForConflicts', () => {
    it('detects observation candidates with same hypothesisKey for same person', async () => {
        await insertObservation({
            subjectPersonId: TEST_PERSON,
            hypothesisKey: 'pref:morning-meetings',
            summary: 'User prefers morning meetings',
        })
        await insertObservation({
            subjectPersonId: TEST_PERSON,
            hypothesisKey: 'pref:morning-meetings',
            summary: 'User prefers afternoon meetings',
        })

        const result = await scanForConflicts(pool)

        expect(result.scannedObservationGroups).toBeGreaterThanOrEqual(1)
        expect(result.createdConflictIds.length).toBeGreaterThanOrEqual(1)

        const personal = await listConflicts('personal')
        const conflict = personal.find(
            (c) => c.subject_key === `obs:${TEST_PERSON}:pref:morning-meetings`,
        )
        expect(conflict).toBeTruthy()
        expect(Array.isArray(conflict?.entries)).toBe(true)
        expect((conflict?.entries as unknown[]).length).toBe(2)
    })

    it('does not duplicate an existing open conflict on rescan', async () => {
        const before = await listConflicts('personal')
        const result = await scanForConflicts(pool)
        const after = await listConflicts('personal')

        expect(after.length).toBe(before.length)
        expect(result.skippedDuplicateGroups).toBeGreaterThanOrEqual(1)
    })

    it('detects team memory candidates sharing the same memory_ref', async () => {
        await insertTeamMemoryCandidate({
            memoryRef: 'team:onboarding-doc',
            content: 'Onboarding starts on Monday',
            proposedByEmail: 'alice@example.com',
        })
        await insertTeamMemoryCandidate({
            memoryRef: 'team:onboarding-doc',
            content: 'Onboarding starts on Wednesday',
            proposedByEmail: 'bob@example.com',
        })

        const result = await scanForConflicts(pool)

        expect(result.scannedTeamMemoryGroups).toBeGreaterThanOrEqual(1)

        const team = await listConflicts('team')
        const conflict = team.find((c) => c.subject_key === 'mem:team:onboarding-doc')
        expect(conflict).toBeTruthy()
        expect((conflict?.entries as unknown[]).length).toBe(2)
    })

    it('writes a generated audit row for each new conflict', async () => {
        const r = await pool.query(
            `SELECT mca.action, mca.new_status, mca.payload
             FROM memory_conflict_audits mca
             JOIN memory_conflict_candidates mcc ON mcc.id = mca.candidate_id
             WHERE mcc.namespace = $1`,
            [TEST_NS],
        )
        expect(r.rows.length).toBeGreaterThanOrEqual(1)
        for (const row of r.rows) {
            expect(row.action).toBe('generated')
            expect(row.new_status).toBe('open')
            const payload = row.payload as { detectorVersion?: string }
            expect(payload?.detectorVersion).toBe(CONFLICT_DETECTOR_VERSION)
        }
    })

    it('ignores observation rows whose status is not pending', async () => {
        const ns = `${TEST_NS}-decided`
        const person = `person-${randomUUID().slice(0, 8)}`
        try {
            await insertObservation({
                namespace: ns,
                subjectPersonId: person,
                hypothesisKey: 'pref:tabs-vs-spaces',
                summary: 'tabs',
                status: 'accepted',
            })
            await insertObservation({
                namespace: ns,
                subjectPersonId: person,
                hypothesisKey: 'pref:tabs-vs-spaces',
                summary: 'spaces',
                status: 'rejected',
            })
            await scanForConflicts(pool)
            const r = await pool.query(
                `SELECT id FROM memory_conflict_candidates WHERE namespace = $1`,
                [ns],
            )
            expect(r.rowCount).toBe(0)
        } finally {
            await pool.query('DELETE FROM observation_candidates WHERE namespace = $1', [ns])
        }
    })
})
