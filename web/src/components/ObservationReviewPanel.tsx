import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type {
    ObservationCandidateStatus,
    ObservationDecision,
    StoredObservationCandidate,
} from '@/types/api'

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function formatConfidence(conf: number): string {
    return `${Math.round(conf * 100)}%`
}

const STATUS_LABEL: Record<ObservationCandidateStatus, string> = {
    pending: '待确认',
    confirmed: '已确认',
    rejected: '已驳回',
    dismissed: '已忽略',
    expired: '已过期',
}

const STATUS_OPTIONS: ObservationCandidateStatus[] = ['pending', 'confirmed', 'rejected', 'dismissed', 'expired']

type ObservationContentProps = {
    statusFilter: ObservationCandidateStatus
    onStatusFilterChange: (status: ObservationCandidateStatus) => void
    candidates: StoredObservationCandidate[]
    selectedCandidate: StoredObservationCandidate | null
    onSelectCandidate: (id: string) => void
    planId: string
    onPlanIdChange: (value: string) => void
    reason: string
    onReasonChange: (value: string) => void
    isLoading: boolean
    isDeciding: boolean
    error: string | null
    onConfirm: (candidate: StoredObservationCandidate) => void
    onReject: (candidate: StoredObservationCandidate) => void
    onDismiss: (candidate: StoredObservationCandidate) => void
    onExpire: (candidate: StoredObservationCandidate) => void
}

export function ObservationReviewContent(props: ObservationContentProps) {
    const {
        statusFilter,
        onStatusFilterChange,
        candidates,
        selectedCandidate,
        onSelectCandidate,
        planId,
        onPlanIdChange,
        reason,
        onReasonChange,
        isLoading,
        isDeciding,
        error,
        onConfirm,
        onReject,
        onDismiss,
        onExpire,
    } = props

    return (
        <div id="section-observation-review" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">观察假设池</h3>
                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                        {candidates.length} {STATUS_LABEL[statusFilter]}假设 · 候选默认不进 prompt
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={statusFilter}
                        onChange={(e) => onStatusFilterChange(e.target.value as ObservationCandidateStatus)}
                        className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1 text-xs"
                    >
                        {STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                        ))}
                    </select>
                    {isLoading && <Spinner size="sm" label="加载中" />}
                </div>
            </div>

            {error && (
                <div className="px-3 py-2 text-xs text-red-500 bg-red-500/10 border-b border-red-500/20">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <div className="border-r border-[var(--app-divider)] max-h-[400px] overflow-y-auto">
                    {candidates.length === 0 && !isLoading && (
                        <div className="px-3 py-6 text-center text-xs text-[var(--app-hint)]">
                            暂无{STATUS_LABEL[statusFilter]}假设
                        </div>
                    )}
                    {candidates.map((candidate) => {
                        const isSelected = selectedCandidate?.id === candidate.id
                        return (
                            <button
                                key={candidate.id}
                                type="button"
                                onClick={() => onSelectCandidate(candidate.id)}
                                className={[
                                    'w-full text-left px-3 py-2 border-b border-[var(--app-divider)] text-xs',
                                    isSelected ? 'bg-[var(--app-button)]/10' : 'hover:bg-[var(--app-secondary-bg)]',
                                ].join(' ')}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <div className="font-medium text-[var(--app-fg)] truncate">{candidate.hypothesisKey}</div>
                                    <div className="text-[10px] text-[var(--app-hint)] shrink-0">
                                        {formatConfidence(candidate.confidence)}
                                    </div>
                                </div>
                                <div className="mt-1 text-[var(--app-fg)] truncate">{candidate.summary}</div>
                                <div className="mt-1 text-[10px] text-[var(--app-hint)] truncate">
                                    关于 {candidate.subjectEmail ?? candidate.subjectPersonId ?? 'unknown'} · {formatTimestamp(candidate.createdAt)}
                                </div>
                            </button>
                        )
                    })}
                </div>

                <div className="p-3">
                    {selectedCandidate ? (
                        <div className="space-y-3">
                            <div>
                                <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">假设</div>
                                <div className="mt-1 text-sm font-medium text-[var(--app-fg)]">
                                    {selectedCandidate.hypothesisKey}
                                </div>
                                <div className="mt-1 text-sm text-[var(--app-fg)]">{selectedCandidate.summary}</div>
                                {selectedCandidate.detail && (
                                    <div className="mt-2 whitespace-pre-wrap text-xs text-[var(--app-hint)]">
                                        {selectedCandidate.detail}
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--app-hint)]">
                                <div>当事人：{selectedCandidate.subjectEmail ?? selectedCandidate.subjectPersonId ?? '—'}</div>
                                <div>置信度：{formatConfidence(selectedCandidate.confidence)}</div>
                                <div>检测器：{selectedCandidate.detectorVersion}</div>
                                <div>状态：{STATUS_LABEL[selectedCandidate.status]}</div>
                            </div>

                            {selectedCandidate.signals.length > 0 && (
                                <div>
                                    <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                        信号 ({selectedCandidate.signals.length})
                                    </div>
                                    <ul className="mt-1 space-y-1 text-[11px] text-[var(--app-fg)]">
                                        {selectedCandidate.signals.slice(0, 5).map((signal, idx) => (
                                            <li key={idx} className="border-l-2 border-[var(--app-divider)] pl-2">
                                                <span className="font-mono text-[10px] text-[var(--app-hint)]">{signal.kind}</span>
                                                {signal.summary && <span className="ml-1">{signal.summary}</span>}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {selectedCandidate.suggestedPatch && (
                                <div>
                                    <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">建议调整</div>
                                    <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-[var(--app-bg)] p-2 text-[11px] text-[var(--app-fg)]">
                                        {JSON.stringify(selectedCandidate.suggestedPatch, null, 2)}
                                    </pre>
                                </div>
                            )}

                            {selectedCandidate.promotedCommunicationPlanId && (
                                <div className="text-[11px] text-[var(--app-hint)]">
                                    已升级为 plan：<code className="text-[var(--app-fg)]">{selectedCandidate.promotedCommunicationPlanId}</code>
                                </div>
                            )}

                            {selectedCandidate.status === 'pending' && (
                                <>
                                    <label className="block">
                                        <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                            confirm 时关联 communicationPlanId（可选）
                                        </div>
                                        <input
                                            type="text"
                                            value={planId}
                                            onChange={(e) => onPlanIdChange(e.target.value)}
                                            placeholder="plan-xxxxx"
                                            className="mt-1 w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-1.5 text-sm"
                                        />
                                    </label>
                                    <label className="block">
                                        <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">理由（可选）</div>
                                        <textarea
                                            rows={2}
                                            value={reason}
                                            onChange={(e) => onReasonChange(e.target.value)}
                                            placeholder="决策原因"
                                            className="mt-1 w-full resize-none rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-1.5 text-sm"
                                        />
                                    </label>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => onConfirm(selectedCandidate)}
                                            disabled={isDeciding}
                                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)] disabled:opacity-50"
                                        >
                                            确认
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onReject(selectedCandidate)}
                                            disabled={isDeciding}
                                            className="rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/15 disabled:opacity-50"
                                        >
                                            驳回
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onDismiss(selectedCandidate)}
                                            disabled={isDeciding}
                                            className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                                        >
                                            忽略
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onExpire(selectedCandidate)}
                                            disabled={isDeciding}
                                            className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                                        >
                                            过期
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">选择一个假设查看详情</div>
                    )}
                </div>
            </div>
        </div>
    )
}

export function ObservationReviewPanel(props: {
    orgId: string | null
    canManage: boolean
    subjectEmail?: string | null
}) {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const [statusFilter, setStatusFilter] = useState<ObservationCandidateStatus>('pending')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [planId, setPlanId] = useState('')
    const [reason, setReason] = useState('')

    const candidatesQuery = useQuery({
        queryKey: queryKeys.observationCandidates(props.orgId, statusFilter, props.subjectEmail ?? null),
        queryFn: async () => await api.getObservationCandidates({
            orgId: props.orgId!,
            status: statusFilter,
            subjectEmail: props.subjectEmail ?? null,
        }),
        enabled: Boolean(api && props.orgId && props.canManage),
    })

    const candidates = useMemo(() => candidatesQuery.data?.candidates ?? [], [candidatesQuery.data?.candidates])
    const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null

    useEffect(() => {
        if (!selected) {
            setSelectedId(null)
            return
        }
        if (selectedId !== selected.id) setSelectedId(selected.id)
    }, [selected, selectedId])

    const invalidate = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: ['observation-candidates'] })
        await queryClient.invalidateQueries({ queryKey: ['observation-candidate-audits'] })
    }, [queryClient])

    const decisionMutation = useMutation({
        mutationFn: async (input: { id: string; decision: ObservationDecision }) => {
            if (!props.orgId) throw new Error('orgId required')
            return await api.decideObservationCandidate(input.id, input.decision, props.orgId)
        },
        onSuccess: async () => {
            setPlanId('')
            setReason('')
            setSelectedId(null)
            await invalidate()
        },
    })

    const withReason = useCallback(<T extends ObservationDecision>(decision: T): T => {
        const trimmed = reason.trim()
        return trimmed ? { ...decision, reason: trimmed } : decision
    }, [reason])

    const decide = useCallback((id: string, decision: ObservationDecision) => {
        decisionMutation.mutate({ id, decision })
    }, [decisionMutation])

    if (!props.canManage || !props.orgId) return null

    const trimmedPlanId = planId.trim() || null

    return (
        <ObservationReviewContent
            statusFilter={statusFilter}
            onStatusFilterChange={(s) => {
                setStatusFilter(s)
                setSelectedId(null)
            }}
            candidates={candidates}
            selectedCandidate={selected}
            onSelectCandidate={setSelectedId}
            planId={planId}
            onPlanIdChange={setPlanId}
            reason={reason}
            onReasonChange={setReason}
            isLoading={candidatesQuery.isLoading}
            isDeciding={decisionMutation.isPending}
            error={candidatesQuery.error instanceof Error
                ? candidatesQuery.error.message
                : decisionMutation.error instanceof Error
                    ? decisionMutation.error.message
                    : null}
            onConfirm={(c) => decide(c.id, withReason({
                action: 'confirm',
                promotedCommunicationPlanId: trimmedPlanId,
            }))}
            onReject={(c) => decide(c.id, withReason({ action: 'reject' }))}
            onDismiss={(c) => decide(c.id, withReason({ action: 'dismiss' }))}
            onExpire={(c) => decide(c.id, withReason({ action: 'expire' }))}
        />
    )
}
