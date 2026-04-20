import type { ApprovalRequestStatus, StoredApprovalDecision, StoredApprovalRequest } from '../store'
import { ControlPlaneError } from './types'
import type { IStore, CreateApprovalRequestInput, RecordApprovalDecisionInput } from './types'

function mapDecisionToRequestStatus(result: RecordApprovalDecisionInput['result']): ApprovalRequestStatus {
    switch (result) {
        case 'approved':
            return 'approved'
        case 'rejected':
        case 'provider_failed':
            return 'rejected'
        case 'expired':
            return 'expired'
        case 'cancelled':
            return 'cancelled'
    }
}

export class ApprovalService {
    constructor(private readonly store: IStore) {}

    async createRequest(input: CreateApprovalRequestInput): Promise<StoredApprovalRequest> {
        return this.store.createApprovalRequestAtomically({
            request: {
                ...input,
                status: 'pending',
            },
            auditEvent: {
                namespace: input.namespace,
                orgId: input.orgId,
                eventType: 'approval_request.created',
                subjectType: input.requestedByType,
                subjectId: input.requestedById,
                sessionId: input.sessionId ?? null,
                parentSessionId: input.parentSessionId ?? null,
                resourceType: input.resourceType ?? null,
                action: input.requestKind,
                result: 'pending',
                sourceSystem: 'control-plane',
                payload: {
                    toolName: input.toolName ?? null,
                    requestedMode: input.requestedMode ?? null,
                    requestedTools: input.requestedTools ?? null,
                },
            },
        })
    }

    async recordDecision(input: RecordApprovalDecisionInput): Promise<StoredApprovalDecision> {
        const request = await this.store.getApprovalRequest(input.approvalRequestId)
        if (!request) {
            throw new ControlPlaneError(404, 'Approval request not found')
        }
        if (request.namespace !== input.namespace || request.orgId !== input.orgId) {
            throw new ControlPlaneError(403, 'Approval request access denied')
        }

        const existingDecision = await this.store.getApprovalDecisionByRequestId(request.id)
        if (existingDecision) {
            throw new ControlPlaneError(409, 'Approval request already has a decision')
        }
        if (request.status !== 'pending') {
            throw new ControlPlaneError(409, 'Approval request is no longer pending')
        }

        try {
            return await this.store.recordApprovalDecisionAtomically({
                decision: input,
                requestStatus: mapDecisionToRequestStatus(input.result),
                auditEvent: {
                    namespace: input.namespace,
                    orgId: input.orgId,
                    eventType: 'approval_decision.recorded',
                    subjectType: input.decidedByType,
                    subjectId: input.decidedById,
                    sessionId: request.sessionId,
                    parentSessionId: request.parentSessionId,
                    resourceType: request.resourceType,
                    action: request.requestKind,
                    result: input.result,
                    sourceSystem: 'control-plane',
                    payload: {
                        approvalRequestId: request.id,
                        provider: input.provider ?? null,
                    },
                },
            })
        } catch (error: any) {
            if (error?.code === '23505' || error?.code === 'APPROVAL_DECISION_EXISTS') {
                throw new ControlPlaneError(409, 'Approval request already has a decision')
            }
            if (error?.code === 'APPROVAL_REQUEST_NOT_PENDING') {
                throw new ControlPlaneError(409, 'Approval request is no longer pending')
            }
            if (error?.code === 'APPROVAL_REQUEST_NOT_FOUND') {
                throw new ControlPlaneError(404, 'Approval request not found')
            }
            throw error
        }
    }
}
