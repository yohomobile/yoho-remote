import { z } from 'zod'
import type { ApprovalDomain } from '../types'

// Team-shared memory approval domain. Approves/rejects/supersedes candidates
// proposed by org members for the team knowledge base. Admin-only decisions.

export interface TeamMemoryApprovalPayload extends Record<string, unknown> {
    proposed_by_person_id: string | null
    proposed_by_email: string | null
    scope: string
    content: string
    source: string | null
    session_id: string | null
    memory_ref: string | null
}

export type TeamMemoryApprovalAction =
    | { action: 'approve'; memoryRef?: string | null; reason?: string | null }
    | { action: 'reject'; reason?: string | null }
    | { action: 'supersede'; memoryRef?: string | null; reason?: string | null }
    | { action: 'expire'; reason?: string | null }

const proposalPayloadSchema = z.object({
    proposed_by_person_id: z.string().nullable().optional().transform((v) => v ?? null),
    proposed_by_email: z.string().email().nullable().optional().transform((v) => v ?? null),
    scope: z.string().min(1).max(100),
    content: z.string().min(1).max(8000),
    source: z.string().max(200).nullable().optional().transform((v) => v ?? null),
    session_id: z.string().max(200).nullable().optional().transform((v) => v ?? null),
    memory_ref: z.string().max(500).nullable().optional().transform((v) => v ?? null),
}) as unknown as import('../types').ApprovalActionValidator<TeamMemoryApprovalPayload>

const actionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('approve'),
        memoryRef: z.string().max(500).nullable().optional(),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('reject'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('supersede'),
        memoryRef: z.string().max(500).nullable().optional(),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('expire'),
        reason: z.string().max(1000).nullable().optional(),
    }),
])

export const teamMemoryDomain: ApprovalDomain<
    TeamMemoryApprovalPayload,
    TeamMemoryApprovalAction
> = {
    name: 'team_memory',
    subjectKind: 'memory_proposal',
    payloadTable: 'approval_payload_team_memory',
    actionSchema,
    proposalPayloadSchema,

    canPropose({ isOperator, orgRole }) {
        // Any authenticated org member can propose; approval still requires admin.
        return isOperator || orgRole !== null
    },

    subjectKey(payload) {
        // Supersede flows dedupe on memory_ref; fresh proposals use a content
        // digest so re-submitting the same text lands on the same row.
        if (payload.memory_ref) return `tm:ref:${payload.memory_ref}`
        return `tm:content:${simpleHash(payload.content)}`
    },

    nextStatus(current, action) {
        if (current !== 'pending') return null
        switch (action.action) {
            case 'approve': return 'approved'
            case 'reject': return 'rejected'
            case 'supersede': return 'approved'
            case 'expire': return 'expired'
        }
    },

    permission({ isOperator, orgRole }) {
        if (isOperator) return 'operator'
        if (orgRole === 'owner' || orgRole === 'admin') return 'admin'
        return null
    },

    async effects({ action }) {
        if (action.action === 'approve' || action.action === 'supersede') {
            const ref = action.memoryRef ?? null
            return { payloadPatch: { memory_ref: ref } }
        }
        return {}
    },
}

function simpleHash(input: string): string {
    // FNV-1a 64-bit lite; we only need stable-for-the-same-input, not crypto.
    let hash = 0xcbf29ce484222325n
    const prime = 0x100000001b3n
    const bytes = new TextEncoder().encode(input)
    for (const b of bytes) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(b)) * prime)
    }
    return hash.toString(16)
}
