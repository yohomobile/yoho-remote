import type { ChatBlock, UserTextBlock } from '@/chat/types'
import type { BrainMessageDelivery, BrainMessageDeliveryPhase, Session } from '@/types/api'

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function isBrainMessageDeliveryPhase(value: unknown): value is BrainMessageDeliveryPhase {
    return value === 'queued'
        || value === 'pending_consume'
        || value === 'consuming'
        || value === 'merged'
}

export function readBrainMessageDelivery(meta: unknown): BrainMessageDelivery | undefined {
    if (!isRecord(meta)) {
        return undefined
    }

    const rawBrainDelivery = isRecord(meta.brainDelivery) ? meta.brainDelivery : null
    if (rawBrainDelivery) {
        const phase = rawBrainDelivery.phase
        const acceptedAt = rawBrainDelivery.acceptedAt
        if (isBrainMessageDeliveryPhase(phase) && typeof acceptedAt === 'number' && Number.isFinite(acceptedAt)) {
            return {
                phase,
                acceptedAt,
            }
        }
    }

    const rawBrainSessionQueue = isRecord(meta.brainSessionQueue) ? meta.brainSessionQueue : null
    if (!rawBrainSessionQueue) {
        return undefined
    }

    const delivery = rawBrainSessionQueue.delivery
    const acceptedAt = rawBrainSessionQueue.acceptedAt
    if (
        delivery !== 'queued'
        && delivery !== 'delivered'
    ) {
        return undefined
    }
    if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) {
        return undefined
    }

    // `delivered` only means the message reached the brain session inbox.
    // Whether it has started consuming must be inferred from later assistant boundaries.
    return {
        phase: delivery === 'queued' ? 'queued' : 'pending_consume',
        acceptedAt,
    }
}

function isConsumptionBoundary(block: ChatBlock): boolean {
    if (block.kind === 'agent-text' || block.kind === 'agent-reasoning' || block.kind === 'tool-call') {
        return true
    }
    return block.kind === 'agent-event' && block.event.type === 'brain-child-callback'
}

function countConsumptionBoundariesAfter(
    index: number,
    blocks: readonly ChatBlock[],
): number {
    let boundaries = 0
    for (let i = index + 1; i < blocks.length; i += 1) {
        const next = blocks[i]
        if (!next) continue
        if (next.kind === 'user-text') {
            break
        }
        if (isConsumptionBoundary(next)) {
            boundaries += 1
        }
    }
    return boundaries
}

export function deriveBrainMessageDelivery(
    block: UserTextBlock,
    index: number,
    blocks: readonly ChatBlock[],
    session?: Session,
): BrainMessageDelivery | undefined {
    const raw = readBrainMessageDelivery(block.meta)
    if (!raw) {
        return undefined
    }

    // Keep the recorded delivery phase stable and only promote it when replayed
    // assistant-side consumption boundaries prove that the message has progressed.
    const boundaries = countConsumptionBoundariesAfter(index, blocks)
    const requiredBoundaries = raw.phase === 'pending_consume' ? 2 : 1
    if (boundaries >= requiredBoundaries) {
        return {
            ...raw,
            phase: 'merged',
        }
    }

    if (raw.phase === 'pending_consume') {
        if (boundaries >= 1) {
            return {
                ...raw,
                phase: 'consuming',
            }
        }
        return {
            ...raw,
            phase: 'pending_consume',
        }
    }

    return raw
}
