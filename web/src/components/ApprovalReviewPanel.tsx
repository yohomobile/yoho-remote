import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type {
    ApprovalDomainName,
    ApprovalMasterStatus,
    ApprovalRecord,
} from '@/types/api'

// Unified approvals review panel — lists approvals across all 4 domains,
// filters by domain + status, and lets the operator/admin decide via a
// per-domain dynamic form. Sticks to the Yoho Remote app design tokens
// (var(--app-*)) so it slots into any host page without a custom theme.

const DOMAIN_OPTIONS: Array<{ value: 'all' | ApprovalDomainName; label: string }> = [
    { value: 'all', label: '全部域' },
    { value: 'identity', label: 'Identity' },
    { value: 'team_memory', label: 'Team Memory' },
    { value: 'observation', label: '观察假设' },
    { value: 'memory_conflict', label: '记忆冲突' },
]

const STATUS_OPTIONS: ApprovalMasterStatus[] = ['pending', 'approved', 'rejected', 'dismissed', 'expired']

const STATUS_LABEL: Record<ApprovalMasterStatus, string> = {
    pending: '待审',
    approved: '已批准',
    rejected: '已驳回',
    dismissed: '已忽略',
    expired: '已过期',
}

// Tailwind palette per domain — distinct enough at a glance, muted enough to
// not fight with the page background.
const DOMAIN_TONE: Record<string, { badge: string; chipBg: string; chipFg: string }> = {
    identity: {
        badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30',
        chipBg: 'bg-violet-500/15',
        chipFg: 'text-violet-700 dark:text-violet-300',
    },
    team_memory: {
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
        chipBg: 'bg-sky-500/15',
        chipFg: 'text-sky-700 dark:text-sky-300',
    },
    observation: {
        badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
        chipBg: 'bg-emerald-500/15',
        chipFg: 'text-emerald-700 dark:text-emerald-300',
    },
    memory_conflict: {
        badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
        chipBg: 'bg-amber-500/15',
        chipFg: 'text-amber-700 dark:text-amber-300',
    },
}

const DOMAIN_LABEL_SHORT: Record<string, string> = {
    identity: 'Identity',
    team_memory: 'Memory',
    observation: 'Observation',
    memory_conflict: 'Conflict',
}

const STATUS_TONE: Record<ApprovalMasterStatus, string> = {
    pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    approved: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    rejected: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    dismissed: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
    expired: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
}

// Per-action extra-field metadata. Drives the dynamic form rendered after the
// action dropdown so users don't have to hand-write JSON. Field names with a
// dot path (e.g. `createPerson.canonicalName`) are nested when posted.
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
    /** Optional Tailwind class to color the submit button (e.g. destructive red for reject). */
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
            fields: [{ name: 'memoryRef', label: 'memoryRef', type: 'text', placeholder: '可选 — 留空将由后台分配' }],
        },
        {
            value: 'supersede',
            label: '覆盖旧版',
            tone: 'primary',
            fields: [{ name: 'memoryRef', label: 'memoryRef', type: 'text', placeholder: '指向被覆盖的旧记忆 ref' }],
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
    primary:
        'bg-[var(--app-button)] text-[var(--app-button-fg,white)] hover:opacity-90 disabled:opacity-50',
    success:
        'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/50',
    danger:
        'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-600/50',
    neutral:
        'bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-divider)] disabled:opacity-50',
}

function setNestedField(target: Record<string, unknown>, dotPath: string, value: unknown): void {
    const parts = dotPath.split('.')
    let cursor = target
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]!
        if (typeof cursor[key] !== 'object' || cursor[key] === null) {
            cursor[key] = {}
        }
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
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} 天前`
    return formatTimestamp(ts)
}

export function ApprovalReviewPanel() {
    const { currentOrgId, api: apiClient } = useAppContext()
    const queryClient = useQueryClient()
    const [domainFilter, setDomainFilter] = useState<'all' | ApprovalDomainName>('all')
    const [statusFilter, setStatusFilter] = useState<ApprovalMasterStatus>('pending')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [actionKey, setActionKey] = useState<string>('')
    const [reason, setReason] = useState<string>('')
    const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
    const [lastResultHint, setLastResultHint] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showRawPayload, setShowRawPayload] = useState(false)

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

    const detailQuery = useQuery({
        queryKey: queryKeys.approvalDetail(currentOrgId, selectedId),
        queryFn: () => apiClient.getApproval(selectedId!, currentOrgId!),
        enabled: !!selectedId && !!currentOrgId,
    })

    const selected = detailQuery.data?.approval ?? null
    const payload = (detailQuery.data?.payload ?? null) as Record<string, unknown> | null

    const availableActions = useMemo(() => {
        if (!selected) return []
        return ACTIONS_BY_DOMAIN[selected.domain] ?? []
    }, [selected])

    const currentAction = useMemo(() => {
        return availableActions.find((a) => a.value === actionKey)
    }, [availableActions, actionKey])

    const currentActionFields = currentAction?.fields ?? []
    const currentActionTone = currentAction?.tone ?? 'primary'

    const decideMutation = useMutation({
        mutationFn: async (args: { id: string; body: Record<string, unknown> }) => {
            return await apiClient.decideApproval(args.id, args.body as { action: string }, currentOrgId!)
        },
        onSuccess: (result) => {
            setError(null)
            if (result.effectsError) {
                setLastResultHint(`决策已提交，但 effects 失败：${result.effectsError}`)
            } else if (result.effectsMeta && Object.keys(result.effectsMeta).length > 0) {
                setLastResultHint(`决策成功 · 副作用：${JSON.stringify(result.effectsMeta)}`)
            } else {
                setLastResultHint('决策已提交')
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

    if (!currentOrgId) {
        return (
            <div className="rounded-lg bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
                请先选择组织。审批数据按 org 隔离。
            </div>
        )
    }

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-3 h-full min-h-0">
            <ApprovalListColumn
                domainFilter={domainFilter}
                onDomainFilterChange={setDomainFilter}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                approvals={approvals}
                selectedId={selectedId}
                onSelect={setSelectedId}
                isLoading={listQuery.isLoading}
            />
            <ApprovalDetailColumn
                selected={selected}
                payload={payload}
                isLoading={!!selectedId && detailQuery.isLoading}
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
                actionTone={currentActionTone}
                isSubmitting={decideMutation.isPending}
                error={error}
                hint={lastResultHint}
                showRawPayload={showRawPayload}
                onToggleRawPayload={() => setShowRawPayload((v) => !v)}
            />
        </div>
    )
}

// ============================================================================
// List column

function ApprovalListColumn(props: {
    domainFilter: 'all' | ApprovalDomainName
    onDomainFilterChange: (v: 'all' | ApprovalDomainName) => void
    statusFilter: ApprovalMasterStatus
    onStatusFilterChange: (v: ApprovalMasterStatus) => void
    approvals: ApprovalRecord[]
    selectedId: string | null
    onSelect: (id: string) => void
    isLoading: boolean
}) {
    return (
        <div className="flex flex-col rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden min-h-0">
            <div className="px-3 py-2.5 border-b border-[var(--app-divider)] space-y-2 bg-[var(--app-bg)]">
                <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                        <span className="text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide">域</span>
                        <select
                            className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                            value={props.domainFilter}
                            onChange={(e) => props.onDomainFilterChange(e.target.value as 'all' | ApprovalDomainName)}
                        >
                            {DOMAIN_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide">状态</span>
                        <select
                            className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                            value={props.statusFilter}
                            onChange={(e) => props.onStatusFilterChange(e.target.value as ApprovalMasterStatus)}
                        >
                            {STATUS_OPTIONS.map((s) => (
                                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                            ))}
                        </select>
                    </label>
                </div>
                <div className="text-[11px] text-[var(--app-hint)]">
                    {props.isLoading ? '加载中...' : `${props.approvals.length} 条`}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
                {props.isLoading && (
                    <div className="p-6 flex justify-center"><Spinner /></div>
                )}
                {!props.isLoading && props.approvals.length === 0 && (
                    <div className="p-6 text-center text-sm text-[var(--app-hint)]">
                        暂无{STATUS_LABEL[props.statusFilter]}审批
                    </div>
                )}
                <ul className="divide-y divide-[var(--app-divider)]">
                    {props.approvals.map((a) => (
                        <li key={a.id}>
                            <ApprovalRow
                                approval={a}
                                selected={a.id === props.selectedId}
                                onClick={() => props.onSelect(a.id)}
                            />
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    )
}

function ApprovalRow({ approval, selected, onClick }: {
    approval: ApprovalRecord
    selected: boolean
    onClick: () => void
}) {
    const tone = DOMAIN_TONE[approval.domain]
    const subjectKeyDisplay = approval.subjectKey.length > 60
        ? `…${approval.subjectKey.slice(-60)}`
        : approval.subjectKey
    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full text-left px-3 py-2.5 transition-colors ${
                selected
                    ? 'bg-[var(--app-button)]/10 border-l-2 border-[var(--app-button)]'
                    : 'hover:bg-[var(--app-secondary-bg)] border-l-2 border-transparent'
            }`}
        >
            <div className="flex items-center gap-1.5 mb-1">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${tone?.badge ?? 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30'}`}>
                    {DOMAIN_LABEL_SHORT[approval.domain] ?? approval.domain}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_TONE[approval.status]}`}>
                    {STATUS_LABEL[approval.status]}
                </span>
                <span className="ml-auto text-[10px] text-[var(--app-hint)]">{relativeTime(approval.createdAt)}</span>
            </div>
            <div className="text-xs font-mono text-[var(--app-fg)] truncate" title={approval.subjectKey}>
                {subjectKeyDisplay}
            </div>
        </button>
    )
}

// ============================================================================
// Detail column

function ApprovalDetailColumn(props: {
    selected: ApprovalRecord | null
    payload: Record<string, unknown> | null
    isLoading: boolean
    availableActions: DomainAction[]
    actionKey: string
    onActionKeyChange: (v: string) => void
    fields: ExtraField[]
    fieldValues: Record<string, string>
    onFieldValueChange: (name: string, value: string) => void
    reason: string
    onReasonChange: (v: string) => void
    onSubmit: () => void
    actionTone: NonNullable<DomainAction['tone']>
    isSubmitting: boolean
    error: string | null
    hint: string | null
    showRawPayload: boolean
    onToggleRawPayload: () => void
}) {
    const { selected, payload } = props

    if (!selected) {
        return (
            <div className="rounded-lg bg-[var(--app-subtle-bg)] flex items-center justify-center text-sm text-[var(--app-hint)] min-h-[200px]">
                {props.isLoading ? <Spinner /> : '从左侧选一条审批查看详情'}
            </div>
        )
    }

    const tone = DOMAIN_TONE[selected.domain]
    const isPending = selected.status === 'pending'

    return (
        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden flex flex-col min-h-0">
            {/* Header */}
            <div className="px-4 py-3 border-b border-[var(--app-divider)] bg-[var(--app-bg)]">
                <div className="flex items-center gap-2 mb-1.5">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${tone?.badge ?? 'bg-zinc-500/10 text-zinc-600 border-zinc-500/30'}`}>
                        {DOMAIN_LABEL_SHORT[selected.domain] ?? selected.domain}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${STATUS_TONE[selected.status]}`}>
                        {STATUS_LABEL[selected.status]}
                    </span>
                    <span className="ml-auto text-[11px] text-[var(--app-hint)] font-mono">{selected.id}</span>
                </div>
                <div className="text-xs font-mono text-[var(--app-fg)] break-all" title={selected.subjectKey}>
                    {selected.subjectKey}
                </div>
                <div className="text-[11px] text-[var(--app-hint)] mt-1.5">
                    创建于 {formatTimestamp(selected.createdAt)}
                    {selected.decidedAt
                        ? ` · 决定于 ${formatTimestamp(selected.decidedAt)} by ${selected.decidedBy ?? '系统'}`
                        : ''}
                </div>
                {selected.decisionReason && (
                    <div className="mt-1.5 text-[11px] text-[var(--app-hint)] italic">
                        原因：{selected.decisionReason}
                    </div>
                )}
            </div>

            {/* Body — payload + decision */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
                <PayloadSection
                    domain={selected.domain}
                    payload={payload}
                    showRaw={props.showRawPayload}
                    onToggleRaw={props.onToggleRawPayload}
                />

                {isPending && props.availableActions.length > 0 && (
                    <DecisionForm
                        availableActions={props.availableActions}
                        actionKey={props.actionKey}
                        onActionKeyChange={props.onActionKeyChange}
                        fields={props.fields}
                        fieldValues={props.fieldValues}
                        onFieldValueChange={props.onFieldValueChange}
                        reason={props.reason}
                        onReasonChange={props.onReasonChange}
                        onSubmit={props.onSubmit}
                        tone={props.actionTone}
                        isSubmitting={props.isSubmitting}
                    />
                )}

                {props.error && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 break-all">
                        {props.error}
                    </div>
                )}
                {props.hint && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 break-all">
                        {props.hint}
                    </div>
                )}
            </div>
        </div>
    )
}

// ============================================================================
// Payload — domain-specific renderers, falls back to JSON

function PayloadSection({ domain, payload, showRaw, onToggleRaw }: {
    domain: string
    payload: Record<string, unknown> | null
    showRaw: boolean
    onToggleRaw: () => void
}) {
    return (
        <section>
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] font-semibold text-[var(--app-hint)] uppercase tracking-wide">Payload</h3>
                <button
                    type="button"
                    onClick={onToggleRaw}
                    className="text-[11px] text-[var(--app-link)] hover:underline"
                >
                    {showRaw ? '友好视图' : '原始 JSON'}
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
        <pre className="text-[11px] font-mono bg-[var(--app-bg)] border border-[var(--app-divider)] rounded p-3 overflow-x-auto max-h-80 leading-relaxed">
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

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[110px_1fr] gap-2 text-xs">
            <div className="text-[var(--app-hint)] font-medium pt-0.5">{label}</div>
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

function TeamMemoryPayload({ p }: { p: Record<string, unknown> }) {
    return (
        <div className="space-y-2 rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3">
            <FieldRow label="提议人">
                {emptyDash(p.proposed_by_email ?? p.proposed_by_person_id)}
            </FieldRow>
            <FieldRow label="范围">{emptyDash(p.scope)}</FieldRow>
            <FieldRow label="memory_ref">{emptyDash(p.memory_ref)}</FieldRow>
            <FieldRow label="来源">{emptyDash(p.source)}</FieldRow>
            <FieldRow label="内容">
                <div className="whitespace-pre-wrap leading-relaxed">{String(p.content ?? '')}</div>
            </FieldRow>
        </div>
    )
}

function ObservationPayload({ p }: { p: Record<string, unknown> }) {
    const confidence = typeof p.confidence === 'number' ? Math.round(p.confidence * 100) : null
    const signals = Array.isArray(p.signals) ? p.signals : []
    return (
        <div className="space-y-2 rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3">
            <FieldRow label="主体">
                {emptyDash(p.subject_email ?? p.subject_person_id)}
            </FieldRow>
            <FieldRow label="hypothesis">{emptyDash(p.hypothesis_key)}</FieldRow>
            <FieldRow label="置信度">
                {confidence !== null ? (
                    <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-[var(--app-divider)] overflow-hidden max-w-[160px]">
                            <div
                                className="h-full bg-emerald-500"
                                style={{ width: `${confidence}%` }}
                            />
                        </div>
                        <span className="text-[var(--app-fg)] font-mono">{confidence}%</span>
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
        </div>
    )
}

function MemoryConflictPayload({ p }: { p: Record<string, unknown> }) {
    const entries = Array.isArray(p.entries) ? p.entries : []
    return (
        <div className="space-y-2 rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3">
            <FieldRow label="范围">{emptyDash(p.scope)}</FieldRow>
            <FieldRow label="检测器">{emptyDash(p.detector_version)}</FieldRow>
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
                                    className="rounded border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] p-2 text-[11px]"
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
                                    <div className="text-[var(--app-fg)]">{String(entry.content ?? '')}</div>
                                </li>
                            )
                        })}
                    </ul>
                </FieldRow>
            )}
        </div>
    )
}

function IdentityPayload({ p }: { p: Record<string, unknown> }) {
    const score = typeof p.score === 'number' ? Math.round(p.score * 100) : null
    const riskFlags = Array.isArray(p.risk_flags) ? p.risk_flags : []
    return (
        <div className="space-y-2 rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3">
            <FieldRow label="identity_id"><code className="text-[11px] font-mono">{String(p.identity_id)}</code></FieldRow>
            <FieldRow label="候选 person">
                {p.candidate_person_id
                    ? <code className="text-[11px] font-mono">{String(p.candidate_person_id)}</code>
                    : <span className="text-[var(--app-hint)]">无（待新建）</span>
                }
            </FieldRow>
            <FieldRow label="匹配分">
                {score !== null ? (
                    <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-[var(--app-divider)] overflow-hidden max-w-[160px]">
                            <div className="h-full bg-violet-500" style={{ width: `${score}%` }} />
                        </div>
                        <span className="font-mono">{score}%</span>
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
        </div>
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
            <h3 className="text-[11px] font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">决策</h3>
            <div className="rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] p-3 space-y-3">
                {/* Action segmented buttons */}
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

                {/* Per-action fields */}
                {props.fields.map((field) => (
                    <div key={field.name}>
                        <label className="block">
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
                    </div>
                ))}

                {/* Reason */}
                <label className="block">
                    <span className="text-[11px] font-medium text-[var(--app-hint)]">原因（可选）</span>
                    <textarea
                        className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] resize-none"
                        rows={2}
                        value={props.reason}
                        onChange={(e) => props.onReasonChange(e.target.value)}
                    />
                </label>

                {/* Submit */}
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
