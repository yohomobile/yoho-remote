import { useCallback, useMemo, useState } from 'react'
import type { IdentityActorMeta } from '@/types/api'
import { parseIdentityActorMeta } from '@/chat/identityAttribution'

export type ActorFilterState = {
    selectedIdentityId: string | null
    setSelectedIdentityId: (id: string | null) => void
    clear: () => void
    matches: (meta: unknown) => boolean
}

function extractActorsFromMeta(meta: unknown): IdentityActorMeta[] {
    if (!meta || typeof meta !== 'object') return []
    const record = meta as Record<string, unknown>
    const result: IdentityActorMeta[] = []
    const primary = parseIdentityActorMeta(record.actor)
    if (primary) result.push(primary)
    if (Array.isArray(record.actors)) {
        for (const raw of record.actors) {
            const parsed = parseIdentityActorMeta(raw)
            if (parsed) result.push(parsed)
        }
    }
    return result
}

export function messageMatchesActor(meta: unknown, identityId: string): boolean {
    const actors = extractActorsFromMeta(meta)
    return actors.some((actor) => actor.identityId === identityId)
}

export function useActorFilter(): ActorFilterState {
    const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null)

    const clear = useCallback(() => {
        setSelectedIdentityId(null)
    }, [])

    const matches = useCallback((meta: unknown) => {
        if (!selectedIdentityId) return true
        return messageMatchesActor(meta, selectedIdentityId)
    }, [selectedIdentityId])

    return useMemo(
        () => ({ selectedIdentityId, setSelectedIdentityId, clear, matches }),
        [selectedIdentityId, clear, matches],
    )
}
