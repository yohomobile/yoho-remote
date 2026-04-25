import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { WorkerContext } from '../types'

// Phase 3C Conflict Scan — rewritten in PR 9 to read/write the unified
// approvals schema. Scans pending observation hypotheses and pending team
// memory proposals, groups them by conflict subject, and upserts a
// memory_conflict approval row when ≥2 pending candidates share the same
// subject. Hard boundary: only generates candidates, never auto-resolves.
//
// Subject key conventions (carried over from the legacy schema so existing
// conflict rows continue to dedupe correctly after migration):
//   personal: `obs:<personId>:<hypothesisKey>`
//   team:     `mem:<memoryRef>`

export const CONFLICT_DETECTOR_VERSION = 'conflict-scan-v1'

export type ConflictScanResult = {
    scannedObservationGroups: number
    scannedTeamMemoryGroups: number
    createdConflictIds: string[]
    skippedDuplicateGroups: number
}

type ObservationGroupRow = {
    namespace: string
    org_id: string
    subject_person_id: string
    hypothesis_key: string
    candidate_ids: string[]
    summaries: string[]
    captured_ats: string[] // BIGINT comes back as string from pg
}

type TeamMemoryGroupRow = {
    namespace: string
    org_id: string
    memory_ref: string
    candidate_ids: string[]
    contents: string[]
    captured_ats: string[]
    actors: Array<string | null>
}

// Join master `approvals` with domain payload tables so the grouping key
// (subject_person_id / hypothesis_key / memory_ref) stays typed.
const OBSERVATION_GROUPS_SQL = `
    SELECT
        a.namespace,
        a.org_id,
        p.subject_person_id,
        p.hypothesis_key,
        ARRAY_AGG(a.id ORDER BY a.created_at) AS candidate_ids,
        ARRAY_AGG(p.summary ORDER BY a.created_at) AS summaries,
        ARRAY_AGG(a.created_at::TEXT ORDER BY a.created_at) AS captured_ats
    FROM approvals a
    JOIN approval_payload_observation p ON p.approval_id = a.id
    WHERE a.domain = 'observation'
      AND a.status = 'pending'
      AND p.subject_person_id IS NOT NULL
    GROUP BY a.namespace, a.org_id, p.subject_person_id, p.hypothesis_key
    HAVING COUNT(*) >= 2
`

const TEAM_MEMORY_GROUPS_SQL = `
    SELECT
        a.namespace,
        a.org_id,
        p.memory_ref,
        ARRAY_AGG(a.id ORDER BY a.created_at) AS candidate_ids,
        ARRAY_AGG(p.content ORDER BY a.created_at) AS contents,
        ARRAY_AGG(a.created_at::TEXT ORDER BY a.created_at) AS captured_ats,
        ARRAY_AGG(p.proposed_by_email ORDER BY a.created_at) AS actors
    FROM approvals a
    JOIN approval_payload_team_memory p ON p.approval_id = a.id
    WHERE a.domain = 'team_memory'
      AND a.status = 'pending'
      AND p.memory_ref IS NOT NULL
    GROUP BY a.namespace, a.org_id, p.memory_ref
    HAVING COUNT(*) >= 2
`

async function findOpenConflictId(
    client: PoolClient,
    args: { namespace: string; orgId: string; subjectKey: string },
): Promise<string | null> {
    const result = await client.query<{ id: string }>(
        `SELECT id FROM approvals
         WHERE namespace = $1
           AND org_id = $2
           AND domain = 'memory_conflict'
           AND subject_key = $3
           AND status = 'pending'
         LIMIT 1`,
        [args.namespace, args.orgId, args.subjectKey],
    )
    return result.rows[0]?.id ?? null
}

async function insertConflict(
    client: PoolClient,
    args: {
        namespace: string
        orgId: string
        scope: 'personal' | 'team'
        subjectKey: string
        summary: string
        entries: Array<Record<string, unknown>>
        evidence: Record<string, unknown>
    },
): Promise<string> {
    const id = randomUUID()
    const now = Date.now()
    // Master row — pending conflict for admin resolution.
    await client.query(
        `INSERT INTO approvals (
            id, namespace, org_id, domain, subject_kind, subject_key,
            status, created_at, updated_at
        ) VALUES ($1, $2, $3, 'memory_conflict', 'conflict_subject', $4, 'pending', $5, $5)`,
        [id, args.namespace, args.orgId, args.subjectKey, now],
    )
    // Domain payload.
    await client.query(
        `INSERT INTO approval_payload_memory_conflict (
            approval_id, scope, summary, entries, evidence, detector_version, resolution
        ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NULL)`,
        [
            id,
            args.scope,
            args.summary,
            JSON.stringify(args.entries),
            JSON.stringify(args.evidence),
            CONFLICT_DETECTOR_VERSION,
        ],
    )
    // Audit: detector auto-generation event. `actor_role='system'` signals a
    // non-human origin so downstream review UI can filter these out.
    await client.query(
        `INSERT INTO approval_audits (
            id, approval_id, namespace, org_id, domain, action,
            prior_status, new_status, actor_email, actor_role, reason,
            payload_snapshot, created_at
        ) VALUES ($1, $2, $3, $4, 'memory_conflict', 'generated',
                  NULL, 'pending', NULL, 'system', $5, $6::jsonb, $7)`,
        [
            randomUUID(),
            id,
            args.namespace,
            args.orgId,
            'auto-generated by conflict-scan',
            JSON.stringify({
                detectorVersion: CONFLICT_DETECTOR_VERSION,
                scope: args.scope,
                summary: args.summary,
                entries: args.entries,
                evidence: args.evidence,
            }),
            now,
        ],
    )
    return id
}

function summarizeObservationGroup(row: ObservationGroupRow): string {
    return `Conflicting observation pool for ${row.subject_person_id}/${row.hypothesis_key}: ${row.candidate_ids.length} pending candidates`
}

function summarizeTeamMemoryGroup(row: TeamMemoryGroupRow): string {
    return `Conflicting team memory references for ${row.memory_ref}: ${row.candidate_ids.length} pending candidates`
}

function obsEntries(row: ObservationGroupRow): Array<Record<string, unknown>> {
    return row.candidate_ids.map((id, idx) => ({
        source: 'observation_candidate',
        memoryId: id,
        content: row.summaries[idx] ?? '',
        capturedAt: Number(row.captured_ats[idx] ?? 0),
        actor: null,
    }))
}

function teamEntries(row: TeamMemoryGroupRow): Array<Record<string, unknown>> {
    return row.candidate_ids.map((id, idx) => ({
        source: 'team_memory_candidate',
        memoryId: id,
        content: row.contents[idx] ?? '',
        capturedAt: Number(row.captured_ats[idx] ?? 0),
        actor: row.actors[idx] ?? null,
    }))
}

export async function scanForConflicts(pool: Pool): Promise<ConflictScanResult> {
    const result: ConflictScanResult = {
        scannedObservationGroups: 0,
        scannedTeamMemoryGroups: 0,
        createdConflictIds: [],
        skippedDuplicateGroups: 0,
    }

    const client = await pool.connect()
    try {
        const obsGroups = await client.query<ObservationGroupRow>(OBSERVATION_GROUPS_SQL)
        result.scannedObservationGroups = obsGroups.rows.length
        for (const row of obsGroups.rows) {
            const subjectKey = `obs:${row.subject_person_id}:${row.hypothesis_key}`
            const existing = await findOpenConflictId(client, {
                namespace: row.namespace,
                orgId: row.org_id,
                subjectKey,
            })
            if (existing) {
                result.skippedDuplicateGroups += 1
                continue
            }
            const id = await insertConflict(client, {
                namespace: row.namespace,
                orgId: row.org_id,
                scope: 'personal',
                subjectKey,
                summary: summarizeObservationGroup(row),
                entries: obsEntries(row),
                evidence: { kind: 'observation', candidateIds: row.candidate_ids },
            })
            result.createdConflictIds.push(id)
        }

        const teamGroups = await client.query<TeamMemoryGroupRow>(TEAM_MEMORY_GROUPS_SQL)
        result.scannedTeamMemoryGroups = teamGroups.rows.length
        for (const row of teamGroups.rows) {
            const subjectKey = `mem:${row.memory_ref}`
            const existing = await findOpenConflictId(client, {
                namespace: row.namespace,
                orgId: row.org_id,
                subjectKey,
            })
            if (existing) {
                result.skippedDuplicateGroups += 1
                continue
            }
            const id = await insertConflict(client, {
                namespace: row.namespace,
                orgId: row.org_id,
                scope: 'team',
                subjectKey,
                summary: summarizeTeamMemoryGroup(row),
                entries: teamEntries(row),
                evidence: { kind: 'team_memory', candidateIds: row.candidate_ids },
            })
            result.createdConflictIds.push(id)
        }
    } finally {
        client.release()
    }

    return result
}

export async function handleConflictScan(_data: unknown, ctx: WorkerContext): Promise<void> {
    try {
        const result = await scanForConflicts(ctx.pool)
        if (result.createdConflictIds.length > 0 || result.skippedDuplicateGroups > 0) {
            console.log(
                `[conflictScan] obsGroups=${result.scannedObservationGroups}` +
                ` teamGroups=${result.scannedTeamMemoryGroups}` +
                ` created=${result.createdConflictIds.length}` +
                ` skippedDup=${result.skippedDuplicateGroups}`,
            )
        }
    } catch (err) {
        console.error('[conflictScan] scan failed:', err)
    }
}
