import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, SpawnLogEntry, TokenSource } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import {
    DEFAULT_CLAUDE_MODEL,
    DEFAULT_CODEX_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    SessionAgentFields,
    type AgentType,
    type ClaudeModelMode,
} from '@/components/SessionAgentFields'
import { usePlatform } from '@/hooks/usePlatform'
import { isLicenseTermination, getLicenseTerminationLabel } from '@/lib/license'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { getMachineStatusLabel, getMachineTitle, sortMachinesForStableDisplay } from '@/lib/machines'
import { LOCAL_TOKEN_SOURCE, LOCAL_TOKEN_SOURCE_ID } from '@/lib/tokenSources'

/** 上次创建 session 时的偏好设置，存储在 localStorage */
interface SpawnPrefs {
    machineId?: string
    projectPath?: string
    agent?: AgentType
    tokenSourceId?: string
    claudeModel?: ClaudeModelMode
    codexModel?: string
    codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
}

function sanitizeAgentType(agent: unknown): AgentType | null {
    return agent === 'claude' || agent === 'codex' ? agent : null
}

function getSpawnPrefsKey(userEmail: string | null): string {
    const suffix = userEmail ? `:${userEmail}` : ''
    return `yr:lastSpawnPrefs${suffix}`
}

function loadSpawnPrefs(userEmail: string | null): SpawnPrefs {
    try {
        const stored = localStorage.getItem(getSpawnPrefsKey(userEmail))
        return stored ? JSON.parse(stored) : {}
    } catch {
        return {}
    }
}

function saveSpawnPrefs(userEmail: string | null, prefs: SpawnPrefs): void {
    try {
        localStorage.setItem(getSpawnPrefsKey(userEmail), JSON.stringify(prefs))
    } catch {
        // Ignore storage errors
    }
}

function getCompatibleTokenSources(tokenSources: TokenSource[], agent: AgentType): TokenSource[] {
    return tokenSources.filter((tokenSource) => tokenSource.supportedAgents.includes(agent))
}
export function SpawnLogPanel({ logs }: { logs: SpawnLogEntry[] }) {
    if (logs.length === 0) return null

    const getStatusIcon = (status: SpawnLogEntry['status']) => {
        switch (status) {
            case 'pending':
                return <span className="text-gray-400">○</span>
            case 'running':
                return <span className="text-blue-500 animate-pulse">●</span>
            case 'success':
                return <span className="text-green-500">✓</span>
            case 'error':
                return <span className="text-red-500">✗</span>
        }
    }

    const getStatusColor = (status: SpawnLogEntry['status']) => {
        switch (status) {
            case 'pending':
                return 'text-gray-400'
            case 'running':
                return 'text-blue-600'
            case 'success':
                return 'text-green-600'
            case 'error':
                return 'text-red-600'
        }
    }

    return (
        <div className="px-3 py-2 bg-[var(--app-bg-secondary)] border-t border-[var(--app-divider)]">
            <div className="text-xs font-medium text-[var(--app-hint)] mb-2">
                Creation Log
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto font-mono text-xs">
                {logs.map((log, index) => (
                    <div key={index} className="flex items-start gap-2">
                        <span className="flex-shrink-0 w-4">
                            {getStatusIcon(log.status)}
                        </span>
                        <span className="text-[var(--app-hint)] flex-shrink-0 w-16">
                            [{log.step}]
                        </span>
                        <span className={getStatusColor(log.status)}>
                            {log.message}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

export function NewSession(props: {
    api: ApiClient
    machines: Machine[]
    isLoading?: boolean
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}) {
    const { userEmail, currentOrgId } = useAppContext()
    const { haptic } = usePlatform()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const isFormDisabled = isPending || props.isLoading

    const [savedPrefs] = useState(() => loadSpawnPrefs(userEmail))
    const [machineId, setMachineId] = useState<string | null>(savedPrefs.machineId ?? null)
    const [projectPath, setProjectPath] = useState(savedPrefs.projectPath ?? '')
    const [agent, setAgent] = useState<AgentType>(sanitizeAgentType(savedPrefs.agent) ?? 'claude')
    const [tokenSourceId, setTokenSourceId] = useState(typeof savedPrefs.tokenSourceId === 'string' ? savedPrefs.tokenSourceId : '')
    const [claudeModel, setClaudeModel] = useState<ClaudeModelMode>(savedPrefs.claudeModel ?? DEFAULT_CLAUDE_MODEL)
    const [codexModel, setCodexModel] = useState(savedPrefs.codexModel ?? DEFAULT_CODEX_MODEL)
    const [codexReasoningEffort, setCodexReasoningEffort] = useState<'low' | 'medium' | 'high' | 'xhigh'>(savedPrefs.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT)
    const [error, setError] = useState<string | null>(null)
    const [isCustomPath, setIsCustomPath] = useState(false)
    const [spawnLogs, setSpawnLogs] = useState<SpawnLogEntry[]>([])
    const onlineMachines = useMemo(
        () => sortMachinesForStableDisplay(props.machines).filter((machine) => machine.active),
        [props.machines]
    )
    const { data: tokenSourcesData } = useQuery({
        queryKey: queryKeys.tokenSources(currentOrgId ?? '', false),
        queryFn: async () => {
            return await props.api.getTokenSources(currentOrgId, false)
        },
        enabled: Boolean(currentOrgId)
    })
    const tokenSources = useMemo(() => {
        const remoteTokenSources = Array.isArray(tokenSourcesData?.tokenSources) ? tokenSourcesData.tokenSources : []
        return [LOCAL_TOKEN_SOURCE, ...remoteTokenSources]
    }, [tokenSourcesData])
    const compatibleTokenSources = useMemo(
        () => getCompatibleTokenSources(tokenSources, agent),
        [agent, tokenSources]
    )

    // Fetch projects for selected machine.
    const { data: projectsData, isLoading: projectsLoading } = useQuery({
        queryKey: ['projects', currentOrgId, machineId],
        queryFn: async () => {
            return await props.api.getProjects(currentOrgId, machineId)
        },
        enabled: machineId !== null
    })

    // Get current machine's platform
    const currentMachine = useMemo(
        () => props.machines.find(m => m.id === machineId) ?? null,
        [props.machines, machineId]
    )
    const projects = useMemo(() => {
        return Array.isArray(projectsData?.projects) ? projectsData.projects : []
    }, [projectsData])

    const selectedProject = useMemo(
        () => projects.find((p) => p.path === projectPath.trim()) ?? null,
        [projects, projectPath]
    )

    const selectedProjectScopeText = useMemo(() => {
        if (!selectedProject) return null
        return currentMachine
            ? `${getMachineTitle(currentMachine)}`
            : 'Machine local project'
    }, [currentMachine, selectedProject])

    // Initialize with saved machine or first available
    useEffect(() => {
        if (onlineMachines.length === 0) {
            setMachineId(null)
            return
        }
        if (machineId && onlineMachines.find((m) => m.id === machineId)) return

        // savedPrefs.machineId 已通过 useState 初始值设置，如果它不在列表中才 fallback
        if (onlineMachines[0]) {
            setMachineId(onlineMachines[0].id)
        }
    }, [onlineMachines, machineId])

    useEffect(() => {
        if (compatibleTokenSources.length === 0) {
            setTokenSourceId('')
            return
        }
        if (compatibleTokenSources.some((tokenSource) => tokenSource.id === tokenSourceId)) {
            return
        }
        const restored = compatibleTokenSources.find((tokenSource) => tokenSource.id === savedPrefs.tokenSourceId)
        setTokenSourceId(restored?.id ?? compatibleTokenSources[0]?.id ?? '')
    }, [compatibleTokenSources, savedPrefs.tokenSourceId, tokenSourceId])

    // Reset project path when machine changes (different machine may have different projects)
    const [initialProjectRestored, setInitialProjectRestored] = useState(false)
    useEffect(() => {
        if (projects.length === 0) {
            setProjectPath('')
            return
        }
        // On first load, try to restore saved project path if it exists in the list
        if (!initialProjectRestored && savedPrefs.projectPath && projects.some(p => p.path === savedPrefs.projectPath)) {
            setProjectPath(savedPrefs.projectPath)
            setInitialProjectRestored(true)
            return
        }
        setInitialProjectRestored(true)
        setProjectPath(projects[0].path)
    }, [machineId, projects])

    const handleMachineChange = useCallback((newMachineId: string) => {
        setMachineId(newMachineId)
        setInitialProjectRestored(true) // 手动切换机器时不再尝试恢复旧项目
        // Auto-switch agent if current agent is not supported by the new machine
        const newMachine = props.machines.find(m => m.id === newMachineId)
        if (newMachine?.supportedAgents && newMachine.supportedAgents.length > 0) {
            setAgent(prev => newMachine.supportedAgents!.includes(prev) ? prev : (newMachine.supportedAgents![0] as AgentType))
        }
    }, [props.machines])

    async function handleCreate() {
        if (!machineId) return
        const directory = projectPath.trim()
        if (!directory || !tokenSourceId) return

        setError(null)
        setSpawnLogs([])

        // Add initial local log entries to show progress
        const localLogs: SpawnLogEntry[] = [
            { timestamp: Date.now(), step: 'request', message: `Sending spawn request for ${agent} agent...`, status: 'running' }
        ]
        setSpawnLogs([...localLogs])

        try {
            const result = await spawnSession({
                machineId,
                directory,
                agent,
                yolo: true,
                sessionType: 'simple',
                tokenSourceId: tokenSourceId === LOCAL_TOKEN_SOURCE_ID ? undefined : tokenSourceId,
                claudeModel: agent === 'claude' ? claudeModel : undefined,
                codexModel: agent === 'codex' ? codexModel : undefined,
                modelReasoningEffort: agent === 'codex' ? codexReasoningEffort : undefined,
                orgId: currentOrgId,
            })

            // Update logs from server response
            if (result.logs && result.logs.length > 0) {
                setSpawnLogs(result.logs)
            }

            if (result.type === 'success') {
                // 保存本次偏好设置，下次新建时自动恢复
                saveSpawnPrefs(userEmail, {
                    machineId: machineId ?? undefined,
                    projectPath: directory,
                    agent,
                    tokenSourceId,
                    claudeModel,
                    codexModel,
                    codexReasoningEffort,
                })
                haptic.notification('success')
                props.onSuccess(result.sessionId)
                return
            }

            haptic.notification('error')
            const isLicenseError = isLicenseTermination(result.code)
            setError(isLicenseError
                ? `${getLicenseTerminationLabel(result.code!)} — please contact your administrator.`
                : result.message
            )
        } catch (e) {
            haptic.notification('error')
            setSpawnLogs(prev => [
                ...prev,
                { timestamp: Date.now(), step: 'error', message: e instanceof Error ? e.message : 'Failed to create session', status: 'error' }
            ])
            setError(e instanceof Error ? e.message : 'Failed to create session')
        }
    }

    const canCreate = Boolean(
        machineId
        && currentMachine?.active
        && projectPath.trim()
        && tokenSourceId
        && compatibleTokenSources.some((tokenSource) => tokenSource.id === tokenSourceId)
        && !isFormDisabled
    )

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            {/* Machine Selector */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Machine
                </label>
                <select
                    value={machineId ?? ''}
                    onChange={(e) => handleMachineChange(e.target.value)}
                    disabled={isFormDisabled}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                >
                    {props.isLoading && (
                        <option value="">Loading machines…</option>
                    )}
                    {!props.isLoading && onlineMachines.length === 0 && (
                        <option value="">No online machines available</option>
                    )}
                    {onlineMachines.map((m) => (
                        <option key={m.id} value={m.id}>
                            {getMachineTitle(m)}
                            {m.metadata?.platform ? ` (${m.metadata.platform})` : ''} · {getMachineStatusLabel(m)}
                        </option>
                    ))}
                </select>
            </div>

            {/* Project Selector */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Project
                    </label>
                    <button
                        type="button"
                        onClick={() => setIsCustomPath(!isCustomPath)}
                        className="text-xs text-[var(--app-link)] hover:underline"
                    >
                        {isCustomPath ? 'Select from list' : 'Custom path'}
                    </button>
                </div>
                {isCustomPath ? (
                    <input
                        type="text"
                        value={projectPath}
                        onChange={(e) => setProjectPath(e.target.value)}
                        disabled={isFormDisabled}
                        placeholder="/path/to/project"
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                ) : (
                    <>
                        <select
                            value={projectPath}
                            onChange={(e) => setProjectPath(e.target.value)}
                            disabled={isFormDisabled || projectsLoading}
                            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                        >
                            {projectsLoading && (
                                <option value="">Loading projects…</option>
                            )}
                            {!projectsLoading && projects.length === 0 && (
                                <option value="">No projects available</option>
                            )}
                            {projects.map((project) => (
                                <option key={project.id} value={project.path}>
                                    {project.name}
                                </option>
                            ))}
                        </select>
                        {selectedProject ? (
                            <div className="space-y-1 text-xs text-[var(--app-hint)]">
                                <div>{selectedProjectScopeText}</div>
                                {selectedProject.description ? (
                                    <div>{selectedProject.description}</div>
                                ) : null}
                            </div>
                        ) : !projectsLoading && currentMachine ? (
                            <div className="text-xs text-[var(--app-hint)]">
                                {`No saved projects for ${getMachineTitle(currentMachine)}. Add projects in Settings.`}
                            </div>
                        ) : null}
                    </>
                )}
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
                supportedAgents={currentMachine?.supportedAgents ?? null}
                getUnsupportedTitle={(agentType) => currentMachine
                    ? `${getMachineTitle(currentMachine)} does not support ${agentType}`
                    : undefined}
            />

            {/* Spawn Logs */}
            {spawnLogs.length > 0 && (
                <SpawnLogPanel logs={spawnLogs} />
            )}

            {/* Error Message */}
            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            {/* Action Buttons */}
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
                    aria-busy={isPending}
                    className="gap-2"
                >
                    {isPending ? (
                        <>
                            <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                            Creating…
                        </>
                    ) : (
                        'Create'
                    )}
                </Button>
            </div>
        </div>
    )
}
