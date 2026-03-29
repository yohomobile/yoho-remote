import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Machine, SpawnLogEntry } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { usePlatform } from '@/hooks/usePlatform'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { queryKeys } from '@/lib/query-keys'
import { useAppContext } from '@/lib/app-context'

type AgentType = 'claude' | 'codex' | 'opencode' | 'droid'
type ClaudeSettingsType = 'litellm' | 'claude'

/** 上次创建 session 时的偏好设置，存储在 localStorage */
interface SpawnPrefs {
    machineId?: string
    projectPath?: string
    agent?: AgentType
    claudeSettingsType?: ClaudeSettingsType
    claudeAgent?: string
    opencodeModel?: string
    codexReasoningEffort?: 'medium' | 'high' | 'xhigh'
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

// Codex 固定使用 gpt-5.3-codex
const CODEX_MODEL = 'openai/gpt-5.3-codex'

// Codex reasoning effort levels
const CODEX_REASONING_EFFORTS = [
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

// OpenCode supported models - using OpenCode's native model ID format
const OPENCODE_MODELS = [
    // Anthropic (Claude) - latest generation
    { value: 'anthropic.claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic' },
    { value: 'anthropic.claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
    { value: 'anthropic.claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
    // Anthropic (Claude) - legacy
    { value: 'anthropic.claude-opus-4-5-20251101', label: 'Claude Opus 4.5', provider: 'Anthropic' },
    { value: 'anthropic.claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'Anthropic' },
    { value: 'anthropic.claude-opus-4-20250514', label: 'Claude Opus 4', provider: 'Anthropic' },
    // OpenAI (from `opencode models openai`)
    { value: 'openai/gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI' },
    // Google Gemini
    { value: 'gemini.gemini-2.5', label: 'Gemini 2.5', provider: 'Google' },
    { value: 'gemini.gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google' },
    { value: 'gemini.gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'Google' },
    { value: 'gemini.gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', provider: 'Google' },
    // xAI (Grok)
    { value: 'xai.grok-3-beta', label: 'Grok 3 Beta', provider: 'xAI' },
    { value: 'xai.grok-3-mini-beta', label: 'Grok 3 Mini Beta', provider: 'xAI' },
    { value: 'xai.grok-3-fast-beta', label: 'Grok 3 Fast Beta', provider: 'xAI' },
    { value: 'xai.grok-3-mini-fast-beta', label: 'Grok 3 Mini Fast Beta', provider: 'xAI' },
    // Groq (fast inference)
    { value: 'groq.llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', provider: 'Groq' },
    { value: 'groq.qwen-qwq', label: 'Qwen QWQ', provider: 'Groq' },
    { value: 'groq.deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill Llama 70B', provider: 'Groq' },
    { value: 'groq.meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout', provider: 'Groq' },
    { value: 'groq.meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick', provider: 'Groq' },
    // GitHub Copilot
    { value: 'copilot.gpt-4o', label: 'GPT-4o', provider: 'Copilot' },
    { value: 'copilot.gpt-4.1', label: 'GPT-4.1', provider: 'Copilot' },
    { value: 'copilot.claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'Copilot' },
    { value: 'copilot.claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', provider: 'Copilot' },
    { value: 'copilot.o1', label: 'o1', provider: 'Copilot' },
    { value: 'copilot.o3-mini', label: 'o3 Mini', provider: 'Copilot' },
    { value: 'copilot.o4-mini', label: 'o4 Mini', provider: 'Copilot' },
    { value: 'copilot.gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Copilot' },
    { value: 'copilot.gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'Copilot' },
    // AWS Bedrock
    { value: 'bedrock.claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', provider: 'Bedrock' },
    // OpenRouter
    { value: 'openrouter.openrouter/pony-alpha', label: 'Pony Alpha', provider: 'OpenRouter' },
    // MiniMax (OpenAI-compatible API)
    { value: 'minimax-openai/MiniMax-M2.1', label: 'MiniMax-M2.1', provider: 'MiniMax' },
    { value: 'minimax-openai/MiniMax-Text-01', label: 'MiniMax-Text-01', provider: 'MiniMax' },
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

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
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
    const queryClient = useQueryClient()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const isFormDisabled = isPending || props.isLoading

    const [savedPrefs] = useState(() => loadSpawnPrefs(userEmail))
    const [machineId, setMachineId] = useState<string | null>(savedPrefs.machineId ?? null)
    const [projectPath, setProjectPath] = useState(savedPrefs.projectPath ?? '')
    const [agent, setAgent] = useState<AgentType>(savedPrefs.agent ?? 'claude')
    const [claudeSettingsType, setClaudeSettingsType] = useState<ClaudeSettingsType>(savedPrefs.claudeSettingsType ?? 'litellm')
    const [claudeAgent, setClaudeAgent] = useState(savedPrefs.claudeAgent ?? '')
    const [opencodeModel, setOpencodeModel] = useState(savedPrefs.opencodeModel ?? OPENCODE_MODELS[0].value)
    const [codexReasoningEffort, setCodexReasoningEffort] = useState<'medium' | 'high' | 'xhigh'>(savedPrefs.codexReasoningEffort ?? 'medium')
    const [droidModel, setDroidModel] = useState(savedPrefs.droidModel ?? DROID_MODELS[0].value)
    const [droidReasoningEffort, setDroidReasoningEffort] = useState(savedPrefs.droidReasoningEffort ?? DROID_MODELS[0].defaultEffort)
    const [error, setError] = useState<string | null>(null)
    const [isCustomPath, setIsCustomPath] = useState(false)
    const [spawnLogs, setSpawnLogs] = useState<SpawnLogEntry[]>([])

    // Fetch projects for selected machine (includes global projects where machineId is null)
    const { data: projectsData, isLoading: projectsLoading } = useQuery({
        queryKey: ['projects', machineId, currentOrgId],
        queryFn: async () => {
            return await props.api.getProjects(machineId ?? undefined, currentOrgId)
        },
        enabled: machineId !== null
    })

    // Get current machine's platform
    const currentMachine = useMemo(
        () => props.machines.find(m => m.id === machineId) ?? null,
        [props.machines, machineId]
    )

    // Filter projects: machine-specific projects + platform-compatible global projects
    const projects = useMemo(() => {
        const allProjects = Array.isArray(projectsData?.projects) ? projectsData.projects : []
        const platform = currentMachine?.metadata?.platform ?? ''

        return allProjects.filter(project => {
            // If project has machineId, only show if it matches current machine
            if (project.machineId) {
                return project.machineId === machineId
            }
            // Global project: check if path is compatible with current platform
            if (platform === 'darwin') {
                // macOS: paths start with /Users
                return project.path.startsWith('/Users/')
            } else {
                // Linux: paths start with /home or /root or /opt
                return project.path.startsWith('/home/') ||
                       project.path.startsWith('/root/') ||
                       project.path.startsWith('/opt/')
            }
        })
    }, [projectsData, machineId, currentMachine])

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
        if (props.machines.length === 0) return
        if (machineId && props.machines.find((m) => m.id === machineId)) return

        // savedPrefs.machineId 已通过 useState 初始值设置，如果它不在列表中才 fallback
        if (props.machines[0]) {
            setMachineId(props.machines[0].id)
        }
    }, [props.machines, machineId])

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
                sessionType: 'simple',
                claudeSettingsType: agent === 'claude' ? claudeSettingsType : undefined,
                claudeAgent: agent === 'claude' ? (claudeAgent.trim() || undefined) : undefined,
                opencodeModel: agent === 'opencode' ? opencodeModel : undefined,
                codexModel: agent === 'codex' ? CODEX_MODEL : undefined,
                modelReasoningEffort: agent === 'codex' ? codexReasoningEffort : undefined,
                droidModel: agent === 'droid' ? droidModel : undefined,
                droidReasoningEffort: agent === 'droid' ? droidReasoningEffort : undefined,
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
                    claudeSettingsType,
                    claudeAgent: claudeAgent.trim() || undefined,
                    opencodeModel,
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

    const canCreate = Boolean(machineId && projectPath.trim() && !isFormDisabled)

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
                    {!props.isLoading && props.machines.length === 0 && (
                        <option value="">No machines available</option>
                    )}
                    {props.machines.map((m) => (
                        <option key={m.id} value={m.id}>
                            {getMachineTitle(m)}
                            {m.metadata?.platform ? ` (${m.metadata.platform})` : ''}
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

            {/* Agent Selector */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Agent
                </label>
                <div className="flex flex-wrap gap-x-3 gap-y-2">
                    {(['claude', 'codex', 'opencode', 'droid'] as const).map((agentType) => (
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

            {/* Claude Settings Type Selector */}
            {agent === 'claude' ? (
                <div className="flex flex-col gap-1.5 px-3 py-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Settings
                    </label>
                    <div className="flex flex-wrap gap-x-3 gap-y-2">
                        {(['litellm', 'claude'] as const).map((settingsType) => (
                            <label
                                key={settingsType}
                                className="flex items-center gap-1 cursor-pointer"
                            >
                                <input
                                    type="radio"
                                    name="claudeSettings"
                                    value={settingsType}
                                    checked={claudeSettingsType === settingsType}
                                    onChange={() => setClaudeSettingsType(settingsType)}
                                    disabled={isFormDisabled}
                                    className="accent-[var(--app-link)] w-3.5 h-3.5"
                                />
                                <span className="text-xs">{settingsType === 'litellm' ? 'LiteLLM' : 'Claude'}</span>
                            </label>
                        ))}
                    </div>
                </div>
            ) : null}

            {/* Claude Agent (optional) */}
            {agent === 'claude' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Claude Agent (optional)
                    </label>
                    <input
                        type="text"
                        value={claudeAgent}
                        onChange={(e) => setClaudeAgent(e.target.value)}
                        disabled={isFormDisabled}
                        placeholder="e.g. grok"
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                    <div className="text-[11px] text-[var(--app-hint)]">
                        Matches the name from Claude Code (--agent).
                    </div>
                </div>
            ) : null}

            {/* Codex Reasoning Effort Selector */}
            {agent === 'codex' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Reasoning Effort (Codex)
                    </label>
                    <select
                        value={codexReasoningEffort}
                        onChange={(e) => setCodexReasoningEffort(e.target.value as 'medium' | 'high' | 'xhigh')}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {CODEX_REASONING_EFFORTS.map((effort) => (
                            <option key={effort.value} value={effort.value}>
                                {effort.label}
                            </option>
                        ))}
                    </select>
                    <div className="text-[11px] text-[var(--app-hint)]">
                        Codex 固定使用 GPT-5.3，可选择推理强度。
                    </div>
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

            {/* OpenCode Model Selector */}
            {agent === 'opencode' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Model (OpenCode)
                    </label>
                    <select
                        value={opencodeModel}
                        onChange={(e) => setOpencodeModel(e.target.value)}
                        disabled={isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {OPENCODE_MODELS.map((model) => (
                            <option key={model.value} value={model.value}>
                                {model.provider} - {model.label}
                            </option>
                        ))}
                    </select>
                    <div className="text-[11px] text-[var(--app-hint)]">
                        OpenCode supports 75+ providers via AI SDK. Configure API keys in opencode.json.
                    </div>
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
