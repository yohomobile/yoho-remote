import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { Sheet, SheetContent, SheetClose } from '@/components/ui/sheet'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type {
    ApprovalDomainName,
    ApprovalMasterStatus,
    ApprovalRecord,
} from '@/types/api'

// Unified approvals review — single-column list of approvals across all 4
// domains. Click a row to open a right-side Sheet with full details +
// decision form. Sticks to var(--app-*) tokens so it slots cleanly into the
// host page.

const DOMAIN_OPTIONS: Array<{
    value: 'all' | ApprovalDomainName
    label: string
    activeGradient: string
}> = [
    { value: 'all', label: '全部', activeGradient: 'from-indigo-500 to-purple-600' },
    { value: 'identity', label: 'Identity', activeGradient: 'from-violet-500 to-purple-600' },
    { value: 'team_memory', label: 'Team Memory', activeGradient: 'from-sky-500 to-blue-600' },
    { value: 'observation', label: '观察假设', activeGradient: 'from-emerald-500 to-teal-600' },
    { value: 'memory_conflict', label: '记忆冲突', activeGradient: 'from-amber-500 to-orange-600' },
]

const STATUS_GRADIENT: Record<ApprovalMasterStatus, string> = {
    pending: 'from-amber-500 to-orange-600',
    approved: 'from-emerald-500 to-teal-600',
    rejected: 'from-rose-500 to-red-600',
    dismissed: 'from-slate-500 to-slate-600',
    expired: 'from-slate-500 to-slate-600',
}

const STATUS_OPTIONS: ApprovalMasterStatus[] = ['pending', 'approved', 'rejected', 'dismissed', 'expired']

const STATUS_LABEL: Record<ApprovalMasterStatus, string> = {
    pending: '待审',
    approved: '已批准',
    rejected: '已驳回',
    dismissed: '已忽略',
    expired: '已过期',
}

const DOMAIN_TONE: Record<string, { dot: string; badge: string; accent: string }> = {
    identity: {
        dot: 'bg-violet-500',
        badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
        accent: 'text-violet-600 dark:text-violet-400',
    },
    team_memory: {
        dot: 'bg-sky-500',
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
        accent: 'text-sky-600 dark:text-sky-400',
    },
    observation: {
        dot: 'bg-emerald-500',
        badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        accent: 'text-emerald-600 dark:text-emerald-400',
    },
    memory_conflict: {
        dot: 'bg-amber-500',
        badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        accent: 'text-amber-700 dark:text-amber-400',
    },
}

const DOMAIN_LABEL: Record<string, string> = {
    identity: 'Identity',
    team_memory: 'Team Memory',
    observation: '观察假设',
    memory_conflict: '记忆冲突',
}

const STATUS_TONE: Record<ApprovalMasterStatus, string> = {
    pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    approved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    rejected: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    dismissed: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
    expired: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
}

// --- per-action form metadata ---------------------------------------------
type ExtraField = {
    name: string
    label: string
    type: 'text' | 'select'
    required?: boolean
    options?: string[]
    placeholder?: string
}

type DomainAction = {
    value: string
    label: string
    fields?: ExtraField[]
    tone?: 'primary' | 'success' | 'danger' | 'neutral'
}

const ACTIONS_BY_DOMAIN: Record<string, DomainAction[]> = {
    identity: [
        {
            value: 'confirm_existing_person',
            label: '关联到已有 Person',
            tone: 'success',
            fields: [{ name: 'personId', label: 'personId', type: 'text', required: true, placeholder: 'person_xxxxxxxx' }],
        },
        {
            value: 'create_person_and_confirm',
            label: '新建 Person 并关联',
            tone: 'primary',
            fields: [
                { name: 'createPerson.canonicalName', label: '姓名', type: 'text', placeholder: '可选' },
                { name: 'createPerson.canonicalEmail', label: '邮箱', type: 'text', placeholder: '可选' },
                { name: 'createPerson.description', label: '描述', type: 'text', placeholder: '可选' },
            ],
        },
        { value: 'mark_shared', label: '标记为共享身份', tone: 'neutral' },
        { value: 'reject', label: '驳回', tone: 'danger' },
    ],
    team_memory: [
        {
            value: 'approve',
            label: '批准',
            tone: 'success',
            fields: [{ name: 'memoryRef', label: 'memoryRef', type: 'text', placeholder: '可选' }],
        },
        {
            value: 'supersede',
            label: '覆盖旧版',
            tone: 'primary',
            fields: [{ name: 'memoryRef', label: 'memoryRef', type: 'text', placeholder: '指向旧记忆 ref' }],
        },
        { value: 'reject', label: '驳回', tone: 'danger' },
        { value: 'expire', label: '过期', tone: 'neutral' },
    ],
    observation: [
        {
            value: 'confirm',
            label: '确认假设',
            tone: 'success',
            fields: [
                {
                    name: 'promotedCommunicationPlanId',
                    label: '手动 plan id',
                    type: 'text',
                    placeholder: '留空走 auto-promote',
                },
            ],
        },
        { value: 'reject', label: '驳回', tone: 'danger' },
        { value: 'dismiss', label: '忽略', tone: 'neutral' },
        { value: 'expire', label: '过期', tone: 'neutral' },
    ],
    memory_conflict: [
        {
            value: 'resolve',
            label: '解决',
            tone: 'success',
            fields: [
                {
                    name: 'resolution',
                    label: '解决方式',
                    type: 'select',
                    required: true,
                    options: ['keep_a', 'keep_b', 'supersede', 'discard_all', 'mark_expired'],
                },
            ],
        },
        { value: 'dismiss', label: '忽略', tone: 'neutral' },
        { value: 'reopen', label: '重新打开', tone: 'primary' },
    ],
}

const TONE_BUTTON_CLASS: Record<NonNullable<DomainAction['tone']>, string> = {
    primary: 'bg-[var(--app-button)] text-white hover:opacity-90 disabled:opacity-50',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-600/50',
    neutral: 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-divider)] disabled:opacity-50',
}

function setNestedField(target: Record<string, unknown>, dotPath: string, value: unknown): void {
    const parts = dotPath.split('.')
    let cursor = target
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]!
        if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
        cursor = cursor[key] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1]!] = value
}

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function relativeTime(ts: number): string {
    const diff = Date.now() - ts
    const m = Math.floor(diff / 60_000)
    if (m < 1) return '刚刚'
    if (m < 60) return `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d} 天前`
    return formatTimestamp(ts)
}

// Short, human-friendly title for a list row. Reads from payload when
// available, falls back to subjectKey.
function buildRowTitle(record: ApprovalRecord, payload: Record<string, unknown> | null): string {
    if (!payload) {
        return record.subjectKey
    }
    if (record.domain === 'team_memory' && typeof payload.content === 'string') {
        const c = payload.content as string
        return c.length > 80 ? `${c.slice(0, 80)}…` : c
    }
    if (record.domain === 'observation' && typeof payload.summary === 'string') {
        return payload.summary as string
    }
    if (record.domain === 'memory_conflict' && typeof payload.summary === 'string') {
        return payload.summary as string
    }
    if (record.domain === 'identity') {
        const score = typeof payload.score === 'number' ? Math.round(payload.score * 100) : null
        const target = payload.candidate_person_id ? `→ ${payload.candidate_person_id}` : '→ 待新建'
        return `${target}${score !== null ? ` · 匹配 ${score}%` : ''}`
    }
    return record.subjectKey
}

// ============================================================================
// Main panel

export function ApprovalReviewPanel() {
    const { currentOrgId, api: apiClient } = useAppContext()
    const queryClient = useQueryClient()
    const [domainFilter, setDomainFilter] = useState<'all' | ApprovalDomainName>('all')
    const [statusFilter, setStatusFilter] = useState<ApprovalMasterStatus>('pending')
    const [openId, setOpenId] = useState<string | null>(null)

    const domainParam = domainFilter === 'all' ? null : domainFilter

    const listQuery = useQuery({
        queryKey: queryKeys.approvals(currentOrgId, domainParam, statusFilter),
        queryFn: () => apiClient.getApprovals({
            orgId: currentOrgId!,
            domain: domainParam,
            status: statusFilter,
            limit: 100,
        }),
        enabled: !!currentOrgId,
    })

    const approvals = listQuery.data?.approvals ?? []

    if (!currentOrgId) {
        return (
            <div className="rounded-lg bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
                请先选择组织。审批数据按 org 隔离。
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            <FilterBar
                domain={domainFilter}
                onDomainChange={setDomainFilter}
                status={statusFilter}
                onStatusChange={setStatusFilter}
                count={approvals.length}
                isLoading={listQuery.isLoading}
            />

            <div className="flex-1 overflow-y-auto min-h-0">
                {listQuery.isLoading && (
                    <div className="p-8 flex justify-center"><Spinner /></div>
                )}
                {!listQuery.isLoading && approvals.length === 0 && (
                    <div className="rounded-lg bg-[var(--app-subtle-bg)] mt-3 p-8 text-center">
                        <div className="text-sm text-[var(--app-hint)]">
                            暂无{STATUS_LABEL[statusFilter]}审批
                        </div>
                    </div>
                )}
                {!listQuery.isLoading && approvals.length > 0 && (
                    <ul className="divide-y divide-[var(--app-divider)] rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden mt-3">
                        {approvals.map((a) => (
                            <li key={a.id}>
                                <ApprovalRow approval={a} onClick={() => setOpenId(a.id)} />
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <Sheet open={!!openId} onOpenChange={(open) => { if (!open) setOpenId(null) }}>
                <SheetContent className="!max-w-2xl">
                    {openId && <DetailSheetContent approvalId={openId} onClose={() => setOpenId(null)} />}
                </SheetContent>
            </Sheet>
        </div>
    )
}

// ============================================================================
// Filter bar

function FilterBar(props: {
    domain: 'all' | ApprovalDomainName
    onDomainChange: (v: 'all' | ApprovalDomainName) => void
    status: ApprovalMasterStatus
    onStatusChange: (v: ApprovalMasterStatus) => void
    count: number
    isLoading: boolean
}) {
    return (
        <div className="flex flex-wrap items-center gap-2 py-2 border-b border-[var(--app-divider)]">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <span className="text-[11px] text-[var(--app-hint)] shrink-0">域</span>
                {DOMAIN_OPTIONS.map((o) => {
                    const isActive = props.domain === o.value
                    return (
                        <button
                            key={o.value}
                            type="button"
                            onClick={() => props.onDomainChange(o.value)}
                            className={`px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                                isActive
                                    ? `bg-gradient-to-r ${o.activeGradient} text-white shadow-sm`
                                    : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                            }`}
                        >
                            {o.label}
                        </button>
                    )
                })}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <span className="text-[11px] text-[var(--app-hint)] shrink-0">状态</span>
                {STATUS_OPTIONS.map((s) => {
                    const isActive = props.status === s
                    return (
                        <button
                            key={s}
                            type="button"
                            onClick={() => props.onStatusChange(s)}
                            className={`px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                                isActive
                                    ? `bg-gradient-to-r ${STATUS_GRADIENT[s]} text-white shadow-sm`
                                    : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                            }`}
                        >
                            {STATUS_LABEL[s]}
                        </button>
                    )
                })}
            </div>
            <div className="ml-auto text-[11px] text-[var(--app-hint)]">
                {props.isLoading ? '加载中...' : `${props.count} 条`}
            </div>
        </div>
    )
}

// ============================================================================
// Row

function ApprovalRow({ approval, onClick }: { approval: ApprovalRecord; onClick: () => void }) {
    const tone = DOMAIN_TONE[approval.domain]
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full text-left px-4 py-3 hover:bg-[var(--app-secondary-bg)] transition-colors flex items-start gap-3"
        >
            <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${tone?.dot ?? 'bg-zinc-400'}`} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${tone?.accent ?? 'text-[var(--app-hint)]'}`}>
                        {DOMAIN_LABEL[approval.domain] ?? approval.domain}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_TONE[approval.status]}`}>
                        {STATUS_LABEL[approval.status]}
                    </span>
                    <span className="ml-auto text-[10px] text-[var(--app-hint)]">{relativeTime(approval.createdAt)}</span>
                </div>
                <div className="text-sm text-[var(--app-fg)] truncate" title={approval.subjectKey}>
                    {approval.subjectKey}
                </div>
            </div>
            <ChevronRightIcon className="h-4 w-4 text-[var(--app-hint)] shrink-0 mt-1" />
        </button>
    )
}

function ChevronRightIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function CloseIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

// ============================================================================
// Detail sheet — owns its own state because it is unmounted on close

function DetailSheetContent({ approvalId, onClose }: { approvalId: string; onClose: () => void }) {
    const { currentOrgId, api: apiClient } = useAppContext()
    const queryClient = useQueryClient()
    const [actionKey, setActionKey] = useState<string>('')
    const [reason, setReason] = useState<string>('')
    const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
    const [error, setError] = useState<string | null>(null)
    const [hint, setHint] = useState<string | null>(null)
    const [showRawPayload, setShowRawPayload] = useState(false)

    const detailQuery = useQuery({
        queryKey: queryKeys.approvalDetail(currentOrgId, approvalId),
        queryFn: () => apiClient.getApproval(approvalId, currentOrgId!),
        enabled: !!currentOrgId,
    })

    const selected = detailQuery.data?.approval ?? null
    const payload = (detailQuery.data?.payload ?? null) as Record<string, unknown> | null

    const availableActions = useMemo(() => {
        if (!selected) return []
        return ACTIONS_BY_DOMAIN[selected.domain] ?? []
    }, [selected])

    const currentAction = availableActions.find((a) => a.value === actionKey)
    const currentActionFields = currentAction?.fields ?? []
    const currentActionTone = currentAction?.tone ?? 'primary'

    const decideMutation = useMutation({
        mutationFn: async (args: { id: string; body: Record<string, unknown> }) => {
            return await apiClient.decideApproval(args.id, args.body as { action: string }, currentOrgId!)
        },
        onSuccess: (result) => {
            setError(null)
            if (result.effectsError) {
                setHint(`决策已提交，但 effects 失败：${result.effectsError}`)
            } else if (result.effectsMeta && Object.keys(result.effectsMeta).length > 0) {
                setHint(`决策成功 · 副作用：${JSON.stringify(result.effectsMeta)}`)
            } else {
                setHint('决策已提交')
            }
            queryClient.invalidateQueries({ queryKey: queryKeys.approvals(currentOrgId) })
            queryClient.invalidateQueries({ queryKey: queryKeys.approvalDetail(currentOrgId, result.approval.id) })
            setActionKey('')
            setReason('')
            setFieldValues({})
        },
        onError: (err: unknown) => {
            setError(err instanceof Error ? err.message : String(err))
        },
    })

    const handleSubmit = () => {
        if (!selected || !actionKey) return
        const body: Record<string, unknown> = { action: actionKey, reason: reason || null }
        for (const field of currentActionFields) {
            const raw = (fieldValues[field.name] ?? '').trim()
            if (!raw) {
                if (field.required) {
                    setError(`${field.label} 是必填项`)
                    return
                }
                continue
            }
            setNestedField(body, field.name, raw)
        }
        setError(null)
        decideMutation.mutate({ id: selected.id, body })
    }

    const tone = selected ? DOMAIN_TONE[selected.domain] : null
    const isPending = selected?.status === 'pending'

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-start gap-3 pb-3 border-b border-[var(--app-divider)]">
                <div className="flex-1 min-w-0">
                    {selected ? (
                        <>
                            <div className="flex items-center gap-2 mb-1">
                                <span className={`h-2 w-2 rounded-full shrink-0 ${tone?.dot ?? 'bg-zinc-400'}`} />
                                <span className={`text-[10px] font-semibold uppercase tracking-wide ${tone?.accent ?? 'text-[var(--app-hint)]'}`}>
                                    {DOMAIN_LABEL[selected.domain] ?? selected.domain}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_TONE[selected.status]}`}>
                                    {STATUS_LABEL[selected.status]}
                                </span>
                            </div>
                            <div className="text-sm font-medium text-[var(--app-fg)] break-all">
                                {selected.subjectKey}
                            </div>
                            <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                创建于 {formatTimestamp(selected.createdAt)}
                                {selected.decidedAt
                                    ? ` · 决定于 ${formatTimestamp(selected.decidedAt)} by ${selected.decidedBy ?? '系统'}`
                                    : ''}
                            </div>
                        </>
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">加载中...</div>
                    )}
                </div>
                <SheetClose asChild>
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] transition-colors"
                        aria-label="关闭"
                    >
                        <CloseIcon className="h-4 w-4" />
                    </button>
                </SheetClose>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto py-3 space-y-4 min-h-0">
                {detailQuery.isLoading && (
                    <div className="p-8 flex justify-center"><Spinner /></div>
                )}

                {selected && (
                    <ContextPanel domain={selected.domain} />
                )}

                {selected && payload && (
                    <PayloadSection
                        domain={selected.domain}
                        payload={payload}
                        showRaw={showRawPayload}
                        onToggleRaw={() => setShowRawPayload((v) => !v)}
                    />
                )}

                {selected?.decisionReason && (
                    <div className="rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3 text-xs text-[var(--app-hint)]">
                        <span className="font-semibold uppercase tracking-wide text-[10px]">决策原因</span>
                        <div className="mt-1 italic">{selected.decisionReason}</div>
                    </div>
                )}

                {selected && isPending && availableActions.length > 0 && (
                    <DecisionForm
                        availableActions={availableActions}
                        actionKey={actionKey}
                        onActionKeyChange={(value) => {
                            setActionKey(value)
                            setFieldValues({})
                            setError(null)
                        }}
                        fields={currentActionFields}
                        fieldValues={fieldValues}
                        onFieldValueChange={(name, value) =>
                            setFieldValues((prev) => ({ ...prev, [name]: value }))
                        }
                        reason={reason}
                        onReasonChange={setReason}
                        onSubmit={handleSubmit}
                        tone={currentActionTone}
                        isSubmitting={decideMutation.isPending}
                    />
                )}

                {error && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 break-all">
                        {error}
                    </div>
                )}
                {hint && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 break-all">
                        {hint}
                    </div>
                )}
            </div>
        </div>
    )
}

// ============================================================================
// Payload — domain-specific friendly views, fall back to JSON

function PayloadSection({ domain, payload, showRaw, onToggleRaw }: {
    domain: string
    payload: Record<string, unknown> | null
    showRaw: boolean
    onToggleRaw: () => void
}) {
    return (
        <section>
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide">详情</h3>
                <button
                    type="button"
                    onClick={onToggleRaw}
                    className="text-[11px] text-[var(--app-link)] hover:underline"
                >
                    {showRaw ? '友好视图' : 'JSON'}
                </button>
            </div>
            {showRaw || !payload
                ? <RawJsonView value={payload} />
                : <DomainPayloadView domain={domain} payload={payload} />
            }
        </section>
    )
}

function RawJsonView({ value }: { value: unknown }) {
    return (
        <pre className="text-[11px] font-mono bg-[var(--app-bg)] border border-[var(--app-divider)] rounded-lg p-3 overflow-x-auto max-h-[400px] leading-relaxed">
            {JSON.stringify(value, null, 2)}
        </pre>
    )
}

function DomainPayloadView({ domain, payload }: { domain: string; payload: Record<string, unknown> }) {
    if (domain === 'team_memory') return <TeamMemoryPayload p={payload} />
    if (domain === 'observation') return <ObservationPayload p={payload} />
    if (domain === 'memory_conflict') return <MemoryConflictPayload p={payload} />
    if (domain === 'identity') return <IdentityPayload p={payload} />
    return <RawJsonView value={payload} />
}

// "决策上下文" — 在 payload 之前讲清楚这是啥、为什么要决策、批/拒分别怎样。
// 文案与每个 domain 的 effects 实现强绑定；effect 没真接通的部分用 ⚠️ 标出来，
// 避免审批人误以为按了"批准"就万事大吉。
function ContextPanel({ domain }: { domain: string }) {
    const ctx = DOMAIN_CONTEXT[domain]
    if (!ctx) return null
    return (
        <section>
            <h3 className="text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">这是什么 / 为什么要决策</h3>
            <div className="rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3 space-y-2.5 text-xs leading-relaxed">
                <p className="text-[var(--app-fg)]">{ctx.what}</p>
                <p className="text-[var(--app-hint)]">
                    <span className="font-medium text-[var(--app-fg)]">为什么要你审批：</span>{ctx.why}
                </p>
                <div className="space-y-1 pt-1.5 border-t border-[var(--app-divider)]">
                    {ctx.outcomes.map((o, i) => (
                        <div key={i} className="flex items-start gap-2">
                            <span className={`mt-0.5 inline-block w-1 h-1 rounded-full shrink-0 ${
                                o.tone === 'positive' ? 'bg-emerald-500'
                                : o.tone === 'negative' ? 'bg-rose-500'
                                : 'bg-[var(--app-hint)]'
                            }`} />
                            <div className="flex-1">
                                <span className="font-medium text-[var(--app-fg)]">{o.action}</span>
                                <span className="text-[var(--app-hint)]"> · {o.effect}</span>
                                {o.warn && (
                                    <span className="ml-1 px-1 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                        ⚠ {o.warn}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}

type DomainContext = {
    what: string
    why: string
    outcomes: Array<{
        action: string
        effect: string
        tone: 'positive' | 'negative' | 'neutral'
        warn?: string
    }>
}

const DOMAIN_CONTEXT: Record<string, DomainContext> = {
    identity: {
        what: '系统在某个渠道（飞书 / 邮件 / CLI 等）看到一个新身份，但匹配到多个候选 Person 或没把握，请人工裁决归属。',
        why: 'identity 自动绑定误判会让别人的会话/记忆错挂到你账号上，影响隐私和审计。匹配分低或风险标志命中时由人工判断。',
        outcomes: [
            { action: '关联到已有 Person', effect: '此 identity 绑定到指定 person；今后此渠道的所有发言都视为同一人，参与统一记忆/会话。', tone: 'positive' },
            { action: '新建 Person 并关联', effect: '建一个新 person 并绑定；该人可被其他渠道继续关联。', tone: 'positive' },
            { action: '标记为共享身份', effect: '标记为非个人账号（如 #channel / 服务账号），不归属任何 person。', tone: 'neutral' },
            { action: '驳回', effect: '本次不绑定。同候选不再重复打扰你。', tone: 'negative' },
        ],
    },
    team_memory: {
        what: '组织成员提议把一条规则/约定写入团队共享知识库（yoho-vault 的 team/ 命名空间），所有人召回时会读到。',
        why: '团队共享记忆是高权限写入，会影响所有人的 AI 决策上下文，必须 org admin 批准；同时防止低质量/错误事实污染共享池。',
        outcomes: [
            { action: '批准', effect: '记录决策 + 标记 memory_ref。', tone: 'positive', warn: '当前未真正写入 yoho-vault；后续接通后会自动 remember' },
            { action: '覆盖旧版', effect: '声明此条替换某个旧 memory_ref。', tone: 'positive', warn: '当前未真正替换旧记忆' },
            { action: '驳回', effect: '不写入团队记忆库；同提议人短期内不再重复同样内容。', tone: 'negative' },
            { action: '过期', effect: '候选超过保留期，自动清理。', tone: 'neutral' },
        ],
    },
    observation: {
        what: 'K1 detector 在多次会话里观察到某个 person 表现出某种偏好（如「要更短回复」「要更详细解释」），生成一条"假设"等你确认。',
        why: '把假设直接写成事实风险大（错误标签会被 AI 当真）。必须由本人或 admin 确认后才升级为 communicationPlan，让 Brain 在后续会话里调整风格。',
        outcomes: [
            { action: '确认假设', effect: '把 suggested_patch 写入此人的 communicationPlan；后续 Brain 会话会按这些 hint 调整 length/tone/explanationDepth。', tone: 'positive', warn: '当前 demo 数据 person_id 为空时会跳过 auto-promote' },
            { action: '驳回', effect: '明确否决，detector 短期不再生成同 hypothesis_key。', tone: 'negative' },
            { action: '忽略', effect: '暂不处理也不否决，候选静默归档。', tone: 'neutral' },
            { action: '过期', effect: '超过 TTL 自动隐藏。', tone: 'neutral' },
        ],
    },
    memory_conflict: {
        what: 'worker 扫描发现同一主体下有多条互相矛盾的记忆（如「onboarding 周一 / 周三」），需要人工裁决保留哪条。',
        why: '冲突解决的正确性取决于业务上下文，自动合并/删除可能丢失正确信息或保留错的版本，所以由 admin 裁决。',
        outcomes: [
            { action: '解决（keep_a / keep_b / supersede / discard_all / mark_expired）', effect: '记录裁决方式。', tone: 'positive', warn: '当前未真正应用裁决（未删除/合并冲突项）；接通 yoho-vault forget 后会自动执行' },
            { action: '忽略', effect: '暂不处理，冲突候选保留为已忽略。', tone: 'neutral' },
            { action: '重新打开', effect: '把已解决的冲突回滚为待审，重新进入决策流。', tone: 'neutral' },
        ],
    },
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[100px_1fr] gap-3 text-xs items-baseline">
            <div className="text-[var(--app-hint)] text-[11px] font-medium">{label}</div>
            <div className="text-[var(--app-fg)] break-words">{children}</div>
        </div>
    )
}

function emptyDash(v: unknown): React.ReactNode {
    if (v === null || v === undefined || v === '') {
        return <span className="text-[var(--app-hint)]">—</span>
    }
    return String(v)
}

function PayloadCard({ children }: { children: React.ReactNode }) {
    return (
        <div className="space-y-2.5 rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3">
            {children}
        </div>
    )
}

function TeamMemoryPayload({ p }: { p: Record<string, unknown> }) {
    return (
        <PayloadCard>
            <FieldRow label="提议人">{emptyDash(p.proposed_by_email ?? p.proposed_by_person_id)}</FieldRow>
            <FieldRow label="范围">{emptyDash(p.scope)}</FieldRow>
            <FieldRow label="memory_ref">{emptyDash(p.memory_ref)}</FieldRow>
            <FieldRow label="来源">{emptyDash(p.source)}</FieldRow>
            <FieldRow label="内容">
                <div className="whitespace-pre-wrap leading-relaxed text-[var(--app-fg)]">{String(p.content ?? '')}</div>
            </FieldRow>
        </PayloadCard>
    )
}

function ObservationPayload({ p }: { p: Record<string, unknown> }) {
    const confidence = typeof p.confidence === 'number' ? Math.round(p.confidence * 100) : null
    const signals = Array.isArray(p.signals) ? p.signals : []
    return (
        <PayloadCard>
            <FieldRow label="主体">{emptyDash(p.subject_email ?? p.subject_person_id)}</FieldRow>
            <FieldRow label="hypothesis">
                <code className="text-[11px] font-mono">{String(p.hypothesis_key ?? '')}</code>
            </FieldRow>
            <FieldRow label="置信度">
                {confidence !== null ? (
                    <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-[var(--app-divider)] overflow-hidden max-w-[180px]">
                            <div className="h-full bg-emerald-500" style={{ width: `${confidence}%` }} />
                        </div>
                        <span className="text-[var(--app-fg)] font-mono text-[11px]">{confidence}%</span>
                    </div>
                ) : <span className="text-[var(--app-hint)]">—</span>}
            </FieldRow>
            <FieldRow label="摘要">
                <div className="font-medium">{String(p.summary ?? '')}</div>
            </FieldRow>
            {p.detail ? (
                <FieldRow label="详情">
                    <div className="whitespace-pre-wrap text-[var(--app-hint)] leading-relaxed">{String(p.detail)}</div>
                </FieldRow>
            ) : null}
            {signals.length > 0 && (
                <FieldRow label="信号">
                    <ul className="space-y-1">
                        {signals.map((s, i) => {
                            const sig = s as Record<string, unknown>
                            return (
                                <li key={i} className="flex items-baseline gap-2">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-mono">
                                        {String(sig.kind ?? '?')}
                                    </span>
                                    <span className="text-[var(--app-hint)]">{String(sig.summary ?? '')}</span>
                                </li>
                            )
                        })}
                    </ul>
                </FieldRow>
            )}
            {p.suggested_patch ? (
                <FieldRow label="建议 patch">
                    <pre className="text-[11px] font-mono bg-[var(--app-secondary-bg)] rounded p-2 overflow-x-auto">
                        {JSON.stringify(p.suggested_patch, null, 2)}
                    </pre>
                </FieldRow>
            ) : null}
            {p.promoted_communication_plan_id ? (
                <FieldRow label="已晋升 plan">
                    <code className="text-[11px] font-mono">{String(p.promoted_communication_plan_id)}</code>
                </FieldRow>
            ) : null}
        </PayloadCard>
    )
}

function MemoryConflictPayload({ p }: { p: Record<string, unknown> }) {
    const entries = Array.isArray(p.entries) ? p.entries : []
    return (
        <PayloadCard>
            <FieldRow label="范围">{emptyDash(p.scope)}</FieldRow>
            <FieldRow label="检测器">
                <code className="text-[11px] font-mono">{String(p.detector_version ?? '')}</code>
            </FieldRow>
            <FieldRow label="resolution">
                {p.resolution
                    ? <code className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">{String(p.resolution)}</code>
                    : <span className="text-[var(--app-hint)]">未决</span>
                }
            </FieldRow>
            <FieldRow label="摘要">
                <div className="leading-relaxed">{String(p.summary ?? '')}</div>
            </FieldRow>
            {entries.length > 0 && (
                <FieldRow label="冲突项">
                    <ul className="space-y-2">
                        {entries.map((e, i) => {
                            const entry = e as Record<string, unknown>
                            return (
                                <li
                                    key={i}
                                    className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] p-2.5 text-[11px]"
                                >
                                    <div className="flex items-center gap-2 mb-1 text-[var(--app-hint)]">
                                        <span className="font-mono">#{i + 1}</span>
                                        <span>{String(entry.actor ?? '系统')}</span>
                                        {entry.capturedAt ? (
                                            <span className="ml-auto">
                                                {formatTimestamp(Number(entry.capturedAt) * 1000)}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="text-[var(--app-fg)] leading-relaxed">{String(entry.content ?? '')}</div>
                                </li>
                            )
                        })}
                    </ul>
                </FieldRow>
            )}
        </PayloadCard>
    )
}

function IdentityPayload({ p }: { p: Record<string, unknown> }) {
    const score = typeof p.score === 'number' ? Math.round(p.score * 100) : null
    const riskFlags = Array.isArray(p.risk_flags) ? p.risk_flags : []
    return (
        <PayloadCard>
            <FieldRow label="identity_id">
                <code className="text-[11px] font-mono">{String(p.identity_id)}</code>
            </FieldRow>
            <FieldRow label="候选 person">
                {p.candidate_person_id
                    ? <code className="text-[11px] font-mono">{String(p.candidate_person_id)}</code>
                    : <span className="text-[var(--app-hint)]">无（待新建）</span>
                }
            </FieldRow>
            <FieldRow label="匹配分">
                {score !== null ? (
                    <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-[var(--app-divider)] overflow-hidden max-w-[180px]">
                            <div className="h-full bg-violet-500" style={{ width: `${score}%` }} />
                        </div>
                        <span className="font-mono text-[11px]">{score}%</span>
                    </div>
                ) : <span className="text-[var(--app-hint)]">—</span>}
            </FieldRow>
            <FieldRow label="auto_action">{emptyDash(p.auto_action)}</FieldRow>
            <FieldRow label="matcher">{emptyDash(p.matcher_version)}</FieldRow>
            {riskFlags.length > 0 && (
                <FieldRow label="风险">
                    <div className="flex flex-wrap gap-1">
                        {riskFlags.map((f, i) => (
                            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-700 dark:text-rose-300 font-mono">
                                {String(f)}
                            </span>
                        ))}
                    </div>
                </FieldRow>
            )}
        </PayloadCard>
    )
}

// ============================================================================
// Decision form

function DecisionForm(props: {
    availableActions: DomainAction[]
    actionKey: string
    onActionKeyChange: (v: string) => void
    fields: ExtraField[]
    fieldValues: Record<string, string>
    onFieldValueChange: (name: string, value: string) => void
    reason: string
    onReasonChange: (v: string) => void
    onSubmit: () => void
    tone: NonNullable<DomainAction['tone']>
    isSubmitting: boolean
}) {
    return (
        <section>
            <h3 className="text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">决策</h3>
            <div className="rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {props.availableActions.map((a) => {
                        const isActive = props.actionKey === a.value
                        return (
                            <button
                                key={a.value}
                                type="button"
                                onClick={() => props.onActionKeyChange(a.value)}
                                className={`px-2 py-1.5 rounded text-xs font-medium border transition-colors ${
                                    isActive
                                        ? 'border-[var(--app-button)] bg-[var(--app-button)]/10 text-[var(--app-button)]'
                                        : 'border-[var(--app-divider)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
                                }`}
                            >
                                {a.label}
                            </button>
                        )
                    })}
                </div>

                {props.fields.map((field) => (
                    <label key={field.name} className="block">
                        <span className="text-[11px] font-medium text-[var(--app-hint)]">
                            {field.label}{field.required ? ' *' : ''}
                        </span>
                        {field.type === 'select' ? (
                            <select
                                className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                                value={props.fieldValues[field.name] ?? ''}
                                onChange={(e) => props.onFieldValueChange(field.name, e.target.value)}
                            >
                                <option value="">— 选择 —</option>
                                {(field.options ?? []).map((opt) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </select>
                        ) : (
                            <input
                                type="text"
                                className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                                placeholder={field.placeholder ?? ''}
                                value={props.fieldValues[field.name] ?? ''}
                                onChange={(e) => props.onFieldValueChange(field.name, e.target.value)}
                            />
                        )}
                    </label>
                ))}

                <label className="block">
                    <span className="text-[11px] font-medium text-[var(--app-hint)]">原因（可选）</span>
                    <textarea
                        className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] resize-none"
                        rows={2}
                        value={props.reason}
                        onChange={(e) => props.onReasonChange(e.target.value)}
                    />
                </label>

                <button
                    type="button"
                    className={`w-full px-3 py-2 rounded text-sm font-medium transition-all ${TONE_BUTTON_CLASS[props.tone]}`}
                    disabled={!props.actionKey || props.isSubmitting}
                    onClick={props.onSubmit}
                >
                    {props.isSubmitting ? '提交中...' : '提交决策'}
                </button>
            </div>
        </section>
    )
}
