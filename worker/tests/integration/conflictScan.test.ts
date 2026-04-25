/**
 * Phase 3C Conflict Scan integration test — rewritten for the unified
 * Approvals Engine schema (approvals + approval_payload_*).
 *
 * Real PostgreSQL (yoho_remote) — same pattern as phase4-e2e.test.ts.
 * Each run uses a unique namespace so it does not collide with concurrent runs
 * or with production data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { scanForConflicts } from '../../src/handlers/conflictScan'

const DB_CONFIG = {
    host: '101.100.174.21',
    port: 5432,
    user: 'guang',
    password: 'Root,./000000',
    database: 'yoho_remote',
    ssl: false as const,
}

const TEST_NS = `test-conflict-scan-${randomUUID().slice(0, 8)}`
const TEST_ORG = `test-org-${randomUUID().slice(0, 8)}`
const TEST_PERSON = `person-${randomUUID().slice(0, 8)}`
let pool: Pool

async function insertApprovalRow(input: {
    id: string
    domain: string
    subjectKind: string
    subjectKey: string
    orgId?: string | null
    status?: string
    createdAt?: number
}): Promise<void> {
    const now = input.createdAt ?? Date.now()
    await pool.query(
        `INSERT INTO approvals (
            id, namespace, org_id, domain, subject_kind, subject_key,
            status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
            input.id,
            TEST_NS,
            input.orgId ?? TEST_ORG,
            input.domain,
            input.subjectKind,
            input.subjectKey,
            input.status ?? 'pending',
            now,
        ],
    )
}

async function insertObservation(input: {
    id?: string
    subjectPersonId: string
    hypothesisKey: string
    summary: string
    status?: string
    createdAt?: number
}): Promise<string> {
    const id = input.id ?? randomUUID()
    await insertApprovalRow({
        id,
        domain: 'observation',
        subjectKind: 'person_hypothesis',
        subjectKey: `obs:${input.subjectPersonId}:${input.hypothesisKey}`,
        status: input.status ?? 'pending',
        createdAt: input.createdAt,
    })
    await pool.query(
        `INSERT INTO approval_payload_observation (
            approval_id, subject_person_id, subject_email, hypothesis_key,
            summary, detail, detector_version, confidence, signals,
            suggested_patch, promoted_communication_plan_id
        ) VALUES ($1, $2, NULL, $3, $4, NULL, 'test-detector-v1', NULL,
                  '[]'::jsonb, NULL, NULL)`,
        [id, input.subjectPersonId, input.hypothesisKey, input.summary],
    )
    return id
}

async function insertTeamMemoryCandidate(input: {
    id?: string
    memoryRef: string
    content: string
    proposedByEmail?: string | null
    status?: string
    createdAt?: number
}): Promise<string> {
    const id = input.id ?? randomUUID()
    await insertApprovalRow({
        id,
        domain: 'team_memory',
        subjectKind: 'memory_proposal',
        subjectKey: `tm:ref:${input.memoryRef}:${id}`,
        status: input.status ?? 'pending',
        createdAt: input.createdAt,
    })
    await pool.query(
        `INSERT INTO approval_payload_team_memory (
            approval_id, proposed_by_person_id, proposed_by_email,
            scope, content, source, session_id, memory_ref
        ) VALUES ($1, NULL, $2, 'team', $3, NULL, NULL, $4)`,
        [id, input.proposedByEmail ?? null, input.content, input.memoryRef],
    )
    return id
}

async function listConflicts(scope?: 'personal' | 'team'): Promise<
    Array<{ id: string; scope: string; subject_key: string; entries: unknown }>
> {
    const scopeClause = scope ? 'AND p.scope = $2' : ''
    const params: unknown[] = [TEST_NS]
    if (scope) params.push(scope)
    const r = await pool.query(
        `SELECT a.id, p.scope, a.subject_key, p.entries
         FROM approvals a
         JOIN approval_payload_memory_conflict p ON p.approval_id = a.id
         WHERE a.namespace = $1 AND a.domain = 'memory_conflict' ${scopeClause}`,
        params,
    )
    return r.rows
}

beforeAll(async () => {
    pool = new Pool(DB_CONFIG)
    await pool.query('SELECT 1')
    // approvals DDL is expected to exist in yoho_remote (shared with server
    // initSchema). Test data is scoped by namespace so it won't touch real
    // rows.
})

afterAll(async () => {
    if (!pool) return
    // Cleanup order: audits → payloads → master.
    await pool.query('DELETE FROM approval_audits WHERE namespace = $1', [TEST_NS])
    await pool.query(
        `DELETE FROM approval_payload_memory_conflict
         WHERE approval_id IN (SELECT id FROM approvals WHERE namespace = $1)`,
        [TEST_NS],
    )
    await pool.query(
        `DELETE FROM approval_payload_observation
         WHERE approval_id IN (SELECT id FROM approvals WHERE namespace = $1)`,
        [TEST_NS],
    )
    await pool.query(
        `DELETE FROM approval_payload_team_memory
         WHERE approval_id IN (SELECT id FROM approvals WHERE namespace = $1)`,
        [TEST_NS],
    )
    await pool.query('DELETE FROM approvals WHERE namespace = $1', [TEST_NS])
    await pool.end()
})

describe('Phase 3C scanForConflicts (unified approvals schema)', () => {
    it('detects observation approvals with same hypothesisKey for same person', async () => {
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

    it('does not duplicate an existing pending conflict on rescan', async () => {
        const before = await listConflicts('personal')
        const result = await scanForConflicts(pool)
        const after = await listConflicts('personal')

        expect(after.length).toBe(before.length)
        expect(result.skippedDuplicateGroups).toBeGreaterThanOrEqual(1)
    })

    it('detects team memory approvals sharing the same memory_ref', async () => {
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
        expect(Array.isArray(conflict?.entries)).toBe(true)
        expect((conflict?.entries as unknown[]).length).toBeGreaterThanOrEqual(2)
    })
})
