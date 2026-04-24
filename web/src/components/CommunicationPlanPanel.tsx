import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import type {
    CommunicationPlanExplanationDepth,
    CommunicationPlanFormality,
    CommunicationPlanLength,
    CommunicationPlanPreferences,
} from '@/types/api'

const lengthOptions: Array<{ value: CommunicationPlanLength; label: string }> = [
    { value: 'concise', label: '简洁' },
    { value: 'default', label: '默认' },
    { value: 'detailed', label: '详细' },
]

const depthOptions: Array<{ value: CommunicationPlanExplanationDepth; label: string }> = [
    { value: 'minimal', label: '只给结论' },
    { value: 'moderate', label: '中等' },
    { value: 'thorough', label: '充分' },
]

const formalityOptions: Array<{ value: CommunicationPlanFormality; label: string }> = [
    { value: 'casual', label: '随意' },
    { value: 'neutral', label: '中性' },
    { value: 'formal', label: '正式' },
]

export function buildFormState(preferences: CommunicationPlanPreferences | null | undefined): {
    tone: string
    length: CommunicationPlanLength | ''
    explanationDepth: CommunicationPlanExplanationDepth | ''
    formality: CommunicationPlanFormality | ''
    customInstructions: string
} {
    return {
        tone: preferences?.tone ?? '',
        length: preferences?.length ?? '',
        explanationDepth: preferences?.explanationDepth ?? '',
        formality: preferences?.formality ?? '',
        customInstructions: preferences?.customInstructions ?? '',
    }
}

export function toPreferencesPayload(form: ReturnType<typeof buildFormState>): CommunicationPlanPreferences {
    const trim = (v: string) => v.trim()
    return {
        tone: trim(form.tone) || null,
        length: form.length || null,
        explanationDepth: form.explanationDepth || null,
        formality: form.formality || null,
        customInstructions: trim(form.customInstructions) || null,
    }
}

export function CommunicationPlanPanel(props: { orgId: string | null }) {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const orgId = props.orgId
    const [form, setForm] = useState(() => buildFormState(null))
    const [savedMessage, setSavedMessage] = useState<string | null>(null)

    const planQuery = useQuery({
        queryKey: queryKeys.communicationPlanMe(orgId),
        queryFn: async () => await api.getMyCommunicationPlan(orgId),
        enabled: Boolean(api && orgId),
    })
    const plan = planQuery.data?.plan ?? null
    const isPlanMissing = !planQuery.isLoading && planQuery.isFetched && plan === null
    const noActor = planQuery.error instanceof Error && /No linked person/i.test(planQuery.error.message)

    useEffect(() => {
        setForm(buildFormState(plan?.preferences ?? null))
    }, [plan?.id, plan?.updatedAt])

    const saveMutation = useMutation({
        mutationFn: async () => await api.updateMyCommunicationPlan({
            preferences: toPreferencesPayload(form),
        }, orgId),
        onSuccess: async () => {
            setSavedMessage('已保存')
            await queryClient.invalidateQueries({ queryKey: queryKeys.communicationPlanMe(orgId) })
            await queryClient.invalidateQueries({ queryKey: queryKeys.communicationPlanMeAudits(orgId) })
        },
    })

    const toggleMutation = useMutation({
        mutationFn: async (enabled: boolean) => await api.setMyCommunicationPlanEnabled(enabled, null, orgId),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.communicationPlanMe(orgId) })
            await queryClient.invalidateQueries({ queryKey: queryKeys.communicationPlanMeAudits(orgId) })
        },
    })

    useEffect(() => {
        if (!savedMessage) return
        const t = setTimeout(() => setSavedMessage(null), 2500)
        return () => clearTimeout(t)
    }, [savedMessage])

    const error = useMemo(() => {
        const err = planQuery.error ?? saveMutation.error ?? toggleMutation.error
        if (!err) return null
        return err instanceof Error ? err.message : String(err)
    }, [planQuery.error, saveMutation.error, toggleMutation.error])

    if (!orgId) {
        return null
    }

    return (
        <div className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--app-divider)] px-3 py-2">
                <div>
                    <h3 className="text-sm font-semibold">我的回复偏好</h3>
                    <p className="mt-0.5 text-[11px] text-[var(--app-hint)]">
                        仅影响 K1 对你的表达方式（结构、长度、解释深度、风格）。不会改变事实、权限或审批逻辑。
                    </p>
                </div>
                {planQuery.isLoading && <Spinner size="sm" label="Loading communication plan" />}
            </div>

            {noActor ? (
                <div className="px-3 py-4 text-sm text-[var(--app-hint)]">
                    当前账号尚未绑定 Identity Person，无法保存偏好。请联系管理员在 Identity 面板完成绑定。
                </div>
            ) : (
                <div className="px-3 py-3 space-y-3">
                    {error && !noActor && (
                        <div className="text-xs text-red-500">{error}</div>
                    )}

                    {plan && (
                        <div className="flex items-center justify-between text-xs text-[var(--app-hint)]">
                            <span>
                                状态：{plan.enabled ? '已启用' : '已关闭'} · 版本 {plan.version}
                            </span>
                            <button
                                type="button"
                                className="rounded border border-[var(--app-divider)] px-2 py-0.5 hover:bg-[var(--app-secondary-bg)]"
                                onClick={() => toggleMutation.mutate(!plan.enabled)}
                                disabled={toggleMutation.isPending}
                            >
                                {plan.enabled ? '关闭适配' : '重新启用'}
                            </button>
                        </div>
                    )}

                    {isPlanMissing && (
                        <div className="text-xs text-[var(--app-hint)]">
                            还没有偏好配置，填写下面的表单并保存即可创建。
                        </div>
                    )}

                    <div className="grid gap-2 md:grid-cols-3">
                        <label className="flex flex-col gap-1 text-xs">
                            <span className="text-[var(--app-hint)]">回复长度</span>
                            <select
                                className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1"
                                value={form.length}
                                onChange={(e) => setForm((prev) => ({ ...prev, length: e.target.value as typeof prev.length }))}
                            >
                                <option value="">不指定</option>
                                {lengthOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            <span className="text-[var(--app-hint)]">解释深度</span>
                            <select
                                className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1"
                                value={form.explanationDepth}
                                onChange={(e) => setForm((prev) => ({ ...prev, explanationDepth: e.target.value as typeof prev.explanationDepth }))}
                            >
                                <option value="">不指定</option>
                                {depthOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            <span className="text-[var(--app-hint)]">正式度</span>
                            <select
                                className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1"
                                value={form.formality}
                                onChange={(e) => setForm((prev) => ({ ...prev, formality: e.target.value as typeof prev.formality }))}
                            >
                                <option value="">不指定</option>
                                {formalityOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-[var(--app-hint)]">语气（自由填写，例如“直接、少铺垫”）</span>
                        <input
                            type="text"
                            className="rounded border border-[var(--app-divider)] bg-transparent px-2 py-1"
                            value={form.tone}
                            maxLength={200}
                            onChange={(e) => setForm((prev) => ({ ...prev, tone: e.target.value }))}
                        />
                    </label>

                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-[var(--app-hint)]">自定义指令（可选）</span>
                        <textarea
                            className="min-h-[72px] rounded border border-[var(--app-divider)] bg-transparent px-2 py-1"
                            value={form.customInstructions}
                            maxLength={2000}
                            onChange={(e) => setForm((prev) => ({ ...prev, customInstructions: e.target.value }))}
                        />
                    </label>

                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[var(--app-hint)]">
                            {savedMessage ?? '保存后立即生效；可在 Brain 初始化时读取。'}
                        </span>
                        <button
                            type="button"
                            className="rounded bg-[var(--app-button)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                            onClick={() => saveMutation.mutate()}
                            disabled={saveMutation.isPending}
                        >
                            {saveMutation.isPending ? '保存中…' : '保存'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
