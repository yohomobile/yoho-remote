import type { IdentityActorMeta, IdentityChannel } from '@/types/api'

const CHANNEL_LABELS: Record<IdentityChannel, string> = {
    keycloak: 'Keycloak',
    feishu: 'Feishu',
    wecom: 'WeCom',
    'custom-im': 'IM',
    cli: 'CLI',
}

function actorName(actor: IdentityActorMeta): string {
    return actor.displayName || actor.email || actor.externalId
}

export function ActorFilterDropdown(props: {
    actors: IdentityActorMeta[]
    selectedIdentityId: string | null
    onSelect: (identityId: string | null) => void
}) {
    const { actors, selectedIdentityId, onSelect } = props
    if (!actors || actors.length <= 1) return null

    return (
        <select
            value={selectedIdentityId ?? ''}
            onChange={(event) => onSelect(event.target.value === '' ? null : event.target.value)}
            className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1 text-[11px] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
            aria-label="Filter messages by speaker"
            data-testid="actor-filter-dropdown"
        >
            <option value="">All speakers</option>
            {actors.map((actor) => (
                <option key={actor.identityId} value={actor.identityId}>
                    {actorName(actor)} · {CHANNEL_LABELS[actor.channel] ?? actor.channel}
                </option>
            ))}
        </select>
    )
}
