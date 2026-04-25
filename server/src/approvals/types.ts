// Unified Approvals Engine — core type contracts.
//
// Four domains (identity / team_memory / observation / memory_conflict) share
// one master table + one audit table (see store/approvals-ddl.ts). Each domain
// owns a typed payload table and plugs a `ApprovalDomain` into the registry.
// Core code routes decisions without knowing domain semantics; domain plugins
// own state-machine / permission / effects.

import type { OrgRole } from '../store'

export type ApprovalMasterStatus =
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'dismissed'

/** Row of the master `approvals` table — shared across all domains. */
export interface ApprovalRecord {
    id: string
    namespace: string
    orgId: string
    domain: string
    subjectKind: string
    subjectKey: string
    status: ApprovalMasterStatus
    decidedBy: string | null
    decidedAt: number | null
    decisionReason: string | null
    expiresAt: number | null
    createdAt: number
    updatedAt: number
}

/** Row of the `approval_audits` table. */
export interface ApprovalAudit {
    id: string
    approvalId: string
    namespace: string
    orgId: string
    domain: string
    action: string
    priorStatus: string | null
    newStatus: string | null
    actorEmail: string | null
    actorRole: ApprovalActorRole | null
    reason: string | null
    payloadSnapshot: unknown | null
    createdAt: number
}

/**
 * Role granted by the domain's permission policy. Recorded in the audit row
 * so later reviewers can tell *why* a decision was allowed, not just *who*.
 */
export type ApprovalActorRole = 'admin' | 'subject' | 'operator' | 'system'

/**
 * SQL escape hatch exposed to `effects` and `decide` callbacks so they can run
 * domain-specific side-effect SQL inside the same transaction that writes the
 * approval decision. The callback must *not* persist a reference to this
 * function — it is only valid for the lifetime of the enclosing txn.
 */
export type ApprovalTxnQuery = (
    text: string,
    params?: unknown[],
) => Promise<{ rows: any[]; rowCount: number }>

/**
 * Minimal structural validator the Approvals route layer uses to parse raw
 * action bodies into typed domain actions. Shape-compatible with Zod schemas
 * so domain plugins can pass `z.discriminatedUnion(...)` directly without
 * forcing types.ts to depend on zod.
 */
export interface ApprovalActionValidator<TAction> {
    safeParse(input: unknown):
        | { success: true; data: TAction }
        | { success: false; error: { issues: readonly unknown[] } }
}

export interface ApprovalPermissionContext<TPayload> {
    actorEmail: string | null
    isOperator: boolean
    orgRole: OrgRole | null
    record: ApprovalRecord
    payload: TPayload
}

export interface ApprovalEffectsContext<TPayload, TAction> {
    query: ApprovalTxnQuery
    orgId: string
    record: ApprovalRecord
    payload: TPayload
    action: TAction
    priorStatus: ApprovalMasterStatus
    newStatus: ApprovalMasterStatus
    actorEmail: string | null
    actorRole: ApprovalActorRole
}

export interface ApprovalEffectsResult<TPayload> {
    /** Partial patch merged onto the payload row before the audit snapshot. */
    payloadPatch?: Partial<TPayload>
    /** Arbitrary metadata surfaced back to the caller (e.g. auto-promoted plan id). */
    effectsMeta?: Record<string, unknown>
}

/**
 * Contract each approval domain implements. Methods must be pure or use the
 * provided transactional context; do not reach to external state in ways that
 * cannot be rolled back with the surrounding transaction.
 */
export interface ApprovalDomain<
    TPayload,
    TAction extends { action: string } = { action: string },
> {
    readonly name: string
    readonly subjectKind: string
    /** Physical `approval_payload_*` table this domain owns. Must pass the
     *  snake_case identifier check enforced by the store layer. */
    readonly payloadTable: string
    /** Validator for the decide-body `{ action: ... }` payload. The generic
     *  HTTP route calls `safeParse` and returns 400 on failure. */
    readonly actionSchema: ApprovalActionValidator<TAction>

    /**
     * Derive the subject_key used for dedup. Must be stable for the same logical
     * subject so that `UNIQUE(namespace, org_id, domain, subject_key)` catches
     * re-proposals instead of producing duplicates.
     */
    subjectKey(payload: TPayload): string

    /**
     * Decide the new master status given the current status + action, or return
     * null when the transition is illegal. Called inside the decision txn.
     */
    nextStatus(
        currentStatus: ApprovalMasterStatus,
        action: TAction,
    ): ApprovalMasterStatus | null

    /**
     * Return the actor role when permitted; null when denied. Runs before the
     * state-machine check so forbidden callers cannot see transition errors.
     */
    permission(ctx: ApprovalPermissionContext<TPayload>): ApprovalActorRole | null

    /**
     * Best-effort side effects (auto-promote plan, merge persons, etc). Thrown
     * errors are caught by the executor, logged, and recorded on the audit row
     * without aborting the primary transition. Return a payload patch to amend
     * the payload table inside the same transaction.
     */
    effects?(
        ctx: ApprovalEffectsContext<TPayload, TAction>,
    ): Promise<ApprovalEffectsResult<TPayload>>
}

/**
 * Context handed to the `decide` callback inside a `store.decideApproval`
 * transaction. The row is already locked FOR UPDATE; payload is the typed
 * snapshot read in the same txn. `now` is the shared Date.now() so audit
 * timestamps line up with the master-row update.
 */
export interface ApprovalTxnContext<TPayload> {
    record: ApprovalRecord
    payload: TPayload
    now: number
    query: ApprovalTxnQuery
}

/**
 * Result returned by the `decide` callback. Store commits this and writes the
 * audit row whose `payload_snapshot` is `payload` merged with `payloadPatch`.
 */
export interface ApprovalDecisionOutcome<TPayload> {
    newStatus: ApprovalMasterStatus
    decidedBy: string | null
    decisionReason: string | null
    /** Partial patch applied to the payload row in the same txn. */
    payloadPatch: Partial<TPayload> | null
    audit: {
        action: string
        actorEmail: string | null
        actorRole: ApprovalActorRole
        reason: string | null
    }
}

export class ApprovalNotFoundError extends Error {
    readonly code = 'APPROVAL_NOT_FOUND'
    constructor(readonly approvalId: string) {
        super(`Approval ${approvalId} not found`)
    }
}

export class ApprovalForbiddenError extends Error {
    readonly code = 'APPROVAL_FORBIDDEN'
    constructor(message = 'Not permitted to decide this approval') {
        super(message)
    }
}

export class ApprovalInvalidActionError extends Error {
    readonly code = 'APPROVAL_INVALID_ACTION'
    constructor(readonly issues: readonly unknown[]) {
        super('Invalid approval action payload')
    }
}

export class ApprovalInvalidTransitionError extends Error {
    readonly code = 'APPROVAL_INVALID_TRANSITION'
    constructor(
        readonly currentStatus: ApprovalMasterStatus,
        readonly action: string,
    ) {
        super(`Cannot apply action "${action}" when status is "${currentStatus}"`)
    }
}
