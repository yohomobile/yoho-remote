import type {
    CapabilityGrantStatus,
    StoredApprovalDecision,
    StoredApprovalRequest,
    StoredCapabilityGrant,
} from '../store'
import { AuditService } from './auditService'
import { ControlPlaneError } from './types'
import type {
    GrantIntrospection,
    IStore,
    IssueCapabilityGrantInput,
    RevokeCapabilityGrantInput,
} from './types'

function deriveEffectiveStatus(grant: StoredCapabilityGrant, now = Date.now()): CapabilityGrantStatus {
    if (grant.status === 'revoked' || grant.revokedAt != null) {
        return 'revoked'
    }
    if (grant.status === 'expired' || (grant.expiresAt != null && grant.expiresAt <= now)) {
        return 'expired'
    }
    if (grant.status === 'exhausted' || (grant.maxUses != null && grant.usedCount >= grant.maxUses)) {
        return 'exhausted'
    }
    return 'active'
}

function buildInactiveReason(status: CapabilityGrantStatus): string | null {
    switch (status) {
        case 'revoked':
            return 'grant_revoked'
        case 'expired':
            return 'grant_expired'
        case 'exhausted':
            return 'grant_exhausted'
        case 'active':
            return null
    }
}

export class CapabilityGrantService {
    constructor(
        private readonly store: IStore,
        private readonly auditService: AuditService,
    ) {}

    async issueGrant(input: IssueCapabilityGrantInput): Promise<StoredCapabilityGrant> {
        let request: StoredApprovalRequest | null = null
        if (input.approvalRequestId) {
            request = await this.store.getApprovalRequest(input.approvalRequestId)
            if (!request) {
                throw new ControlPlaneError(404, 'Approval request not found')
            }
            if (request.namespace !== input.namespace || request.orgId !== input.orgId) {
                throw new ControlPlaneError(403, 'Approval request access denied')
            }
        }

        let decision: StoredApprovalDecision | null = null
        if (input.approvalDecisionId) {
            decision = await this.store.getApprovalDecision(input.approvalDecisionId)
            if (!decision) {
                throw new ControlPlaneError(404, 'Approval decision not found')
            }
            if (decision.namespace !== input.namespace || decision.orgId !== input.orgId) {
                throw new ControlPlaneError(403, 'Approval decision access denied')
            }
            if (decision.result !== 'approved') {
                throw new ControlPlaneError(409, 'Approval decision is not approved')
            }

            const decisionRequest = await this.store.getApprovalRequest(decision.approvalRequestId)
            if (!decisionRequest) {
                throw new ControlPlaneError(404, 'Approval request not found for decision')
            }
            if (decisionRequest.namespace !== input.namespace || decisionRequest.orgId !== input.orgId) {
                throw new ControlPlaneError(403, 'Approval request access denied')
            }

            if (request && decision.approvalRequestId !== request.id) {
                throw new ControlPlaneError(409, 'Approval request and decision do not match')
            }
            request = request ?? decisionRequest
        }

        if (request && request.status !== 'approved') {
            throw new ControlPlaneError(409, 'Approval request is not approved')
        }

        return this.store.issueCapabilityGrantAtomically({
            grant: {
                ...input,
                approvalRequestId: request?.id ?? null,
                approvalDecisionId: decision?.id ?? null,
                status: 'active',
            },
            auditEvent: {
                namespace: input.namespace,
                orgId: input.orgId,
                eventType: 'capability_grant.issued',
                subjectType: input.subjectType,
                subjectId: input.subjectId,
                sessionId: input.boundSessionId ?? input.sourceSessionId,
                resourceType: 'capability_grant',
                action: 'issue',
                result: 'active',
                sourceSystem: 'control-plane',
                payload: {
                    approvalRequestId: request?.id ?? null,
                    approvalDecisionId: decision?.id ?? null,
                    modeCap: input.modeCap ?? null,
                    toolAllowlist: input.toolAllowlist ?? null,
                },
            },
        })
    }

    async introspectGrant(grantId: string): Promise<GrantIntrospection | null> {
        const grant = await this.store.getCapabilityGrant(grantId)
        if (!grant) {
            return null
        }

        const effectiveStatus = deriveEffectiveStatus(grant)
        return {
            grant: {
                ...grant,
                effectiveStatus,
            },
            active: effectiveStatus === 'active',
            reason: buildInactiveReason(effectiveStatus),
        }
    }

    async revokeGrant(input: RevokeCapabilityGrantInput): Promise<StoredCapabilityGrant | null> {
        const existing = await this.store.getCapabilityGrant(input.grantId)
        if (!existing) {
            return null
        }

        const revoked = existing.status === 'revoked'
            ? existing
            : await this.store.revokeCapabilityGrant(input.grantId, input.reason ?? null)
        if (!revoked) {
            return null
        }

        await this.auditService.writeEvent({
            namespace: revoked.namespace,
            orgId: revoked.orgId,
            eventType: 'capability_grant.revoked',
            subjectType: input.actorType,
            subjectId: input.actorId,
            sessionId: revoked.boundSessionId ?? revoked.sourceSessionId,
            resourceType: 'capability_grant',
            resourceId: revoked.id,
            action: 'revoke',
            result: 'revoked',
            sourceSystem: 'control-plane',
            correlationId: revoked.id,
            payload: {
                reason: input.reason ?? revoked.revokeReason,
            },
        })

        return revoked
    }
}
