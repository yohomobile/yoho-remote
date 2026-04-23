import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type { IdentityCandidate, IdentityCandidateDecision, StoredPerson } from '@/types/api'

export function formatIdentityScore(score: number): string {
    return `${Math.round(score * 100)}%`
}

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function personTitle(person: StoredPerson): string {
    return person.canonicalName || person.primaryEmail || person.employeeCode || person.id
}

function identityTitle(candidate: IdentityCandidate): string {
    return candidate.identity.displayName
        || candidate.identity.canonicalEmail
        || candidate.identity.loginName
        || candidate.identity.externalId
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function compactList(values: unknown[]): string {
    if (values.length === 0) return 'none'
    const visible = values.slice(0, 3).map(formatUnknown).join(', ')
    return values.length > 3 ? `${visible}, +${values.length - 3}` : visible
}

type IdentityReviewContentProps = {
    candidates: IdentityCandidate[]
    selectedCandidate: IdentityCandidate | null
    persons: StoredPerson[]
    personQuery: string
    reason: string
    isLoading: boolean
    isSearching: boolean
    isDeciding: boolean
    error: string | null
    onSelectCandidate: (candidateId: string) => void
    onPersonQueryChange: (value: string) => void
    onReasonChange: (value: string) => void
    onConfirmSuggested: (candidate: IdentityCandidate) => void
    onConfirmPerson: (candidate: IdentityCandidate, person: StoredPerson) => void
    onCreatePerson: (candidate: IdentityCandidate) => void
    onMarkShared: (candidate: IdentityCandidate) => void
    onReject: (candidate: IdentityCandidate) => void
}

export function IdentityReviewContent(props: IdentityReviewContentProps) {
    const {
        candidates,
        selectedCandidate,
        persons,
        personQuery,
        reason,
        isLoading,
        isSearching,
        isDeciding,
        error,
        onSelectCandidate,
        onPersonQueryChange,
        onReasonChange,
        onConfirmSuggested,
        onConfirmPerson,
        onCreatePerson,
        onMarkShared,
        onReject,
    } = props

    return (
        <div id="section-identity-review" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">Identity Review</h3>
                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                        {candidates.length} open candidate{candidates.length !== 1 ? 's' : ''}
                    </p>
                </div>
                {isLoading && <Spinner size="sm" label="Loading identity candidates" />}
            </div>

            {error && (
                <div className="px-3 py-2 text-xs text-red-500 border-b border-[var(--app-divider)]">
                    {error}
                </div>
            )}

            {candidates.length === 0 && !isLoading ? (
                <div className="px-3 py-4 text-sm text-[var(--app-hint)]">
                    No open candidates.
                </div>
            ) : (
                <div className="grid gap-0 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.2fr)]">
                    <div className="divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)] md:border-b-0 md:border-r">
                        {candidates.map((candidate) => {
                            const isSelected = selectedCandidate?.id === candidate.id
                            return (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    onClick={() => onSelectCandidate(candidate.id)}
                                    className={`w-full px-3 py-2.5 text-left transition-colors ${
                                        isSelected ? 'bg-[var(--app-button)]/10' : 'hover:bg-[var(--app-secondary-bg)]'
                                    }`}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium truncate">{identityTitle(candidate)}</div>
                                            <div className="mt-0.5 text-[11px] text-[var(--app-hint)] truncate">
                                                {candidate.identity.channel} · {candidate.identity.canonicalEmail ?? candidate.identity.externalId}
                                            </div>
                                        </div>
                                        <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] font-semibold">
                                            {formatIdentityScore(candidate.score)}
                                        </span>
                                    </div>
                                    {candidate.candidatePerson && (
                                        <div className="mt-1 text-[11px] text-[var(--app-hint)] truncate">
                                            Suggested: {personTitle(candidate.candidatePerson)}
                                        </div>
                                    )}
                                </button>
                            )
                        })}
                    </div>

                    <div className="min-w-0">
                        {selectedCandidate ? (
                            <div className="p-3 space-y-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="rounded-md bg-[var(--app-secondary-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                                            {selectedCandidate.identity.channel}
                                        </span>
                                        <span className="text-sm font-medium truncate">{identityTitle(selectedCandidate)}</span>
                                    </div>
                                    <div className="grid grid-cols-1 gap-1 text-[11px] text-[var(--app-hint)] sm:grid-cols-2">
                                        <div className="truncate">Email: {selectedCandidate.identity.canonicalEmail ?? '-'}</div>
                                        <div className="truncate">External: {selectedCandidate.identity.externalId}</div>
                                        <div>Seen: {formatTimestamp(selectedCandidate.identity.lastSeenAt)}</div>
                                        <div>Evidence: {compactList(selectedCandidate.evidence)}</div>
                                    </div>
                                    {selectedCandidate.riskFlags.length > 0 && (
                                        <div className="text-[11px] text-amber-600 dark:text-amber-400">
                                            Risk: {compactList(selectedCandidate.riskFlags)}
                                        </div>
                                    )}
                                </div>

                                {selectedCandidate.candidatePerson && (
                                    <div className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-xs font-medium truncate">{personTitle(selectedCandidate.candidatePerson)}</div>
                                                <div className="text-[11px] text-[var(--app-hint)] truncate">
                                                    {selectedCandidate.candidatePerson.primaryEmail ?? selectedCandidate.candidatePerson.employeeCode ?? selectedCandidate.candidatePerson.id}
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => onConfirmSuggested(selectedCandidate)}
                                                disabled={isDeciding}
                                                className="shrink-0 rounded-md bg-[var(--app-button)] px-2.5 py-1 text-xs font-medium text-[var(--app-button-text)] disabled:opacity-50"
                                            >
                                                Confirm suggested
                                            </button>
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <input
                                        type="text"
                                        value={personQuery}
                                        onChange={(event) => onPersonQueryChange(event.target.value)}
                                        placeholder="Search persons"
                                        className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                                    />
                                    {isSearching ? (
                                        <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                                            <Spinner size="sm" label={null} />
                                            Searching
                                        </div>
                                    ) : persons.length > 0 ? (
                                        <div className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]">
                                            {persons.map((person) => (
                                                <div key={person.id} className="flex items-center justify-between gap-3 px-3 py-2">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-medium truncate">{personTitle(person)}</div>
                                                        <div className="text-[11px] text-[var(--app-hint)] truncate">
                                                            {person.primaryEmail ?? person.employeeCode ?? person.id}
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => onConfirmPerson(selectedCandidate, person)}
                                                        disabled={isDeciding}
                                                        className="shrink-0 rounded-md bg-[var(--app-secondary-bg)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--app-border)] disabled:opacity-50"
                                                    >
                                                        Confirm
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    ) : personQuery.trim() ? (
                                        <div className="text-xs text-[var(--app-hint)]">No matching persons.</div>
                                    ) : null}
                                </div>

                                <textarea
                                    value={reason}
                                    onChange={(event) => onReasonChange(event.target.value)}
                                    placeholder="Reason"
                                    rows={2}
                                    className="w-full resize-none rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                                />

                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => onCreatePerson(selectedCandidate)}
                                        disabled={isDeciding}
                                        className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)] disabled:opacity-50"
                                    >
                                        Create person
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onMarkShared(selectedCandidate)}
                                        disabled={isDeciding}
                                        className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--app-border)] disabled:opacity-50"
                                    >
                                        Mark shared
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onReject(selectedCandidate)}
                                        disabled={isDeciding}
                                        className="rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/15 disabled:opacity-50"
                                    >
                                        Reject
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="px-3 py-4 text-sm text-[var(--app-hint)]">Select a candidate.</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

export function IdentityReviewPanel(props: {
    orgId: string | null
    canManage: boolean
}) {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
    const [personQuery, setPersonQuery] = useState('')
    const [reason, setReason] = useState('')

    const candidatesQuery = useQuery({
        queryKey: queryKeys.identityCandidates(props.orgId, 'open'),
        queryFn: async () => await api.getIdentityCandidates(props.orgId, 'open'),
        enabled: Boolean(api && props.orgId && props.canManage),
    })
    const candidates = useMemo(() => candidatesQuery.data?.candidates ?? [], [candidatesQuery.data?.candidates])
    const selectedCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId) ?? candidates[0] ?? null

    useEffect(() => {
        if (!selectedCandidate) {
            setSelectedCandidateId(null)
            return
        }
        if (selectedCandidateId !== selectedCandidate.id) {
            setSelectedCandidateId(selectedCandidate.id)
        }
    }, [selectedCandidate, selectedCandidateId])

    const personsQuery = useQuery({
        queryKey: queryKeys.identityPersons(props.orgId, personQuery),
        queryFn: async () => await api.searchIdentityPersons(props.orgId, personQuery),
        enabled: Boolean(api && props.orgId && props.canManage && selectedCandidate && personQuery.trim()),
    })
    const persons = personsQuery.data?.persons ?? []

    const invalidateIdentityQueries = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.identityCandidates(props.orgId, 'open') }),
            queryClient.invalidateQueries({ queryKey: queryKeys.identityPersons(props.orgId, personQuery) }),
        ])
    }, [personQuery, props.orgId, queryClient])

    const decisionMutation = useMutation({
        mutationFn: async (input: { candidateId: string; decision: IdentityCandidateDecision }) => (
            await api.decideIdentityCandidate(input.candidateId, input.decision, props.orgId)
        ),
        onSuccess: async () => {
            setReason('')
            setPersonQuery('')
            setSelectedCandidateId(null)
            await invalidateIdentityQueries()
        },
    })

    const withReason = useCallback(<T extends IdentityCandidateDecision>(decision: T): T => {
        const trimmed = reason.trim()
        return trimmed ? { ...decision, reason: trimmed } : decision
    }, [reason])

    const decide = useCallback((candidate: IdentityCandidate, decision: IdentityCandidateDecision) => {
        decisionMutation.mutate({
            candidateId: candidate.id,
            decision,
        })
    }, [decisionMutation])

    if (!props.canManage || !props.orgId) {
        return null
    }

    return (
        <IdentityReviewContent
            candidates={candidates}
            selectedCandidate={selectedCandidate}
            persons={persons}
            personQuery={personQuery}
            reason={reason}
            isLoading={candidatesQuery.isLoading}
            isSearching={personsQuery.isFetching}
            isDeciding={decisionMutation.isPending}
            error={candidatesQuery.error instanceof Error
                ? candidatesQuery.error.message
                : decisionMutation.error instanceof Error
                    ? decisionMutation.error.message
                    : null}
            onSelectCandidate={setSelectedCandidateId}
            onPersonQueryChange={setPersonQuery}
            onReasonChange={setReason}
            onConfirmSuggested={(candidate) => {
                if (!candidate.candidatePerson) return
                decide(candidate, withReason({
                    action: 'confirm_existing_person',
                    personId: candidate.candidatePerson.id,
                }))
            }}
            onConfirmPerson={(candidate, person) => decide(candidate, withReason({
                action: 'confirm_existing_person',
                personId: person.id,
            }))}
            onCreatePerson={(candidate) => decide(candidate, withReason({
                action: 'create_person_and_confirm',
                createPerson: {
                    canonicalName: candidate.identity.displayName,
                    primaryEmail: candidate.identity.canonicalEmail,
                    employeeCode: candidate.identity.employeeCode,
                },
            }))}
            onMarkShared={(candidate) => decide(candidate, withReason({ action: 'mark_shared' }))}
            onReject={(candidate) => decide(candidate, withReason({ action: 'reject' }))}
        />
    )
}
