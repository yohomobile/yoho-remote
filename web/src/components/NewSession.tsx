import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, SpawnLogEntry } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { usePlatform } from '@/hooks/usePlatform'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { queryKeys } from '@/lib/query-keys'
import { useAppContext } from '@/lib/app-context'
import { getMachineStatusLabel, getMachineTitle } from '@/lib/machines'
import { getDefaultSessionTypeForMachine, getPersonalWorktreeOwner, isPersonalWorktreeMachine } from '@/lib/personal-worktree'

type AgentType = 'claude' | 'codex' | 'codez' | 'droid'
type ClaudeModelMode = 'sonnet' | 'opus' | 'glm-5.1'
type SessionType = 'simple' | 'worktree'

/** 上次创建 session 时的偏好设置，存储在 localStorage */
interface SpawnPrefs {
    machineId?: string
    projectPath?: string
    agent?: AgentType
    claudeModel?: ClaudeModelMode
    codexModel?: string
    codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    droidModel?: string
    droidReasoningEffort?: string
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

// Claude 模型选项
const CLAUDE_MODES: { value: ClaudeModelMode; label: string; description: string }[] = [
    { value: 'sonnet', label: 'Sonnet', description: 'Claude Sonnet 4.5+' },
    { value: 'opus', label: 'Opus', description: 'Claude Opus 4.6' },
    { value: 'glm-5.1', label: 'GLM 5.1', description: '智谱 GLM-5.1 (思考模式)' },
]

// Codex 模型选项
const CODEX_MODELS: { value: string; label: string }[] = [
    { value: 'openai/gpt-5.4', label: 'GPT-5.4 (Latest)' },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark (Ultra-fast)' },
    { value: 'openai/gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'openai/gpt-5.2', label: 'GPT-5.2' },
    { value: 'openai/gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'openai/gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
]

// Codex reasoning effort levels
const CODEX_REASONING_EFFORTS = [
    { value: 'low' as const, label: 'Low (快速)' },
    { value: 'medium' as const, label: 'Medium (默认)' },
    { value: 'high' as const, label: 'High (更强推理)' },
    { value: 'xhigh' as const, label: 'X-High (最强推理)' },
]

// Droid supported models (from `droid exec --help`)
const DROID_MODELS: { value: string; label: string; reasoningEfforts: string[]; defaultEffort: string }[] = [
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    { value: 'claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast', reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', reasoningEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'off' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', reasoningEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'off' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', reasoningEfforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'off' },
    { value: 'gpt-5.4', label: 'GPT-5.4', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    { value: 'gpt-5.4-fast', label: 'GPT-5.4 Fast', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
    { value: 'gpt-5.2', label: 'GPT-5.2', reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', reasoningEfforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'high' },
    { value: 'glm-5', label: 'GLM-5', reasoningEfforts: ['none'], defaultEffort: 'none' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5', reasoningEfforts: ['none'], defaultEffort: 'none' },
    { value: 'minimax-m2.5', label: 'MiniMax M2.5', reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
]

function SpawnLogPanel({ logs }: { logs: SpawnLogEntry[] }) {
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
    const [agent, setAgent] = useState<AgentType>(savedPrefs.agent ?? 'claude')
    const [claudeModel, setClaudeModel] = useState<ClaudeModelMode>(savedPrefs.claudeModel ?? 'sonnet')
    const [codexModel, setCodexModel] = useState(savedPrefs.codexModel ?? CODEX_MODELS[0].value)
    const [codexReasoningEffort, setCodexReasoningEffort] = useState<'low' | 'medium' | 'high' | 'xhigh'>(savedPrefs.codexReasoningEffort ?? 'medium')
    const [droidModel, setDroidModel] = useState(savedPrefs.droidModel ?? DROID_MODELS[0].value)
    const [droidReasoningEffort, setDroidReasoningEffort] = useState(savedPrefs.droidReasoningEffort ?? DROID_MODELS[0].defaultEffort)
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [error, setError] = useState<string | null>(null)
    const [isCustomPath, setIsCustomPath] = useState(false)
    const [spawnLogs, setSpawnLogs] = useState<SpawnLogEntry[]>([])
    const onlineMachines = useMemo(
        () => props.machines.filter((machine) => machine.active),
        [props.machines]
    )

    // Fetch org-shared projects once a target machine is selected.
    const { data: projectsData, isLoading: projectsLoading } = useQuery({
        queryKey: ['projects', currentOrgId],
        queryFn: async () => {
            return await props.api.getProjects(currentOrgId)
        },
        enabled: machineId !== null
    })

    // Get current machine's platform
    const currentMachine = useMemo(
        () => props.machines.find(m => m.id === machineId) ?? null,
        [props.machines, machineId]
    )
    const personalWorktreeOwner = useMemo(
        () => isPersonalWorktreeMachine(currentMachine) ? getPersonalWorktreeOwner(userEmail) : null,
        [currentMachine, userEmail]
    )
    const supportsPersonalWorktree = Boolean(personalWorktreeOwner)
    const effectiveSessionType: SessionType = supportsPersonalWorktree ? sessionType : 'simple'

    const projects = useMemo(() => {
        return Array.isArray(projectsData?.projects) ? projectsData.projects : []
    }, [projectsData])

    const selectedProject = useMemo(
        () => projects.find((p) => p.path === projectPath.trim()) ?? null,
        [projects, projectPath]
    )

    const projectSuggestions = useMemo(() => {
        return projects.map((project) => ({
            value: project.path,
            label: project.name
        }))
    }, [projects])

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
        setSessionType(getDefaultSessionTypeForMachine(currentMachine, userEmail))
    }, [currentMachine, userEmail])

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

    // Droid: get available reasoning efforts for the selected model
    const selectedDroidModel = useMemo(
        () => DROID_MODELS.find(m => m.value === droidModel) ?? DROID_MODELS[0],
        [droidModel]
    )

    const handleDroidModelChange = useCallback((newModel: string) => {
        setDroidModel(newModel)
        const model = DROID_MODELS.find(m => m.value === newModel)
        if (model) {
            setDroidReasoningEffort(model.defaultEffort)
        }
    }, [])

    const handleMachineChange = useCallback((newMachineId: string) => {
        setMachineId(newMachineId)
        setInitialProjectRestored(true) // 手动切换机器时不再尝试恢复旧项目
    }, [])

    async function handleCreate() {
        if (!machineId) return
        const directory = projectPath.trim()
        if (!directory) return

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
                sessionType: effectiveSessionType,
                worktreeName: effectiveSessionType === 'worktree' ? (personalWorktreeOwner ?? undefined) : undefined,
                claudeModel: agent === 'claude' ? claudeModel : undefined,
                codexModel: agent === 'codex' ? codexModel : undefined,
                modelReasoningEffort: agent === 'codex' ? codexReasoningEffort : undefined,
                droidModel: agent === 'droid' ? droidModel : undefined,
                droidReasoningEffort: agent === 'droid' ? droidReasoningEffort : undefined,
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
                    claudeModel,
                    codexModel,
                    codexReasoningEffort,
                    droidModel,
                    droidReasoningEffort,
                })
                haptic.notification('success')
                props.onSuccess(result.sessionId)
                return
            }

            haptic.notification('error')
            setError(result.message)
        } catch (e) {
            haptic.notification('error')
            setSpawnLogs(prev => [
                ...prev,
                { timestamp: Date.now(), step: 'error', message: e instanceof Error ? e.message : 'Failed to create session', status: 'error' }
            ])
            setError(e instanceof Error ? e.message : 'Failed to create session')
        }
    }

    const canCreate = Boolean(machineId && currentMachine?.active && projectPath.trim() && !isFormDisabled)

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
                            {!projectsLoading && projectSuggestions.length === 0 && (
                                <option value="">No projects available</option>
                            )}
                            {projectSuggestions.map((suggestion) => (
                                <option key={suggestion.value} value={suggestion.value}>
                                    {suggestion.label ?? suggestion.value}
                                </option>
                            ))}
                        </select>
                        {selectedProject?.description && (
                            <div className="text-xs text-[var(--app-hint)]">
                                {selectedProject.description}
                            </div>
                        )}
                    </>
                )}
            </div>

            {supportsPersonalWorktree ? (
                <div className="flex flex-col gap-1.5 px-3 py-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Workspace
                    </label>
                    <div className="flex flex-col gap-2">
                        <label className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="sessionType"
                                value="worktree"
                                checked={sessionType === 'worktree'}
                                onChange={() => setSessionType('worktree')}
                                disabled={isFormDisabled}
                                className="mt-0.5 accent-[var(--app-link)] w-3.5 h-3.5"
                            />
                            <div className="flex-1">
                                <div className="text-sm">Personal worktree</div>
                                <div className="text-xs text-[var(--app-hint)]">
                                    Reuse or create <span className="font-mono">{personalWorktreeOwner}</span> for this repo
                                </div>
                            </div>
                        </label>
                        <label className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="sessionType"
                                value="simple"
                                checked={sessionType === 'simple'}
                                onChange={() => setSessionType('simple')}
                                disabled={isFormDisabled}
                                className="mt-0.5 accent-[var(--app-link)] w-3.5 h-3.5"
                            />
                            <div className="flex-1">
                                <div className="text-sm">Base repo</div>
                                <div className="text-xs text-[var(--app-hint)]">
                                    Open the selected directory directly without creating a worktree
                                </div>
                            </div>
                        </label>
                    </div>
                </div>
            ) : null}

            {/* Agent Selector */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Agent
                </label>
                <div className="flex flex-wrap gap-x-3 gap-y-2">
                    {(['claude', 'codex', 'codez', 'droid'] as const).map((agentType) => (
                        <label
                            key={agentType}
                            className="flex items-center gap-1 cursor-pointer"
                        >
                            <input
                                type="radio"
                                name="agent"
                                value={agentType}
                                checked={agent === agentType}
                                onChange={() => setAgent(agentType)}
                                disabled={isFormDisabled}
                                className="accent-[var(--app-link)] w-3.5 h-3.5"
                            />
                            <span className="text-xs capitalize">{agentType}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Claude Model Selector */}
            {agent === 'claude' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Model
                    </label>
                    <select
                        value={claudeModel}
                        onChange={(e) => setClaudeModel(e.target.value as ClaudeModelMode)}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {CLAUDE_MODES.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                                {mode.label} - {mode.description}
                            </option>
                        ))}
                    </select>
                </div>
            ) : null}

            {/* Codex Model + Reasoning Effort Selector */}
            {agent === 'codex' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Model (Codex)
                    </label>
                    <select
                        value={codexModel}
                        onChange={(e) => setCodexModel(e.target.value)}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {CODEX_MODELS.map((model) => (
                            <option key={model.value} value={model.value}>
                                {model.label}
                            </option>
                        ))}
                    </select>
                    <label className="text-xs font-medium text-[var(--app-hint)] mt-2">
                        Reasoning Effort
                    </label>
                    <select
                        value={codexReasoningEffort}
                        onChange={(e) => setCodexReasoningEffort(e.target.value as 'low' | 'medium' | 'high' | 'xhigh')}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {CODEX_REASONING_EFFORTS.map((effort) => (
                            <option key={effort.value} value={effort.value}>
                                {effort.label}
                            </option>
                        ))}
                    </select>
                </div>
            ) : null}

            {/* Droid Model + Reasoning Effort Selector */}
            {agent === 'droid' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Model (Droid)
                    </label>
                    <select
                        value={droidModel}
                        onChange={(e) => handleDroidModelChange(e.target.value)}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {DROID_MODELS.map((model) => (
                            <option key={model.value} value={model.value}>
                                {model.label}
                            </option>
                        ))}
                    </select>
                    {selectedDroidModel.reasoningEfforts.length > 1 && (
                        <>
                            <label className="text-xs font-medium text-[var(--app-hint)] mt-1.5">
                                Reasoning Effort
                            </label>
                            <select
                                value={droidReasoningEffort}
                                onChange={(e) => setDroidReasoningEffort(e.target.value)}
                                disabled={isFormDisabled}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                            >
                                {selectedDroidModel.reasoningEfforts.map((effort) => (
                                    <option key={effort} value={effort}>
                                        {effort}{effort === selectedDroidModel.defaultEffort ? ' (default)' : ''}
                                    </option>
                                ))}
                            </select>
                        </>
                    )}
                </div>
            ) : null}

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
