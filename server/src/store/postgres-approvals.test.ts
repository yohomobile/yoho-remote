import { describe, expect, it } from 'bun:test'
import { PostgresStore } from './postgres'
import { ApprovalNotFoundError } from '../approvals/types'

type MockQueryResult = {
    rows: Array<Record<string, unknown>>
    rowCount?: number
}

type MockQueryCall = {
    sql: string
    params: unknown[] | undefined
}

function createStore(
    queryImpl: (sql: string, params?: unknown[]) => Promise<MockQueryResult>,
): PostgresStore {
    const store = Object.create(PostgresStore.prototype) as PostgresStore
    ;(store as any).pool = {
        query: queryImpl,
        connect: async () => ({
            query: queryImpl,
            release() {},
        }),
    }
    return store
}

function approvalRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 'approval-1',
        namespace: 'ns-a',
        org_id: 'org-1',
        domain: 'identity',
        subject_kind: 'identity_pair',
        subject_key: 'id:person-1:link-2',
        status: 'pending',
        decided_by: null,
        decided_at: null,
        decision_reason: null,
        expires_at: null,
        created_at: '1700000000000',
        updated_at: '1700000000000',
        ...overrides,
    }
}

function auditRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        id: 'audit-1',
        approval_id: 'approval-1',
        namespace: 'ns-a',
        org_id: 'org-1',
        domain: 'identity',
        action: 'approve',
        prior_status: 'pending',
        new_status: 'approved',
        actor_email: 'admin@example.com',
        actor_role: 'admin',
        reason: 'looks right',
        payload_snapshot: { foo: 'bar' },
        created_at: '1700000000500',
        ...overrides,
    }
}

describe('PostgresStore approvals — list / get', () => {
    it('listApprovals filters by namespace + org + status + domain', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            return { rows: [approvalRow(), approvalRow({ id: 'approval-2' })] }
        })

        const out = await store.listApprovals({
            namespace: 'ns-a',
            orgId: 'org-1',
            domain: 'identity',
            status: 'pending',
            limit: 25,
        })
        expect(out).toHaveLength(2)
        expect(out[0]?.id).toBe('approval-1')
        expect(calls[0]?.sql).toContain('SELECT * FROM approvals')
        expect(calls[0]?.sql).toContain('ORDER BY created_at DESC')
        expect(calls[0]?.params).toEqual(['ns-a', 'org-1', 'identity', 'pending', 25])
    })

    it('getApproval returns null when missing', async () => {
        const store = createStore(async () => ({ rows: [] }))
        const out = await store.getApproval('ns-a', 'org-1', 'approval-x')
        expect(out).toBeNull()
    })

    it('getApprovalBySubject returns parsed record', async () => {
        const store = createStore(async () => ({ rows: [approvalRow({ status: 'approved' })] }))
        const out = await store.getApprovalBySubject('ns-a', 'org-1', 'identity', 'id:person-1:link-2')
        expect(out?.status).toBe('approved')
    })
})

describe('PostgresStore approvals — upsertApproval', () => {
    it('inserts fresh master row + payload row inside a txn', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [] }
            }
            if (sql.startsWith('INSERT INTO approvals')) {
                return { rows: [approvalRow()] }
            }
            if (sql.startsWith('INSERT INTO approval_payload_identity')) {
                return {
                    rows: [{ approval_id: 'approval-1', identity_id: 'idy-1', score: 0.95, matcher_version: 'v1' }],
                }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const out = await store.upsertApproval({
            namespace: 'ns-a',
            orgId: 'org-1',
            domain: 'identity',
            subjectKind: 'identity_pair',
            subjectKey: 'id:person-1:link-2',
            payloadTable: 'approval_payload_identity',
            payload: { identity_id: 'idy-1', score: 0.95, matcher_version: 'v1' },
        })
        expect(out.record.id).toBe('approval-1')
        expect(out.payload).toEqual({ identity_id: 'idy-1', score: 0.95, matcher_version: 'v1' })
        expect(calls.map((c) => c.sql)).toContain('BEGIN')
        expect(calls.map((c) => c.sql)).toContain('COMMIT')
    })

    it('updates expires_at when existing approval is still pending', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [approvalRow({ status: 'pending' })] }
            }
            if (sql.startsWith('UPDATE approvals SET updated_at')) {
                return { rows: [approvalRow({ expires_at: '1700000001000' })] }
            }
            if (sql.startsWith('INSERT INTO approval_payload_identity')) {
                return { rows: [{ approval_id: 'approval-1', identity_id: 'idy-1', score: 0.9, matcher_version: 'v2' }] }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const out = await store.upsertApproval({
            namespace: 'ns-a',
            orgId: 'org-1',
            domain: 'identity',
            subjectKind: 'identity_pair',
            subjectKey: 'id:person-1:link-2',
            expiresAt: 1_700_000_001_000,
            payloadTable: 'approval_payload_identity',
            payload: { identity_id: 'idy-1', score: 0.9, matcher_version: 'v2' },
        })
        expect(out.record.expiresAt).toBe(1_700_000_001_000)
        expect(calls.some((c) => c.sql.startsWith('INSERT INTO approvals'))).toBe(false)
        expect(calls.some((c) => c.sql.startsWith('UPDATE approvals SET updated_at'))).toBe(true)
    })

    it('refuses to overwrite a decided approval and rolls back', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [approvalRow({ status: 'approved' })] }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(
            store.upsertApproval({
                namespace: 'ns-a',
                orgId: 'org-1',
                domain: 'identity',
                subjectKind: 'identity_pair',
                subjectKey: 'id:person-1:link-2',
                payloadTable: 'approval_payload_identity',
                payload: { identity_id: 'idy-1', score: 0.9, matcher_version: 'v2' },
            }),
        ).rejects.toThrow(/Cannot overwrite decided approval/)
        expect(calls.map((c) => c.sql)).toContain('ROLLBACK')
        expect(calls.map((c) => c.sql)).not.toContain('COMMIT')
    })

    it('rejects malicious identifier on payloadTable', async () => {
        const store = createStore(async () => ({ rows: [] }))
        await expect(
            store.upsertApproval({
                namespace: 'ns-a',
                orgId: 'org-1',
                domain: 'identity',
                subjectKind: 'identity_pair',
                subjectKey: 'id:person-1:link-2',
                payloadTable: 'approval_payload_identity; DROP TABLE users',
                payload: { identity_id: 'idy-1' },
            }),
        ).rejects.toThrow(/Invalid approvals identifier/)
    })

    it('rejects malicious identifier in payload key', async () => {
        const store = createStore(async () => ({ rows: [] }))
        await expect(
            store.upsertApproval({
                namespace: 'ns-a',
                orgId: 'org-1',
                domain: 'identity',
                subjectKind: 'identity_pair',
                subjectKey: 'id:person-1:link-2',
                payloadTable: 'approval_payload_identity',
                payload: { 'evil; DROP TABLE': 'x' },
            }),
        ).rejects.toThrow(/Invalid approvals identifier/)
    })
})

describe('PostgresStore approvals — decideApproval', () => {
    it('locks row, applies outcome, writes audit in one txn', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [approvalRow({ status: 'pending' })] }
            }
            if (sql.startsWith('SELECT * FROM approval_payload_identity')) {
                return { rows: [{ approval_id: 'approval-1', identity_id: 'idy-1', score: 0.9 }] }
            }
            if (sql.startsWith('UPDATE approvals')) {
                return { rows: [approvalRow({ status: 'approved', decided_by: 'admin@example.com', decided_at: '1700000000500', decision_reason: 'ok' })] }
            }
            if (sql.startsWith('INSERT INTO approval_audits')) {
                return { rows: [auditRow()] }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const out = await store.decideApproval({
            namespace: 'ns-a',
            approvalId: 'approval-1',
            payloadTable: 'approval_payload_identity',
            decide: async (ctx) => {
                expect(ctx.record.id).toBe('approval-1')
                expect(ctx.payload).toEqual({ identity_id: 'idy-1', score: 0.9 })
                return {
                    newStatus: 'approved',
                    decidedBy: 'admin@example.com',
                    decisionReason: 'looks right',
                    payloadPatch: null,
                    audit: {
                        action: 'approve',
                        actorEmail: 'admin@example.com',
                        actorRole: 'admin',
                        reason: 'looks right',
                    },
                }
            },
        })
        expect(out.record.status).toBe('approved')
        expect(out.audit.action).toBe('approve')
        expect(calls.map((c) => c.sql)).toContain('BEGIN')
        expect(calls.map((c) => c.sql)).toContain('COMMIT')
    })

    it('applies payloadPatch and surfaces the patched payload in the returned row', async () => {
        const store = createStore(async (sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [approvalRow()] }
            }
            if (sql.startsWith('SELECT * FROM approval_payload_observation')) {
                return { rows: [{ approval_id: 'approval-1', hypothesis_key: 'h', summary: 's', detector_version: 'v1' }] }
            }
            if (sql.startsWith('UPDATE approvals')) {
                return { rows: [approvalRow({ status: 'approved' })] }
            }
            if (sql.startsWith('UPDATE approval_payload_observation')) {
                return { rows: [{ approval_id: 'approval-1', hypothesis_key: 'h', summary: 's', detector_version: 'v1', promoted_communication_plan_id: 'plan-42' }] }
            }
            if (sql.startsWith('INSERT INTO approval_audits')) {
                return { rows: [auditRow()] }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        const out = await store.decideApproval<{ promoted_communication_plan_id?: string | null } & Record<string, unknown>>({
            namespace: 'ns-a',
            approvalId: 'approval-1',
            payloadTable: 'approval_payload_observation',
            decide: async () => ({
                newStatus: 'approved',
                decidedBy: 'admin@example.com',
                decisionReason: null,
                payloadPatch: { promoted_communication_plan_id: 'plan-42' },
                audit: {
                    action: 'confirm',
                    actorEmail: 'admin@example.com',
                    actorRole: 'admin',
                    reason: null,
                },
            }),
        })
        expect((out.payload as any).promoted_communication_plan_id).toBe('plan-42')
    })

    it('throws ApprovalNotFoundError when row missing and rolls back', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [] }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(
            store.decideApproval({
                namespace: 'ns-a',
                approvalId: 'approval-x',
                payloadTable: 'approval_payload_identity',
                decide: async () => {
                    throw new Error('should not be called')
                },
            }),
        ).rejects.toBeInstanceOf(ApprovalNotFoundError)
        expect(calls.map((c) => c.sql)).toContain('ROLLBACK')
    })

    it('decide callback throws → ROLLBACK, no COMMIT, no audit insert', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] }
            if (sql.includes('SELECT * FROM approvals') && sql.includes('FOR UPDATE')) {
                return { rows: [approvalRow()] }
            }
            if (sql.startsWith('SELECT * FROM approval_payload_identity')) {
                return { rows: [{ approval_id: 'approval-1' }] }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(
            store.decideApproval({
                namespace: 'ns-a',
                approvalId: 'approval-1',
                payloadTable: 'approval_payload_identity',
                decide: async () => {
                    throw new Error('permission denied')
                },
            }),
        ).rejects.toThrow('permission denied')
        expect(calls.map((c) => c.sql)).toContain('ROLLBACK')
        expect(calls.map((c) => c.sql)).not.toContain('COMMIT')
        expect(calls.some((c) => c.sql.startsWith('INSERT INTO approval_audits'))).toBe(false)
    })
})

describe('PostgresStore approvals — listApprovalAudits', () => {
    it('filters by approvalId and maps rows', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            return { rows: [auditRow(), auditRow({ id: 'audit-2' })] }
        })

        const out = await store.listApprovalAudits({
            namespace: 'ns-a',
            orgId: 'org-1',
            approvalId: 'approval-1',
            limit: 10,
        })
        expect(out).toHaveLength(2)
        expect(out[0]?.id).toBe('audit-1')
        expect(calls[0]?.params).toEqual(['ns-a', 'org-1', 'approval-1', 10])
    })
})
