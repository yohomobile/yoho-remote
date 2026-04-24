import type { IdentityActorMeta, IdentityChannel } from '@/types/api'

const CHANNEL_LABELS: Record<IdentityChannel, string> = {
    keycloak: 'Keycloak',
    feishu: 'Feishu',
    wecom: 'WeCom',
    'custom-im': 'IM',
    cli: 'CLI',
}

function actorShortName(actor: IdentityActorMeta): string {
    const source = actor.displayName || actor.email || actor.externalId
    if (!source) return '?'
    const trimmed = source.trim()
    if (trimmed.includes('@')) return trimmed.split('@')[0] ?? trimmed
    return trimmed
}

function actorInitial(actor: IdentityActorMeta): string {
    const name = actorShortName(actor)
    return name ? name[0]?.toUpperCase() ?? '?' : '?'
}

function actorTitle(actor: IdentityActorMeta): string {
    const parts = [
        actorShortName(actor),
        CHANNEL_LABELS[actor.channel] ?? actor.channel,
        actor.resolution,
    ]
    return parts.filter(Boolean).join(' · ')
}

export function ParticipantsBadge(props: { actors: IdentityActorMeta[]; maxVisible?: number }) {
    const actors = props.actors
    if (!actors || actors.length === 0) return null

    const maxVisible = props.maxVisible ?? 3
    const visible = actors.slice(0, maxVisible)
    const overflow = actors.length - visible.length

    return (
        <div className="flex items-center gap-1" data-testid="participants-badge">
            <div className="flex -space-x-1">
                {visible.map((actor) => (
                    <span
                        key={actor.identityId}
                        title={actorTitle(actor)}
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--app-bg)] bg-[var(--app-secondary-bg)] text-[9px] font-semibold text-[var(--app-fg)]"
                    >
                        {actorInitial(actor)}
                    </span>
                ))}
            </div>
            {overflow > 0 ? (
                <span className="text-[10px] text-[var(--app-hint)]" data-testid="participants-overflow">
                    +{overflow}
                </span>
            ) : null}
        </div>
    )
}
