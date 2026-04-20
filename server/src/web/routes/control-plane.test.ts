import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createControlPlaneRoutes } from './control-plane'
import type {
    ApprovalDecisionResult,
    ApprovalRequestStatus,
    CapabilityGrantStatus,
    ControlPlaneActorType,
    StoredApprovalDecision,
    StoredApprovalRequest,
    StoredAuditEvent,
    StoredCapabilityGrant,
} from '../../store'

function createAuthedApp(store: Record<string, unknown>, email = 'owner@example.com') {
    const app = new Hono<any>()
    app.use('/api/*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('email', email)
        c.set('userId', 'user-1')
        await next()
    })
    app.route('/api', createControlPlaneRoutes(store as any))
    return app
}

function createInMemoryControlPlaneStore() {
    let approvalSeq = 1
    let decisionSeq = 1
    let grantSeq = 1
    let auditSeq = 1
    const approvalRequests = new Map<string, StoredApprovalRequest>()
    const approvalDecisions = new Map<string, StoredApprovalDecision>()
    const grants = new Map<string, StoredCapabilityGrant>()
    const auditEvents: StoredAuditEvent[] = []

    const createApprovalRequestRecord = (data: {
        namespace: string
        orgId?: string | null
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
        status?: ApprovalRequestStatus
        expiresAt?: number | null
    }) => {
        const approvalRequest: StoredApprovalRequest = {
            id: `approval-${approvalSeq++}`,
            namespace: data.namespace,
            orgId: data.orgId ?? null,
            sessionId: data.sessionId ?? null,
            parentSessionId: data.parentSessionId ?? null,
            requestKind: data.requestKind,
            toolName: data.toolName ?? null,
            resourceType: data.resourceType ?? null,
            resourceSelector: data.resourceSelector ?? null,
            requestedMode: data.requestedMode ?? null,
            requestedTools: data.requestedTools ?? null,
            requestPayload: data.requestPayload ?? null,
            riskLevel: data.riskLevel ?? null,
            providerHint: data.providerHint ?? null,
            requestedByType: data.requestedByType,
            requestedById: data.requestedById,
            status: data.status ?? 'pending',
            requestedAt: Date.now(),
            expiresAt: data.expiresAt ?? null,
        }
        approvalRequests.set(approvalRequest.id, approvalRequest)
        return approvalRequest
    }

    const setApprovalRequestStatus = (id: string, status: ApprovalRequestStatus) => {
        const approvalRequest = approvalRequests.get(id)
        if (!approvalRequest) {
            return false
        }
        approvalRequests.set(id, { ...approvalRequest, status })
        return true
    }

    const createApprovalDecisionRecord = (data: {
        approvalRequestId: string
        namespace: string
        orgId?: string | null
        provider?: string | null
        result: ApprovalDecisionResult
        decidedByType: ControlPlaneActorType
        decidedById: string
        decisionPayload?: unknown
        expiresAt?: number | null
    }) => {
        const approvalDecision: StoredApprovalDecision = {
            id: `decision-${decisionSeq++}`,
            approvalRequestId: data.approvalRequestId,
            namespace: data.namespace,
            orgId: data.orgId ?? null,
            provider: data.provider ?? null,
            result: data.result,
            decidedByType: data.decidedByType,
            decidedById: data.decidedById,
            decisionPayload: data.decisionPayload ?? null,
            decidedAt: Date.now(),
            expiresAt: data.expiresAt ?? null,
        }
        approvalDecisions.set(approvalDecision.id, approvalDecision)
        return approvalDecision
    }

    const createCapabilityGrantRecord = (data: {
        namespace: string
        orgId?: string | null
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
        usedCount?: number
        status?: CapabilityGrantStatus
        expiresAt?: number | null
    }) => {
        const grant: StoredCapabilityGrant = {
            id: `grant-${grantSeq++}`,
            approvalRequestId: data.approvalRequestId ?? null,
            approvalDecisionId: data.approvalDecisionId ?? null,
            namespace: data.namespace,
            orgId: data.orgId ?? null,
            subjectType: data.subjectType,
            subjectId: data.subjectId,
            sourceSessionId: data.sourceSessionId ?? null,
            boundSessionId: data.boundSessionId ?? null,
            boundMachineId: data.boundMachineId ?? null,
            boundProjectIds: data.boundProjectIds ?? null,
            toolAllowlist: data.toolAllowlist ?? null,
            resourceScopes: data.resourceScopes ?? null,
            modeCap: data.modeCap ?? null,
            maxUses: data.maxUses ?? null,
            usedCount: data.usedCount ?? 0,
            status: data.status ?? 'active',
            issuedAt: Date.now(),
            expiresAt: data.expiresAt ?? null,
            revokedAt: null,
            revokeReason: null,
        }
        grants.set(grant.id, grant)
        return grant
    }

    const createAuditEventRecord = (data: {
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
    }) => {
        const auditEvent: StoredAuditEvent = {
            id: `audit-${auditSeq++}`,
            namespace: data.namespace,
            orgId: data.orgId ?? null,
            eventType: data.eventType,
            subjectType: data.subjectType ?? null,
            subjectId: data.subjectId ?? null,
            sessionId: data.sessionId ?? null,
            parentSessionId: data.parentSessionId ?? null,
            resourceType: data.resourceType ?? null,
            resourceId: data.resourceId ?? null,
            action: data.action,
            result: data.result,
            sourceSystem: data.sourceSystem,
            correlationId: data.correlationId ?? null,
            payload: data.payload ?? null,
            createdAt: Date.now(),
        }
        auditEvents.unshift(auditEvent)
        return auditEvent
    }

    const store = {
        getUserOrgRole: async (orgId: string, email: string) => (
            orgId === 'org-1' && email.endsWith('@example.com') ? 'owner' : null
        ),
        createApprovalRequest: async (data: {
            namespace: string
            orgId?: string | null
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
            status?: ApprovalRequestStatus
            expiresAt?: number | null
        }) => createApprovalRequestRecord(data),
        createApprovalRequestAtomically: async (data: {
            request: {
                namespace: string
                orgId?: string | null
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
                status?: ApprovalRequestStatus
                expiresAt?: number | null
            }
            auditEvent: {
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
        }) => {
            const approvalRequest = createApprovalRequestRecord(data.request)
            createAuditEventRecord({
                ...data.auditEvent,
                correlationId: data.auditEvent.correlationId ?? approvalRequest.id,
                payload: {
                    ...(typeof data.auditEvent.payload === 'object' && data.auditEvent.payload !== null && !Array.isArray(data.auditEvent.payload)
                        ? data.auditEvent.payload as Record<string, unknown>
                        : {}),
                    approvalRequestId: approvalRequest.id,
                },
            })
            return approvalRequest
        },
        getApprovalRequest: async (id: string) => approvalRequests.get(id) ?? null,
        updateApprovalRequestStatus: async (id: string, status: ApprovalRequestStatus) => setApprovalRequestStatus(id, status),
        createApprovalDecision: async (data: {
            approvalRequestId: string
            namespace: string
            orgId?: string | null
            provider?: string | null
            result: ApprovalDecisionResult
            decidedByType: ControlPlaneActorType
            decidedById: string
            decisionPayload?: unknown
            expiresAt?: number | null
        }) => createApprovalDecisionRecord(data),
        recordApprovalDecisionAtomically: async (data: {
            decision: {
                approvalRequestId: string
                namespace: string
                orgId?: string | null
                provider?: string | null
                result: ApprovalDecisionResult
                decidedByType: ControlPlaneActorType
                decidedById: string
                decisionPayload?: unknown
                expiresAt?: number | null
            }
            requestStatus: ApprovalRequestStatus
            auditEvent: {
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
        }) => {
            const request = approvalRequests.get(data.decision.approvalRequestId)
            if (!request) {
                throw Object.assign(new Error('Approval request not found'), {
                    code: 'APPROVAL_REQUEST_NOT_FOUND',
                })
            }
            const existingDecision = Array.from(approvalDecisions.values()).find(
                (decision) => decision.approvalRequestId === data.decision.approvalRequestId
            )
            if (existingDecision) {
                throw Object.assign(new Error('Approval request already has a decision'), {
                    code: 'APPROVAL_DECISION_EXISTS',
                })
            }
            if (request.status !== 'pending') {
                throw Object.assign(new Error('Approval request is no longer pending'), {
                    code: 'APPROVAL_REQUEST_NOT_PENDING',
                })
            }

            const approvalDecision = createApprovalDecisionRecord(data.decision)
            setApprovalRequestStatus(data.decision.approvalRequestId, data.requestStatus)
            createAuditEventRecord({
                ...data.auditEvent,
                correlationId: data.auditEvent.correlationId ?? approvalDecision.id,
                payload: {
                    ...(typeof data.auditEvent.payload === 'object' && data.auditEvent.payload !== null && !Array.isArray(data.auditEvent.payload)
                        ? data.auditEvent.payload as Record<string, unknown>
                        : {}),
                    approvalDecisionId: approvalDecision.id,
                },
            })
            return approvalDecision
        },
        getApprovalDecision: async (id: string) => approvalDecisions.get(id) ?? null,
        getApprovalDecisionByRequestId: async (approvalRequestId: string) => (
            Array.from(approvalDecisions.values()).find((decision) => decision.approvalRequestId === approvalRequestId) ?? null
        ),
        createCapabilityGrant: async (data: {
            namespace: string
            orgId?: string | null
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
            usedCount?: number
            status?: CapabilityGrantStatus
            expiresAt?: number | null
        }) => createCapabilityGrantRecord(data),
        issueCapabilityGrantAtomically: async (data: {
            grant: {
                namespace: string
                orgId?: string | null
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
                usedCount?: number
                status?: CapabilityGrantStatus
                expiresAt?: number | null
            }
            auditEvent: {
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
        }) => {
            const grant = createCapabilityGrantRecord(data.grant)
            createAuditEventRecord({
                ...data.auditEvent,
                resourceId: data.auditEvent.resourceId ?? grant.id,
                correlationId: data.auditEvent.correlationId ?? grant.id,
            })
            return grant
        },
        getCapabilityGrant: async (id: string) => grants.get(id) ?? null,
        revokeCapabilityGrant: async (id: string, reason?: string | null) => {
            const grant = grants.get(id)
            if (!grant) {
                return null
            }
            const revoked = {
                ...grant,
                status: 'revoked' as const,
                revokedAt: Date.now(),
                revokeReason: reason ?? null,
            }
            grants.set(id, revoked)
            return revoked
        },
        createAuditEvent: async (data: {
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
        }) => createAuditEventRecord(data),
        listAuditEvents: async (filters?: { orgId?: string | null; sessionId?: string; subjectId?: string; limit?: number }) => {
            let events = [...auditEvents]
            if (filters?.orgId !== undefined) {
                events = events.filter((event) => event.orgId === filters.orgId)
            }
            if (filters?.sessionId) {
                events = events.filter((event) => event.sessionId === filters.sessionId)
            }
            if (filters?.subjectId) {
                events = events.filter((event) => event.subjectId === filters.subjectId)
            }
            return events.slice(0, filters?.limit ?? 50)
        },
    }

    return { store, approvalRequests, approvalDecisions, grants, auditEvents }
}

describe('createControlPlaneRoutes', () => {
    test('covers approval to grant lifecycle and explicit audit write', async () => {
        const { store } = createInMemoryControlPlaneStore()
        const app = createAuthedApp(store)

        const requestResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                sessionId: 'session-1',
                requestKind: 'tool_permission',
                toolName: 'yoho_memory_remember',
                resourceType: 'memory',
            }),
        })
        expect(requestResponse.status).toBe(200)
        const requestJson = await requestResponse.json() as { approvalRequest: StoredApprovalRequest }

        const decisionResponse = await app.request('/api/control-plane/approval-decisions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                result: 'approved',
            }),
        })
        expect(decisionResponse.status).toBe(200)
        const decisionJson = await decisionResponse.json() as { approvalDecision: StoredApprovalDecision }

        const grantResponse = await app.request('/api/control-plane/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                approvalDecisionId: decisionJson.approvalDecision.id,
                subjectType: 'session',
                subjectId: 'session-1',
                sourceSessionId: 'session-1',
                boundSessionId: 'session-1',
                toolAllowlist: ['remember'],
                modeCap: 'safe-yolo',
            }),
        })
        expect(grantResponse.status).toBe(200)
        const grantJson = await grantResponse.json() as { grant: StoredCapabilityGrant }

        const introspectResponse = await app.request('/api/control-plane/grants/introspect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                grantId: grantJson.grant.id,
            }),
        })
        expect(introspectResponse.status).toBe(200)
        expect(await introspectResponse.json()).toMatchObject({
            ok: true,
            introspection: {
                active: true,
                reason: null,
                grant: {
                    id: grantJson.grant.id,
                    effectiveStatus: 'active',
                    subjectId: 'session-1',
                },
            },
        })

        const revokeResponse = await app.request(`/api/control-plane/grants/${grantJson.grant.id}/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                reason: 'manual revoke',
            }),
        })
        expect(revokeResponse.status).toBe(200)
        expect(await revokeResponse.json()).toMatchObject({
            ok: true,
            grant: {
                id: grantJson.grant.id,
                status: 'revoked',
                revokeReason: 'manual revoke',
            },
        })

        const revokedIntrospectResponse = await app.request('/api/control-plane/grants/introspect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                grantId: grantJson.grant.id,
            }),
        })
        expect(revokedIntrospectResponse.status).toBe(200)
        expect(await revokedIntrospectResponse.json()).toMatchObject({
            ok: true,
            introspection: {
                active: false,
                reason: 'grant_revoked',
                grant: {
                    id: grantJson.grant.id,
                    effectiveStatus: 'revoked',
                },
            },
        })

        const auditWriteResponse = await app.request('/api/control-plane/audit-events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                eventType: 'memory.accessed',
                subjectType: 'session',
                subjectId: 'session-1',
                sessionId: 'session-1',
                resourceType: 'memory',
                resourceId: 'memory-1',
                action: 'remember',
                result: 'success',
                sourceSystem: 'yoho-memory',
                payload: { capability: 'memory.remember' },
            }),
        })
        expect(auditWriteResponse.status).toBe(200)

        const auditListResponse = await app.request('/api/control-plane/audit-events?orgId=org-1&limit=10')
        expect(auditListResponse.status).toBe(200)
        expect(await auditListResponse.json()).toMatchObject({
            events: expect.arrayContaining([
                expect.objectContaining({ eventType: 'memory.accessed', sourceSystem: 'yoho-memory' }),
                expect.objectContaining({ eventType: 'capability_grant.revoked', resourceId: grantJson.grant.id }),
                expect.objectContaining({ eventType: 'capability_grant.issued', resourceId: grantJson.grant.id }),
                expect.objectContaining({ eventType: 'approval_decision.recorded' }),
                expect.objectContaining({ eventType: 'approval_request.created' }),
            ]),
        })
    })

    test('rejects grant issuance when approval decision is not approved', async () => {
        const { store } = createInMemoryControlPlaneStore()
        const app = createAuthedApp(store)

        const requestResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                requestKind: 'tool_permission',
            }),
        })
        const requestJson = await requestResponse.json() as { approvalRequest: StoredApprovalRequest }

        const decisionResponse = await app.request('/api/control-plane/approval-decisions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                result: 'rejected',
            }),
        })
        const decisionJson = await decisionResponse.json() as { approvalDecision: StoredApprovalDecision }

        const grantResponse = await app.request('/api/control-plane/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                approvalDecisionId: decisionJson.approvalDecision.id,
                subjectType: 'session',
                subjectId: 'session-1',
            }),
        })

        expect(grantResponse.status).toBe(409)
        expect(await grantResponse.json()).toEqual({
            error: 'Approval decision is not approved',
        })
    })

    test('rejects grant issuance when approval request and decision do not match', async () => {
        const { store } = createInMemoryControlPlaneStore()
        const app = createAuthedApp(store)

        const requestAResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                requestKind: 'tool_permission',
            }),
        })
        const requestAJson = await requestAResponse.json() as { approvalRequest: StoredApprovalRequest }

        const requestBResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                requestKind: 'tool_permission',
            }),
        })
        const requestBJson = await requestBResponse.json() as { approvalRequest: StoredApprovalRequest }

        const decisionResponse = await app.request('/api/control-plane/approval-decisions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestBJson.approvalRequest.id,
                result: 'approved',
            }),
        })
        const decisionJson = await decisionResponse.json() as { approvalDecision: StoredApprovalDecision }

        const grantResponse = await app.request('/api/control-plane/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestAJson.approvalRequest.id,
                approvalDecisionId: decisionJson.approvalDecision.id,
                subjectType: 'session',
                subjectId: 'session-1',
            }),
        })

        expect(grantResponse.status).toBe(409)
        expect(await grantResponse.json()).toEqual({
            error: 'Approval request and decision do not match',
        })
    })

    test('rejects grant issuance when approval request is still pending', async () => {
        const { store } = createInMemoryControlPlaneStore()
        const app = createAuthedApp(store)

        const requestResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                requestKind: 'tool_permission',
            }),
        })
        const requestJson = await requestResponse.json() as { approvalRequest: StoredApprovalRequest }

        const grantResponse = await app.request('/api/control-plane/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                subjectType: 'session',
                subjectId: 'session-1',
            }),
        })

        expect(grantResponse.status).toBe(409)
        expect(await grantResponse.json()).toEqual({
            error: 'Approval request is not approved',
        })
    })

    test('rejects grant issuance when approval request was rejected', async () => {
        const { store } = createInMemoryControlPlaneStore()
        const app = createAuthedApp(store)

        const requestResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                requestKind: 'tool_permission',
            }),
        })
        const requestJson = await requestResponse.json() as { approvalRequest: StoredApprovalRequest }

        const decisionResponse = await app.request('/api/control-plane/approval-decisions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                result: 'rejected',
            }),
        })
        expect(decisionResponse.status).toBe(200)

        const grantResponse = await app.request('/api/control-plane/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                subjectType: 'session',
                subjectId: 'session-1',
            }),
        })

        expect(grantResponse.status).toBe(409)
        expect(await grantResponse.json()).toEqual({
            error: 'Approval request is not approved',
        })
    })

    test('rejects duplicate decision submissions for the same request', async () => {
        const { store } = createInMemoryControlPlaneStore()
        const app = createAuthedApp(store)

        const requestResponse = await app.request('/api/control-plane/approval-requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                requestKind: 'tool_permission',
            }),
        })
        const requestJson = await requestResponse.json() as { approvalRequest: StoredApprovalRequest }

        const firstDecisionResponse = await app.request('/api/control-plane/approval-decisions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                result: 'approved',
            }),
        })
        expect(firstDecisionResponse.status).toBe(200)

        const secondDecisionResponse = await app.request('/api/control-plane/approval-decisions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                orgId: 'org-1',
                approvalRequestId: requestJson.approvalRequest.id,
                result: 'rejected',
            }),
        })

        expect(secondDecisionResponse.status).toBe(409)
        expect(await secondDecisionResponse.json()).toEqual({
            error: 'Approval request already has a decision',
        })

        const auditListResponse = await app.request('/api/control-plane/audit-events?orgId=org-1&limit=20')
        expect(auditListResponse.status).toBe(200)
        const auditListJson = await auditListResponse.json() as { events: StoredAuditEvent[] }
        expect(auditListJson.events.filter((event) => event.eventType === 'approval_decision.recorded')).toHaveLength(1)
        expect(auditListJson.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ eventType: 'approval_decision.recorded', result: 'approved' }),
        ]))
    })
})
