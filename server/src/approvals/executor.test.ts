import { describe, expect, it } from 'bun:test'
import type { IStore } from '../store'
import type {
    ApprovalDomain,
    ApprovalRecord,
    ApprovalAudit,
    ApprovalMasterStatus,
    ApprovalTxnContext,
    ApprovalDecisionOutcome,
} from './types'
import {
    ApprovalForbiddenError,
    ApprovalInvalidTransitionError,
} from './types'
import { executeDecide } from './executor'

interface TestPayload extends Record<string, unknown> {
    subject_email: string
    hint?: string | null
    promoted_plan_id?: string | null
}

type TestAction =
    | { action: 'approve' }
    | { action: 'reject' }

function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
    return {
        id: 'approval-1',
        namespace: 'ns-a',
        orgId: 'org-1',
        domain: 'test_domain',
        subjectKind: 'email',
        subjectKey: 'guang@example.com',
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        expiresAt: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...overrides,
    }
}

function makeAudit(overrides: Partial<ApprovalAudit> = {}): ApprovalAudit {
    return {
        id: 'audit-1',
        approvalId: 'approval-1',
        namespace: 'ns-a',
        orgId: 'org-1',
        domain: 'test_domain',
        action: 'approve',
        priorStatus: 'pending',
        newStatus: 'approved',
        actorEmail: 'admin@example.com',
        actorRole: 'admin',
        reason: null,
        payloadSnapshot: { subject_email: 'guang@example.com' },
        createdAt: 1_700_000_000_500,
        ...overrides,
    }
}

interface StubStoreOptions {
    record: ApprovalRecord
    payload: TestPayload
    updatedRecordStatus?: ApprovalMasterStatus
}

function makeStubStore(opts: StubStoreOptions): IStore {
    return {
        async decideApproval<T extends Record<string, unknown>>(args: {
            namespace: string
            approvalId: string
            payloadTable: string
            decide: (ctx: ApprovalTxnContext<T>) => Promise<ApprovalDecisionOutcome<T>>
        }): Promise<{ record: ApprovalRecord; payload: T; audit: ApprovalAudit }> {
            const outcome = await args.decide({
                record: opts.record,
                payload: opts.payload as unknown as T,
                now: 1_700_000_000_500,
                query: async () => ({ rows: [], rowCount: 0 }),
            })
            const finalPayload = {
                ...(opts.payload as unknown as T),
                ...(outcome.payloadPatch ?? {}),
            }
            return {
                record: { ...opts.record, status: outcome.newStatus, decidedBy: outcome.decidedBy, decidedAt: 1_700_000_000_500, decisionReason: outcome.decisionReason },
                payload: finalPayload,
                audit: makeAudit({
                    action: outcome.audit.action,
                    actorEmail: outcome.audit.actorEmail,
                    actorRole: outcome.audit.actorRole,
                    reason: outcome.audit.reason,
                    priorStatus: opts.record.status,
                    newStatus: outcome.newStatus,
                    payloadSnapshot: finalPayload,
                }),
            }
        },
    } as unknown as IStore
}

const testActionSchema = {
    safeParse(input: unknown):
        | { success: true; data: TestAction }
        | { success: false; error: { issues: readonly unknown[] } } {
        if (!input || typeof input !== 'object') {
            return { success: false, error: { issues: ['not an object'] } }
        }
        const action = (input as { action?: unknown }).action
        if (action === 'approve' || action === 'reject') {
            return { success: true, data: { action } as TestAction }
        }
        return { success: false, error: { issues: ['invalid action'] } }
    },
}

const testDomain: ApprovalDomain<TestPayload, TestAction> = {
    name: 'test_domain',
    subjectKind: 'email',
    payloadTable: 'approval_payload_test',
    actionSchema: testActionSchema,
    subjectKey: (payload) => payload.subject_email,
    nextStatus: (current, action) => {
        if (current !== 'pending') return null
        if (action.action === 'approve') return 'approved'
        if (action.action === 'reject') return 'rejected'
        return null
    },
    permission: ({ actorEmail, isOperator, orgRole, record }) => {
        if (isOperator) return 'operator'
        if (orgRole === 'admin' || orgRole === 'owner') return 'admin'
        if (actorEmail && record.subjectKey === actorEmail) return 'subject'
        return null
    },
}

describe('executeDecide', () => {
    it('approves a pending approval when actor is org admin', async () => {
        const store = makeStubStore({
            record: makeRecord(),
            payload: { subject_email: 'guang@example.com' },
        })
        const out = await executeDecide({
            store,
            domain: testDomain,
            namespace: 'ns-a',
            approvalId: 'approval-1',
            actorEmail: 'admin@example.com',
            isOperator: false,
            orgRoleOf: async () => 'admin',
            action: { action: 'approve' },
            reason: 'looks right',
        })
        expect(out.record.status).toBe('approved')
        expect(out.audit.actorRole).toBe('admin')
        expect(out.effectsMeta).toBeNull()
        expect(out.effectsError).toBeNull()
    })

    it('allows the subject of the approval to decide', async () => {
        const store = makeStubStore({
            record: makeRecord(),
            payload: { subject_email: 'guang@example.com' },
        })
        const out = await executeDecide({
            store,
            domain: testDomain,
            namespace: 'ns-a',
            approvalId: 'approval-1',
            actorEmail: 'guang@example.com',
            isOperator: false,
            orgRoleOf: async () => null,
            action: { action: 'approve' },
        })
        expect(out.audit.actorRole).toBe('subject')
    })

    it('throws ApprovalForbiddenError when permission returns null', async () => {
        const store = makeStubStore({
            record: makeRecord(),
            payload: { subject_email: 'guang@example.com' },
        })
        await expect(
            executeDecide({
                store,
                domain: testDomain,
                namespace: 'ns-a',
                approvalId: 'approval-1',
                actorEmail: 'stranger@example.com',
                isOperator: false,
                orgRoleOf: async () => 'member',
                action: { action: 'approve' },
            }),
        ).rejects.toBeInstanceOf(ApprovalForbiddenError)
    })

    it('throws ApprovalInvalidTransitionError on illegal state transition', async () => {
        const store = makeStubStore({
            record: makeRecord({ status: 'approved' }),
            payload: { subject_email: 'guang@example.com' },
        })
        await expect(
            executeDecide({
                store,
                domain: testDomain,
                namespace: 'ns-a',
                approvalId: 'approval-1',
                actorEmail: 'admin@example.com',
                isOperator: false,
                orgRoleOf: async () => 'admin',
                action: { action: 'approve' },
            }),
        ).rejects.toBeInstanceOf(ApprovalInvalidTransitionError)
    })

    it('invokes effects and surfaces payloadPatch + effectsMeta', async () => {
        const store = makeStubStore({
            record: makeRecord(),
            payload: { subject_email: 'guang@example.com' },
        })
        const domainWithEffects: ApprovalDomain<TestPayload, TestAction> = {
            ...testDomain,
            effects: async ({ action }) => {
                if (action.action !== 'approve') return {}
                return {
                    payloadPatch: { promoted_plan_id: 'plan-42' },
                    effectsMeta: { autoPromoted: true },
                }
            },
        }
        const out = await executeDecide({
            store,
            domain: domainWithEffects,
            namespace: 'ns-a',
            approvalId: 'approval-1',
            actorEmail: 'admin@example.com',
            isOperator: false,
            orgRoleOf: async () => 'admin',
            action: { action: 'approve' },
        })
        expect(out.payload.promoted_plan_id).toBe('plan-42')
        expect(out.effectsMeta).toEqual({ autoPromoted: true })
        expect(out.effectsError).toBeNull()
        expect(out.audit.payloadSnapshot).toMatchObject({ promoted_plan_id: 'plan-42' })
    })

    it('captures effects exception as effectsError but still commits the decision', async () => {
        const store = makeStubStore({
            record: makeRecord(),
            payload: { subject_email: 'guang@example.com' },
        })
        const domainWithFailingEffects: ApprovalDomain<TestPayload, TestAction> = {
            ...testDomain,
            effects: async () => {
                throw new Error('side-effect blew up')
            },
        }
        const out = await executeDecide({
            store,
            domain: domainWithFailingEffects,
            namespace: 'ns-a',
            approvalId: 'approval-1',
            actorEmail: 'admin@example.com',
            isOperator: false,
            orgRoleOf: async () => 'admin',
            action: { action: 'approve' },
        })
        expect(out.record.status).toBe('approved')
        expect(out.effectsError).toBe('side-effect blew up')
        expect(out.effectsMeta).toBeNull()
    })

    it('operator bypasses org-role check', async () => {
        const store = makeStubStore({
            record: makeRecord(),
            payload: { subject_email: 'guang@example.com' },
        })
        const out = await executeDecide({
            store,
            domain: testDomain,
            namespace: 'ns-a',
            approvalId: 'approval-1',
            actorEmail: null,
            isOperator: true,
            orgRoleOf: async () => null,
            action: { action: 'approve' },
        })
        expect(out.audit.actorRole).toBe('operator')
    })

    it('rejects when approval record domain mismatches executor domain', async () => {
        const store = makeStubStore({
            record: makeRecord({ domain: 'other_domain' }),
            payload: { subject_email: 'guang@example.com' },
        })
        await expect(
            executeDecide({
                store,
                domain: testDomain,
                namespace: 'ns-a',
                approvalId: 'approval-1',
                actorEmail: 'admin@example.com',
                isOperator: false,
                orgRoleOf: async () => 'admin',
                action: { action: 'approve' },
            }),
        ).rejects.toThrow(/belongs to domain "other_domain"/)
    })
})
