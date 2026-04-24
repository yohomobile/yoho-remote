import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isFlutterApp } from '@/hooks/useFlutterApp'
import { Spinner } from '@/components/Spinner'
import { AIProfileSettings } from '@/components/AIProfileSettings'
import { IdentityReviewPanel } from '@/components/IdentityReviewPanel'
import { IdentityPersonsPanel } from '@/components/IdentityPersonsPanel'
import { IdentityAuditPanel } from '@/components/IdentityAuditPanel'
import { queryKeys } from '@/lib/query-keys'
import type { AIProfile, Machine } from '@/types/api'
import {
    applySelfSystemConfigPatch,
    canEnableSelfSystem,
    extractSelfSystemConfig,
    isValidSelfSystemConfig,
    type BrainSelfSystemConfig,
} from '@/lib/brain-self-system'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function sanitizeSelfSystemConfig(
    config: BrainSelfSystemConfig,
    profiles: AIProfile[],
    profilesLoaded: boolean,
): BrainSelfSystemConfig {
    if (!profilesLoaded || !config.defaultProfileId) {
        return config
    }
    const exists = profiles.some((profile) => profile.id === config.defaultProfileId)
    if (exists) {
        return config
    }
    return {
        ...config,
        enabled: false,
        defaultProfileId: null,
    }
}

export default function SelfSystemPage() {
    const { api, currentOrgId } = useAppContext()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const search = useSearch({ from: '/self-system' })
    const openPersonId = search.openPerson ?? null

    const { data: meData } = useQuery({
        queryKey: queryKeys.me,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMe()
        },
        enabled: Boolean(api),
    })
    const currentOrgRole = useMemo(
        () => meData?.orgs.find((org) => org.id === currentOrgId)?.role ?? null,
        [currentOrgId, meData?.orgs],
    )
    const canManageOrgProfiles = meData?.role === 'operator' || currentOrgRole === 'owner' || currentOrgRole === 'admin'

    const { data: brainConfig, isLoading: brainConfigLoading } = useQuery({
        queryKey: queryKeys.brainConfig(currentOrgId),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getBrainConfig(currentOrgId ?? undefined)
        },
        enabled: Boolean(api && currentOrgId),
    })
    const { data: aiProfilesData, isLoading: aiProfilesLoading } = useQuery({
        queryKey: queryKeys.aiProfiles(currentOrgId ?? null),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getAIProfiles(currentOrgId ?? undefined)
        },
        enabled: Boolean(api && currentOrgId),
    })
    const { data: selfSystemData } = useQuery({
        queryKey: queryKeys.selfSystem(currentOrgId),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getSelfSystemConfig(currentOrgId ?? undefined)
        },
        enabled: Boolean(api && currentOrgId),
    })
    const { data: machinesData } = useQuery({
        queryKey: ['machines', currentOrgId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMachines(currentOrgId ?? undefined)
        },
        enabled: Boolean(api),
    })

    const brainConfigMutation = useMutation({
        mutationFn: async (config: { agent: 'claude' | 'codex'; claudeModelMode?: string; codexModel?: string; extra?: Record<string, unknown> }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateBrainConfig(config, currentOrgId ?? undefined)
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.brainConfig(currentOrgId) }),
    })
    const selfSystemMutation = useMutation({
        mutationFn: async (config: BrainSelfSystemConfig) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateSelfSystemConfig(config, currentOrgId ?? undefined)
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.selfSystem(currentOrgId) }),
    })

    const aiProfiles = useMemo(() => {
        return Array.isArray(aiProfilesData?.profiles) ? aiProfilesData.profiles : []
    }, [aiProfilesData])
    const aiProfilesLoaded = Array.isArray(aiProfilesData?.profiles)
    const machines = machinesData?.machines ?? []
    const supportedAgentSet = useMemo(() => {
        const onlineMachines = machines.filter((machine: Machine) => machine.active)
        const supported = new Set<string>()
        for (const machine of onlineMachines) {
            if (!machine.supportedAgents || machine.supportedAgents.length === 0) {
                supported.add('claude')
                supported.add('codex')
            } else {
                for (const agent of machine.supportedAgents) supported.add(agent)
            }
        }
        return supported
    }, [machines])

    const orgSelfSystemConfig = useMemo(() => sanitizeSelfSystemConfig(
        extractSelfSystemConfig(brainConfig?.extra),
        aiProfiles,
        aiProfilesLoaded,
    ), [aiProfiles, aiProfilesLoaded, brainConfig?.extra])
    const selfSystemConfig = useMemo(() => {
        const current: BrainSelfSystemConfig = {
            enabled: selfSystemData?.enabled === true,
            defaultProfileId: selfSystemData?.defaultProfileId ?? null,
            memoryProvider: selfSystemData?.memoryProvider === 'none' ? 'none' : 'yoho-memory',
        }
        return sanitizeSelfSystemConfig(current, aiProfiles, aiProfilesLoaded)
    }, [aiProfiles, aiProfilesLoaded, selfSystemData?.defaultProfileId, selfSystemData?.enabled, selfSystemData?.memoryProvider])
    const mutateBrainConfig = useCallback((patch: {
        agent?: 'claude' | 'codex'
        claudeModelMode?: string
        codexModel?: string
        extra?: Record<string, unknown>
    }) => {
        brainConfigMutation.mutate({
            agent: patch.agent ?? brainConfig?.agent ?? 'claude',
            claudeModelMode: patch.claudeModelMode ?? brainConfig?.claudeModelMode ?? 'opus',
            codexModel: patch.codexModel ?? brainConfig?.codexModel ?? 'gpt-5.4',
            extra: patch.extra ?? (isRecord(brainConfig?.extra) ? brainConfig.extra : {}),
        })
    }, [brainConfig, brainConfigMutation])
    const updateOrgSelfSystemConfig = useCallback((patch: Partial<BrainSelfSystemConfig>) => {
        const next = applySelfSystemConfigPatch(orgSelfSystemConfig, patch)
        if (!isValidSelfSystemConfig(next)) {
            return
        }
        mutateBrainConfig({
            extra: {
                ...(isRecord(brainConfig?.extra) ? brainConfig.extra : {}),
                selfSystem: next,
            },
        })
    }, [brainConfig?.extra, mutateBrainConfig, orgSelfSystemConfig])
    const updateSelfSystemConfig = useCallback((patch: Partial<BrainSelfSystemConfig>) => {
        const next = applySelfSystemConfigPatch(selfSystemConfig, patch)
        if (!isValidSelfSystemConfig(next)) {
            return
        }
        selfSystemMutation.mutate(next)
    }, [selfSystemConfig, selfSystemMutation])

    const canToggleOrgSelfSystem = orgSelfSystemConfig.enabled || canEnableSelfSystem(orgSelfSystemConfig)
    const orgSelfSystemToggleTitle = !currentOrgId
        ? 'Select an org first'
        : !orgSelfSystemConfig.enabled && !canToggleOrgSelfSystem
            ? aiProfiles.length === 0
                ? 'Create an AI style before enabling the org default'
                : 'Select an org default AI style before enabling it'
            : !canManageOrgProfiles
                ? 'Only org admins or operators can edit the org default style'
                : undefined
    const canToggleSelfSystem = selfSystemConfig.enabled || canEnableSelfSystem(selfSystemConfig)
    const selfSystemToggleTitle = !currentOrgId
        ? 'Select an org first'
        : !selfSystemConfig.enabled && !canToggleSelfSystem
            ? aiProfiles.length === 0
                ? 'Create an AI style before enabling self system'
                : 'Select a default AI style before enabling self system'
            : undefined

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)]">
            {!isFlutterApp() && (
                <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                        <button
                            type="button"
                            onClick={goBack}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <BackIcon />
                        </button>
                        <div className="flex-1">
                            <div className="text-sm font-medium">Self System</div>
                            <div className="text-[11px] text-[var(--app-hint)]">
                                Org runtime config, shared AI styles, and your personal default style.
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content p-3 space-y-4">
                    {!currentOrgId ? (
                        <div className="rounded-lg bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
                            Select an org first. AI styles, Brain runtime settings, and your default style are all scoped to the current org.
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <h2 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide px-1">Session Persona</h2>

                            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                    <h3 className="text-sm font-medium">Session Agent</h3>
                                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                        Org-scoped runtime agent configuration used by Brain sessions in this org.
                                    </p>
                                </div>
                                {brainConfigLoading ? (
                                    <div className="px-3 py-4 flex justify-center"><Spinner /></div>
                                ) : (
                                    <div className="divide-y divide-[var(--app-divider)]">
                                        <div className="px-3 py-2.5">
                                            <div className="flex gap-2">
                                                {([
                                                    { value: 'claude' as const, label: 'Claude Code', desc: 'Anthropic Claude' },
                                                    { value: 'codex' as const, label: 'Codex', desc: 'OpenAI Codex' },
                                                ] as const).map((opt) => {
                                                    const isActive = (brainConfig?.agent ?? 'claude') === opt.value
                                                    const isSupported = supportedAgentSet.size === 0 || supportedAgentSet.has(opt.value)
                                                    return (
                                                        <button
                                                            key={opt.value}
                                                            type="button"
                                                            disabled={brainConfigMutation.isPending || !isSupported || !canManageOrgProfiles}
                                                            title={!isSupported ? 'No online machine supports this agent' : !canManageOrgProfiles ? 'Only org admins or operators can edit this org Brain config' : undefined}
                                                            onClick={() => mutateBrainConfig({ agent: opt.value })}
                                                            className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                                                isActive
                                                                    ? 'border-[var(--app-button)] bg-[var(--app-button)]/10 text-[var(--app-button)]'
                                                                    : 'border-[var(--app-border)] text-[var(--app-hint)] hover:border-[var(--app-fg)]/30'
                                                            } disabled:opacity-50`}
                                                        >
                                                            <div>{opt.label}</div>
                                                            <div className="text-[10px] font-normal mt-0.5 opacity-70">
                                                                {!isSupported ? 'No machine available' : opt.desc}
                                                            </div>
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                        {brainConfigMutation.isError && (
                                            <div className="px-3 py-2 text-xs text-red-500">
                                                Failed to update: {(brainConfigMutation.error as Error)?.message || 'Unknown error'}
                                            </div>
                                        )}
                                        {!canManageOrgProfiles && (
                                            <div className="px-3 py-2 text-[11px] text-[var(--app-hint)] border-t border-[var(--app-divider)]">
                                                Only org admins or platform operators can change this org Brain configuration.
                                            </div>
                                        )}
                                        {brainConfig?.updatedAt ? (
                                            <div className="px-3 py-2 text-[11px] text-[var(--app-hint)]">
                                                Last updated: {new Date(brainConfig.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                                                {brainConfig.updatedBy ? ` by ${brainConfig.updatedBy}` : ''}
                                            </div>
                                        ) : null}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                    <h3 className="text-sm font-medium">Org Default Style</h3>
                                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                        Shared fallback style for new Brain and regular sessions when a user has not picked a personal default.
                                    </p>
                                </div>
                                <div className="divide-y divide-[var(--app-divider)]">
                                    <div className="px-3 py-3 flex items-center justify-between gap-3">
                                        <div>
                                            <div className="text-sm font-medium">Enable org default style</div>
                                            <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                                Applies a shared fallback persona for this org when no user-specific style is configured.
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => updateOrgSelfSystemConfig({ enabled: !orgSelfSystemConfig.enabled })}
                                            disabled={brainConfigMutation.isPending || !canToggleOrgSelfSystem || !canManageOrgProfiles}
                                            title={orgSelfSystemToggleTitle}
                                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                                                orgSelfSystemConfig.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                                            }`}
                                            aria-pressed={orgSelfSystemConfig.enabled}
                                        >
                                            <span
                                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                                    orgSelfSystemConfig.enabled ? 'translate-x-5' : 'translate-x-0'
                                                }`}
                                            />
                                        </button>
                                    </div>

                                    <div className="px-3 py-3 space-y-3">
                                        <div className="space-y-1.5">
                                            <label className="block text-xs font-medium text-[var(--app-hint)]">Org default AI style</label>
                                            <select
                                                value={orgSelfSystemConfig.defaultProfileId ?? ''}
                                                onChange={(event) => updateOrgSelfSystemConfig({
                                                    defaultProfileId: event.target.value || null,
                                                })}
                                                disabled={brainConfigMutation.isPending || aiProfilesLoading || aiProfiles.length === 0 || !canManageOrgProfiles}
                                                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)] disabled:opacity-50"
                                            >
                                                <option value="">No profile selected</option>
                                                {aiProfiles.map((profile: AIProfile) => (
                                                    <option key={profile.id} value={profile.id}>
                                                        {profile.avatarEmoji} {profile.name} · {profile.role}
                                                    </option>
                                                ))}
                                            </select>
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                {aiProfiles.length === 0
                                                    ? 'Create at least one org AI style below before enabling the org default.'
                                                    : 'Used as the fallback style when a user has not selected their own default.'}
                                            </div>
                                        </div>

                                        <div className="space-y-1.5">
                                            <label className="block text-xs font-medium text-[var(--app-hint)]">Org memory provider</label>
                                            <select
                                                value={orgSelfSystemConfig.memoryProvider}
                                                onChange={(event) => updateOrgSelfSystemConfig({
                                                    memoryProvider: event.target.value === 'none' ? 'none' : 'yoho-memory',
                                                })}
                                                disabled={brainConfigMutation.isPending || !canManageOrgProfiles}
                                                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)] disabled:opacity-50"
                                            >
                                                <option value="yoho-memory">yoho-memory</option>
                                                <option value="none">Disabled</option>
                                            </select>
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                Only applies when the org fallback style is used and the session type allows memory injection.
                                            </div>
                                        </div>

                                        {orgSelfSystemConfig.enabled && !orgSelfSystemConfig.defaultProfileId && (
                                            <div className="text-xs text-amber-600 dark:text-amber-400">
                                                Org default style is enabled, but no fallback style is selected yet.
                                            </div>
                                        )}

                                        {!canManageOrgProfiles && (
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                Only org admins or platform operators can change the org default style.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                    <h3 className="text-sm font-medium">Self System</h3>
                                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                        Pick your default all-purpose AI style for new Brain and regular sessions in the current org.
                                    </p>
                                </div>
                                <div className="divide-y divide-[var(--app-divider)]">
                                    <div className="px-3 py-3 flex items-center justify-between gap-3">
                                        <div>
                                            <div className="text-sm font-medium">Enable self system</div>
                                            <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                                Writes your selected AI style into each new Brain and regular session init prompt.
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => updateSelfSystemConfig({ enabled: !selfSystemConfig.enabled })}
                                            disabled={selfSystemMutation.isPending || !canToggleSelfSystem}
                                            title={selfSystemToggleTitle}
                                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                                                selfSystemConfig.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                                            }`}
                                            aria-pressed={selfSystemConfig.enabled}
                                        >
                                            <span
                                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                                    selfSystemConfig.enabled ? 'translate-x-5' : 'translate-x-0'
                                                }`}
                                            />
                                        </button>
                                    </div>

                                    <div className="px-3 py-3 space-y-3">
                                        <div className="space-y-1.5">
                                            <label className="block text-xs font-medium text-[var(--app-hint)]">Default AI style</label>
                                            <select
                                                value={selfSystemConfig.defaultProfileId ?? ''}
                                                onChange={(event) => updateSelfSystemConfig({
                                                    defaultProfileId: event.target.value || null,
                                                })}
                                                disabled={selfSystemMutation.isPending || aiProfilesLoading || aiProfiles.length === 0}
                                                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)] disabled:opacity-50"
                                            >
                                                <option value="">No profile selected</option>
                                                {aiProfiles.map((profile: AIProfile) => (
                                                    <option key={profile.id} value={profile.id}>
                                                        {profile.avatarEmoji} {profile.name} · {profile.role}
                                                    </option>
                                                ))}
                                            </select>
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                {aiProfiles.length === 0
                                                    ? 'Create at least one org AI style below before enabling self system.'
                                                    : 'The selected style becomes your personal default for new Brain and regular sessions.'}
                                            </div>
                                        </div>

                                        <div className="space-y-1.5">
                                            <label className="block text-xs font-medium text-[var(--app-hint)]">Long-term memory provider</label>
                                            <select
                                                value={selfSystemConfig.memoryProvider}
                                                onChange={(event) => updateSelfSystemConfig({
                                                    memoryProvider: event.target.value === 'none' ? 'none' : 'yoho-memory',
                                                })}
                                                disabled={selfSystemMutation.isPending}
                                                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)] disabled:opacity-50"
                                            >
                                                <option value="yoho-memory">yoho-memory</option>
                                                <option value="none">Disabled</option>
                                            </select>
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                K1 only pulls a short recall snippet here. Long-term memory ownership stays in yoho-memory.
                                            </div>
                                        </div>

                                        {selfSystemMutation.isError && (
                                            <div className="text-xs text-red-500">
                                                Failed to update: {(selfSystemMutation.error as Error)?.message || 'Unknown error'}
                                            </div>
                                        )}

                                        {selfSystemConfig.enabled && !selfSystemConfig.defaultProfileId && (
                                            <div className="text-xs text-amber-600 dark:text-amber-400">
                                                Self system is enabled, but no default style is selected yet.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <AIProfileSettings orgId={currentOrgId} canManage={canManageOrgProfiles} />

                            {canManageOrgProfiles && currentOrgId && (
                                <>
                                    <IdentityReviewPanel orgId={currentOrgId} canManage={canManageOrgProfiles} />
                                    <IdentityPersonsPanel
                                        orgId={currentOrgId}
                                        initialPersonId={openPersonId}
                                        onSelectedPersonChange={(personId) => {
                                            navigate({
                                                to: '/self-system',
                                                search: { openPerson: personId ?? undefined },
                                                replace: true,
                                            })
                                        }}
                                    />
                                    <IdentityAuditPanel orgId={currentOrgId} />
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
