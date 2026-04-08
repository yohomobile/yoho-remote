import type { DecryptedMessage } from '@/types/api'
import type { AgentEvent, NormalizedAgentContent, NormalizedMessage, ToolResultPermission } from '@/chat/types'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
}

function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function hasToolUseErrorTag(value: unknown): boolean {
    return typeof value === 'string' && /<tool_use_error>[\s\S]*<\/tool_use_error>/i.test(value)
}

function inferCodexToolResultIsError(output: unknown): boolean {
    if (hasToolUseErrorTag(output)) {
        return true
    }

    if (Array.isArray(output)) {
        return output.some(inferCodexToolResultIsError)
    }

    if (!isObject(output)) {
        return false
    }

    if (asBoolean(output.is_error) === true || asBoolean(output.isError) === true) {
        return true
    }

    if (typeof output.error === 'string' && output.error.trim().length > 0) {
        return true
    }

    if (typeof output.message === 'string' && hasToolUseErrorTag(output.message)) {
        return true
    }

    const status = asString(output.status)?.toLowerCase()
    if (status === 'error' || status === 'failed') {
        return true
    }

    const exitCode = asNumber(output.exit_code) ?? asNumber(output.exitCode)
    if (exitCode !== null && exitCode !== 0) {
        return true
    }

    if ('output' in output && inferCodexToolResultIsError(output.output)) {
        return true
    }

    if ('content' in output && inferCodexToolResultIsError(output.content)) {
        return true
    }

    return false
}

function isSkippableAgentContent(content: unknown): boolean {
    if (!isObject(content) || content.type !== 'output') return false
    const data = isObject(content.data) ? content.data : null
    if (!data) return false
    return Boolean(data.isMeta) || Boolean(data.isCompactSummary)
}

function isCodexContent(content: unknown): boolean {
    return isObject(content) && content.type === 'codex'
}

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

function normalizeToolResultPermissions(value: unknown): ToolResultPermission | undefined {
    if (!isObject(value)) return undefined
    const date = asNumber(value.date)
    const result = value.result
    if (date === null) return undefined
    if (result !== 'approved' && result !== 'denied') return undefined

    const mode = asString(value.mode) ?? undefined
    const allowedTools = Array.isArray(value.allowedTools)
        ? value.allowedTools.filter((tool) => typeof tool === 'string')
        : undefined
    const decision = value.decision
    const normalizedDecision = decision === 'approved' || decision === 'approved_for_session' || decision === 'denied' || decision === 'abort'
        ? decision
        : undefined

    return {
        date,
        result,
        mode,
        allowedTools,
        decision: normalizedDecision
    }
}

function normalizeAgentEvent(value: unknown): AgentEvent | null {
    if (!isObject(value) || typeof value.type !== 'string') return null
    return value as AgentEvent
}

function normalizeAssistantOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    const blocks: NormalizedAgentContent[] = []

    if (typeof modelContent === 'string') {
        blocks.push({ type: 'text', text: modelContent, uuid, parentUUID })
    } else if (Array.isArray(modelContent)) {
        for (const block of modelContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                blocks.push({ type: 'reasoning', text: block.thinking, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_use' && typeof block.id === 'string') {
                const name = asString(block.name) ?? 'Tool'
                const input = 'input' in block ? (block as Record<string, unknown>).input : undefined
                const description = isObject(input) && typeof input.description === 'string' ? input.description : null
                blocks.push({ type: 'tool-call', id: block.id, name, input, description, uuid, parentUUID })
            }
        }
    }

    const usage = isObject(message.usage) ? (message.usage as Record<string, unknown>) : null
    const inputTokens = usage ? asNumber(usage.input_tokens) : null
    const outputTokens = usage ? asNumber(usage.output_tokens) : null

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain,
        content: blocks,
        meta,
        usage: inputTokens !== null && outputTokens !== null ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: asNumber(usage?.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens: asNumber(usage?.cache_read_input_tokens) ?? undefined,
            service_tier: asString(usage?.service_tier) ?? undefined
        } : undefined
    }
}

function formatCodexPlanEntries(value: unknown): string | null {
    if (!Array.isArray(value) || value.length === 0) {
        return null
    }

    const lines = value.flatMap((entry) => {
        if (!isObject(entry)) {
            return []
        }

        const content = asString(entry.content)?.trim()
        if (!content) {
            return []
        }

        const status = asString(entry.status)
        const priority = asString(entry.priority)
        const checkbox = status === 'completed' ? '[x]' : '[ ]'
        const suffixes: string[] = []

        if (status === 'in_progress') {
            suffixes.push('in progress')
        }
        if (priority === 'high' || priority === 'low') {
            suffixes.push(`${priority} priority`)
        }

        const suffix = suffixes.length > 0 ? ` (${suffixes.join(', ')})` : ''
        return [`- ${checkbox} ${content}${suffix}`]
    })

    if (lines.length === 0) {
        return null
    }

    return ['Plan', '', ...lines].join('\n')
}

function normalizeUserOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const messageContent = message.content

    if (isSidechain && typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            content: [{ type: 'sidechain', uuid, prompt: messageContent }]
        }
    }

    if (typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: messageContent },
            meta
        }
    }

    const blocks: NormalizedAgentContent[] = []

    if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const isError = Boolean(block.is_error)
                const rawContent = 'content' in block ? (block as Record<string, unknown>).content : undefined
                const embeddedToolUseResult = 'toolUseResult' in data ? (data as Record<string, unknown>).toolUseResult : null

                const permissions = normalizeToolResultPermissions(block.permissions)

                blocks.push({
                    type: 'tool-result',
                    tool_use_id: block.tool_use_id,
                    content: embeddedToolUseResult ?? rawContent,
                    is_error: isError,
                    uuid,
                    parentUUID,
                    permissions
                })
            }
        }
    }

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain,
        content: blocks,
        meta
    }
}

function normalizeAgentRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | NormalizedMessage[] | null {
    if (!isObject(content) || typeof content.type !== 'string') return null

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        // Skip meta/compact-summary messages (parity with yoho-remote-app)
        if (data.isMeta) return null
        if (data.isCompactSummary) return null

        if (data.type === 'assistant') {
            return normalizeAssistantOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'user') {
            return normalizeUserOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'system') {
            const subtype = asString(data.subtype)

            if (subtype === 'turn_duration') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'turn-duration',
                        durationMs: asNumber(data.durationMs) ?? 0
                    },
                    isSidechain: false,
                    meta
                }
            }

            // Task system events (task_started, task_progress, task_notification) are
            // redundant when sidechain messages are present — the Agent/Task tool card
            // already shows the sub-agent's tool calls inline.  Suppress them to avoid
            // cluttering the main timeline with dozens of progress events.
            if (subtype === 'task_notification' || subtype === 'task_started' || subtype === 'task_progress') {
                return null
            }

            if (subtype === 'compact_boundary') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: { type: 'compact-boundary' } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            if (subtype === 'status') {
                const status = asString(data.status)
                if (status === 'compacting') {
                    return {
                        id: messageId,
                        localId,
                        createdAt,
                        role: 'event',
                        content: { type: 'status', status: 'compacting' } as AgentEvent,
                        isSidechain: false,
                        meta
                    }
                }
                return null
            }

            if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'hook-event',
                        subtype: subtype,
                        hookName: asString(data.hook_name) ?? '',
                        hookEvent: asString(data.hook_event) ?? '',
                        output: asString(data.output) ?? undefined
                    } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            if (subtype === 'api_retry') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'api-retry',
                        attempt: asNumber(data.attempt) ?? 1,
                        maxRetries: asNumber(data.max_retries) ?? undefined,
                        retryDelayMs: asNumber(data.retry_delay_ms) ?? undefined,
                        error: asString(data.error) ?? undefined
                    } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            if (subtype === 'api_error') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'api-retry',
                        attempt: asNumber(data.retryAttempt) ?? 1,
                        maxRetries: asNumber(data.maxRetries) ?? undefined,
                        retryDelayMs: asNumber(data.retryInMs) ?? undefined,
                        error: asString(data.level) ?? undefined
                    } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            // Silently ignore: files_persisted, init (shouldn't arrive but just in case)
            if (subtype === 'files_persisted' || subtype === 'init') {
                return null
            }

            // Unknown system subtype — skip
            return null
        }

        if (data.type === 'summary' && typeof data.summary === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'summary', summary: data.summary }],
                meta
            }
        }

        // --- New SDK message types (non-system) ---

        if (data.type === 'result') {
            const cost = asNumber(data.total_cost_usd)
            const duration = asNumber(data.duration_ms)
            const turns = asNumber(data.num_turns)

            // Extract cumulative usage from result message
            // SDKResultMessage.usage contains cumulative values for the entire session
            const usage = isObject(data.usage) ? (data.usage as Record<string, unknown>) : null
            const inputTokens = usage ? asNumber(usage.input_tokens) : null
            const outputTokens = usage ? asNumber(usage.output_tokens) : null
            const cacheCreationTokens = usage ? asNumber(usage.cache_creation_input_tokens) : null
            const cacheReadTokens = usage ? asNumber(usage.cache_read_input_tokens) : null

            const resultEvent: NormalizedMessage | null = (cost === null && duration === null && turns === null) ? null : {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'session-result',
                    cost,
                    durationMs: duration,
                    numTurns: turns,
                    isError: Boolean(data.is_error)
                } as AgentEvent,
                isSidechain: false,
                meta,
                // Include cumulative usage for context percentage calculation
                usage: (inputTokens !== null || outputTokens !== null) ? {
                    input_tokens: inputTokens ?? 0,
                    output_tokens: outputTokens ?? 0,
                    cache_creation_input_tokens: cacheCreationTokens ?? 0,
                    cache_read_input_tokens: cacheReadTokens ?? 0
                } : undefined
            }

            // codez (OpenAI) models may not emit a separate assistant text message;
            // the reply text only appears in result.result.  Surface it as an
            // agent text block so the user can see the response.
            const resultText = typeof data.result === 'string' && data.result.trim() ? data.result as string : null
            if (resultText) {
                const uuid = asString(data.uuid) ?? messageId
                const parentUUID = asString(data.parentUuid) ?? null
                const textMsg: NormalizedMessage = {
                    id: `${messageId}:result-text`,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{ type: 'text', text: resultText, uuid, parentUUID }],
                    meta
                }
                if (resultEvent) return [textMsg, resultEvent]
                return textMsg
            }

            return resultEvent
        }

        if (data.type === 'rate_limit_event') {
            const info = isObject(data.rate_limit_info) ? data.rate_limit_info : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'rate-limit',
                    status: asString(info?.status) ?? 'unknown',
                    resetsAt: asNumber(info?.resetsAt) ?? undefined
                } as AgentEvent,
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'tool_progress') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'tool-progress',
                    toolUseId: asString(data.tool_use_id) ?? '',
                    toolName: asString(data.tool_name) ?? '',
                    elapsedSeconds: asNumber(data.elapsed_time_seconds) ?? undefined
                } as AgentEvent,
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'tool_use_summary') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'message',
                    message: asString(data.summary) ?? ''
                },
                isSidechain: false,
                meta
            }
        }

        // Silently ignore: auth_status, prompt_suggestion, queue-operation
        if (data.type === 'auth_status' || data.type === 'prompt_suggestion' || data.type === 'queue-operation') {
            return null
        }

        if (data.type === 'progress') {
            const progressData = isObject(data.data) ? data.data : null
            if (!progressData) return null
            const progressType = asString(progressData.type)

            if (progressType === 'hook_progress') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'hook-event',
                        subtype: 'hook_progress',
                        hookName: asString(progressData.hookName) ?? '',
                        hookEvent: asString(progressData.hookEvent) ?? '',
                    } as AgentEvent,
                    isSidechain: Boolean(data.isSidechain),
                    meta
                }
            }

            if (progressType === 'bash_progress') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'tool-progress',
                        toolUseId: asString(data.toolUseID) ?? '',
                        toolName: 'Bash',
                        elapsedSeconds: asNumber(progressData.elapsedTimeSeconds) ?? undefined
                    } as AgentEvent,
                    isSidechain: Boolean(data.isSidechain),
                    meta
                }
            }

            if (progressType === 'mcp_progress') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'tool-progress',
                        toolUseId: asString(data.toolUseID) ?? '',
                        toolName: asString(progressData.toolName) ?? asString(progressData.serverName) ?? 'MCP',
                        elapsedSeconds: undefined
                    } as AgentEvent,
                    isSidechain: Boolean(data.isSidechain),
                    meta
                }
            }

            if (progressType === 'agent_progress') {
                // agent_progress contains nested messages — silently ignore
                // (the actual sub-agent messages arrive separately)
                return null
            }

            if (progressType === 'query_update') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'message',
                        message: `Searching: ${asString(progressData.query) ?? ''}`
                    },
                    isSidechain: Boolean(data.isSidechain),
                    meta
                }
            }

            if (progressType === 'search_results_received') {
                const count = asNumber(progressData.resultCount)
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'message',
                        message: `Found ${count ?? 0} results for "${asString(progressData.query) ?? ''}"`
                    },
                    isSidechain: Boolean(data.isSidechain),
                    meta
                }
            }

            if (progressType === 'waiting_for_task') {
                const desc = asString(progressData.taskDescription) ?? ''
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'task-progress',
                        taskId: asString(data.toolUseID) ?? '',
                        description: desc || 'Waiting for task...',
                        lastToolName: asString(progressData.taskType) ?? undefined
                    } as AgentEvent,
                    isSidechain: Boolean(data.isSidechain),
                    meta
                }
            }

            // Unknown progress subtype — skip
            return null
        }

        return null
    }

    if (content.type === 'event') {
        const event = normalizeAgentEvent(content.data)
        if (!event) return null
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: event,
            isSidechain: false,
            meta
        }
    }

    if (content.type === 'codex') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        if (data.type === 'plan') {
            const planText = formatCodexPlanEntries(data.entries)
            if (!planText) {
                return null
            }

            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: planText, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'error') {
            const errorMessage = asString(data.message)?.trim()
            if (!errorMessage) {
                return null
            }

            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'message',
                    message: `Error: ${errorMessage}`
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'token_count') {
            const info = isObject(data.info) ? data.info : null
            const inputTokens = asNumber(info?.input_tokens)
            const outputTokens = asNumber(info?.output_tokens)
            const cacheReadTokens = asNumber(info?.cached_input_tokens) ?? asNumber(info?.cache_read_input_tokens) ?? 0
            const cacheCreationTokens = asNumber(info?.cache_creation_input_tokens) ?? 0

            if (inputTokens === null && outputTokens === null && cacheReadTokens === 0 && cacheCreationTokens === 0) {
                return null
            }

            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: { type: 'token-count' },
                isSidechain: false,
                meta,
                usage: {
                    input_tokens: inputTokens ?? 0,
                    output_tokens: outputTokens ?? 0,
                    cache_creation_input_tokens: cacheCreationTokens,
                    cache_read_input_tokens: cacheReadTokens
                }
            }
        }

        if (data.type === 'message' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: data.message, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'reasoning' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'reasoning', text: data.message, uuid: messageId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'reasoning-delta') {
            const delta = asString(data.delta) ?? asString(data.message) ?? asString(data.text)
            if (!delta) {
                return null
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'reasoning', text: delta, uuid: messageId, parentUUID: null, isDelta: true }],
                meta
            }
        }

        if (data.type === 'tool-call' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.callId,
                    name: asString(data.name) ?? 'unknown',
                    input: data.input,
                    description: null,
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: inferCodexToolResultIsError(data.output),
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }
    }

    return null
}

function normalizeUserRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | null {
    if (typeof content === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content },
            isSidechain: false,
            meta
        }
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content.text },
            isSidechain: false,
            meta
        }
    }

    return null
}

export function normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage | NormalizedMessage[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return {
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: safeStringify(message.content), uuid: message.id, parentUUID: null }],
            status: message.status,
            originalText: message.originalText
        }
    }

    if (record.role === 'user') {
        const normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return normalized
            ? { ...normalized, status: message.status, originalText: message.originalText }
            : {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: safeStringify(record.content) },
                meta: record.meta,
                status: message.status,
                originalText: message.originalText
            }
    }
    if (record.role === 'agent') {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        const normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (!normalized && isCodexContent(record.content)) {
            return null
        }
        // If normalizeAgentRecord explicitly returned null for a known output
        // type (system status, filtered events, etc.), suppress the message
        // instead of falling back to raw JSON stringify.
        if (!normalized && isObject(record.content) && (record.content as Record<string, unknown>).type === 'output') {
            return null
        }
        if (!normalized) {
            return {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
                meta: record.meta,
                status: message.status,
                originalText: message.originalText
            }
        }
        if (Array.isArray(normalized)) {
            return normalized.map(n => ({ ...n, status: message.status, originalText: message.originalText }))
        }
        return { ...normalized, status: message.status, originalText: message.originalText }
    }

    return {
        id: message.id,
        localId: message.localId,
        createdAt: message.createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
        meta: record.meta,
        status: message.status,
        originalText: message.originalText
    }
}
