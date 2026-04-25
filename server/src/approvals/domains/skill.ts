import { z } from 'zod'
import type {
    ApprovalDomain,
    ApprovalProxyAdapter,
    ApprovalRecord,
} from '../types'
import { getVaultClient, type VaultSkillSummary } from '../vaultClient'

// Skill approval domain — proxy mode. Candidate skills live in yoho-vault's
// `skills/` dir (with `<!-- status: candidate -->`); workers auto-create them
// via `skill_save`. Approvers in yoho-remote review and either:
//   - approve  → vault.skill_promote(id) → skill becomes active globally
//   - archive  → vault.skill_archive(id) → skill kept on disk but hidden
//   - delete   → vault.skill_delete(id) → file removed
//
// We do not store any rows in `approvals` for skill candidates: the source of
// truth is yoho-vault, and audit history lives in vault's git log.

export type SkillApprovalAction =
    | { action: 'approve'; reason?: string | null }
    | { action: 'archive'; reason?: string | null }
    | { action: 'delete'; reason?: string | null; allowActive?: boolean }
    | { action: 'reject'; reason?: string | null } // alias for archive (UX consistency)

const actionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('approve'), reason: z.string().max(1000).nullable().optional() }),
    z.object({ action: z.literal('archive'), reason: z.string().max(1000).nullable().optional() }),
    z.object({
        action: z.literal('delete'),
        reason: z.string().max(1000).nullable().optional(),
        allowActive: z.boolean().optional(),
    }),
    z.object({ action: z.literal('reject'), reason: z.string().max(1000).nullable().optional() }),
])

function makeRecord(args: {
    namespace: string
    orgId: string
    skill: VaultSkillSummary
    /** Status to surface to the caller — defaults to 'pending' for candidates. */
    status?: ApprovalRecord['status']
}): ApprovalRecord {
    const status = args.status ?? mapVaultStatus(args.skill.status)
    return {
        id: args.skill.id,
        namespace: args.namespace,
        orgId: args.orgId,
        domain: 'skill',
        subjectKind: 'vault_skill',
        subjectKey: `skill:${args.skill.id}`,
        status,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        expiresAt: null,
        // Vault doesn't expose timestamps via skill_list; use 0 so the UI
        // doesn't render a misleading time. Skill detail will fetch real meta
        // later if we surface it.
        createdAt: 0,
        updatedAt: 0,
    }
}

function mapVaultStatus(status: VaultSkillSummary['status']): ApprovalRecord['status'] {
    switch (status) {
        case 'candidate': return 'pending'
        case 'active': return 'approved'
        case 'archived': return 'rejected'
        case 'deprecated': return 'expired'
        default: return 'pending'
    }
}

const proxyAdapter: ApprovalProxyAdapter<SkillApprovalAction> = {
    async list(filter) {
        const client = getVaultClient()
        if (!client) return []
        const status = filter.status === 'pending'
            ? 'candidate'
            : filter.status === 'approved'
                ? 'active'
                : filter.status === 'rejected'
                    ? 'archived'
                    : filter.status === 'expired'
                        ? 'deprecated'
                        : 'all'
        const resp = await client.listSkills({ status })
        return resp.skills
            .slice(0, filter.limit)
            .map((skill) => makeRecord({
                namespace: filter.namespace,
                orgId: filter.orgId,
                skill,
            }))
    },

    async get({ namespace, orgId, id }) {
        const client = getVaultClient()
        if (!client) return null
        try {
            const skill = await client.getSkill(id)
            return {
                record: makeRecord({ namespace, orgId, skill }),
                payload: skill,
            }
        } catch (err) {
            if (err instanceof Error && /not found/i.test(err.message)) return null
            throw err
        }
    },

    async decide({ namespace, orgId, id, action }) {
        const client = getVaultClient()
        if (!client) {
            throw new Error('yoho-vault client not configured (YOHO_MEMORY_URL/YOHO_MEMORY_HTTP_AUTH_TOKEN)')
        }
        let result: { status: string; message: string }
        let effectsMeta: Record<string, unknown> | null = null
        let effectsError: string | null = null
        try {
            if (action.action === 'approve') {
                const r = await client.promoteSkill(id)
                result = r
                effectsMeta = { promoted: true, vaultStatus: r.status }
            } else if (action.action === 'archive' || action.action === 'reject') {
                const r = await client.archiveSkill(id)
                result = r
                effectsMeta = { archived: true, vaultStatus: r.status }
            } else if (action.action === 'delete') {
                const r = await client.deleteSkill(id, action.allowActive ?? false)
                result = r
                effectsMeta = { deleted: true, vaultStatus: r.status }
            } else {
                throw new Error(`Unhandled skill action: ${(action as { action: string }).action}`)
            }
        } catch (err) {
            effectsError = err instanceof Error ? err.message : String(err)
            throw err // upstream will surface via 5xx; effectsError is for the dual-path detection
        }

        // Re-fetch the skill to return the current (post-mutation) record.
        let postRecord: ApprovalRecord
        let postPayload: unknown = null
        try {
            const refreshed = await client.getSkill(id)
            postRecord = makeRecord({ namespace, orgId, skill: refreshed })
            postPayload = refreshed
        } catch {
            // After delete the skill is gone — synthesise a record so the
            // route layer can still respond cleanly.
            postRecord = {
                id,
                namespace,
                orgId,
                domain: 'skill',
                subjectKind: 'vault_skill',
                subjectKey: `skill:${id}`,
                status: action.action === 'delete' ? 'dismissed' : 'approved',
                decidedBy: null,
                decidedAt: Date.now(),
                decisionReason: null,
                expiresAt: null,
                createdAt: 0,
                updatedAt: Date.now(),
            }
        }

        return {
            record: postRecord,
            payload: postPayload,
            effectsMeta: { ...(effectsMeta ?? {}), message: result.message },
            effectsError,
        }
    },
}

export const skillDomain: ApprovalDomain<Record<string, unknown>, SkillApprovalAction> = {
    name: 'skill',
    subjectKind: 'vault_skill',
    payloadTable: '', // proxy mode — no payload table
    actionSchema,
    proxyAdapter,

    subjectKey(payload) {
        return `skill:${(payload as { id?: string }).id ?? 'unknown'}`
    },

    nextStatus(_current, action) {
        switch (action.action) {
            case 'approve': return 'approved'
            case 'archive':
            case 'reject': return 'rejected'
            case 'delete': return 'dismissed'
        }
    },

    permission({ isOperator, orgRole }) {
        // Promoting a skill activates it for everyone in the org → admin only.
        if (isOperator) return 'operator'
        if (orgRole === 'owner' || orgRole === 'admin') return 'admin'
        return null
    },
}
