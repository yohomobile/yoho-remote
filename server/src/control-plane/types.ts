import type {
    ApprovalDecisionResult,
    CapabilityGrantStatus,
    ControlPlaneActorType,
    IStore,
    StoredApprovalDecision,
    StoredApprovalRequest,
    StoredAuditEvent,
    StoredCapabilityGrant,
} from '../store'

export type { IStore, StoredApprovalRequest, StoredApprovalDecision, StoredCapabilityGrant, StoredAuditEvent }
export type { ControlPlaneActorType, ApprovalDecisionResult, CapabilityGrantStatus }

export class ControlPlaneError extends Error {
    status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

export type CreateApprovalRequestInput = {
    namespace: string
    orgId: string
    sessionId?: string | null
    parentSessionId?: string | null
    requestKind: string
    toolName?: string | null
    resourceType?: string | null
    resourceSelector?: unknown
    requestedMode?: string | null
    requestedTools?: string[] | null
    requestPayload?: unknown
    riskLevel?: string | null
    providerHint?: string | null
    requestedByType: ControlPlaneActorType
    requestedById: string
    expiresAt?: number | null
}

export type RecordApprovalDecisionInput = {
    approvalRequestId: string
    namespace: string
    orgId: string
    provider?: string | null
    result: ApprovalDecisionResult
    decidedByType: ControlPlaneActorType
    decidedById: string
    decisionPayload?: unknown
    expiresAt?: number | null
}

export type IssueCapabilityGrantInput = {
    namespace: string
    orgId: string
    approvalRequestId?: string | null
    approvalDecisionId?: string | null
    subjectType: ControlPlaneActorType
    subjectId: string
    sourceSessionId?: string | null
    boundSessionId?: string | null
    boundMachineId?: string | null
    boundProjectIds?: string[] | null
    toolAllowlist?: string[] | null
    resourceScopes?: unknown
    modeCap?: string | null
    maxUses?: number | null
    expiresAt?: number | null
}

export type RevokeCapabilityGrantInput = {
    grantId: string
    actorType: ControlPlaneActorType
    actorId: string
    reason?: string | null
}

export type WriteAuditEventInput = {
    namespace: string
    orgId?: string | null
    eventType: string
    subjectType?: ControlPlaneActorType | null
    subjectId?: string | null
    sessionId?: string | null
    parentSessionId?: string | null
    resourceType?: string | null
    resourceId?: string | null
    action: string
    result: string
    sourceSystem: string
    correlationId?: string | null
    payload?: unknown
}

export type GrantIntrospection = {
    grant: StoredCapabilityGrant & { effectiveStatus: CapabilityGrantStatus }
    active: boolean
    reason: string | null
}
