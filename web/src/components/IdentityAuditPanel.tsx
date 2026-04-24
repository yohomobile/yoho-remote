import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type { StoredPersonIdentityAudit } from '@/types/api'

export const KNOWN_AUDIT_ACTIONS = [
    'all',
    'merge_persons',
    'unmerge_persons',
    'detach_identity_link',
    'confirm_existing_person',
    'create_person_and_confirm',
    'mark_shared',
    'reject_candidate',
] as const

export type AuditActionFilter = typeof KNOWN_AUDIT_ACTIONS[number]

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

type IdentityAuditContentProps = {
    action: AuditActionFilter
    audits: StoredPersonIdentityAudit[]
    isLoading: boolean
    isFetching: boolean
    error: string | null
    onActionChange: (action: AuditActionFilter) => void
}

export function IdentityAuditContent(props: IdentityAuditContentProps) {
    const { action, audits, isLoading, isFetching, error, onActionChange } = props

    return (
        <div id="section-identity-audits" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">Identity Audit Log</h3>
                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                        Latest governance events across candidates, merges and detaches.
                    </p>
                </div>
                {isFetching && <Spinner size="sm" label="Loading audits" />}
            </div>

            <div className="p-3 space-y-3">
                <select
                    value={action}
                    onChange={(event) => onActionChange(event.target.value as AuditActionFilter)}
                    className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                    aria-label="Filter by action"
                >
                    {KNOWN_AUDIT_ACTIONS.map((a) => (
                        <option key={a} value={a}>
                            {a === 'all' ? 'All actions' : a}
                        </option>
                    ))}
                </select>

                {error && <div className="text-xs text-red-500">{error}</div>}

                {audits.length === 0 && !isLoading ? (
                    <div className="text-xs text-[var(--app-hint)]">
                        {action === 'all' ? 'No audit events yet.' : `No ${action} events.`}
                    </div>
                ) : (
                    <ul className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]">
                        {audits.map((audit) => (
                            <li key={audit.id} className="px-3 py-2 text-[11px]" data-testid={`audit-row-${audit.id}`}>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold">{audit.action}</span>
                                    <span className="text-[var(--app-hint)]">{formatTimestamp(audit.createdAt)}</span>
                                </div>
                                <div className="mt-0.5 grid grid-cols-1 gap-0.5 text-[var(--app-hint)] sm:grid-cols-2">
                                    <div className="truncate">Actor: {audit.actorEmail ?? 'system'}</div>
                                    <div className="truncate">
                                        Person: {audit.personId ?? '-'}
                                        {audit.targetPersonId ? ` → ${audit.targetPersonId}` : ''}
                                    </div>
                                    {audit.identityId && <div className="truncate">Identity: {audit.identityId}</div>}
                                    {audit.linkId && <div className="truncate">Link: {audit.linkId}</div>}
                                </div>
                                {audit.reason && (
                                    <div className="mt-0.5 truncate text-[var(--app-fg)]">{audit.reason}</div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    )
}

export function IdentityAuditPanel(props: { orgId: string | null }) {
    const { api } = useAppContext()
    const [action, setAction] = useState<AuditActionFilter>('all')

    const auditQuery = useQuery({
        queryKey: queryKeys.identityAudits(props.orgId, null, null),
        queryFn: async () => await api.getIdentityAuditLog({ orgId: props.orgId, limit: 50 }),
        enabled: Boolean(api && props.orgId),
    })
    const allAudits: StoredPersonIdentityAudit[] = auditQuery.data?.audits ?? []

    const filtered = useMemo(() => {
        if (action === 'all') return allAudits
        return allAudits.filter((audit) => audit.action === action)
    }, [allAudits, action])

    return (
        <IdentityAuditContent
            action={action}
            audits={filtered}
            isLoading={auditQuery.isLoading}
            isFetching={auditQuery.isFetching}
            error={auditQuery.error instanceof Error ? auditQuery.error.message : null}
            onActionChange={setAction}
        />
    )
}
