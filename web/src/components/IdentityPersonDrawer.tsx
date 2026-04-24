import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type {
    IdentityPersonDetail,
    StoredPerson,
    StoredPersonIdentity,
    StoredPersonIdentityAudit,
    StoredPersonIdentityLink,
} from '@/types/api'
import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet'

export type IdentityDrawerConfirm =
    | null
    | { kind: 'detach'; link: StoredPersonIdentityLink; identity: StoredPersonIdentity }
    | { kind: 'merge'; target: StoredPerson }
    | { kind: 'unmerge' }

function personTitle(person: StoredPerson): string {
    return person.canonicalName || person.primaryEmail || person.employeeCode || person.id
}

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function identityLabel(identity: StoredPersonIdentity): string {
    return identity.displayName || identity.canonicalEmail || identity.loginName || identity.externalId
}

export type IdentityPersonDrawerPanelProps = {
    detail: IdentityPersonDetail | undefined
    audits: StoredPersonIdentityAudit[]
    isDetailLoading: boolean
    detailError: string | null
    isAuditsLoading: boolean
    mergeQuery: string
    mergeCandidates: StoredPerson[]
    isMergeSearching: boolean
    reason: string
    confirm: IdentityDrawerConfirm
    errorMsg: string | null
    busy: boolean
    onMergeQueryChange: (value: string) => void
    onReasonChange: (value: string) => void
    onRequestDetach: (link: StoredPersonIdentityLink, identity: StoredPersonIdentity) => void
    onRequestMerge: (target: StoredPerson) => void
    onRequestUnmerge: () => void
    onConfirm: () => void
    onCancelConfirm: () => void
}

export function IdentityPersonDrawerPanel(props: IdentityPersonDrawerPanelProps) {
    const {
        detail,
        audits,
        isDetailLoading,
        detailError,
        isAuditsLoading,
        mergeQuery,
        mergeCandidates,
        isMergeSearching,
        reason,
        confirm,
        errorMsg,
        busy,
        onMergeQueryChange,
        onReasonChange,
        onRequestDetach,
        onRequestMerge,
        onRequestUnmerge,
        onConfirm,
        onCancelConfirm,
    } = props

    if (isDetailLoading) {
        return (
            <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                <Spinner size="sm" label={null} /> Loading person detail
            </div>
        )
    }
    if (detailError) {
        return <div className="text-xs text-red-500">{detailError}</div>
    }
    if (!detail) return null

    const person = detail.person

    return (
        <>
            {errorMsg && (
                <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600">{errorMsg}</div>
            )}

            <section aria-label="Reason" className="space-y-1.5">
                <label className="block text-xs font-medium text-[var(--app-hint)]">Reason (optional, applies to next action)</label>
                <textarea
                    value={reason}
                    onChange={(event) => onReasonChange(event.target.value)}
                    placeholder="e.g. wrong Feishu binding, duplicate person..."
                    rows={2}
                    className="w-full resize-none rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                />
            </section>

            <section aria-label="Identities" className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                    Identities ({detail.identities.length})
                </h4>
                {detail.identities.length === 0 ? (
                    <div className="text-xs text-[var(--app-hint)]">No active identity links.</div>
                ) : (
                    <div className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]">
                        {detail.identities.map(({ identity, link }) => (
                            <div
                                key={link.id}
                                className="flex items-center justify-between gap-3 px-3 py-2"
                                data-testid={`identity-row-${link.id}`}
                            >
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 text-xs">
                                        <span className="rounded bg-[var(--app-secondary-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                                            {identity.channel}
                                        </span>
                                        <span className="font-medium truncate">{identityLabel(identity)}</span>
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-[var(--app-hint)] truncate">
                                        {identity.externalId} · {link.state} · {Math.round(link.confidence * 100)}%
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => onRequestDetach(link, identity)}
                                    className="shrink-0 rounded-md bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/15 disabled:opacity-50"
                                >
                                    Detach
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {person.status === 'merged' ? (
                <section aria-label="Unmerge" className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">Unmerge</h4>
                    <div className="text-[11px] text-[var(--app-hint)]">
                        This person is merged into {person.mergedIntoPersonId ?? 'another person'}. Unmerge will restore their identities.
                    </div>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onRequestUnmerge}
                        className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)] disabled:opacity-50"
                    >
                        Unmerge this person
                    </button>
                </section>
            ) : (
                <section aria-label="Merge" className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">Merge into another person</h4>
                    <input
                        type="text"
                        value={mergeQuery}
                        onChange={(event) => onMergeQueryChange(event.target.value)}
                        placeholder="Search target person"
                        className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                    />
                    {isMergeSearching ? (
                        <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                            <Spinner size="sm" label={null} /> Searching
                        </div>
                    ) : mergeCandidates.length > 0 ? (
                        <div className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]">
                            {mergeCandidates.map((target) => (
                                <div key={target.id} className="flex items-center justify-between gap-3 px-3 py-2">
                                    <div className="min-w-0">
                                        <div className="text-xs font-medium truncate">{personTitle(target)}</div>
                                        <div className="text-[11px] text-[var(--app-hint)] truncate">
                                            {target.primaryEmail ?? target.employeeCode ?? target.id}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => onRequestMerge(target)}
                                        className="shrink-0 rounded-md bg-[var(--app-secondary-bg)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--app-border)] disabled:opacity-50"
                                    >
                                        Merge into
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : mergeQuery.trim() ? (
                        <div className="text-xs text-[var(--app-hint)]">No matching persons.</div>
                    ) : null}
                </section>
            )}

            <section aria-label="Audit" className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">Recent audits</h4>
                {isAuditsLoading ? (
                    <Spinner size="sm" label="Loading audits" />
                ) : audits.length === 0 ? (
                    <div className="text-xs text-[var(--app-hint)]">No audits for this person yet.</div>
                ) : (
                    <ul className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]">
                        {audits.map((audit) => (
                            <li key={audit.id} className="px-3 py-2 text-[11px]">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold">{audit.action}</span>
                                    <span className="text-[var(--app-hint)]">{formatTimestamp(audit.createdAt)}</span>
                                </div>
                                <div className="text-[var(--app-hint)] truncate">
                                    {audit.actorEmail ?? 'system'}{audit.reason ? ` · ${audit.reason}` : ''}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {confirm && (
                <div className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 space-y-2" role="alertdialog">
                    <div className="text-xs font-medium">
                        {confirm.kind === 'detach' && `Detach ${identityLabel(confirm.identity)}?`}
                        {confirm.kind === 'merge' && `Merge ${personTitle(person)} into ${personTitle(confirm.target)}?`}
                        {confirm.kind === 'unmerge' && 'Unmerge this person?'}
                    </div>
                    <div className="text-[11px] text-[var(--app-hint)]">
                        {confirm.kind === 'detach' && 'The link will be moved to detached state. Identity data is retained.'}
                        {confirm.kind === 'merge' && 'Source person will be marked merged. Active links move to the target person.'}
                        {confirm.kind === 'unmerge' && 'The merge audit will be recorded. Links restoration is manual.'}
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={onConfirm}
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)] disabled:opacity-50"
                        >
                            Confirm
                        </button>
                        <button
                            type="button"
                            onClick={onCancelConfirm}
                            className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--app-border)]"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </>
    )
}

export function IdentityPersonDrawer(props: {
    orgId: string | null
    personId: string | null
    onClose: () => void
}) {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const open = Boolean(props.personId)

    const [reason, setReason] = useState('')
    const [mergeQuery, setMergeQuery] = useState('')
    const [confirm, setConfirm] = useState<IdentityDrawerConfirm>(null)
    const [errorMsg, setErrorMsg] = useState<string | null>(null)

    useEffect(() => {
        if (!open) {
            setReason('')
            setMergeQuery('')
            setConfirm(null)
            setErrorMsg(null)
        }
    }, [open])

    const detailQuery = useQuery({
        queryKey: queryKeys.identityPersonDetail(props.orgId, props.personId),
        queryFn: async () => await api.getIdentityPersonDetail(props.personId!, props.orgId),
        enabled: Boolean(api && props.orgId && props.personId),
    })
    const detail = detailQuery.data
    const person = detail?.person

    const auditQuery = useQuery({
        queryKey: queryKeys.identityAudits(props.orgId, props.personId, null),
        queryFn: async () => await api.getIdentityAuditLog({ orgId: props.orgId, personId: props.personId ?? undefined, limit: 20 }),
        enabled: Boolean(api && props.orgId && props.personId),
    })
    const audits = auditQuery.data?.audits ?? []

    const mergeSearchQuery = useQuery({
        queryKey: queryKeys.identityPersons(props.orgId, mergeQuery),
        queryFn: async () => await api.searchIdentityPersons(props.orgId, mergeQuery, 10),
        enabled: Boolean(api && props.orgId && mergeQuery.trim().length > 0),
    })
    const mergeCandidates = (mergeSearchQuery.data?.persons ?? []).filter((p) => p.id !== props.personId)

    const invalidateAll = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['identity-candidates'] }),
            queryClient.invalidateQueries({ queryKey: ['identity-persons'] }),
            queryClient.invalidateQueries({ queryKey: ['identity-person-detail'] }),
            queryClient.invalidateQueries({ queryKey: ['identity-audits'] }),
        ])
    }, [queryClient])

    const mergeMutation = useMutation({
        mutationFn: async (input: { targetPersonId: string; reason: string | null }) => {
            if (!props.personId) throw new Error('personId missing')
            return await api.mergeIdentityPersons(props.personId, input.targetPersonId, input.reason, props.orgId)
        },
        onSuccess: async () => {
            setErrorMsg(null)
            setReason('')
            setMergeQuery('')
            setConfirm(null)
            await invalidateAll()
        },
        onError: (err) => setErrorMsg(err instanceof Error ? err.message : 'Merge failed'),
    })

    const unmergeMutation = useMutation({
        mutationFn: async (input: { reason: string | null }) => {
            if (!props.personId) throw new Error('personId missing')
            return await api.unmergeIdentityPerson(props.personId, input.reason, props.orgId)
        },
        onSuccess: async () => {
            setErrorMsg(null)
            setReason('')
            setConfirm(null)
            await invalidateAll()
        },
        onError: (err) => setErrorMsg(err instanceof Error ? err.message : 'Unmerge failed'),
    })

    const detachMutation = useMutation({
        mutationFn: async (input: { linkId: string; reason: string | null }) => {
            return await api.detachIdentityLink(input.linkId, input.reason, props.orgId)
        },
        onSuccess: async () => {
            setErrorMsg(null)
            setReason('')
            setConfirm(null)
            await invalidateAll()
        },
        onError: (err) => setErrorMsg(err instanceof Error ? err.message : 'Detach failed'),
    })

    const busy = mergeMutation.isPending || unmergeMutation.isPending || detachMutation.isPending

    const handleConfirm = useCallback(() => {
        if (!confirm) return
        const trimmed = reason.trim() || null
        if (confirm.kind === 'detach') {
            detachMutation.mutate({ linkId: confirm.link.id, reason: trimmed })
        } else if (confirm.kind === 'merge') {
            mergeMutation.mutate({ targetPersonId: confirm.target.id, reason: trimmed })
        } else if (confirm.kind === 'unmerge') {
            unmergeMutation.mutate({ reason: trimmed })
        }
    }, [confirm, reason, detachMutation, mergeMutation, unmergeMutation])

    return (
        <Sheet open={open} onOpenChange={(next) => { if (!next) props.onClose() }}>
            <SheetContent side="right" aria-describedby={undefined} data-testid="identity-person-drawer">
                <SheetHeader>
                    <div className="flex items-center justify-between gap-2">
                        <SheetTitle>{person ? personTitle(person) : 'Person'}</SheetTitle>
                        <SheetClose className="rounded-md bg-[var(--app-bg)] px-2 py-1 text-xs" aria-label="Close">
                            Close
                        </SheetClose>
                    </div>
                    {person && (
                        <SheetDescription>
                            {person.primaryEmail ?? person.employeeCode ?? person.id} · {person.personType} · {person.status}
                        </SheetDescription>
                    )}
                </SheetHeader>

                <IdentityPersonDrawerPanel
                    detail={detail}
                    audits={audits}
                    isDetailLoading={detailQuery.isLoading}
                    detailError={detailQuery.error instanceof Error ? detailQuery.error.message : null}
                    isAuditsLoading={auditQuery.isLoading}
                    mergeQuery={mergeQuery}
                    mergeCandidates={mergeCandidates}
                    isMergeSearching={mergeSearchQuery.isFetching}
                    reason={reason}
                    confirm={confirm}
                    errorMsg={errorMsg}
                    busy={busy}
                    onMergeQueryChange={setMergeQuery}
                    onReasonChange={setReason}
                    onRequestDetach={(link, identity) => setConfirm({ kind: 'detach', link, identity })}
                    onRequestMerge={(target) => setConfirm({ kind: 'merge', target })}
                    onRequestUnmerge={() => setConfirm({ kind: 'unmerge' })}
                    onConfirm={handleConfirm}
                    onCancelConfirm={() => setConfirm(null)}
                />
            </SheetContent>
        </Sheet>
    )
}
