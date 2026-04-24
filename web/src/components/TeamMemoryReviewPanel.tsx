import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type {
    StoredTeamMemoryCandidate,
    TeamMemoryCandidateDecision,
    TeamMemoryCandidateStatus,
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

const STATUS_LABEL: Record<TeamMemoryCandidateStatus, string> = {
    pending: '待审批',
    approved: '已批准',
    rejected: '已驳回',
    superseded: '已替换',
    expired: '已过期',
}

const STATUS_OPTIONS: TeamMemoryCandidateStatus[] = ['pending', 'approved', 'rejected', 'superseded', 'expired']

type TeamMemoryContentProps = {
    statusFilter: TeamMemoryCandidateStatus
    onStatusFilterChange: (status: TeamMemoryCandidateStatus) => void
    candidates: StoredTeamMemoryCandidate[]
    selectedCandidate: StoredTeamMemoryCandidate | null
    onSelectCandidate: (id: string) => void
    memoryRef: string
    onMemoryRefChange: (value: string) => void
    reason: string
    onReasonChange: (value: string) => void
    isLoading: boolean
    isDeciding: boolean
    error: string | null
    onApprove: (candidate: StoredTeamMemoryCandidate) => void
    onSupersede: (candidate: StoredTeamMemoryCandidate) => void
    onReject: (candidate: StoredTeamMemoryCandidate) => void
    onExpire: (candidate: StoredTeamMemoryCandidate) => void
}

export function TeamMemoryReviewContent(props: TeamMemoryContentProps) {
    const {
        statusFilter,
        onStatusFilterChange,
        candidates,
        selectedCandidate,
        onSelectCandidate,
        memoryRef,
        onMemoryRefChange,
        reason,
        onReasonChange,
        isLoading,
        isDeciding,
        error,
        onApprove,
        onSupersede,
        onReject,
        onExpire,
    } = props

    return (
        <div id="section-team-memory-review" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">团队记忆审批</h3>
                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                        {candidates.length} {STATUS_LABEL[statusFilter]}候选
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={statusFilter}
                        onChange={(e) => onStatusFilterChange(e.target.value as TeamMemoryCandidateStatus)}
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

            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <div className="border-r border-[var(--app-divider)] max-h-[360px] overflow-y-auto">
                    {candidates.length === 0 && !isLoading && (
                        <div className="px-3 py-6 text-center text-xs text-[var(--app-hint)]">
                            暂无{STATUS_LABEL[statusFilter]}候选
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
                                <div className="truncate font-medium text-[var(--app-fg)]">{candidate.content}</div>
                                <div className="mt-1 text-[10px] text-[var(--app-hint)] truncate">
                                    {candidate.proposedByEmail ?? 'unknown'} · {formatTimestamp(candidate.createdAt)}
                                </div>
                            </button>
                        )
                    })}
                </div>

                <div className="p-3">
                    {selectedCandidate ? (
                        <div className="space-y-3">
                            <div>
                                <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">记忆内容</div>
                                <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--app-fg)]">
                                    {selectedCandidate.content}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--app-hint)]">
                                <div>提议者：{selectedCandidate.proposedByEmail ?? '—'}</div>
                                <div>来源：{selectedCandidate.source ?? '—'}</div>
                                <div>状态：{STATUS_LABEL[selectedCandidate.status]}</div>
                                <div>更新：{formatTimestamp(selectedCandidate.updatedAt)}</div>
                            </div>
                            {selectedCandidate.memoryRef && (
                                <div className="text-[11px] text-[var(--app-hint)]">
                                    已关联 memoryRef：<code className="text-[var(--app-fg)]">{selectedCandidate.memoryRef}</code>
                                </div>
                            )}
                            {selectedCandidate.status === 'pending' && (
                                <>
                                    <label className="block">
                                        <div className="text-[10px] uppercase tracking-wide text-[var(--app-hint)]">memoryRef（可选）</div>
                                        <input
                                            type="text"
                                            value={memoryRef}
                                            onChange={(e) => onMemoryRefChange(e.target.value)}
                                            placeholder="如 team/domain/xxx"
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
                                            onClick={() => onApprove(selectedCandidate)}
                                            disabled={isDeciding}
                                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)] disabled:opacity-50"
                                        >
                                            批准
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onSupersede(selectedCandidate)}
                                            disabled={isDeciding}
                                            className="rounded-md bg-[var(--app-secondary-bg)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                                        >
                                            替换旧版
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
                        <div className="text-sm text-[var(--app-hint)]">选择一个候选查看详情</div>
                    )}
                </div>
            </div>
        </div>
    )
}

export function TeamMemoryReviewPanel(props: {
    orgId: string | null
    canManage: boolean
}) {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const [statusFilter, setStatusFilter] = useState<TeamMemoryCandidateStatus>('pending')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [memoryRef, setMemoryRef] = useState('')
    const [reason, setReason] = useState('')

    const candidatesQuery = useQuery({
        queryKey: queryKeys.teamMemoryCandidates(props.orgId, statusFilter),
        queryFn: async () => await api.getTeamMemoryCandidates({ orgId: props.orgId!, status: statusFilter }),
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
        await queryClient.invalidateQueries({ queryKey: ['team-memory-candidates'] })
        await queryClient.invalidateQueries({ queryKey: ['team-memory-candidate-audits'] })
    }, [queryClient])

    const decisionMutation = useMutation({
        mutationFn: async (input: { id: string; decision: TeamMemoryCandidateDecision }) => {
            if (!props.orgId) throw new Error('orgId required')
            return await api.decideTeamMemoryCandidate(input.id, input.decision, props.orgId)
        },
        onSuccess: async () => {
            setMemoryRef('')
            setReason('')
            setSelectedId(null)
            await invalidate()
        },
    })

    const withReason = useCallback(<T extends TeamMemoryCandidateDecision>(decision: T): T => {
        const trimmed = reason.trim()
        return trimmed ? { ...decision, reason: trimmed } : decision
    }, [reason])

    const decide = useCallback((id: string, decision: TeamMemoryCandidateDecision) => {
        decisionMutation.mutate({ id, decision })
    }, [decisionMutation])

    if (!props.canManage || !props.orgId) return null

    const trimmedRef = memoryRef.trim() || null

    return (
        <TeamMemoryReviewContent
            statusFilter={statusFilter}
            onStatusFilterChange={(s) => {
                setStatusFilter(s)
                setSelectedId(null)
            }}
            candidates={candidates}
            selectedCandidate={selected}
            onSelectCandidate={setSelectedId}
            memoryRef={memoryRef}
            onMemoryRefChange={setMemoryRef}
            reason={reason}
            onReasonChange={setReason}
            isLoading={candidatesQuery.isLoading}
            isDeciding={decisionMutation.isPending}
            error={candidatesQuery.error instanceof Error
                ? candidatesQuery.error.message
                : decisionMutation.error instanceof Error
                    ? decisionMutation.error.message
                    : null}
            onApprove={(c) => decide(c.id, withReason({ action: 'approve', memoryRef: trimmedRef }))}
            onSupersede={(c) => decide(c.id, withReason({ action: 'supersede', memoryRef: trimmedRef }))}
            onReject={(c) => decide(c.id, withReason({ action: 'reject' }))}
            onExpire={(c) => decide(c.id, withReason({ action: 'expire' }))}
        />
    )
}
