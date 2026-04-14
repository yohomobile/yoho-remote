import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, SpawnLogEntry } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { SpawnLogPanel } from '@/components/NewSession'
import {
    DEFAULT_CODEX_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    SessionAgentFields,
    normalizeCodexModelValue,
    sanitizeClaudeModelMode,
    type AgentType,
    type ClaudeModelMode,
    type ClaudeSettingsType,
    type CodexReasoningEffort,
} from '@/components/SessionAgentFields'
import { usePlatform } from '@/hooks/usePlatform'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'

function sanitizeAgentType(agent: unknown): AgentType {
    return agent === 'codex' ? 'codex' : 'claude'
}

function collectSupportedAgents(machines: Machine[]): AgentType[] {
    const supported = new Set<AgentType>()
    for (const machine of machines) {
        if (!machine.active) continue
        if (!machine.supportedAgents || machine.supportedAgents.includes('claude')) {
            supported.add('claude')
        }
        if (!machine.supportedAgents || machine.supportedAgents.includes('codex')) {
            supported.add('codex')
        }
    }
    return (['claude', 'codex'] as const).filter((agent): agent is AgentType => supported.has(agent))
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
    const [agent, setAgent] = useState<AgentType>('claude')
    const [claudeModel, setClaudeModel] = useState<ClaudeModelMode>('opus')
    const [claudeSettingsType, setClaudeSettingsType] = useState<ClaudeSettingsType>('default')
    const [claudeAgent, setClaudeAgent] = useState('')
    const [codexModel, setCodexModel] = useState(DEFAULT_CODEX_MODEL)
    const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(DEFAULT_CODEX_REASONING_EFFORT)
    const [isCreating, setIsCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [spawnLogs, setSpawnLogs] = useState<SpawnLogEntry[]>([])
    const supportedAgents = useMemo(
        () => collectSupportedAgents(props.machines),
        [props.machines]
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
    }, [brainConfig])

    useEffect(() => {
        if (supportedAgents.length === 0) return
        if (!supportedAgents.includes(agent)) {
            setAgent(supportedAgents[0])
        }
    }, [agent, supportedAgents])

    const isFormDisabled = isCreating || props.isLoading || brainConfigLoading
    const canCreate = !isFormDisabled && supportedAgents.length > 0

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
                agent,
                claudeModel: agent === 'claude' ? claudeModel : undefined,
                claudeSettingsType: agent === 'claude' && claudeSettingsType !== 'default' ? claudeSettingsType : undefined,
                claudeAgent: agent === 'claude' ? (claudeAgent.trim() || undefined) : undefined,
                codexModel: agent === 'codex' ? codexModel : undefined,
                modelReasoningEffort: agent === 'codex' ? codexReasoningEffort : undefined,
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
        claudeAgent,
        claudeModel,
        claudeSettingsType,
        codexModel,
        codexReasoningEffort,
        currentOrgId,
        haptic,
        props,
        queryClient,
    ])

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            <div className="px-3 py-3 text-xs text-[var(--app-hint)]">
                Brain sessions use the managed brain workspace and automatically choose a compatible online machine.
            </div>

            <SessionAgentFields
                agent={agent}
                claudeModel={claudeModel}
                claudeSettingsType={claudeSettingsType}
                claudeAgent={claudeAgent}
                codexModel={codexModel}
                codexReasoningEffort={codexReasoningEffort}
                onAgentChange={setAgent}
                onClaudeModelChange={setClaudeModel}
                onClaudeSettingsTypeChange={setClaudeSettingsType}
                onClaudeAgentChange={setClaudeAgent}
                onCodexModelChange={setCodexModel}
                onCodexReasoningEffortChange={setCodexReasoningEffort}
                isFormDisabled={isFormDisabled}
                supportedAgents={supportedAgents}
                getUnsupportedTitle={(agentType) => `No online machine supports ${agentType}`}
            />

            {spawnLogs.length > 0 ? (
                <SpawnLogPanel logs={spawnLogs} />
            ) : null}

            {supportedAgents.length === 0 && !props.isLoading ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    No online machine supports Brain session creation right now.
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
