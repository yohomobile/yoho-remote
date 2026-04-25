import { z } from 'zod'
import type { ApprovalDomain } from '../types'

// Identity graph candidate approval domain. Merges an `identity` (an IM user
// row) with a `person` (the cross-channel subject). Admin-only; operator can
// bypass. The `create_person_and_confirm` action also needs to create a new
// person — that side-effect runs inside the same txn via `effects`.

export interface IdentityApprovalPayload extends Record<string, unknown> {
    identity_id: string
    candidate_person_id: string | null
    score: number
    auto_action: string
    risk_flags: unknown[]
    evidence: unknown[]
    matcher_version: string
    suppress_until: number | null
}

export type IdentityApprovalAction =
    | {
          action: 'confirm_existing_person'
          personId: string
          reason?: string | null
      }
    | {
          action: 'create_person_and_confirm'
          createPerson: {
              canonicalName?: string | null
              canonicalEmail?: string | null
              description?: string | null
          }
          reason?: string | null
      }
    | { action: 'mark_shared'; reason?: string | null }
    | { action: 'reject'; reason?: string | null }

const actionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('confirm_existing_person'),
        personId: z.string().min(1),
        reason: z.string().max(1000).optional(),
    }),
    z.object({
        action: z.literal('create_person_and_confirm'),
        createPerson: z.object({
            canonicalName: z.string().max(200).nullable().optional(),
            canonicalEmail: z.string().max(320).nullable().optional(),
            description: z.string().max(1000).nullable().optional(),
        }),
        reason: z.string().max(1000).optional(),
    }),
    z.object({
        action: z.literal('mark_shared'),
        reason: z.string().max(1000).optional(),
    }),
    z.object({
        action: z.literal('reject'),
        reason: z.string().max(1000).optional(),
    }),
])

export const identityDomain: ApprovalDomain<
    IdentityApprovalPayload,
    IdentityApprovalAction
> = {
    name: 'identity',
    subjectKind: 'identity_candidate',
    payloadTable: 'approval_payload_identity',
    actionSchema,

    subjectKey(payload) {
        return `id:${payload.identity_id}:${payload.candidate_person_id ?? 'new'}`
    },

    nextStatus(current, action) {
        if (current !== 'pending') return null
        switch (action.action) {
            case 'confirm_existing_person': return 'approved'
            case 'create_person_and_confirm': return 'approved'
            case 'mark_shared': return 'dismissed'
            case 'reject': return 'rejected'
        }
    },

    permission({ isOperator, orgRole }) {
        if (isOperator) return 'operator'
        if (orgRole === 'owner' || orgRole === 'admin') return 'admin'
        return null
    },

    async effects({ action, payload, record, query }) {
        if (action.action === 'confirm_existing_person') {
            await linkIdentityToPerson({
                query,
                identityId: payload.identity_id,
                personId: action.personId,
                orgId: record.orgId,
                namespace: record.namespace,
            })
            return {
                payloadPatch: { candidate_person_id: action.personId },
                effectsMeta: { linkedPersonId: action.personId },
            }
        }
        if (action.action === 'create_person_and_confirm') {
            const personId = await createPerson({
                query,
                orgId: record.orgId,
                namespace: record.namespace,
                canonicalName: action.createPerson.canonicalName ?? null,
                canonicalEmail: action.createPerson.canonicalEmail ?? null,
                description: action.createPerson.description ?? null,
            })
            await linkIdentityToPerson({
                query,
                identityId: payload.identity_id,
                personId,
                orgId: record.orgId,
                namespace: record.namespace,
            })
            return {
                payloadPatch: { candidate_person_id: personId },
                effectsMeta: { createdPersonId: personId, linkedPersonId: personId },
            }
        }
        return {}
    },
}

async function createPerson(args: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>
    orgId: string
    namespace: string
    canonicalName: string | null
    canonicalEmail: string | null
    description: string | null
}): Promise<string> {
    const id = `person_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const now = Date.now()
    await args.query(
        `INSERT INTO persons
         (id, namespace, org_id, canonical_name, canonical_email, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [id, args.namespace, args.orgId, args.canonicalName, args.canonicalEmail, args.description, now],
    )
    return id
}

async function linkIdentityToPerson(args: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>
    identityId: string
    personId: string
    orgId: string
    namespace: string
}): Promise<void> {
    const now = Date.now()
    await args.query(
        `INSERT INTO person_identity_links
         (id, namespace, org_id, identity_id, person_id, created_at, created_by)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, NULL)
         ON CONFLICT (identity_id) DO UPDATE
         SET person_id = EXCLUDED.person_id, created_at = EXCLUDED.created_at`,
        [args.namespace, args.orgId, args.identityId, args.personId, now],
    )
}
