import type { IdentityAccountType, IdentityActorMeta, IdentityActorResolution, IdentityChannel } from '@/types/api'

type ActorRecord = Record<string, unknown>

const CHANNEL_LABELS: Record<IdentityChannel, string> = {
    keycloak: 'Keycloak',
    feishu: 'Feishu',
    wecom: 'WeCom',
    'custom-im': 'IM',
    telegram: 'Telegram',
    cli: 'CLI',
}

const IDENTITY_CHANNELS: ReadonlySet<string> = new Set(['keycloak', 'feishu', 'wecom', 'custom-im', 'telegram', 'cli'])
const IDENTITY_RESOLUTIONS: ReadonlySet<string> = new Set(['auto_verified', 'admin_verified', 'pending', 'rejected', 'detached', 'unresolved', 'shared'])
const IDENTITY_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['human', 'shared', 'service', 'bot', 'unknown'])

export type MessageActorAttribution = {
    primaryActor: IdentityActorMeta | null
    actors: IdentityActorMeta[]
    label: string
    detail: string
    title: string
}

function isRecord(value: unknown): value is ActorRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asNullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asIdentityChannel(value: unknown): IdentityChannel | null {
    const text = asString(value)
    return text && IDENTITY_CHANNELS.has(text) ? text as IdentityChannel : null
}

function asIdentityResolution(value: unknown): IdentityActorResolution | null {
    const text = asString(value)
    return text && IDENTITY_RESOLUTIONS.has(text) ? text as IdentityActorResolution : null
}

function asIdentityAccountType(value: unknown): IdentityAccountType | null {
    const text = asString(value)
    return text && IDENTITY_ACCOUNT_TYPES.has(text) ? text as IdentityAccountType : null
}

export function parseIdentityActorMeta(value: unknown): IdentityActorMeta | null {
    if (!isRecord(value)) return null

    const identityId = asString(value.identityId)
    const channel = asIdentityChannel(value.channel)
    const resolution = asIdentityResolution(value.resolution)
    const externalId = asString(value.externalId)
    const accountType = asIdentityAccountType(value.accountType)

    if (!identityId || !channel || !resolution || !externalId || !accountType) {
        return null
    }

    return {
        identityId,
        personId: asNullableString(value.personId),
        channel,
        resolution,
        displayName: asNullableString(value.displayName),
        email: asNullableString(value.email),
        externalId,
        accountType,
    }
}

function actorKey(actor: IdentityActorMeta): string {
    return actor.identityId || `${actor.channel}:${actor.externalId}`
}

function actorName(actor: IdentityActorMeta): string {
    return actor.displayName || actor.email || actor.externalId
}

function dedupeActors(actors: IdentityActorMeta[]): IdentityActorMeta[] {
    const seen = new Set<string>()
    const result: IdentityActorMeta[] = []
    for (const actor of actors) {
        const key = actorKey(actor)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(actor)
    }
    return result
}

function formatActorLabel(actors: IdentityActorMeta[]): string {
    const names = actors.map(actorName)
    if (names.length <= 2) {
        return names.join(', ')
    }
    return `${names.slice(0, 2).join(', ')} + ${names.length - 2}`
}

function formatActorDetail(actors: IdentityActorMeta[]): string {
    const channels = Array.from(new Set(actors.map((actor) => CHANNEL_LABELS[actor.channel] ?? actor.channel)))
    const channelText = channels.length <= 2 ? channels.join(', ') : `${channels.slice(0, 2).join(', ')} + ${channels.length - 2}`
    return actors.length > 1 ? `${actors.length} speakers · ${channelText}` : channelText
}

export function getMessageActorAttribution(meta: unknown): MessageActorAttribution | null {
    if (!isRecord(meta)) return null

    const primaryActor = parseIdentityActorMeta(meta.actor)
    const actorList = Array.isArray(meta.actors)
        ? meta.actors.map(parseIdentityActorMeta).filter((actor): actor is IdentityActorMeta => actor !== null)
        : []
    const actors = dedupeActors([
        ...actorList,
        ...(primaryActor ? [primaryActor] : []),
    ])

    if (actors.length === 0) {
        return null
    }

    const title = actors
        .map((actor) => `${actorName(actor)} · ${CHANNEL_LABELS[actor.channel] ?? actor.channel} · ${actor.resolution}`)
        .join('\n')

    return {
        primaryActor,
        actors,
        label: formatActorLabel(actors),
        detail: formatActorDetail(actors),
        title,
    }
}
