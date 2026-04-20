import { Context, Hono } from 'hono'
import { z } from 'zod'
import { ApprovalService } from '../../control-plane/approvalService'
import { AuditService } from '../../control-plane/auditService'
import { CapabilityGrantService } from '../../control-plane/capabilityGrantService'
import { ControlPlaneError } from '../../control-plane/types'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore, OrgRole } from '../../store'

const createApprovalRequestSchema = z.object({
    orgId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).optional(),
    requestKind: z.string().min(1),
    toolName: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
    resourceSelector: z.unknown().optional(),
    requestedMode: z.string().min(1).optional(),
    requestedTools: z.array(z.string().min(1)).optional(),
    requestPayload: z.unknown().optional(),
    riskLevel: z.string().min(1).optional(),
    providerHint: z.string().min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
})

const createApprovalDecisionSchema = z.object({
    orgId: z.string().min(1),
    approvalRequestId: z.string().min(1),
    provider: z.string().min(1).optional(),
    result: z.enum(['approved', 'rejected', 'expired', 'cancelled', 'provider_failed']),
    decisionPayload: z.unknown().optional(),
    expiresAt: z.number().int().positive().optional(),
})

const createGrantSchema = z.object({
    orgId: z.string().min(1),
    approvalRequestId: z.string().min(1).optional(),
    approvalDecisionId: z.string().min(1).optional(),
    subjectType: z.enum(['user', 'session', 'service']),
    subjectId: z.string().min(1),
    sourceSessionId: z.string().min(1).optional(),
    boundSessionId: z.string().min(1).optional(),
    boundMachineId: z.string().min(1).optional(),
    boundProjectIds: z.array(z.string().min(1)).optional(),
    toolAllowlist: z.array(z.string().min(1)).optional(),
    resourceScopes: z.unknown().optional(),
    modeCap: z.string().min(1).optional(),
    maxUses: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().optional(),
})

const introspectGrantSchema = z.object({
    orgId: z.string().min(1),
    grantId: z.string().min(1),
})

const revokeGrantSchema = z.object({
    orgId: z.string().min(1),
    reason: z.string().trim().min(1).max(500).optional(),
})

const createAuditEventSchema = z.object({
    orgId: z.string().min(1),
    eventType: z.string().min(1),
    subjectType: z.enum(['user', 'session', 'service']).optional(),
    subjectId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
    resourceId: z.string().min(1).optional(),
    action: z.string().min(1),
    result: z.string().min(1),
    sourceSystem: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    payload: z.unknown().optional(),
})

const listAuditEventsQuerySchema = z.object({
    orgId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    subjectId: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
})

async function requireOrgRole(
    store: IStore,
    orgId: string,
    email: string,
    minimumRoles: OrgRole[],
): Promise<{ role: OrgRole } | { error: string; status: 403 }> {
    const role = await store.getUserOrgRole(orgId, email)
    if (!role) {
        return { error: 'Not a member of this organization', status: 403 }
    }
    if (!minimumRoles.includes(role)) {
        return { error: 'Insufficient permissions', status: 403 }
    }
    return { role }
}

function mapControlPlaneError(c: Context<WebAppEnv>, error: unknown): Response {
    if (error instanceof ControlPlaneError) {
        return c.json({ error: error.message }, error.status as 400 | 403 | 404 | 409)
    }
    console.error('[control-plane] unexpected error', error)
    return c.json({ error: 'Internal server error' }, 500)
}

export function createControlPlaneRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const auditService = new AuditService(store)
    const approvalService = new ApprovalService(store)
    const grantService = new CapabilityGrantService(store, auditService)

    app.post('/control-plane/approval-requests', async (c) => {
        const email = c.get('email')
        const userId = c.get('userId')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = createApprovalRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin', 'member'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const approvalRequest = await approvalService.createRequest({
                ...parsed.data,
                namespace: c.get('namespace'),
                requestedByType: 'user',
                requestedById: userId,
            })
            return c.json({ ok: true, approvalRequest })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    app.post('/control-plane/approval-decisions', async (c) => {
        const email = c.get('email')
        const userId = c.get('userId')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = createApprovalDecisionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const approvalDecision = await approvalService.recordDecision({
                ...parsed.data,
                namespace: c.get('namespace'),
                decidedByType: 'user',
                decidedById: userId,
            })
            return c.json({ ok: true, approvalDecision })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    app.post('/control-plane/grants', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = createGrantSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const grant = await grantService.issueGrant({
                ...parsed.data,
                namespace: c.get('namespace'),
            })
            return c.json({ ok: true, grant })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    app.post('/control-plane/grants/introspect', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = introspectGrantSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin', 'member'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const introspection = await grantService.introspectGrant(parsed.data.grantId)
            if (!introspection) {
                return c.json({ error: 'Grant not found' }, 404)
            }
            if (introspection.grant.namespace !== c.get('namespace') || introspection.grant.orgId !== parsed.data.orgId) {
                return c.json({ error: 'Grant access denied' }, 403)
            }
            return c.json({ ok: true, introspection })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    app.post('/control-plane/grants/:grantId/revoke', async (c) => {
        const email = c.get('email')
        const userId = c.get('userId')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = revokeGrantSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const introspection = await grantService.introspectGrant(c.req.param('grantId'))
            if (!introspection) {
                return c.json({ error: 'Grant not found' }, 404)
            }
            if (introspection.grant.namespace !== c.get('namespace') || introspection.grant.orgId !== parsed.data.orgId) {
                return c.json({ error: 'Grant access denied' }, 403)
            }

            const grant = await grantService.revokeGrant({
                grantId: c.req.param('grantId'),
                actorType: 'user',
                actorId: userId,
                reason: parsed.data.reason,
            })
            if (!grant) {
                return c.json({ error: 'Grant not found' }, 404)
            }
            return c.json({ ok: true, grant })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    app.post('/control-plane/audit-events', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = createAuditEventSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin', 'member'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const auditEvent = await auditService.writeEvent({
                ...parsed.data,
                namespace: c.get('namespace'),
            })
            return c.json({ ok: true, auditEvent })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    app.get('/control-plane/audit-events', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const parsed = listAuditEventsQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400)
        }

        const roleCheck = await requireOrgRole(store, parsed.data.orgId, email, ['owner', 'admin', 'member'])
        if ('error' in roleCheck) {
            return c.json({ error: roleCheck.error }, roleCheck.status)
        }

        try {
            const events = await auditService.listEvents(parsed.data)
            return c.json({ events })
        } catch (error) {
            return mapControlPlaneError(c, error)
        }
    })

    return app
}
