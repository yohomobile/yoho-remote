type AgentType = 'claude' | 'codex'
type ClaudeModelMode = 'sonnet' | 'opus'
type ClaudeSettingsType = 'default' | 'claude' | 'litellm'
type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

const CLAUDE_MODES: { value: ClaudeModelMode; label: string; description: string }[] = [
    { value: 'sonnet', label: 'Sonnet', description: 'Claude Sonnet 4.5+' },
    { value: 'opus', label: 'Opus', description: 'Claude Opus 4.6' },
]

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

const CODEX_REASONING_EFFORTS = [
    { value: 'low' as const, label: 'Low (快速)' },
    { value: 'medium' as const, label: 'Medium (默认)' },
    { value: 'high' as const, label: 'High (更强推理)' },
    { value: 'xhigh' as const, label: 'X-High (最强推理)' },
]

const DEFAULT_CLAUDE_MODEL: ClaudeModelMode = 'sonnet'
const DEFAULT_CLAUDE_SETTINGS_TYPE: ClaudeSettingsType = 'default'
const DEFAULT_CODEX_MODEL = CODEX_MODELS[0].value
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'medium'

function normalizeSupportedAgents(supportedAgents: readonly string[] | null | undefined): AgentType[] | null {
    if (!supportedAgents || supportedAgents.length === 0) {
        return null
    }
    return supportedAgents.filter((agent): agent is AgentType => agent === 'claude' || agent === 'codex')
}

function normalizeCodexModelValue(value: string | null | undefined): string {
    const trimmed = value?.trim()
    if (!trimmed) {
        return DEFAULT_CODEX_MODEL
    }
    if (trimmed.startsWith('openai/')) {
        return trimmed
    }
    return `openai/${trimmed}`
}

function sanitizeClaudeModelMode(value: unknown, fallback: ClaudeModelMode = DEFAULT_CLAUDE_MODEL): ClaudeModelMode {
    return value === 'sonnet' || value === 'opus'
        ? value
        : fallback
}

type SessionAgentFieldsProps = {
    agent: AgentType
    claudeModel: ClaudeModelMode
    claudeSettingsType: ClaudeSettingsType
    claudeAgent: string
    codexModel: string
    codexReasoningEffort: CodexReasoningEffort
    onAgentChange: (agent: AgentType) => void
    onClaudeModelChange: (model: ClaudeModelMode) => void
    onClaudeSettingsTypeChange: (settingsType: ClaudeSettingsType) => void
    onClaudeAgentChange: (agentName: string) => void
    onCodexModelChange: (model: string) => void
    onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void
    isFormDisabled?: boolean
    supportedAgents?: readonly string[] | null
    getUnsupportedTitle?: (agent: AgentType) => string | undefined
}

export function SessionAgentFields(props: SessionAgentFieldsProps) {
    const supportedAgents = normalizeSupportedAgents(props.supportedAgents)

    return (
        <>
            <div className="flex flex-col gap-1.5 px-3 py-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    Agent
                </label>
                <div className="flex flex-wrap gap-x-3 gap-y-2">
                    {(['claude', 'codex'] as const).map((agentType) => {
                        const isSupported = !supportedAgents || supportedAgents.includes(agentType)
                        return (
                            <label
                                key={agentType}
                                className={`flex items-center gap-1 ${isSupported ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                                title={!isSupported ? props.getUnsupportedTitle?.(agentType) : undefined}
                            >
                                <input
                                    type="radio"
                                    name="agent"
                                    value={agentType}
                                    checked={props.agent === agentType}
                                    onChange={() => props.onAgentChange(agentType)}
                                    disabled={props.isFormDisabled || !isSupported}
                                    className="accent-[var(--app-link)] w-3.5 h-3.5"
                                />
                                <span className="text-xs capitalize">{agentType}</span>
                            </label>
                        )
                    })}
                </div>
            </div>

            {props.agent === 'claude' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Model
                    </label>
                    <select
                        value={props.claudeModel}
                        onChange={(e) => props.onClaudeModelChange(e.target.value as ClaudeModelMode)}
                        disabled={props.isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        {CLAUDE_MODES.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                                {mode.label} - {mode.description}
                            </option>
                        ))}
                    </select>
                    <label className="text-xs font-medium text-[var(--app-hint)] mt-2">
                        Runtime
                    </label>
                    <select
                        value={props.claudeSettingsType}
                        onChange={(e) => props.onClaudeSettingsTypeChange(e.target.value as ClaudeSettingsType)}
                        disabled={props.isFormDisabled}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        <option value="default">Default</option>
                        <option value="claude">Claude / OAuth Relay</option>
                        <option value="litellm">LiteLLM</option>
                    </select>
                    <label className="text-xs font-medium text-[var(--app-hint)] mt-2">
                        Claude Agent (optional)
                    </label>
                    <input
                        type="text"
                        value={props.claudeAgent}
                        onChange={(e) => props.onClaudeAgentChange(e.target.value)}
                        disabled={props.isFormDisabled}
                        placeholder="Optional agent name, e.g. ClaudeOauthRelay"
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                </div>
            ) : null}

            {props.agent === 'codex' ? (
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        Model (Codex)
                    </label>
                    <select
                        value={props.codexModel}
                        onChange={(e) => props.onCodexModelChange(e.target.value)}
                        disabled={props.isFormDisabled}
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
                        value={props.codexReasoningEffort}
                        onChange={(e) => props.onCodexReasoningEffortChange(e.target.value as CodexReasoningEffort)}
                        disabled={props.isFormDisabled}
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
        </>
    )
}

export {
    CLAUDE_MODES,
    CODEX_MODELS,
    CODEX_REASONING_EFFORTS,
    DEFAULT_CLAUDE_MODEL,
    DEFAULT_CLAUDE_SETTINGS_TYPE,
    DEFAULT_CODEX_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    normalizeCodexModelValue,
    sanitizeClaudeModelMode,
}

export type {
    AgentType,
    ClaudeModelMode,
    ClaudeSettingsType,
    CodexReasoningEffort,
}
