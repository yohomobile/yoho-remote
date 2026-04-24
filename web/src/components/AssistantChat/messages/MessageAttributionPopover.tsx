import type { MessageActorAttribution } from '@/chat/identityAttribution'
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

function ResolutionBadge(props: { resolution: IdentityActorMeta['resolution'] }) {
    const tone = props.resolution === 'auto_verified' || props.resolution === 'admin_verified'
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
        : props.resolution === 'pending' || props.resolution === 'unresolved'
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
    return (
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
            {props.resolution}
        </span>
    )
}

export function MessageAttributionPopover(props: {
    attribution: MessageActorAttribution
    onOpenPerson?: (personId: string) => void
}) {
    const { attribution, onOpenPerson } = props
    return (
        <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {attribution.actors.length > 1 ? `${attribution.actors.length} speakers` : 'Speaker'}
            </div>
            <ul className="space-y-2">
                {attribution.actors.map((actor) => {
                    const channelLabel = CHANNEL_LABELS[actor.channel] ?? actor.channel
                    const subtitle = [actor.email, actor.externalId].filter(Boolean).join(' · ')
                    return (
                        <li
                            key={actor.identityId}
                            className="rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] p-2"
                            data-testid={`attribution-actor-${actor.identityId}`}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-[12px] font-medium text-[var(--app-fg)]">
                                        {actorName(actor)}
                                    </div>
                                    {subtitle ? (
                                        <div className="truncate text-[10px] text-[var(--app-hint)]">{subtitle}</div>
                                    ) : null}
                                </div>
                                <ResolutionBadge resolution={actor.resolution} />
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-[var(--app-hint)]">
                                <span className="rounded bg-[var(--app-bg)] px-1 py-0.5">{channelLabel}</span>
                                <span className="rounded bg-[var(--app-bg)] px-1 py-0.5">{actor.accountType}</span>
                            </div>
                            <div className="mt-1.5">
                                {actor.personId ? (
                                    <a
                                        href={`/self-system?openPerson=${encodeURIComponent(actor.personId)}`}
                                        className="text-[11px] font-medium text-[var(--app-button)] hover:underline"
                                        data-testid={`attribution-open-person-${actor.personId}`}
                                        onClick={(event) => {
                                            if (!onOpenPerson) return
                                            event.preventDefault()
                                            onOpenPerson(actor.personId as string)
                                        }}
                                    >
                                        View in Self System →
                                    </a>
                                ) : (
                                    <span className="text-[11px] text-[var(--app-hint)]">Not yet linked to a person</span>
                                )}
                            </div>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}
