import { z } from 'zod'
import type { ApprovalDomain } from '../types'

// Memory conflict approval domain. A pg-boss worker detects conflicting
// observations/memories; admins resolve by choosing a resolution strategy.
// Supports the rare reverse transition (resolved → pending via `reopen`).

export interface MemoryConflictApprovalPayload extends Record<string, unknown> {
    scope: string
    summary: string
    entries: unknown[]
    evidence: unknown | null
    detector_version: string
    resolution: string | null
}

export type MemoryConflictResolution =
    | 'keep_a'
    | 'keep_b'
    | 'supersede'
    | 'discard_all'
    | 'mark_expired'

export type MemoryConflictApprovalAction =
    | { action: 'resolve'; resolution: MemoryConflictResolution; reason?: string | null }
    | { action: 'dismiss'; reason?: string | null }
    | { action: 'reopen'; reason?: string | null }

const resolutionSchema = z.enum(['keep_a', 'keep_b', 'supersede', 'discard_all', 'mark_expired'])

const actionSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('resolve'),
        resolution: resolutionSchema,
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('dismiss'),
        reason: z.string().max(1000).nullable().optional(),
    }),
    z.object({
        action: z.literal('reopen'),
        reason: z.string().max(1000).nullable().optional(),
    }),
])

export const memoryConflictDomain: ApprovalDomain<
    MemoryConflictApprovalPayload,
    MemoryConflictApprovalAction
> = {
    name: 'memory_conflict',
    subjectKind: 'conflict_subject',
    payloadTable: 'approval_payload_memory_conflict',
    actionSchema,

    subjectKey(payload) {
        // Memory conflict subject keys are set by the detector (e.g.
        // `obs:<personId>:<hypothesisKey>` or `mem:<memoryRef>`); they live on
        // the approval master row. The payload alone doesn't know the key, so
        // this helper is a placeholder used only by migration tooling.
        return `mc:${payload.scope}`
    },

    nextStatus(current, action) {
        switch (action.action) {
            case 'resolve':
                return current === 'pending' ? 'approved' : null
            case 'dismiss':
                return current === 'pending' ? 'dismissed' : null
            case 'reopen':
                return current === 'pending' ? null : 'pending'
        }
    },

    permission({ isOperator, orgRole }) {
        if (isOperator) return 'operator'
        if (orgRole === 'owner' || orgRole === 'admin') return 'admin'
        return null
    },

    async effects({ action }) {
        if (action.action === 'resolve') {
            return { payloadPatch: { resolution: action.resolution } }
        }
        if (action.action === 'reopen') {
            return { payloadPatch: { resolution: null } }
        }
        return {}
    },
}
