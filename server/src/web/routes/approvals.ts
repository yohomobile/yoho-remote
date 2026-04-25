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
    type ApprovalRecord,
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
        const domainParam = c.req.query('domain')?.trim() || null
        const subjectKey = c.req.query('subjectKey')?.trim() || null
        const limit = Number(c.req.query('limit') ?? 50)
        const status = (statusRaw as ApprovalMasterStatus | null) ?? null
        const safeLimit = Number.isFinite(limit) ? limit : 50

        // Owner-mode list: only run when the caller is asking for "all" or for
        // a domain we own. When the caller filters by a proxy-only domain we
        // skip the SQL entirely.
        const proxyDomains = registry.list().filter((d) => d.proxyAdapter)
        const isProxyDomain = domainParam !== null
            && proxyDomains.some((d) => d.name === domainParam)

        let storeRecords: ApprovalRecord[] = []
        if (!isProxyDomain) {
            storeRecords = await store.listApprovals({
                namespace,
                orgId,
                domain: domainParam,
                status,
                subjectKey,
                limit: safeLimit,
            })
        }

        // Proxy domains: fetch each, but only when the caller didn't pin a
        // different domain. Proxy failures are captured per-domain so one
        // upstream outage doesn't break the whole listing.
        const proxyResults: Array<{ domain: string; records: ApprovalRecord[]; error?: string }> = []
        const proxyTargets = domainParam === null
            ? proxyDomains
            : proxyDomains.filter((d) => d.name === domainParam)
        for (const proxyDomain of proxyTargets) {
            try {
                const adapter = proxyDomain.proxyAdapter!
                const records = await adapter.list({
                    namespace,
                    orgId,
                    status,
                    limit: safeLimit,
                })
                proxyResults.push({ domain: proxyDomain.name, records })
            } catch (err) {
                proxyResults.push({
                    domain: proxyDomain.name,
                    records: [],
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }

        const merged = [
            ...storeRecords,
            ...proxyResults.flatMap((r) => r.records),
        ]
        const proxyErrors = proxyResults
            .filter((r) => r.error)
            .map((r) => ({ domain: r.domain, error: r.error! }))

        return c.json({
            approvals: merged,
            ...(proxyErrors.length > 0 ? { proxyErrors } : {}),
        })
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

        // Try owner-mode first (lookup by id in our DB).
        const record = await store.getApproval(namespace, orgId, id)
        if (record) {
            const domain = registry.get(record.domain)
            let payload: unknown = null
            if (domain && domain.payloadTable) {
                payload = await store.getApprovalPayload(namespace, id, domain.payloadTable).catch(() => null)
            }
            return c.json({ approval: record, payload })
        }

        // Fall back to proxy domains: id may belong to an external system
        // (e.g. yoho-vault skill id). Try each proxy adapter until one knows
        // the id.
        for (const proxyDomain of registry.list()) {
            if (!proxyDomain.proxyAdapter) continue
            try {
                const found = await proxyDomain.proxyAdapter.get({ namespace, orgId, id })
                if (found) return c.json({ approval: found.record, payload: found.payload })
            } catch {
                // try next adapter
            }
        }
        return c.json({ error: 'Approval not found' }, 404)
    })

    app.post('/approvals/:id/decide', async (c) => {
        const orgId = requireOrgId(c)
        if (orgId instanceof Response) return orgId
        const permissionError = await requireOrgMember(c, store, orgId)
        if (permissionError) return permissionError

        const id = c.req.param('id')
        const actorEmail = c.get('email') ?? null
        const isOperator = c.get('role') === 'operator'

        const ownerRecord = await store.getApproval(namespace, orgId, id)
        const body = await c.req.json().catch(() => null)
        const reason = typeof body?.reason === 'string' ? body.reason : null

        // Owner-mode path: id resolves to a row in our DB.
        if (ownerRecord) {
            const domain = registry.get(ownerRecord.domain)
            if (!domain) {
                return c.json({ error: `Unknown approval domain "${ownerRecord.domain}"` }, 500)
            }
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
                    actorEmail,
                    isOperator,
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
                return mapDecideError(c, err)
            }
        }

        // Proxy-mode path: try each proxy adapter to find the id.
        for (const proxyDomain of registry.list()) {
            if (!proxyDomain.proxyAdapter) continue
            const found = await proxyDomain.proxyAdapter.get({ namespace, orgId, id }).catch(() => null)
            if (!found) continue

            const parsed = proxyDomain.actionSchema.safeParse(body)
            if (!parsed.success) {
                return c.json({ error: 'Invalid action payload', issues: parsed.error.issues }, 400)
            }

            // Permission gate (proxy domains still use the same permission hook).
            const orgRole = actorEmail ? await store.getUserOrgRole(orgId, actorEmail) : null
            const role = proxyDomain.permission({
                actorEmail,
                isOperator,
                orgRole,
                record: found.record,
                payload: found.payload as Record<string, unknown>,
            })
            if (!role) {
                return c.json({ error: 'Not permitted to decide this approval' }, 403)
            }

            try {
                const result = await proxyDomain.proxyAdapter.decide({
                    namespace,
                    orgId,
                    id,
                    action: parsed.data,
                    reason,
                    actorEmail,
                    isOperator,
                })
                return c.json({
                    ok: true,
                    approval: result.record,
                    payload: result.payload,
                    audit: null, // proxy mode: upstream system owns audit history
                    effectsMeta: result.effectsMeta,
                    effectsError: result.effectsError,
                })
            } catch (err) {
                return mapDecideError(c, err)
            }
        }

        return c.json({ error: 'Approval not found' }, 404)

        function mapDecideError(_c: Context<WebAppEnv>, err: unknown): Response {
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
