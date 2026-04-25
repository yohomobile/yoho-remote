// Unified Approvals Engine — core type contracts.
//
// Two flavours of domain are supported:
//   1. "owner" mode (default): candidate data lives in our `approvals` master
//      table + a per-domain `approval_payload_*` table. The standard store
//      layer (`store.listApprovals` / `decideApproval`) drives the workflow.
//   2. "proxy" mode (set `proxyAdapter`): candidate data lives in another
//      service (e.g. yoho-vault skill candidates). The store layer is
//      bypassed; the route layer calls the adapter's list/get/decide methods
//      directly, and audits are skipped (the upstream system owns history).
//
// Today: identity uses owner mode; skill uses proxy mode.

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
export interface ApprovalProxyAdapter<TAction extends { action: string }> {
    list(filter: {
        namespace: string
        orgId: string
        status: ApprovalMasterStatus | null
        limit: number
    }): Promise<ApprovalRecord[]>
    get(filter: {
        namespace: string
        orgId: string
        id: string
    }): Promise<{ record: ApprovalRecord; payload: unknown } | null>
    decide(args: {
        namespace: string
        orgId: string
        id: string
        action: TAction
        reason: string | null
        actorEmail: string | null
        isOperator: boolean
    }): Promise<{
        record: ApprovalRecord
        payload: unknown
        effectsMeta: Record<string, unknown> | null
        effectsError: string | null
    }>
}

export interface ApprovalDomain<
    TPayload,
    TAction extends { action: string } = { action: string },
> {
    readonly name: string
    readonly subjectKind: string
    /** Owner-mode physical payload table. Empty string when running in proxy
     *  mode (no payload row in our DB). */
    readonly payloadTable: string
    /** Proxy mode: when set, the route layer bypasses store and uses this
     *  adapter to list/get/decide. */
    readonly proxyAdapter?: ApprovalProxyAdapter<TAction>
    /** Validator for the decide-body `{ action: ... }` payload. The generic
     *  HTTP route calls `safeParse` and returns 400 on failure. */
    readonly actionSchema: ApprovalActionValidator<TAction>
    /** Optional: validator for the proposal body. Domains that accept human
     *  submissions (e.g. team_memory) populate this; worker-only domains
     *  (identity/observation/memory_conflict) leave it undefined and the
     *  `POST /api/approvals` route returns 403. */
    readonly proposalPayloadSchema?: ApprovalActionValidator<TPayload>
    /**
     * Optional: decide whether the caller may submit a proposal for this
     * domain. Defaults to "no one" when `proposalPayloadSchema` is also
     * unset. Intended for domains whose candidates come from a human, not a
     * detector.
     */
    canPropose?(ctx: {
        actorEmail: string | null
        isOperator: boolean
        orgRole: OrgRole | null
    }): boolean

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
