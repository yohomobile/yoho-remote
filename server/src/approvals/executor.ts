// Approvals Engine — decision executor.
//
// Orchestrates permission + state-machine + effects around
// `store.decideApproval`. Domain semantics live on the plugin; this file knows
// only how to thread a decision through the plugin in the right order inside
// the store transaction.

import type { IStore, OrgRole } from '../store'
import type {
    ApprovalDomain,
    ApprovalRecord,
    ApprovalAudit,
} from './types'
import {
    ApprovalForbiddenError,
    ApprovalInvalidTransitionError,
} from './types'

export interface ExecuteDecideArgs<
    TPayload extends Record<string, unknown>,
    TAction extends { action: string },
> {
    store: IStore
    domain: ApprovalDomain<TPayload, TAction>
    namespace: string
    approvalId: string
    actorEmail: string | null
    isOperator: boolean
    /** Resolver for the acting user's role in the approval's org. Executed
     *  inside the txn once the approval row is locked. */
    orgRoleOf: (orgId: string, email: string) => Promise<OrgRole | null>
    action: TAction
    reason?: string | null
}

export interface ExecuteDecideResult<TPayload> {
    record: ApprovalRecord
    payload: TPayload
    audit: ApprovalAudit
    /** Arbitrary metadata returned from `domain.effects` (e.g. auto-promoted
     *  plan id). `null` when the domain has no effects or effects failed. */
    effectsMeta: Record<string, unknown> | null
    /** Error message captured from a best-effort `domain.effects` failure.
     *  `null` when effects succeeded or were not configured. */
    effectsError: string | null
}

/**
 * Run a domain decision inside one approvals txn. Throws on permission denial,
 * invalid transition, or missing record. `domain.effects` failures are NOT
 * fatal: they are captured into `effectsError` and surfaced to the caller so
 * the decision still commits.
 */
export async function executeDecide<
    TPayload extends Record<string, unknown>,
    TAction extends { action: string },
>(
    args: ExecuteDecideArgs<TPayload, TAction>,
): Promise<ExecuteDecideResult<TPayload>> {
    const {
        store,
        domain,
        namespace,
        approvalId,
        actorEmail,
        isOperator,
        orgRoleOf,
        action,
        reason,
    } = args

    let effectsMeta: Record<string, unknown> | null = null
    let effectsError: string | null = null

    const result = await store.decideApproval<TPayload>({
        namespace,
        approvalId,
        payloadTable: domain.payloadTable,
        decide: async ({ record, payload, query }) => {
            if (record.domain !== domain.name) {
                throw new Error(
                    `Approval ${record.id} belongs to domain "${record.domain}", not "${domain.name}"`,
                )
            }

            const orgRole = actorEmail ? await orgRoleOf(record.orgId, actorEmail) : null
            const role = domain.permission({
                actorEmail,
                isOperator,
                orgRole,
                record,
                payload,
            })
            if (!role) {
                throw new ApprovalForbiddenError()
            }

            const newStatus = domain.nextStatus(record.status, action)
            if (!newStatus) {
                throw new ApprovalInvalidTransitionError(record.status, action.action)
            }

            let payloadPatch: Partial<TPayload> | null = null
            if (domain.effects) {
                try {
                    const r = await domain.effects({
                        query,
                        orgId: record.orgId,
                        record,
                        payload,
                        action,
                        priorStatus: record.status,
                        newStatus,
                        actorEmail,
                        actorRole: role,
                    })
                    payloadPatch = r.payloadPatch ?? null
                    effectsMeta = r.effectsMeta ?? null
                } catch (err) {
                    effectsError = err instanceof Error ? err.message : String(err)
                }
            }

            return {
                newStatus,
                decidedBy: actorEmail,
                decisionReason: reason ?? null,
                payloadPatch,
                audit: {
                    action: action.action,
                    actorEmail,
                    actorRole: role,
                    reason: reason ?? null,
                },
            }
        },
    })

    return {
        record: result.record,
        payload: result.payload,
        audit: result.audit,
        effectsMeta,
        effectsError,
    }
}
