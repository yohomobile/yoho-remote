import { z } from 'zod'
import type { ApprovalDomain, ApprovalTxnQuery } from '../types'

// Observation hypothesis approval domain. The K1 detector proposes behavioral
// hypotheses about a person; confirming promotes them to communicationPlan
// preferences via the effects hook. The subject of the observation (by email)
// can decide, or an org admin. Operator bypasses.

export interface ObservationApprovalPayload extends Record<string, unknown> {
    subject_person_id: string | null
    subject_email: string | null
    hypothesis_key: string
    summary: string
    detail: string | null
    detector_version: string
    confidence: number | null
    signals: unknown[]
    suggested_patch: unknown | null
    promoted_communication_plan_id: string | null
}

export type ObservationApprovalAction =
    | {
          action: 'confirm'
          promotedCommunicationPlanId?: string | null
          reason?: string | null
      }
    | { action: 'reject'; reason?: string | null }
    | { action: 'dismiss'; reason?: string | null }
    | { action: 'expire'; reason?: string | null }

const actionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('confirm'),
        promotedCommunicationPlanId: z.string().max(200).nullable().optional(),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('reject'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('dismiss'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('expire'),
        reason: z.string().max(1000).nullable().optional(),
    }),
])

const COMMUNICATION_PLAN_PREFERENCE_KEYS = [
    'length',
    'explanationDepth',
    'tone',
    'formality',
    'responseStyle',
] as const

export const observationDomain: ApprovalDomain<
    ObservationApprovalPayload,
    ObservationApprovalAction
> = {
    name: 'observation',
    subjectKind: 'person_hypothesis',
    payloadTable: 'approval_payload_observation',
    actionSchema,

    subjectKey(payload) {
        const subject = payload.subject_person_id || payload.subject_email || 'unknown'
        return `obs:${subject}:${payload.hypothesis_key}`
    },

    nextStatus(current, action) {
        if (current !== 'pending') return null
        switch (action.action) {
            case 'confirm': return 'approved'
            case 'reject': return 'rejected'
            case 'dismiss': return 'dismissed'
            case 'expire': return 'expired'
        }
    },

    permission({ actorEmail, isOperator, orgRole, payload }) {
        if (isOperator) return 'operator'
        if (orgRole === 'owner' || orgRole === 'admin') return 'admin'
        if (actorEmail && payload.subject_email === actorEmail) return 'subject'
        return null
    },

    async effects({ action, payload, record, query }) {
        if (action.action !== 'confirm') return {}
        const manualId = action.promotedCommunicationPlanId ?? null
        if (manualId) {
            return { payloadPatch: { promoted_communication_plan_id: manualId } }
        }
        // Auto-promote: derive whitelisted preferences and upsert a
        // communication_plan row inside the same txn. Best-effort — any
        // failure is caught by the executor and surfaced as effectsError.
        const personId = payload.subject_person_id
        if (!personId) return {}
        const patch = extractCommunicationPlanPreferences(payload.suggested_patch)
        if (!patch) return {}

        const planId = await upsertCommunicationPlan({
            query,
            orgId: record.orgId,
            namespace: record.namespace,
            personId,
            preferences: patch,
        })
        return {
            payloadPatch: { promoted_communication_plan_id: planId },
            effectsMeta: { autoPromoted: true, communicationPlanId: planId },
        }
    },
}

function extractCommunicationPlanPreferences(patch: unknown): Record<string, unknown> | null {
    if (!patch || typeof patch !== 'object') return null
    const source = patch as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of COMMUNICATION_PLAN_PREFERENCE_KEYS) {
        if (key in source) out[key] = source[key]
    }
    return Object.keys(out).length > 0 ? out : null
}

async function upsertCommunicationPlan(args: {
    query: ApprovalTxnQuery
    orgId: string
    namespace: string
    personId: string
    preferences: Record<string, unknown>
}): Promise<string> {
    const existing = await args.query(
        `SELECT id, preferences FROM communication_plans
         WHERE namespace = $1 AND COALESCE(org_id, '') = COALESCE($2, '') AND person_id = $3
         LIMIT 1`,
        [args.namespace, args.orgId, args.personId],
    )
    const now = Date.now()
    if (existing.rows.length > 0) {
        const row = existing.rows[0]
        const merged = {
            ...(typeof row.preferences === 'object' && row.preferences !== null
                ? (row.preferences as Record<string, unknown>)
                : {}),
            ...args.preferences,
        }
        await args.query(
            `UPDATE communication_plans
             SET preferences = $1, updated_at = $2, version = version + 1
             WHERE id = $3`,
            [JSON.stringify(merged), now, row.id],
        )
        return row.id as string
    }
    const id = `cp_${now}_${Math.random().toString(36).slice(2, 10)}`
    await args.query(
        `INSERT INTO communication_plans
         (id, namespace, org_id, person_id, preferences, enabled, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, 1, $6, $6)`,
        [id, args.namespace, args.orgId, args.personId, JSON.stringify(args.preferences), now],
    )
    return id
}
