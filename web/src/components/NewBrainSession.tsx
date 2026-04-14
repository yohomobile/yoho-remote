import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, SpawnLogEntry, TokenSource } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { SpawnLogPanel } from '@/components/NewSession'
import {
    CODEX_MODELS,
    DEFAULT_CODEX_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    SessionAgentFields,
    normalizeCodexModelValue,
    sanitizeClaudeModelMode,
    type AgentType,
    type ClaudeModelMode,
    type CodexReasoningEffort,
} from '@/components/SessionAgentFields'
import { usePlatform } from '@/hooks/usePlatform'
import { useAppContext } from '@/lib/app-context'
import { getMachineStatusLabel, getMachineTitle, sortMachinesForStableDisplay } from '@/lib/machines'
import { queryKeys } from '@/lib/query-keys'
import { LOCAL_TOKEN_SOURCE, LOCAL_TOKEN_SOURCE_ID } from '@/lib/tokenSources'

function sanitizeAgentType(agent: unknown): AgentType {
    return agent === 'codex' ? 'codex' : 'claude'
}

const CLAUDE_CHILD_MODELS: { value: ClaudeModelMode; label: string; description: string }[] = [
    { value: 'sonnet', label: 'Sonnet', description: '默认优先的 Claude 子任务模型' },
    { value: 'opus', label: 'Opus', description: '高复杂度 Claude 子任务模型' },
]

function collectSupportedAgents(machine: Machine | null): AgentType[] {
    if (!machine) {
        return []
    }
    if (!machine.supportedAgents || machine.supportedAgents.length === 0) {
        return ['claude', 'codex']
    }
    return (['claude', 'codex'] as const).filter((agent): agent is AgentType => machine.supportedAgents?.includes(agent) ?? false)
}

function getCompatibleTokenSources(tokenSources: TokenSource[], agent: AgentType): TokenSource[] {
    return tokenSources.filter((tokenSource) => tokenSource.supportedAgents.includes(agent))
}

function normalizeChildClaudeModels(extra: Record<string, unknown> | null | undefined): ClaudeModelMode[] {
    const values = Array.isArray(extra?.['childClaudeModels']) ? extra['childClaudeModels'] : null
    const normalized = values?.filter((value): value is ClaudeModelMode => value === 'sonnet' || value === 'opus') ?? []
    return normalized.length > 0 ? Array.from(new Set(normalized)) : CLAUDE_CHILD_MODELS.map((model) => model.value)
}

function normalizeChildCodexModels(extra: Record<string, unknown> | null | undefined): string[] {
    const allowed = new Set(CODEX_MODELS.map((model) => normalizeCodexModelValue(model.value)))
    const values = Array.isArray(extra?.['childCodexModels']) ? extra['childCodexModels'] : null
    const normalized = values
        ?.filter((value): value is string => typeof value === 'string')
        .map((value) => normalizeCodexModelValue(value))
        .filter((value) => allowed.has(value)) ?? []
    return normalized.length > 0 ? Array.from(new Set(normalized)) : Array.from(allowed)
}

function toggleValue<T extends string>(values: readonly T[], value: T, checked: boolean): T[] {
    if (checked) {
        return values.includes(value) ? [...values] : [...values, value]
    }
    return values.filter((item) => item !== value)
}

export function NewBrainSession(props: {
    api: ApiClient
    machines: Machine[]
    isLoading?: boolean
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}) {
    const { currentOrgId } = useAppContext()
    const { haptic } = usePlatform()
    const queryClient = useQueryClient()
    const [machineId, setMachineId] = useState<string | null>(null)
    const [agent, setAgent] = useState<AgentType>('claude')
    const [tokenSourceId, setTokenSourceId] = useState('')
    const [claudeModel, setClaudeModel] = useState<ClaudeModelMode>('opus')
    const [codexModel, setCodexModel] = useState(DEFAULT_CODEX_MODEL)
    const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(DEFAULT_CODEX_REASONING_EFFORT)
    const [childClaudeModels, setChildClaudeModels] = useState<ClaudeModelMode[]>(CLAUDE_CHILD_MODELS.map((model) => model.value))
    const [childCodexModels, setChildCodexModels] = useState<string[]>(CODEX_MODELS.map((model) => normalizeCodexModelValue(model.value)))
    const [isCreating, setIsCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [spawnLogs, setSpawnLogs] = useState<SpawnLogEntry[]>([])
    const onlineMachines = useMemo(
        () => sortMachinesForStableDisplay(props.machines).filter((machine) => machine.active),
        [props.machines]
    )
    const currentMachine = useMemo(
        () => onlineMachines.find((machine) => machine.id === machineId) ?? null,
        [machineId, onlineMachines]
    )
    const supportedAgents = useMemo(
        () => collectSupportedAgents(currentMachine),
        [currentMachine]
    )
    const { data: tokenSourcesData } = useQuery({
        queryKey: queryKeys.tokenSources(currentOrgId ?? '', false),
        queryFn: async () => await props.api.getTokenSources(currentOrgId, false),
        enabled: Boolean(currentOrgId),
    })
    const tokenSources = useMemo(() => {
        const remoteTokenSources = Array.isArray(tokenSourcesData?.tokenSources) ? tokenSourcesData.tokenSources : []
        return [LOCAL_TOKEN_SOURCE, ...remoteTokenSources]
    }, [tokenSourcesData])
    const compatibleTokenSources = useMemo(
        () => getCompatibleTokenSources(tokenSources, agent),
        [agent, tokenSources]
    )

    const { data: brainConfig, isLoading: brainConfigLoading } = useQuery({
        queryKey: ['brain-config'],
        queryFn: async () => await props.api.getBrainConfig(),
    })

    useEffect(() => {
        if (!brainConfig) return
        setAgent(sanitizeAgentType(brainConfig.agent))
        setClaudeModel(sanitizeClaudeModelMode(brainConfig.claudeModelMode, 'opus'))
        setCodexModel(normalizeCodexModelValue(brainConfig.codexModel))
        setChildClaudeModels(normalizeChildClaudeModels(brainConfig.extra))
        setChildCodexModels(normalizeChildCodexModels(brainConfig.extra))
    }, [brainConfig])

    useEffect(() => {
        if (onlineMachines.length === 0) {
            setMachineId(null)
            return
        }
        if (machineId && onlineMachines.some((machine) => machine.id === machineId)) {
            return
        }
        setMachineId(onlineMachines[0]?.id ?? null)
    }, [machineId, onlineMachines])

    useEffect(() => {
        if (supportedAgents.length === 0) return
        if (!supportedAgents.includes(agent)) {
            setAgent(supportedAgents[0])
        }
    }, [agent, supportedAgents])

    useEffect(() => {
        if (compatibleTokenSources.length === 0) {
            setTokenSourceId('')
            return
        }
        if (compatibleTokenSources.some((tokenSource) => tokenSource.id === tokenSourceId)) {
            return
        }
        setTokenSourceId(compatibleTokenSources[0]?.id ?? '')
    }, [compatibleTokenSources, tokenSourceId])

    const childModelCount = childClaudeModels.length + childCodexModels.length
    const isFormDisabled = isCreating || props.isLoading || brainConfigLoading
    const canCreate = !isFormDisabled
        && machineId !== null
        && supportedAgents.length > 0
        && Boolean(tokenSourceId)
        && compatibleTokenSources.some((tokenSource) => tokenSource.id === tokenSourceId)
        && childModelCount > 0

    const handleCreate = useCallback(async () => {
        if (!canCreate) return

        setError(null)
        setSpawnLogs([
            {
                timestamp: Date.now(),
                step: 'request',
                message: `Sending brain spawn request for ${agent} agent...`,
                status: 'running',
            }
        ])
        setIsCreating(true)

        try {
            const result = await props.api.createBrainSession({
                machineId: machineId ?? undefined,
                agent,
                tokenSourceId: tokenSourceId === LOCAL_TOKEN_SOURCE_ID ? undefined : tokenSourceId,
                claudeModel: agent === 'claude' ? claudeModel : undefined,
                codexModel: agent === 'codex' ? codexModel : undefined,
                modelReasoningEffort: agent === 'codex' ? codexReasoningEffort : undefined,
                childClaudeModels,
                childCodexModels,
                orgId: currentOrgId,
            })

            if (result.logs && result.logs.length > 0) {
                setSpawnLogs(result.logs)
            }

            if (result.type === 'success') {
                void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                haptic.notification('success')
                props.onSuccess(result.sessionId)
                return
            }

            haptic.notification('error')
            const isLicenseError = typeof result.code === 'string' && (result.code.startsWith('LICENSE_') || result.code === 'NO_LICENSE')
            setError(isLicenseError
                ? 'Your organization\'s license has expired or is not active. Please contact your administrator.'
                : result.message
            )
        } catch (err) {
            haptic.notification('error')
            const message = err instanceof Error ? err.message : 'Failed to create brain session'
            setSpawnLogs((prev) => [
                ...prev,
                { timestamp: Date.now(), step: 'error', message, status: 'error' }
            ])
            setError(message)
        } finally {
            setIsCreating(false)
        }
    }, [
        agent,
        canCreate,
        claudeModel,
        childClaudeModels,
        childCodexModels,
        codexModel,
        codexReasoningEffort,
        currentOrgId,
        haptic,
        machineId,
        props,
        queryClient,
        tokenSourceId,
    ])

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            <div className="px-3 py-3 text-xs text-[var(--app-hint)]">
                Brain sessions use the managed brain workspace. Here you pin the Brain runtime machine and define which child-session models this Brain may use.
            </div>

            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Machine
                </label>
                <select
                    value={machineId ?? ''}
                    onChange={(e) => setMachineId(e.target.value || null)}
                    disabled={isFormDisabled || onlineMachines.length === 0}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                >
                    {onlineMachines.length === 0 ? (
                        <option value="">No online machines available</option>
                    ) : null}
                    {onlineMachines.map((machine) => (
                        <option key={machine.id} value={machine.id}>
                            {getMachineTitle(machine)} · {getMachineStatusLabel(machine)}
                        </option>
                    ))}
                </select>
                {currentMachine ? (
                    <div className="text-xs text-[var(--app-hint)]">
                        Host: {currentMachine.metadata?.host ?? currentMachine.id.slice(0, 8)} · Supported agents: {supportedAgents.join(' / ') || 'none'}
                    </div>
                ) : null}
            </div>

            <SessionAgentFields
                agent={agent}
                tokenSources={tokenSources}
                tokenSourceId={tokenSourceId}
                claudeModel={claudeModel}
                codexModel={codexModel}
                codexReasoningEffort={codexReasoningEffort}
                onAgentChange={setAgent}
                onTokenSourceChange={setTokenSourceId}
                onClaudeModelChange={setClaudeModel}
                onCodexModelChange={setCodexModel}
                onCodexReasoningEffortChange={setCodexReasoningEffort}
                isFormDisabled={isFormDisabled}
                supportedAgents={supportedAgents}
                getUnsupportedTitle={(agentType) => `No online machine supports ${agentType}`}
            />

            <div className="flex flex-col gap-3 px-3 py-3">
                <div>
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Child Session Models
                    </label>
                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                        Defaults follow server priority: Claude prefers Sonnet, Codex prefers GPT-5.4. If the preferred model is disabled, Brain will fall back to the next enabled model.
                    </div>
                </div>

                <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg-secondary)] p-3">
                    <div className="text-xs font-medium text-[var(--app-text)]">Claude</div>
                    <div className="mt-2 flex flex-col gap-2">
                        {CLAUDE_CHILD_MODELS.map((model) => {
                            const checked = childClaudeModels.includes(model.value)
                            return (
                                <label key={model.value} className="flex items-start gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={isFormDisabled}
                                        onChange={(e) => setChildClaudeModels((current) => toggleValue(current, model.value, e.target.checked))}
                                        className="mt-0.5 h-4 w-4 accent-[var(--app-link)]"
                                    />
                                    <span>
                                        <span className="font-medium">{model.label}</span>
                                        <span className="ml-1 text-[var(--app-hint)]">{model.description}</span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>
                </div>

                <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg-secondary)] p-3">
                    <div className="text-xs font-medium text-[var(--app-text)]">Codex</div>
                    <div className="mt-2 flex flex-col gap-2">
                        {CODEX_MODELS.map((model) => {
                            const normalizedValue = normalizeCodexModelValue(model.value)
                            const checked = childCodexModels.includes(normalizedValue)
                            return (
                                <label key={model.value} className="flex items-start gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={isFormDisabled}
                                        onChange={(e) => setChildCodexModels((current) => toggleValue(current, normalizedValue, e.target.checked))}
                                        className="mt-0.5 h-4 w-4 accent-[var(--app-link)]"
                                    />
                                    <span>{model.label}</span>
                                </label>
                            )
                        })}
                    </div>
                </div>

                {childModelCount === 0 ? (
                    <div className="text-sm text-red-600">
                        Enable at least one child-session model before creating this Brain session.
                    </div>
                ) : null}
            </div>

            {spawnLogs.length > 0 ? (
                <SpawnLogPanel logs={spawnLogs} />
            ) : null}

            {onlineMachines.length === 0 && !props.isLoading ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    No online machine is available for Brain session creation right now.
                </div>
            ) : null}

            {onlineMachines.length > 0 && supportedAgents.length === 0 && !props.isLoading ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    The selected machine does not support Brain session creation with the available agents.
                </div>
            ) : null}

            {error ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error}
                </div>
            ) : null}

            <div className="flex gap-2 px-3 py-3">
                <Button
                    variant="secondary"
                    onClick={props.onCancel}
                    disabled={isFormDisabled}
                >
                    Cancel
                </Button>
                <Button
                    onClick={handleCreate}
                    disabled={!canCreate}
                    aria-busy={isCreating}
                    className="gap-2"
                >
                    {isCreating ? (
                        <>
                            <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                            Creating…
                        </>
                    ) : (
                        'Create Brain Session'
                    )}
                </Button>
            </div>
        </div>
    )
}
