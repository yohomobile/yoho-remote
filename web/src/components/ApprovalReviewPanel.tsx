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

// Unified审批 Panel — lists approvals across all domains, filters by domain +
// status, and lets the operator/admin decide via a domain-specific action
// dropdown. Payload is rendered as JSON; per-domain pretty views are wired via
// the DOMAIN_RENDERERS map below.

const DOMAIN_OPTIONS: Array<{ value: 'all' | ApprovalDomainName; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'identity', label: 'Identity 合并' },
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

// Per-action extra-field metadata. Drives the dynamic form rendered after the
// action dropdown so users don't have to hand-write JSON. Field names with a
// dot path (e.g. `createPerson.canonicalName`) are nested into the body as
// objects when posted.
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
}

const ACTIONS_BY_DOMAIN: Record<string, DomainAction[]> = {
    identity: [
        {
            value: 'confirm_existing_person',
            label: '关联已有 Person',
            fields: [{ name: 'personId', label: 'personId', type: 'text', required: true }],
        },
        {
            value: 'create_person_and_confirm',
            label: '新建 Person 并关联',
            fields: [
                { name: 'createPerson.canonicalName', label: '姓名（可选）', type: 'text' },
                { name: 'createPerson.canonicalEmail', label: '邮箱（可选）', type: 'text' },
                { name: 'createPerson.description', label: '描述（可选）', type: 'text' },
            ],
        },
        { value: 'mark_shared', label: '标记为共享身份' },
        { value: 'reject', label: '驳回' },
    ],
    team_memory: [
        {
            value: 'approve',
            label: '批准',
            fields: [{ name: 'memoryRef', label: 'memoryRef（可选）', type: 'text' }],
        },
        {
            value: 'supersede',
            label: '覆盖旧版',
            fields: [{ name: 'memoryRef', label: 'memoryRef（可选）', type: 'text' }],
        },
        { value: 'reject', label: '驳回' },
        { value: 'expire', label: '过期' },
    ],
    observation: [
        {
            value: 'confirm',
            label: '确认假设',
            fields: [
                {
                    name: 'promotedCommunicationPlanId',
                    label: '手动 plan id（留空走 auto-promote）',
                    type: 'text',
                },
            ],
        },
        { value: 'reject', label: '驳回' },
        { value: 'dismiss', label: '忽略' },
        { value: 'expire', label: '过期' },
    ],
    memory_conflict: [
        {
            value: 'resolve',
            label: '解决',
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
        { value: 'dismiss', label: '忽略' },
        { value: 'reopen', label: '重新打开' },
    ],
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
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
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
    const payload = detailQuery.data?.payload ?? null

    const availableActions = useMemo(() => {
        if (!selected) return []
        return ACTIONS_BY_DOMAIN[selected.domain] ?? []
    }, [selected])

    const currentActionFields = useMemo(() => {
        if (!actionKey) return []
        return availableActions.find((a) => a.value === actionKey)?.fields ?? []
    }, [availableActions, actionKey])

    const decideMutation = useMutation({
        mutationFn: async (args: { id: string; body: Record<string, unknown> }) => {
            return await apiClient.decideApproval(args.id, args.body as { action: string }, currentOrgId!)
        },
        onSuccess: (result) => {
            setError(null)
            if (result.effectsError) {
                setLastResultHint(`决策已提交，但 effects 失败：${result.effectsError}`)
            } else if (result.effectsMeta && Object.keys(result.effectsMeta).length > 0) {
                setLastResultHint(`决策成功 + 副作用：${JSON.stringify(result.effectsMeta)}`)
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
        return <div className="p-4 text-sm text-gray-500">请先选择组织</div>
    }

    return (
        <div className="flex h-full">
            <div className="w-96 border-r bg-gray-50 flex flex-col">
                <div className="p-3 border-b space-y-2 bg-white">
                    <div className="flex gap-2">
                        <label className="text-xs text-gray-600 flex-1">
                            域
                            <select
                                className="w-full mt-1 text-xs px-2 py-1 border rounded"
                                value={domainFilter}
                                onChange={(e) => setDomainFilter(e.target.value as 'all' | ApprovalDomainName)}
                            >
                                {DOMAIN_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </label>
                        <label className="text-xs text-gray-600 flex-1">
                            状态
                            <select
                                className="w-full mt-1 text-xs px-2 py-1 border rounded"
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value as ApprovalMasterStatus)}
                            >
                                {STATUS_OPTIONS.map((s) => (
                                    <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                </div>
                <div className="flex-1 overflow-auto">
                    {listQuery.isLoading && <div className="p-4"><Spinner /></div>}
                    {!listQuery.isLoading && approvals.length === 0 && (
                        <div className="p-4 text-xs text-gray-500">暂无审批</div>
                    )}
                    {approvals.map((a) => (
                        <ApprovalRow
                            key={a.id}
                            approval={a}
                            selected={a.id === selectedId}
                            onClick={() => setSelectedId(a.id)}
                        />
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
                {!selected && <div className="text-sm text-gray-500">从左侧选一条审批</div>}
                {selected && (
                    <div className="space-y-4 max-w-3xl">
                        <div>
                            <div className="text-xs text-gray-500">#{selected.id}</div>
                            <div className="text-sm font-medium">
                                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs mr-2">
                                    {selected.domain}
                                </span>
                                <span className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded text-xs mr-2">
                                    {STATUS_LABEL[selected.status]}
                                </span>
                                <span className="text-gray-700">{selected.subjectKey}</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                                创建于 {formatTimestamp(selected.createdAt)}
                                {selected.decidedAt ? ` · 决定于 ${formatTimestamp(selected.decidedAt)} by ${selected.decidedBy ?? '-'}` : ''}
                            </div>
                        </div>

                        <div>
                            <div className="text-xs text-gray-600 mb-1">Payload</div>
                            <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-80">
                                {JSON.stringify(payload, null, 2)}
                            </pre>
                        </div>

                        {selected.status === 'pending' && availableActions.length > 0 && (
                            <div className="border-t pt-4 space-y-2">
                                <div className="text-xs text-gray-600">决策</div>
                                <select
                                    className="w-full text-sm px-2 py-1 border rounded"
                                    value={actionKey}
                                    onChange={(e) => {
                                        setActionKey(e.target.value)
                                        setFieldValues({})
                                    }}
                                >
                                    <option value="">选择动作...</option>
                                    {availableActions.map((a) => (
                                        <option key={a.value} value={a.value}>{a.label}</option>
                                    ))}
                                </select>
                                {currentActionFields.map((field) => (
                                    <div key={field.name}>
                                        <label className="text-xs text-gray-600 block mb-1">
                                            {field.label}{field.required ? ' *' : ''}
                                        </label>
                                        {field.type === 'select' ? (
                                            <select
                                                className="w-full text-sm px-2 py-1 border rounded"
                                                value={fieldValues[field.name] ?? ''}
                                                onChange={(e) =>
                                                    setFieldValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                                                }
                                            >
                                                <option value="">— 选择 —</option>
                                                {(field.options ?? []).map((opt) => (
                                                    <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <input
                                                type="text"
                                                className="w-full text-sm px-2 py-1 border rounded"
                                                placeholder={field.placeholder ?? ''}
                                                value={fieldValues[field.name] ?? ''}
                                                onChange={(e) =>
                                                    setFieldValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                                                }
                                            />
                                        )}
                                    </div>
                                ))}
                                <textarea
                                    className="w-full text-xs px-2 py-1 border rounded"
                                    placeholder="原因（可选）"
                                    rows={2}
                                    value={reason}
                                    onChange={(e) => setReason(e.target.value)}
                                />
                                <button
                                    className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:bg-gray-400"
                                    disabled={!actionKey || decideMutation.isPending}
                                    onClick={handleSubmit}
                                >
                                    {decideMutation.isPending ? '提交中...' : '提交决策'}
                                </button>
                            </div>
                        )}

                        {error && (
                            <div className="text-xs text-red-600 bg-red-50 p-2 rounded">{error}</div>
                        )}
                        {lastResultHint && (
                            <div className="text-xs text-green-700 bg-green-50 p-2 rounded">{lastResultHint}</div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

function ApprovalRow({ approval, selected, onClick }: {
    approval: ApprovalRecord
    selected: boolean
    onClick: () => void
}) {
    return (
        <div
            className={`px-3 py-2 border-b cursor-pointer text-xs ${selected ? 'bg-blue-100' : 'hover:bg-gray-100'}`}
            onClick={onClick}
        >
            <div className="flex items-center gap-1 mb-1">
                <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]">
                    {approval.domain}
                </span>
                <span className="px-1.5 py-0.5 bg-gray-200 text-gray-700 rounded text-[10px]">
                    {STATUS_LABEL[approval.status]}
                </span>
            </div>
            <div className="truncate text-gray-800" title={approval.subjectKey}>
                {approval.subjectKey}
            </div>
            <div className="text-gray-400 mt-0.5">
                {formatTimestamp(approval.createdAt)}
            </div>
        </div>
    )
}
