import type { DecryptedMessage } from '@/types/api'
import type { AgentEvent, NormalizedAgentContent, NormalizedMessage, PlanTodoReminderItem, ToolResultPermission } from '@/chat/types'
import { parseBrainChildCallbackMessage } from '@/chat/brainChildCallback'

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

function collectRawFields(source: Record<string, unknown>, knownKeys: string[]): Record<string, unknown> | undefined {
    const raw: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
        if (knownKeys.includes(key)) continue
        raw[key] = value
    }

    return Object.keys(raw).length > 0 ? raw : undefined
}

function createFallbackAgentTextBlock(
    value: unknown,
    uuid: string,
    parentUUID: string | null
): NormalizedAgentContent {
    return {
        type: 'text',
        text: safeStringify(value),
        uuid,
        parentUUID
    }
}

function withMessageEnvelope<T extends NormalizedMessage | NormalizedMessage[]>(
    value: T,
    message: DecryptedMessage
): T {
    if (Array.isArray(value)) {
        return value.map((entry) => ({
            ...entry,
            seq: message.seq,
            status: message.status,
            originalText: message.originalText
        })) as T
    }

    return {
        ...value,
        seq: message.seq,
        status: message.status,
        originalText: message.originalText
    } as T
}

function createRawAgentTextMessage(
    messageId: string,
    localId: string | null,
    createdAt: number,
    text: string,
    meta?: unknown
): NormalizedMessage {
    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text, uuid: messageId, parentUUID: null }],
        meta
    }
}

function createBrainChildCallbackEventMessage(
    messageId: string,
    localId: string | null,
    createdAt: number,
    text: string,
    meta?: unknown
): NormalizedMessage | null {
    const event = parseBrainChildCallbackMessage(text, meta)
    if (!event) {
        return null
    }

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'event',
        isSidechain: false,
        content: event,
        meta
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
    if (status === 'error' || status === 'failed' || status === 'declined') {
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

function normalizeRoleEventContent(value: unknown): AgentEvent | null {
    let content = value
    if (typeof content === 'string') {
        try {
            const parsed: unknown = JSON.parse(content)
            if (isObject(parsed)) {
                content = parsed
            }
        } catch { /* keep as non-JSON string */ }
    }

    if (isObject(content) && content.type === 'event') {
        const nested = normalizeAgentEvent(content.data)
        if (nested) {
            return nested
        }
    }

    return normalizeAgentEvent(content)
}

function normalizeEventRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | null {
    const event = normalizeRoleEventContent(content)
    if (event) {
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

    if (content === null || content === undefined) {
        return null
    }

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'event',
        content: {
            type: 'message',
            message: safeStringify(content)
        },
        isSidechain: false,
        meta
    }
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
            if (!isObject(block) || typeof block.type !== 'string') {
                blocks.push(createFallbackAgentTextBlock(block, uuid, parentUUID))
                continue
            }
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
                continue
            }
            if (block.type === 'server_tool_use' && typeof block.id === 'string') {
                const name = asString(block.name) ?? 'ServerTool'
                let input: unknown = 'input' in block ? (block as Record<string, unknown>).input : undefined
                if (typeof input === 'string') {
                    try { input = JSON.parse(input) } catch { /* keep as string */ }
                }
                const description = isObject(input) && typeof (input as Record<string, unknown>).description === 'string'
                    ? ((input as Record<string, unknown>).description as string)
                    : null
                blocks.push({ type: 'tool-call', id: block.id, name, input, description, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const rawContent = 'content' in block ? (block as Record<string, unknown>).content : undefined
                blocks.push({
                    type: 'tool-result',
                    tool_use_id: block.tool_use_id,
                    content: rawContent,
                    is_error: Boolean(block.is_error),
                    uuid,
                    parentUUID
                })
                continue
            }
            blocks.push(createFallbackAgentTextBlock(block, uuid, parentUUID))
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
            service_tier: asString(usage?.service_tier) ?? undefined,
            raw: usage ? collectRawFields(usage, [
                'input_tokens',
                'output_tokens',
                'cache_creation_input_tokens',
                'cache_read_input_tokens',
                'service_tier'
            ]) : undefined
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

        // Support both old format (entries[].content) and new Codex format (plan[].step)
        const content = (asString(entry.content) ?? asString(entry.step))?.trim()
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

function getCodexReasoningUuid(data: Record<string, unknown>, fallback: string): string {
    const direct = asString(data.id)
        ?? asString(data.reasoningId)
        ?? asString(data.reasoning_id)
        ?? asString(data.item_id)
        ?? asString(data.itemId)
    if (direct) {
        return direct
    }

    const summaryIndex = asNumber(data.summary_index) ?? asNumber(data.summaryIndex)
    if (summaryIndex !== null) {
        return `summary-${summaryIndex}`
    }

    return fallback
}

function normalizeUserOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | NormalizedMessage[] | null {
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

    if (isSidechain && !parentUUID && Array.isArray(messageContent)) {
        const allText = messageContent.length > 0 && messageContent.every(
            (b) => isObject(b) && b.type === 'text' && typeof b.text === 'string'
        )
        if (allText) {
            const prompt = (messageContent as Array<{ text: string }>).map((b) => b.text).join('\n')
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'sidechain', uuid, prompt }]
            }
        }
    }

    if (typeof messageContent === 'string') {
        const brainChildCallback = createBrainChildCallbackEventMessage(messageId, localId, createdAt, messageContent, meta)
        if (brainChildCallback) {
            return brainChildCallback
        }
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

    const userTextParts: string[] = []
    const agentBlocks: NormalizedAgentContent[] = []

    if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                userTextParts.push(block.text)
                continue
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const isError = Boolean(block.is_error)
                const rawContent = 'content' in block ? (block as Record<string, unknown>).content : undefined

                const permissions = normalizeToolResultPermissions(block.permissions)

                agentBlocks.push({
                    type: 'tool-result',
                    tool_use_id: block.tool_use_id,
                    content: rawContent,
                    is_error: isError,
                    uuid,
                    parentUUID,
                    permissions
                })
                continue
            }
            if (block.type === 'image') {
                const source = isObject(block.source) ? block.source : null
                const mediaType = source ? asString(source.media_type) : null
                userTextParts.push(`[Image: ${mediaType ?? 'image'}]`)
                continue
            }
            if (block.type === 'document') {
                const source = isObject(block.source) ? block.source : null
                const mediaType = source ? asString(source.media_type) : null
                userTextParts.push(`[Document: ${mediaType ?? 'file'}]`)
                continue
            }
            userTextParts.push(safeStringify(block))
        }
    }

    const userText = userTextParts
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join('\n')

    const brainChildCallback = userText
        ? createBrainChildCallbackEventMessage(messageId, localId, createdAt, userText, meta)
        : null
    if (brainChildCallback && agentBlocks.length === 0) {
        return brainChildCallback
    }

    const userMessage: NormalizedMessage | null = userText
        ? {
            id: agentBlocks.length > 0 ? `${messageId}:user` : messageId,
            localId,
            createdAt,
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: userText },
            meta
        }
        : null

    const agentMessage: NormalizedMessage | null = agentBlocks.length > 0
        ? {
            id: userMessage ? `${messageId}:tool-result` : messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain,
            content: agentBlocks,
            meta
        }
        : null

    if (userMessage && agentMessage) {
        return [userMessage, agentMessage]
    }
    return userMessage ?? agentMessage
}

function normalizePlanTodoReminderItems(value: unknown): PlanTodoReminderItem[] {
    if (!Array.isArray(value)) return []

    const items: PlanTodoReminderItem[] = []
    for (const raw of value) {
        if (!isObject(raw)) continue
        const content = asString(raw.content)?.trim()
        const status = asString(raw.status)
        if (!content) continue
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
        const activeForm = asString(raw.activeForm)?.trim()
        items.push({
            content,
            status,
            activeForm: activeForm && activeForm.length > 0 ? activeForm : undefined
        })
    }

    return items
}

function extractTaggedValue(text: string, tagName: string): string | null {
    const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i')
    const match = text.match(pattern)
    const value = match?.[1]?.trim()
    return value && value.length > 0 ? value : null
}

function normalizeQueuedCommandAttachment(
    messageId: string,
    localId: string | null,
    createdAt: number,
    attachment: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | null {
    const prompt = asString(attachment.prompt)?.trim()
    const commandMode = asString(attachment.commandMode)

    if (commandMode === 'task-notification' && prompt) {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: {
                type: 'task-notification',
                taskId: extractTaggedValue(prompt, 'task-id') ?? undefined,
                toolUseId: extractTaggedValue(prompt, 'tool-use-id') ?? undefined,
                status: extractTaggedValue(prompt, 'status') ?? undefined,
                summary: extractTaggedValue(prompt, 'summary') ?? prompt
            } as AgentEvent,
            isSidechain: false,
            meta
        }
    }

    if (commandMode === 'prompt' && prompt) {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: {
                type: 'message',
                message: `Queued command: ${prompt}`
            },
            isSidechain: false,
            meta
        }
    }

    return null
}

function getClaudeEditedTextFileAttachmentData(value: unknown): {
    filePath: string
    snippet: string
} | null {
    if (!isObject(value)) {
        return null
    }

    const filePath = asString(value.filename)?.trim()
    const rawSnippet = asString(value.snippet)
    const snippet = rawSnippet?.replace(/(?:\r?\n)+$/, '') ?? null

    if (!filePath || !snippet || snippet.trim().length === 0) {
        return null
    }

    return { filePath, snippet }
}

function normalizeClaudeAttachment(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown
): NormalizedMessage | null {
    const attachment = isObject(data.attachment) ? data.attachment : null
    if (!attachment) return null

    const attachmentType = asString(attachment.type)

    if (attachmentType === 'edited_text_file') {
        const editedFile = getClaudeEditedTextFileAttachmentData(attachment)
        if (!editedFile) {
            return null
        }

        const toolId = `${messageId}:edited-text-file`

        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'tool-call',
                    id: toolId,
                    name: 'ClaudeEditedTextFile',
                    input: {
                        file_path: editedFile.filePath,
                        snippet: editedFile.snippet
                    },
                    description: 'Changed snippet',
                    uuid: toolId,
                    parentUUID: null
                },
                {
                    type: 'tool-result',
                    tool_use_id: toolId,
                    content: null,
                    is_error: false,
                    uuid: toolId,
                    parentUUID: null
                }
            ],
            meta
        }
    }

    if (attachmentType === 'plan_mode') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: {
                type: 'plan-mode',
                reminderType: asString(attachment.reminderType) ?? undefined,
                isSubAgent: asBoolean(attachment.isSubAgent) ?? undefined,
                planFilePath: asString(attachment.planFilePath) ?? undefined,
                planExists: asBoolean(attachment.planExists) ?? undefined
            } as AgentEvent,
            isSidechain: false,
            meta
        }
    }

    if (attachmentType === 'todo_reminder') {
        const items = normalizePlanTodoReminderItems(attachment.content)
        if (items.length === 0) {
            return null
        }

        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: {
                type: 'todo-reminder',
                items,
                itemCount: asNumber(attachment.itemCount) ?? items.length,
                pendingCount: items.filter((item) => item.status === 'pending').length,
                inProgressCount: items.filter((item) => item.status === 'in_progress').length,
                completedCount: items.filter((item) => item.status === 'completed').length
            } as AgentEvent,
            isSidechain: false,
            meta
        }
    }

    if (attachmentType === 'plan_file_reference') {
        const planFilePath = asString(attachment.planFilePath) ?? undefined
        const planContent = asString(attachment.planContent) ?? undefined
        if (!planFilePath && !planContent) {
            return null
        }

        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: {
                type: 'plan-file',
                planFilePath,
                planContent
            } as AgentEvent,
            isSidechain: false,
            meta
        }
    }

    if (attachmentType === 'queued_command') {
        return normalizeQueuedCommandAttachment(messageId, localId, createdAt, attachment, meta)
    }

    return null
}

function normalizeAgentRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | NormalizedMessage[] | null {
    if (typeof content === 'string') {
        try {
            const parsed: unknown = JSON.parse(content)
            if (isObject(parsed)) content = parsed
        } catch { /* not JSON, fall through */ }
    }
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
        if (data.type === 'attachment') {
            return normalizeClaudeAttachment(messageId, localId, createdAt, data, meta)
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

            if (subtype === 'task_started') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'task-started',
                        description: asString(data.description) ?? undefined,
                        taskId: asString(data.task_id) ?? undefined,
                        taskType: asString(data.task_type) ?? undefined,
                        toolUseId: asString(data.tool_use_id) ?? undefined,
                    } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            if (subtype === 'task_notification') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'task-notification',
                        summary: asString(data.summary) ?? undefined,
                        status: asString(data.status) ?? undefined,
                        taskId: asString(data.task_id) ?? undefined,
                        toolUseId: asString(data.tool_use_id) ?? undefined,
                    } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            if (subtype === 'task_updated') {
                const patch = isObject(data.patch) ? data.patch : null
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'event',
                    content: {
                        type: 'task-updated',
                        taskId: asString(data.task_id) ?? undefined,
                        status: patch ? asString(patch.status) ?? undefined : undefined,
                    } as AgentEvent,
                    isSidechain: false,
                    meta
                }
            }

            if (subtype === 'task_progress') {
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

            if (subtype === 'microcompact_boundary') {
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

            if (subtype === 'local_command') {
                const localCommandContent = asString(data.content)?.trim()
                if (!localCommandContent) {
                    return null
                }
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{ type: 'text', text: localCommandContent, uuid: messageId, parentUUID: null }],
                    meta
                }
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

            const stopReason = asString(data.stop_reason) ?? undefined
            const terminalReason = asString(data.terminal_reason) ?? undefined

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
                    isError: Boolean(data.is_error),
                    stopReason,
                    terminalReason
                } as AgentEvent,
                isSidechain: false,
                meta,
                // Include cumulative usage for context percentage calculation
                usage: (inputTokens !== null || outputTokens !== null) ? {
                    input_tokens: inputTokens ?? 0,
                    output_tokens: outputTokens ?? 0,
                    cache_creation_input_tokens: cacheCreationTokens ?? 0,
                    cache_read_input_tokens: cacheReadTokens ?? 0,
                    raw: usage ? collectRawFields(usage, [
                        'input_tokens',
                        'output_tokens',
                        'cache_creation_input_tokens',
                        'cache_read_input_tokens'
                    ]) : undefined
                } : undefined
            }

            // Some OpenAI-style reasoning models may not emit a separate assistant text message;
            // the reply text only appears in result.result.  Surface it as an
            // agent text block so the user can see the response.
            const resultText = typeof data.result === 'string' && data.result.trim() ? data.result as string : null
            const resultFallbackText = resultText ?? (data.result !== undefined && data.result !== null ? safeStringify(data.result) : null)
            if (resultFallbackText) {
                const uuid = asString(data.uuid) ?? messageId
                const parentUUID = asString(data.parentUuid) ?? null
                const textMsg: NormalizedMessage = {
                    id: `${messageId}:result-text`,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{ type: 'text', text: resultFallbackText, uuid, parentUUID }],
                    meta
                }
                if (resultEvent) return [textMsg, resultEvent]
                return textMsg
            }

            return resultEvent
        }

        if (data.type === 'rate_limit_event') {
            const info = isObject(data.rate_limit_info) ? data.rate_limit_info : null
            const status = asString(info?.status)
            if (status === 'allowed') return null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'rate-limit',
                    status: status ?? 'unknown',
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
        if (event.type === 'ready') return null
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
        if (!data || typeof data.type !== 'string') {
            console.warn('[normalize] Unknown Codex content without a subtype', {
                messageId
            })
            return createRawAgentTextMessage(messageId, localId, createdAt, safeStringify(content), meta)
        }

        if (data.type === 'plan') {
            // Support old format (data.entries) and new Codex format (data.plan)
            const planEntries = Array.isArray(data.entries) ? data.entries : Array.isArray(data.plan) ? data.plan : data.entries
            const planText = formatCodexPlanEntries(planEntries)
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

            const source = asString(data.source)?.trim()
            const prefix = source === 'item' ? 'Notice' : 'Error'

            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'message',
                    message: `${prefix}: ${errorMessage}`
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'notice') {
            const noticeMessage = asString(data.message)?.trim()
            if (!noticeMessage) {
                return null
            }

            const level = asString(data.level)?.trim().toLowerCase()
            const prefix = level === 'warning' ? 'Notice' : 'Message'

            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'message',
                    message: `${prefix}: ${noticeMessage}`
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'status') {
            const status = asString(data.status) ?? asString(data.message)
            if (!status) {
                return null
            }

            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'status',
                    status
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'compact-boundary') {
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

        if (data.type === 'token_count') {
            const info = isObject(data.info) ? data.info : null

            // New format: nested last_token_usage + model_context_window (per-turn accurate data)
            // TokenUsageInfo { last_token_usage: TokenUsage, total_token_usage: TokenUsage, model_context_window: i64 }
            const lastUsage = isObject(info?.last_token_usage) ? (info.last_token_usage as Record<string, unknown>) : null
            const modelContextWindow = asNumber(info?.model_context_window) ?? undefined
            const clearContextUsage = info === null

            let inputTokens: number | null
            let outputTokens: number | null
            let cacheReadTokens: number
            let cacheCreationTokens: number

            // reasoning tokens (new format only, from last_token_usage)
            const reasoningOutputTokens = lastUsage ? (asNumber(lastUsage.reasoning_output_tokens) ?? undefined) : undefined

            // rate limit: TokenCountEvent.rate_limits.primary.used_percent (0–100)
            const rateLimits = isObject(data.rate_limits) ? (data.rate_limits as Record<string, unknown>) : null
            const rateLimitPrimary = isObject(rateLimits?.primary) ? (rateLimits.primary as Record<string, unknown>) : null
            const rateLimitUsedPercent = asNumber(rateLimitPrimary?.used_percent) ?? undefined

            if (lastUsage) {
                // New format: use total_tokens (= input + output) as context window usage.
                // This matches how the Codex TUI computes context percentage:
                //   last_token_usage.percent_of_context_window_remaining(model_context_window)
                // which internally uses tokens_in_context_window() → self.total_tokens.
                // cached_input_tokens is a SUBSET of input_tokens — don't add separately.
                inputTokens = asNumber(lastUsage.total_tokens) ?? asNumber(lastUsage.input_tokens)
                outputTokens = asNumber(lastUsage.output_tokens)
                cacheReadTokens = 0
                cacheCreationTokens = 0
            } else {
                // Old format (codex exec --json): flat usage totals are cumulative billing counters
                // and do NOT reflect the current context window after compaction/resume.
                // We keep them for non-context stats only.
                inputTokens = asNumber(info?.input_tokens)
                outputTokens = asNumber(info?.output_tokens)
                cacheReadTokens = asNumber(info?.cache_read_input_tokens) ?? 0
                cacheCreationTokens = asNumber(info?.cache_creation_input_tokens) ?? 0
            }

            const hasAnyTokenCount = inputTokens !== null
                || outputTokens !== null
                || cacheReadTokens !== 0
                || cacheCreationTokens !== 0

            if (!hasAnyTokenCount && rateLimitUsedPercent === undefined && !clearContextUsage) {
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
                    cache_read_input_tokens: cacheReadTokens,
                    model_context_window: modelContextWindow,
                    reasoning_output_tokens: reasoningOutputTokens,
                    rate_limit_used_percent: rateLimitUsedPercent,
                    context_tokens_reliable: Boolean(lastUsage),
                    clear_context_usage: clearContextUsage || undefined
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
            const uuid = getCodexReasoningUuid(data, messageId)
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'reasoning', text: data.message, uuid, parentUUID: null }],
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
                content: [{
                    type: 'reasoning',
                    text: delta,
                    uuid: getCodexReasoningUuid(data, messageId),
                    parentUUID: null,
                    isDelta: true
                }],
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

        console.warn('[normalize] Unknown Codex content subtype', {
            messageId,
            subtype: data.type
        })
        return createRawAgentTextMessage(messageId, localId, createdAt, safeStringify(content), meta)
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
        const brainChildCallback = createBrainChildCallbackEventMessage(messageId, localId, createdAt, content, meta)
        if (brainChildCallback) {
            return brainChildCallback
        }
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
        const brainChildCallback = createBrainChildCallbackEventMessage(messageId, localId, createdAt, content.text, meta)
        if (brainChildCallback) {
            return brainChildCallback
        }
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

const SUPPRESSED_CLAUDE_TOP_LEVEL_TYPES = new Set([
    'last-prompt',
    'permission-mode',
    'ai-title',
    'custom-title',
    'agent-name',
    'queue-operation'
])

const SUPPRESSED_CLAUDE_ATTACHMENT_TYPES = new Set([
    'skill_listing',
    'hook_success',
    'hook_non_blocking_error',
    'compact_file_reference',
    'command_permissions',
    'nested_memory',
    'deferred_tools_delta',
    'date_change',
    'file',
    'directory',
    'invoked_skills'
])

function shouldSuppressKnownAgentContent(content: unknown): boolean {
    if (!isObject(content) || typeof content.type !== 'string') return false

    if (content.type === 'event') {
        const event = normalizeAgentEvent(content.data)
        return event?.type === 'ready'
    }

    if (content.type !== 'output') return false

    const data = isObject(content.data) ? content.data : null
    if (!data || typeof data.type !== 'string') return false

    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) return true

    if (SUPPRESSED_CLAUDE_TOP_LEVEL_TYPES.has(data.type)) {
        return true
    }

    if (data.type === 'attachment') {
        const attachment = isObject(data.attachment) ? data.attachment : null
        const attachmentType = asString(attachment?.type)
        if (attachmentType === 'edited_text_file') {
            return getClaudeEditedTextFileAttachmentData(attachment) === null
        }
        if (attachmentType === 'todo_reminder') {
            return normalizePlanTodoReminderItems(attachment?.content).length === 0
        }
        return attachmentType !== null && SUPPRESSED_CLAUDE_ATTACHMENT_TYPES.has(attachmentType)
    }

    if (data.type === 'auth_status' || data.type === 'prompt_suggestion' || data.type === 'queue-operation') {
        return true
    }

    if (data.type === 'rate_limit_event') {
        const info = isObject(data.rate_limit_info) ? data.rate_limit_info : null
        return asString(info?.status) === 'allowed'
    }

    if (data.type === 'system') {
        const subtype = asString(data.subtype)
        return subtype === 'task_progress' || subtype === 'files_persisted' || subtype === 'init'
            || (subtype === 'status' && asString(data.status) !== 'compacting')
    }

    if (data.type === 'progress') {
        const progressData = isObject(data.data) ? data.data : null
        const progressType = asString(progressData?.type)
        return progressType === 'agent_progress'
    }

    return false
}

export function normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage | NormalizedMessage[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        if (message.content === null || message.content === undefined) {
            return null
        }
        if (typeof message.content === 'string' && message.content.trim().length === 0) {
            return null
        }
        const raw = safeStringify(message.content)
        if (raw === '{}' || raw === '[]') {
            return null
        }
        return withMessageEnvelope({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            role: 'event',
            isSidechain: false,
            content: { type: 'message', message: `Unrecognized message format` } as AgentEvent,
        }, message)
    }

    if (record.role === 'user') {
        const normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return normalized
            ? withMessageEnvelope(normalized, message)
            : withMessageEnvelope({
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: safeStringify(record.content) },
                meta: record.meta
            }, message)
    }
    if (record.role === 'event') {
        const normalized = normalizeEventRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return normalized ? withMessageEnvelope(normalized, message) : null
    }
    if (record.role === 'agent' || record.role === 'assistant') {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        const normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (!normalized && isCodexContent(record.content)) {
            return null
        }
        // Only suppress content we intentionally filter out. Unknown Claude
        // output/event subtypes should degrade to raw JSON instead of vanishing.
        if (!normalized && shouldSuppressKnownAgentContent(record.content)) {
            return null
        }
        if (!normalized) {
            return withMessageEnvelope({
                ...createRawAgentTextMessage(
                    message.id,
                    message.localId,
                    message.createdAt,
                    safeStringify(record.content),
                    record.meta
                ),
            }, message)
        }
        if (Array.isArray(normalized)) {
            return withMessageEnvelope(normalized, message)
        }
        return withMessageEnvelope(normalized, message)
    }

    return withMessageEnvelope({
        id: message.id,
        localId: message.localId,
        createdAt: message.createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
        meta: record.meta,
    }, message)
}
