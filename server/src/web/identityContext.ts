import type { ResolvedActorContext } from '../store'

export type WebActorMeta = {
    identityId: string
    personId: string | null
    channel: ResolvedActorContext['channel']
    resolution: ResolvedActorContext['resolution']
    displayName: string | null
    email: string | null
    externalId: string
    accountType: ResolvedActorContext['accountType']
}

export function toWebActorMeta(actor: ResolvedActorContext | null | undefined): WebActorMeta | null {
    if (!actor) {
        return null
    }
    return {
        identityId: actor.identityId,
        personId: actor.personId,
        channel: actor.channel,
        resolution: actor.resolution,
        displayName: actor.displayName,
        email: actor.email,
        externalId: actor.externalId,
        accountType: actor.accountType,
    }
}

export function buildSessionIdentityContextPatch(actor: ResolvedActorContext | null | undefined): Record<string, unknown> | null {
    const defaultActor = toWebActorMeta(actor)
    if (!defaultActor) {
        return null
    }
    return {
        identityContext: {
            version: 1,
            mode: defaultActor.resolution === 'shared' ? 'multi-actor' : 'single-actor',
            defaultActor,
        },
    }
}

export function mergeMessageMeta(
    actor: ResolvedActorContext | null | undefined,
    baseMeta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const actorMeta = toWebActorMeta(actor)
    const meta = {
        ...(baseMeta ?? {}),
        ...(actorMeta ? { actor: actorMeta } : {}),
    }
    return Object.keys(meta).length > 0 ? meta : undefined
}
