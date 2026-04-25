import { Hono, type Context } from 'hono'
import type { IStore, OrgRole } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import type { ApprovalDomainRegistry } from '../../approvals/registry'
import { executeDecide } from '../../approvals/executor'
import {
    ApprovalForbiddenError,
    ApprovalInvalidActionError,
    ApprovalInvalidTransitionError,
    ApprovalNotFoundError,
    type ApprovalDomain,
    type ApprovalMasterStatus,
} from '../../approvals/types'

// Cross-domain approvals HTTP surface. Thin layer on top of store + executor:
// the route validates org tenancy + resolves the domain, everything else
// delegates to the domain plugin + executor.

const orgAdminRoles: OrgRole[] = ['owner', 'admin']

const approvalStatusValues: ApprovalMasterStatus[] = [
    'pending', 'approved', 'rejected', 'expired', 'dismissed',
]

function requireOrgId(c: Context<WebAppEnv>): string | Response {
    const orgId = c.req.query('orgId')?.trim()
    if (!orgId) return c.json({ error: 'orgId is required' }, 400)
    return orgId
}

async function requireOrgMember(
    c: Context<WebAppEnv>,
    store: IStore,
    orgId: string,
): Promise<Response | null> {
    const email = c.get('email')
    if (!email) return c.json({ error: 'Unauthorized' }, 401)
    if (c.get('role') === 'operator') return null
    const role = await store.getUserOrgRole(orgId, email)
    if (!role) return c.json({ error: 'Insufficient permissions' }, 403)
    return null
}

async function requireOrgAdmin(
    c: Context<WebAppEnv>,
    store: IStore,
    orgId: string,
): Promise<Response | null> {
    const email = c.get('email')
    if (!email) return c.json({ error: 'Unauthorized' }, 401)
    if (c.get('role') === 'operator') return null
    const role = await store.getUserOrgRole(orgId, email)
    if (!role || !orgAdminRoles.includes(role)) {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }
    return null
}

export function createApprovalsRoutes(
    store: IStore,
    registry: ApprovalDomainRegistry,
    namespace = 'default',
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/approvals', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const statusRaw = c.req.query('status')?.trim() || null
        if (statusRaw && !approvalStatusValues.includes(statusRaw as ApprovalMasterStatus)) {
            return c.json({ error: 'Invalid status' }, 400)
        }
        const domain = c.req.query('domain')?.trim() || null
        const subjectKey = c.req.query('subjectKey')?.trim() || null
        const limit = Number(c.req.query('limit') ?? 50)

        const records = await store.listApprovals({
            namespace,
            orgId,
            domain,
            status: (statusRaw as ApprovalMasterStatus | null) ?? null,
            subjectKey,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ approvals: records })
    })

    // Human-origin proposal endpoint. Only domains that opt-in via
    // `proposalPayloadSchema` + `canPropose` accept submissions. Detector-only
    // domains (identity / observation / memory_conflict) return 403 here —
    // their candidates flow in through the worker side.
    app.post('/approvals', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const body = await c.req.json().catch(() => null)
        if (!body || typeof body !== 'object') {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const domainName = typeof (body as { domain?: unknown }).domain === 'string'
            ? (body as { domain: string }).domain
            : null
        if (!domainName) return c.json({ error: 'domain is required' }, 400)

        const domain = registry.get(domainName)
        if (!domain || !domain.proposalPayloadSchema || !domain.canPropose) {
            return c.json({ error: `Domain "${domainName}" does not accept proposals` }, 403)
        }

        const actorEmail = c.get('email') ?? null
        const isOperator = c.get('role') === 'operator'
        const orgRole = actorEmail ? await store.getUserOrgRole(orgId, actorEmail) : null
        if (!domain.canPropose({ actorEmail, isOperator, orgRole })) {
            return c.json({ error: 'Not permitted to propose in this domain' }, 403)
        }

        const payloadInput = (body as { payload?: unknown }).payload
        const parsed = domain.proposalPayloadSchema.safeParse(payloadInput)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload', issues: parsed.error.issues }, 400)
        }

        const expiresAtRaw = (body as { expiresAt?: unknown }).expiresAt
        const expiresAt = typeof expiresAtRaw === 'number' ? expiresAtRaw : null

        const subjectKey = domain.subjectKey(parsed.data as Record<string, unknown>)

        try {
            const result = await store.upsertApproval({
                namespace,
                orgId,
                domain: domain.name,
                subjectKind: domain.subjectKind,
                subjectKey,
                expiresAt,
                payloadTable: domain.payloadTable,
                payload: parsed.data as Record<string, unknown>,
            })
            return c.json({ ok: true, approval: result.record, payload: result.payload }, 201)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (message.includes('Cannot overwrite decided approval')) {
                return c.json({ error: message }, 409)
            }
            throw err
        }
    })

    app.get('/approvals/:id', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const record = await store.getApproval(namespace, orgId, id)
        if (!record) return c.json({ error: 'Approval not found' }, 404)

        const domain = registry.get(record.domain)
        let payload: unknown = null
        if (domain) {
            payload = await store.getApprovalPayload(namespace, id, domain.payloadTable).catch(() => null)
        }
        return c.json({ approval: record, payload })
    })

    app.post('/approvals/:id/decide', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const record = await store.getApproval(namespace, orgId, id)
        if (!record) return c.json({ error: 'Approval not found' }, 404)

        const domain = registry.get(record.domain)
        if (!domain) {
            return c.json({ error: `Unknown approval domain "${record.domain}"` }, 500)
        }

        const body = await c.req.json().catch(() => null)
        const reason = typeof body?.reason === 'string' ? body.reason : null
        const parsed = domain.actionSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid action payload', issues: parsed.error.issues }, 400)
        }

        try {
            const result = await executeDecide({
                store,
                domain: domain as ApprovalDomain<Record<string, unknown>, { action: string }>,
                namespace,
                approvalId: id,
                actorEmail: c.get('email') ?? null,
                isOperator: c.get('role') === 'operator',
                orgRoleOf: (org, email) => store.getUserOrgRole(org, email),
                action: parsed.data,
                reason,
            })
            return c.json({
                ok: true,
                approval: result.record,
                payload: result.payload,
                audit: result.audit,
                effectsMeta: result.effectsMeta,
                effectsError: result.effectsError,
            })
        } catch (err) {
            if (err instanceof ApprovalForbiddenError) {
                return c.json({ error: err.message }, 403)
            }
            if (err instanceof ApprovalInvalidActionError) {
                return c.json({ error: err.message, issues: err.issues }, 400)
            }
            if (err instanceof ApprovalInvalidTransitionError) {
                return c.json({
                    error: err.message,
                    currentStatus: err.currentStatus,
                    action: err.action,
                }, 409)
            }
            if (err instanceof ApprovalNotFoundError) {
                return c.json({ error: err.message }, 404)
            }
            throw err
        }
    })

    app.get('/approvals/:id/audits', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgAdmin(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const record = await store.getApproval(namespace, orgId, id)
        if (!record) return c.json({ error: 'Approval not found' }, 404)

        const limit = Number(c.req.query('limit') ?? 50)
        const audits = await store.listApprovalAudits({
            namespace,
            orgId,
            approvalId: id,
            limit: Number.isFinite(limit) ? limit : 50,
        })
        return c.json({ audits })
    })

    return app
}
