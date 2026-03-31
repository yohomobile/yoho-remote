import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CRSApiKey, CRSKeyStats } from '@/types/api'

type Props = {
    api: ApiClient
    orgId: string
    orgSlug: string
}

export function CRSApiKeyManager({ api, orgId, orgSlug }: Props) {
    const queryClient = useQueryClient()
    const [showCreateForm, setShowCreateForm] = useState(false)
    const [newKeyName, setNewKeyName] = useState('')
    const [timeRange, setTimeRange] = useState<'today' | '7days' | '30days'>('7days')

    // 获取 API Keys 列表
    const { data: keysData, isLoading: keysLoading } = useQuery({
        queryKey: ['crs-api-keys', orgId],
        queryFn: async () => {
            return await api.getCRSApiKeys(orgId)
        },
        enabled: Boolean(api && orgId)
    })

    // 规范化 API Keys 数据（处理字符串类型的数字字段）
    const apiKeys = (keysData?.data?.items ?? []).map(key => ({
        ...key,
        concurrencyLimit: typeof key.concurrencyLimit === 'string' ? parseInt(key.concurrencyLimit) : key.concurrencyLimit,
        dailyCostLimit: typeof key.dailyCostLimit === 'string' ? parseFloat(key.dailyCostLimit) : key.dailyCostLimit,
        totalCostLimit: typeof key.totalCostLimit === 'string' ? parseFloat(key.totalCostLimit) : key.totalCostLimit,
        weeklyOpusCostLimit: typeof key.weeklyOpusCostLimit === 'string' ? parseFloat(key.weeklyOpusCostLimit) : key.weeklyOpusCostLimit,
        rateLimitWindow: typeof key.rateLimitWindow === 'string' ? parseInt(key.rateLimitWindow) : key.rateLimitWindow,
        rateLimitRequests: typeof key.rateLimitRequests === 'string' ? parseInt(key.rateLimitRequests) : key.rateLimitRequests,
        rateLimitCost: typeof key.rateLimitCost === 'string' ? parseFloat(key.rateLimitCost) : key.rateLimitCost,
    }))
    const keyIds = apiKeys.map(k => k.id)

    // 获取用量统计
    const { data: statsData } = useQuery({
        queryKey: ['crs-batch-stats', orgId, keyIds, timeRange],
        queryFn: async () => {
            if (keyIds.length === 0) return { success: true, data: {} }
            return await api.getCRSBatchStats(orgId, keyIds, timeRange)
        },
        enabled: Boolean(api && orgId && keyIds.length > 0)
    })

    const stats: Record<string, CRSKeyStats> = statsData?.data ?? {}

    // 获取总用量
    const { data: summaryData } = useQuery({
        queryKey: ['crs-usage-summary', orgId, timeRange],
        queryFn: async () => {
            return await api.getCRSUsageSummary(orgId, timeRange)
        },
        enabled: Boolean(api && orgId)
    })

    const summary = summaryData?.data

    // 创建 API Key
    const createMutation = useMutation({
        mutationFn: async (name: string) => {
            return await api.createCRSApiKey(orgId, { name })
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['crs-api-keys', orgId] })
            queryClient.invalidateQueries({ queryKey: ['crs-usage-summary', orgId] })
            setShowCreateForm(false)
            setNewKeyName('')
        }
    })

    // 删除 API Key
    const deleteMutation = useMutation({
        mutationFn: async (keyId: string) => {
            return await api.deleteCRSApiKey(orgId, keyId)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['crs-api-keys', orgId] })
            queryClient.invalidateQueries({ queryKey: ['crs-usage-summary', orgId] })
        }
    })

    // 切换激活状态
    const toggleActiveMutation = useMutation({
        mutationFn: async ({ keyId, isActive }: { keyId: string; isActive: boolean }) => {
            return await api.updateCRSApiKey(orgId, keyId, { isActive })
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['crs-api-keys', orgId] })
        }
    })

    const handleCreate = useCallback(async () => {
        if (!newKeyName.trim()) return
        try {
            await createMutation.mutateAsync(newKeyName.trim())
        } catch (error) {
            console.error('Failed to create API key:', error)
        }
    }, [newKeyName, createMutation])

    const handleDelete = useCallback(async (keyId: string, keyName: string) => {
        if (!confirm(`Delete API key "${keyName}"? This action cannot be undone.`)) return
        try {
            await deleteMutation.mutateAsync(keyId)
        } catch (error) {
            console.error('Failed to delete API key:', error)
        }
    }, [deleteMutation])

    const handleToggleActive = useCallback(async (keyId: string, currentStatus: boolean) => {
        try {
            await toggleActiveMutation.mutateAsync({ keyId, isActive: !currentStatus })
        } catch (error) {
            console.error('Failed to toggle API key status:', error)
        }
    }, [toggleActiveMutation])

    const copyToClipboard = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text)
            // 可以添加一个提示
        } catch (error) {
            console.error('Failed to copy to clipboard:', error)
        }
    }, [])

    if (keysLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="text-sm text-[var(--app-hint)]">Loading...</div>
            </div>
        )
    }

    return (
        <div className="space-y-4">
            {/* Summary Card */}
            {summary && (
                <div className="rounded-lg bg-[var(--app-subtle-bg)] p-4">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-medium">Usage Summary</h3>
                        <select
                            value={timeRange}
                            onChange={(e) => setTimeRange(e.target.value as any)}
                            className="text-xs px-2 py-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)]"
                        >
                            <option value="today">Today</option>
                            <option value="7days">Last 7 days</option>
                            <option value="30days">Last 30 days</option>
                        </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <div className="text-[10px] text-[var(--app-hint)] uppercase">Total Keys</div>
                            <div className="text-lg font-semibold mt-0.5">{summary.totalKeys}</div>
                        </div>
                        <div>
                            <div className="text-[10px] text-[var(--app-hint)] uppercase">Total Cost</div>
                            <div className="text-lg font-semibold mt-0.5">{summary.formattedCost}</div>
                        </div>
                        <div>
                            <div className="text-[10px] text-[var(--app-hint)] uppercase">Total Requests</div>
                            <div className="text-lg font-semibold mt-0.5">{summary.totalRequests.toLocaleString()}</div>
                        </div>
                        <div>
                            <div className="text-[10px] text-[var(--app-hint)] uppercase">Total Tokens</div>
                            <div className="text-lg font-semibold mt-0.5">{summary.totalTokens.toLocaleString()}</div>
                        </div>
                    </div>
                </div>
            )}

            {/* API Keys Section */}
            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between">
                    <h3 className="text-sm font-medium">API Keys</h3>
                    {!showCreateForm && (
                        <button
                            type="button"
                            onClick={() => setShowCreateForm(true)}
                            className="text-xs px-2 py-1 rounded bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90"
                        >
                            + Create Key
                        </button>
                    )}
                </div>

                {/* Create Form */}
                {showCreateForm && (
                    <div className="px-3 py-3 border-b border-[var(--app-divider)] space-y-2">
                        <input
                            type="text"
                            value={newKeyName}
                            onChange={(e) => setNewKeyName(e.target.value)}
                            placeholder="Key name (e.g., Production API)"
                            className="w-full px-2.5 py-1.5 text-sm rounded bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                            autoFocus
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
                        />
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => { setShowCreateForm(false); setNewKeyName('') }}
                                className="flex-1 py-1.5 text-sm rounded bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleCreate}
                                disabled={createMutation.isPending || !newKeyName.trim()}
                                className="flex-1 py-1.5 text-sm font-medium rounded bg-gradient-to-r from-indigo-500 to-purple-600 text-white disabled:opacity-50"
                            >
                                {createMutation.isPending ? 'Creating...' : 'Create'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Keys List */}
                {apiKeys.length === 0 && !showCreateForm ? (
                    <div className="px-3 py-8 text-center text-sm text-[var(--app-hint)]">
                        No API keys yet. Create one to get started.
                    </div>
                ) : (
                    <div className="divide-y divide-[var(--app-divider)]">
                        {apiKeys.map((key) => {
                            const keyStat = stats[key.id]
                            return (
                                <div key={key.id} className="px-3 py-3">
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <div className="text-sm font-medium truncate">{key.name}</div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleToggleActive(key.id, key.isActive)}
                                                    disabled={toggleActiveMutation.isPending}
                                                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                                        key.isActive
                                                            ? 'bg-green-500/10 text-green-600'
                                                            : 'bg-gray-500/10 text-gray-600'
                                                    }`}
                                                >
                                                    {key.isActive ? 'Active' : 'Inactive'}
                                                </button>
                                                {/* Limits badges */}
                                                {key.dailyCostLimit > 0 && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600">
                                                        Daily: ${key.dailyCostLimit}
                                                    </span>
                                                )}
                                                {key.totalCostLimit > 0 && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600">
                                                        Total: ${key.totalCostLimit}
                                                    </span>
                                                )}
                                                {key.concurrencyLimit > 0 && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600">
                                                        Concurrent: {key.concurrencyLimit}
                                                    </span>
                                                )}
                                            </div>
                                            {key.description && (
                                                <div className="mt-1 text-xs text-[var(--app-hint)]">{key.description}</div>
                                            )}
                                            <div className="mt-1 flex items-center gap-1">
                                                <code className="text-[11px] font-mono text-[var(--app-hint)] truncate">
                                                    {key.apiKey ? key.apiKey : `${key.id.substring(0, 8)}...`}
                                                </code>
                                                <button
                                                    type="button"
                                                    onClick={() => copyToClipboard(key.apiKey || key.id)}
                                                    className="shrink-0 p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                                    title="Copy to clipboard"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                                                </button>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleDelete(key.id, key.name)}
                                            disabled={deleteMutation.isPending}
                                            className="shrink-0 p-1 text-[var(--app-hint)] hover:text-red-500 disabled:opacity-50"
                                            title="Delete key"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                                        </button>
                                    </div>

                                    {/* Stats */}
                                    {keyStat && (
                                        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                                            <div>
                                                <div className="text-[10px] text-[var(--app-hint)]">Requests</div>
                                                <div className="font-medium">{keyStat.requests.toLocaleString()}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] text-[var(--app-hint)]">Tokens</div>
                                                <div className="font-medium">{keyStat.tokens.toLocaleString()}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] text-[var(--app-hint)]">Cost</div>
                                                <div className="font-medium">{keyStat.formattedCost}</div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Metadata */}
                                    <div className="mt-2 text-[10px] text-[var(--app-hint)] space-y-0.5">
                                        <div>
                                            Created {new Date(key.createdAt).toLocaleDateString()}
                                            {key.lastUsedAt && ` • Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                                        </div>
                                        {key.expiresAt && (
                                            <div>
                                                Expires: {new Date(key.expiresAt).toLocaleDateString()}
                                                {key.expirationMode === 'activation' && !key.isActivated && ' (after first use)'}
                                            </div>
                                        )}
                                        {key.enableModelRestriction && key.restrictedModels.length > 0 && (
                                            <div>
                                                Models: {key.restrictedModels.join(', ')}
                                            </div>
                                        )}
                                        {key.claudeAccountId && (
                                            <div>Claude Account: {key.claudeAccountId}</div>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
        </div>
    )
}
