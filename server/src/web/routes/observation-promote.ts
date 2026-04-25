import type { IStore } from '../../store'
import type {
    CommunicationPlanExplanationDepth,
    CommunicationPlanFormality,
    CommunicationPlanLength,
    CommunicationPlanPreferences,
    StoredObservationCandidate,
} from '../../store/types'

// Phase 3F auto-promotion helpers:
// when an observation candidate is confirmed, derive a communicationPlan
// preferences patch from `suggestedPatch` and upsert the plan automatically.
// Hard rules:
// - Only accept fields that match the CommunicationPlanPreferences contract.
// - Skip auto-promotion entirely if there is no subjectPersonId.
// - Never throw — auto-promotion is best-effort. Errors are reported back
//   to the caller as `null` so the manual flow stays available.

const LENGTH_VALUES: ReadonlySet<CommunicationPlanLength> = new Set(['concise', 'detailed', 'default'])
const DEPTH_VALUES: ReadonlySet<CommunicationPlanExplanationDepth> = new Set(['minimal', 'moderate', 'thorough'])
const FORMALITY_VALUES: ReadonlySet<CommunicationPlanFormality> = new Set(['casual', 'neutral', 'formal'])

export function extractCommunicationPlanPreferences(
    patch: Record<string, unknown> | null | undefined,
): CommunicationPlanPreferences | null {
    if (!patch || typeof patch !== 'object') return null

    const out: CommunicationPlanPreferences = {}
    let hasField = false

    if (typeof patch.tone === 'string' && patch.tone.trim().length > 0) {
        out.tone = patch.tone.trim().slice(0, 200)
        hasField = true
    }
    if (typeof patch.length === 'string' && LENGTH_VALUES.has(patch.length as CommunicationPlanLength)) {
        out.length = patch.length as CommunicationPlanLength
        hasField = true
    }
    if (
        typeof patch.explanationDepth === 'string' &&
        DEPTH_VALUES.has(patch.explanationDepth as CommunicationPlanExplanationDepth)
    ) {
        out.explanationDepth = patch.explanationDepth as CommunicationPlanExplanationDepth
        hasField = true
    }
    if (
        typeof patch.formality === 'string' &&
        FORMALITY_VALUES.has(patch.formality as CommunicationPlanFormality)
    ) {
        out.formality = patch.formality as CommunicationPlanFormality
        hasField = true
    }
    if (typeof patch.customInstructions === 'string' && patch.customInstructions.trim().length > 0) {
        out.customInstructions = patch.customInstructions.trim().slice(0, 4000)
        hasField = true
    }

    return hasField ? out : null
}

export type AutoPromoteInput = {
    store: IStore
    orgId: string
    candidate: StoredObservationCandidate
    actorEmail: string | null
    decisionReason: string | null
}

export type AutoPromoteResult = {
    promotedCommunicationPlanId: string | null
    autoPromoted: boolean
    reason?: 'no_person_id' | 'no_promotable_fields' | 'upsert_failed'
}

export async function tryAutoPromoteObservation(
    input: AutoPromoteInput,
): Promise<AutoPromoteResult> {
    const { store, orgId, candidate, actorEmail, decisionReason } = input
    if (!candidate.subjectPersonId) {
        return { promotedCommunicationPlanId: null, autoPromoted: false, reason: 'no_person_id' }
    }

    const preferences = extractCommunicationPlanPreferences(candidate.suggestedPatch ?? null)
    if (!preferences) {
        return { promotedCommunicationPlanId: null, autoPromoted: false, reason: 'no_promotable_fields' }
    }

    const upsertReason = [
        `auto-promoted from observation ${candidate.id}`,
        decisionReason?.trim() || null,
    ]
        .filter(Boolean)
        .join(': ')

    try {
        const plan = await store.upsertCommunicationPlan({
            namespace: orgId,
            orgId,
            personId: candidate.subjectPersonId,
            preferences,
            editedBy: actorEmail,
            reason: upsertReason,
        })
        return { promotedCommunicationPlanId: plan.id, autoPromoted: true }
    } catch (err) {
        console.error('[observation auto-promote] upsert failed:', err)
        return { promotedCommunicationPlanId: null, autoPromoted: false, reason: 'upsert_failed' }
    }
}
