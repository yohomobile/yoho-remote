import type { AgentState } from '@/types/api'
import type { AgentEvent, ChatBlock, ChatToolCall, CliOutputBlock, NormalizedMessage, ToolCallBlock, ToolPermission, UsageData } from '@/chat/types'
import { traceMessages, type TracedMessage } from '@/chat/tracer'

const CLI_TAG_REGEX = /<(?:local-command-[a-z-]+|command-(?:name|message|args))>/i
const CLI_COMMAND_NAME_REGEX = /<command-name>/i
const CLI_COMMAND_STDOUT_REGEX = /<local-command-stdout>/i

// Calculate context size from usage data
// NOTE: Context size = input_tokens + cache_creation + cache_read
// This matches Claude Code CLI's calculation (src/utils/context.ts:118)
// Reference: Claude Code CLI source code analysis
function calculateContextSize(usage: UsageData): number {
    return usage.input_tokens +
           (usage.cache_creation_input_tokens || 0) +
           (usage.cache_read_input_tokens || 0)
}

function parseClaudeUsageLimit(text: string): number | null {
    const match = text.match(/^Claude AI usage limit reached\|(\d+)$/)
    if (!match) return null
    const timestamp = Number.parseInt(match[1], 10)
    if (!Number.isFinite(timestamp)) return null
    return timestamp
}

function parseMessageAsEvent(msg: NormalizedMessage): AgentEvent | null {
    if (msg.isSidechain) return null
    if (msg.role !== 'agent') return null

    for (const content of msg.content) {
        if (content.type === 'text') {
            const limitReached = parseClaudeUsageLimit(content.text)
            if (limitReached !== null) {
                return { type: 'limit-reached', endsAt: limitReached }
            }
        }
    }

    return null
}

function extractTitleFromChangeTitleInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null
    const title = (input as { title?: unknown }).title
    return typeof title === 'string' && title.trim().length > 0 ? title.trim() : null
}

function collectTitleChanges(messages: NormalizedMessage[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const msg of messages) {
        if (msg.role !== 'agent') continue
        for (const content of msg.content) {
            if (content.type !== 'tool-call') continue
            if (content.name !== 'mcp__yoho_remote__change_title' && content.name !== 'yoho_remote__change_title') continue
            const title = extractTitleFromChangeTitleInput(content.input)
            if (!title) continue
            map.set(content.id, title)
        }
    }
    return map
}

/**
 * Remove result-text blocks when the same turn already has agent-text blocks.
 *
 * normalize.ts extracts result.result text as an extra agent-text message
 * (id ending with ":result-text:0") so that codez responses are visible even
 * when the separate assistant message was lost.  For claude sessions the
 * assistant text message already exists, so we need to strip the duplicate.
 *
 * Strategy: walk backwards from each result-text block; if we find an
 * agent-text block before hitting a user-text block (turn boundary), the
 * result-text is redundant and can be removed.
 */
/**
 * Remove result-text blocks when the same turn already has agent-text blocks.
 *
 * normalize.ts extracts result.result text as an extra agent-text message
 * (id containing ":result-text:") so that codex responses are visible even
 * when the separate assistant message was lost.  For claude sessions the
 * assistant text message already exists, so we need to strip the duplicate.
 *
 * Strategy: group blocks by turn (between user-text boundaries).  Within each
 * turn, if both result-text AND non-result-text agent-text blocks exist, drop
 * the result-text blocks.  This handles both orderings (result before or after
 * assistant) since the CLI can deliver them in either order.
 */
function dedupeResultTextBlocks(blocks: ChatBlock[]): ChatBlock[] {
    // Identify result-text block IDs to remove
    const removeIds = new Set<string>()
    let turnStart = 0

    for (let i = 0; i <= blocks.length; i++) {
        if (i === blocks.length || blocks[i].kind === 'user-text') {
            // Scan the turn [turnStart, i) for agent-text blocks
            let hasNonResultAgentText = false
            const resultTextIds: string[] = []

            for (let j = turnStart; j < i; j++) {
                const b = blocks[j]
                if (b.kind === 'agent-text') {
                    if (b.id.includes(':result-text:')) {
                        resultTextIds.push(b.id)
                    } else {
                        hasNonResultAgentText = true
                    }
                }
            }

            if (hasNonResultAgentText) {
                for (const id of resultTextIds) {
                    removeIds.add(id)
                }
            }

            turnStart = i + 1
        }
    }

    if (removeIds.size === 0) return blocks
    return blocks.filter(b => !removeIds.has(b.id))
}

function dedupeAgentEvents(blocks: ChatBlock[]): ChatBlock[] {
    const result: ChatBlock[] = []
    let prevEventKey: string | null = null
    let prevTitleChangedTo: string | null = null

    for (const block of blocks) {
        if (block.kind !== 'agent-event') {
            result.push(block)
            prevEventKey = null
            prevTitleChangedTo = null
            continue
        }

        const event = block.event as { type: string; [key: string]: unknown }

        // Merge turn-duration + session-result into a single event.
        // When session-result follows turn-duration, replace the previous turn-duration
        // with a combined event showing turn time + turn count (no cost).
        if (event.type === 'session-result') {
            const prev = result.length > 0 ? result[result.length - 1] : null
            if (prev && prev.kind === 'agent-event') {
                const prevEvent = prev.event as { type: string; [key: string]: unknown }
                if (prevEvent.type === 'turn-duration') {
                    const numTurns = typeof event.numTurns === 'number' ? event.numTurns : null
                    // Replace the previous turn-duration with a combined event
                    result[result.length - 1] = {
                        ...prev,
                        event: {
                            ...prevEvent,
                            numTurns
                        }
                    }
                    continue
                }
            }
            // session-result without preceding turn-duration: show it standalone
            result.push(block)
            prevEventKey = `event:session-result`
            prevTitleChangedTo = null
            continue
        }

        if (event.type === 'title-changed' && typeof event.title === 'string') {
            const title = event.title.trim()
            const key = `title-changed:${title}`
            if (key === prevEventKey) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = title
            continue
        }

        if (event.type === 'message' && typeof event.message === 'string') {
            const message = event.message.trim()
            const key = `message:${message}`
            if (key === prevEventKey) {
                continue
            }
            if (prevTitleChangedTo && message === prevTitleChangedTo) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = null
            continue
        }

        let key: string
        try {
            key = `event:${JSON.stringify(event)}`
        } catch {
            key = `event:${String(event.type)}`
        }

        if (key === prevEventKey) {
            continue
        }

        result.push(block)
        prevEventKey = key
        prevTitleChangedTo = null
    }

    return result
}

type PermissionEntry = {
    toolName: string
    input: unknown
    permission: ToolPermission
}

function getPermissions(agentState: AgentState | null | undefined): Map<string, PermissionEntry> {
    const map = new Map<string, PermissionEntry>()

    const completed = agentState?.completedRequests ?? null
    if (completed) {
        for (const [id, entry] of Object.entries(completed)) {
            map.set(id, {
                toolName: entry.tool,
                input: entry.arguments,
                    permission: {
                        id,
                        status: entry.status,
                        reason: entry.reason ?? undefined,
                        mode: entry.mode ?? undefined,
                        decision: entry.decision ?? undefined,
                        allowedTools: entry.allowTools,
                        answers: entry.answers,
                        createdAt: entry.createdAt ?? null,
                        completedAt: entry.completedAt ?? null
                    }
                })
            }
    }

    const requests = agentState?.requests ?? null
    if (requests) {
        for (const [id, request] of Object.entries(requests)) {
            if (map.has(id)) continue
            map.set(id, {
                toolName: request.tool,
                input: request.arguments,
                permission: {
                    id,
                    status: 'pending',
                    createdAt: request.createdAt ?? null
                }
            })
        }
    }

    return map
}

function getMetaSentFrom(meta: unknown): string | null {
    if (!meta || typeof meta !== 'object') return null
    const sentFrom = (meta as { sentFrom?: unknown }).sentFrom
    return typeof sentFrom === 'string' ? sentFrom : null
}

function hasCliOutputTags(text: string): boolean {
    return CLI_TAG_REGEX.test(text)
}

function hasCommandNameTag(text: string): boolean {
    return CLI_COMMAND_NAME_REGEX.test(text)
}

function hasLocalCommandStdoutTag(text: string): boolean {
    return CLI_COMMAND_STDOUT_REGEX.test(text)
}

function isCliOutputText(text: string, meta: unknown): boolean {
    return getMetaSentFrom(meta) === 'cli' && hasCliOutputTags(text)
}

function createCliOutputBlock(props: {
    id: string
    localId: string | null
    createdAt: number
    text: string
    source: CliOutputBlock['source']
    meta?: unknown
}): CliOutputBlock {
    return {
        kind: 'cli-output',
        id: props.id,
        localId: props.localId,
        createdAt: props.createdAt,
        text: props.text,
        source: props.source,
        meta: props.meta
    }
}

function mergeCliOutputBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const merged: ChatBlock[] = []

    for (const block of blocks) {
        if (block.kind !== 'cli-output') {
            merged.push(block)
            continue
        }

        const prev = merged[merged.length - 1]
        if (
            prev
            && prev.kind === 'cli-output'
            && prev.source === block.source
            && hasCommandNameTag(prev.text)
            && !hasLocalCommandStdoutTag(prev.text)
            && hasLocalCommandStdoutTag(block.text)
        ) {
            const separator = prev.text.endsWith('\n') || block.text.startsWith('\n') ? '' : '\n'
            merged[merged.length - 1] = { ...prev, text: `${prev.text}${separator}${block.text}` }
            continue
        }

        merged.push(block)
    }

    return merged
}

// Maximum time gap (ms) between consecutive agent-text blocks to be considered same turn
const STREAMING_MERGE_GAP_MS = 2000

function mergeAgentTextBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const merged: ChatBlock[] = []

    for (const block of blocks) {
        if (block.kind !== 'agent-text') {
            merged.push(block)
            continue
        }

        const prev = merged[merged.length - 1]
        if (prev && prev.kind === 'agent-text') {
            // Check if they belong to the same message (same base id before the index suffix)
            // IDs are like "msg-123:0", "msg-123:1" - same message has same base id
            const prevBaseId = prev.id.split(':')[0]
            const currBaseId = block.id.split(':')[0]
            if (prevBaseId === currBaseId) {
                // Merge consecutive agent-text blocks from the same message (for streaming deltas)
                merged[merged.length - 1] = { ...prev, text: prev.text + block.text }
                continue
            }

            // For streaming backends, merge blocks with small time gaps
            // This handles cases where each streaming chunk has a unique message ID
            const timeGap = block.createdAt - prev.createdAt
            if (timeGap >= 0 && timeGap < STREAMING_MERGE_GAP_MS) {
                merged[merged.length - 1] = { ...prev, text: prev.text + block.text }
                continue
            }
        }

        merged.push(block)
    }

    return merged
}

function mergeAgentReasoningBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const merged: ChatBlock[] = []

    for (const block of blocks) {
        if (block.kind !== 'agent-reasoning') {
            merged.push(block)
            continue
        }

        const prev = merged[merged.length - 1]
        if (prev && prev.kind === 'agent-reasoning' && (prev.isDelta || block.isDelta)) {
            if (prev.isDelta && !block.isDelta) {
                if (block.text.startsWith(prev.text)) {
                    merged[merged.length - 1] = {
                        ...prev,
                        text: block.text,
                        meta: block.meta,
                        localId: block.localId,
                        isDelta: false
                    }
                } else {
                    merged.push(block)
                }
                continue
            }

            merged[merged.length - 1] = {
                ...prev,
                text: prev.text + block.text,
                isDelta: prev.isDelta || block.isDelta
            }
            continue
        }

        merged.push(block)
    }

    return merged
}

function ensureToolBlock(
    blocks: ChatBlock[],
    toolBlocksById: Map<string, ToolCallBlock>,
    id: string,
    seed: {
        createdAt: number
        localId: string | null
        meta?: unknown
        name: string
        input: unknown
        description: string | null
        permission?: ToolPermission
    }
): ToolCallBlock {
    const existing = toolBlocksById.get(id)
    if (existing) {
        const isPlaceholderToolName = (name: string): boolean => {
            const normalized = name.trim().toLowerCase()
            return normalized === '' || normalized === 'tool' || normalized === 'unknown'
        }

        // Preserve earliest createdAt for stable ordering.
        if (seed.createdAt < existing.createdAt) {
            existing.createdAt = seed.createdAt
            existing.tool.createdAt = seed.createdAt
        }
        if (seed.permission) {
            existing.tool.permission = { ...existing.tool.permission, ...seed.permission }
            if (existing.tool.state === 'running' && seed.permission.status === 'pending') {
                existing.tool.state = 'pending'
            }
        }
        if (seed.name && (!isPlaceholderToolName(seed.name) || isPlaceholderToolName(existing.tool.name))) {
            existing.tool.name = seed.name
        }
        if (seed.input !== null && seed.input !== undefined) {
            existing.tool.input = seed.input
        }
        if (seed.description !== null) {
            existing.tool.description = seed.description
        }
        return existing
    }

    const initialState: ChatToolCall['state'] = seed.permission?.status === 'pending'
        ? 'pending'
        : seed.permission?.status === 'denied' || seed.permission?.status === 'canceled'
            ? 'error'
            : 'running'

    const tool: ChatToolCall = {
        id,
        name: seed.name,
        state: initialState,
        input: seed.input,
        createdAt: seed.createdAt,
        startedAt: initialState === 'running' ? seed.createdAt : null,
        completedAt: null,
        description: seed.description,
        permission: seed.permission
    }

    const block: ToolCallBlock = {
        kind: 'tool-call',
        id,
        localId: seed.localId,
        createdAt: seed.createdAt,
        tool,
        children: [],
        meta: seed.meta
    }

    toolBlocksById.set(id, block)
    blocks.push(block)
    return block
}

function collectToolIdsFromMessages(messages: NormalizedMessage[]): Set<string> {
    const ids = new Set<string>()
    for (const msg of messages) {
        if (msg.role !== 'agent') continue
        for (const content of msg.content) {
            if (content.type === 'tool-call') {
                ids.add(content.id)
            } else if (content.type === 'tool-result') {
                ids.add(content.tool_use_id)
            }
        }
    }
    return ids
}

function reduceTimeline(
    messages: TracedMessage[],
    context: {
        permissionsById: Map<string, PermissionEntry>
        groups: Map<string, TracedMessage[]>
        consumedGroupIds: Set<string>
        titleChangesByToolUseId: Map<string, string>
        emittedTitleChangeToolUseIds: Set<string>
    }
): { blocks: ChatBlock[]; toolBlocksById: Map<string, ToolCallBlock>; hasReadyEvent: boolean } {
    const blocks: ChatBlock[] = []
    const toolBlocksById = new Map<string, ToolCallBlock>()
    let hasReadyEvent = false

    for (const msg of messages) {
        if (msg.role === 'event') {
            if (msg.content.type === 'ready') {
                hasReadyEvent = true
                continue
            }
            if (msg.content.type === 'token-count') {
                continue
            }
            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                event: msg.content,
                meta: msg.meta
            })
            continue
        }

        const event = parseMessageAsEvent(msg)
        if (event) {
            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                event,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'user') {
            if (isCliOutputText(msg.content.text, msg.meta)) {
                blocks.push(createCliOutputBlock({
                    id: msg.id,
                    localId: msg.localId,
                    createdAt: msg.createdAt,
                    text: msg.content.text,
                    source: 'user',
                    meta: msg.meta
                }))
                continue
            }
            blocks.push({
                kind: 'user-text',
                id: msg.id,
                localId: msg.localId,
                createdAt: msg.createdAt,
                text: msg.content.text,
                status: msg.status,
                originalText: msg.originalText,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'agent') {
            for (let idx = 0; idx < msg.content.length; idx += 1) {
                const c = msg.content[idx]
                if (c.type === 'text') {
                    if (isCliOutputText(c.text, msg.meta)) {
                        blocks.push(createCliOutputBlock({
                            id: `${msg.id}:${idx}`,
                            localId: msg.localId,
                            createdAt: msg.createdAt,
                            text: c.text,
                            source: 'assistant',
                            meta: msg.meta
                        }))
                        continue
                    }
                    blocks.push({
                        kind: 'agent-text',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'reasoning') {
                    blocks.push({
                        kind: 'agent-reasoning',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        text: c.text,
                        meta: msg.meta,
                        isDelta: c.isDelta
                    })
                    continue
                }

                if (c.type === 'summary') {
                    blocks.push({
                        kind: 'agent-event',
                        id: `${msg.id}:${idx}`,
                        createdAt: msg.createdAt,
                        event: { type: 'message', message: c.summary },
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'tool-call') {
                    if (c.name === 'mcp__yoho_remote__change_title' || c.name === 'yoho_remote__change_title') {
                        const title = context.titleChangesByToolUseId.get(c.id) ?? extractTitleFromChangeTitleInput(c.input)
                        if (title && !context.emittedTitleChangeToolUseIds.has(c.id)) {
                            context.emittedTitleChangeToolUseIds.add(c.id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permission = context.permissionsById.get(c.id)?.permission

                    const block = ensureToolBlock(blocks, toolBlocksById, c.id, {
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: c.name,
                        input: c.input,
                        description: c.description,
                        permission
                    })

                    if (block.tool.state === 'pending') {
                        block.tool.state = 'running'
                        block.tool.startedAt = msg.createdAt
                    }

                    if ((c.name === 'Task' || c.name === 'Agent') && !context.consumedGroupIds.has(msg.id)) {
                        const sidechain = context.groups.get(msg.id) ?? null
                        if (sidechain && sidechain.length > 0) {
                            context.consumedGroupIds.add(msg.id)
                            const child = reduceTimeline(sidechain, context)
                            hasReadyEvent = hasReadyEvent || child.hasReadyEvent
                            block.children = child.blocks
                        }
                    }
                    continue
                }

                if (c.type === 'tool-result') {
                    const title = context.titleChangesByToolUseId.get(c.tool_use_id) ?? null
                    if (title) {
                        if (!context.emittedTitleChangeToolUseIds.has(c.tool_use_id)) {
                            context.emittedTitleChangeToolUseIds.add(c.tool_use_id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permissionEntry = context.permissionsById.get(c.tool_use_id)
                    const permissionFromResult = c.permissions ? ({
                        id: c.tool_use_id,
                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                        date: c.permissions.date,
                        mode: c.permissions.mode,
                        allowedTools: c.permissions.allowedTools,
                        decision: c.permissions.decision
                    } satisfies ToolPermission) : undefined

                    const permission = (() => {
                        if (permissionFromResult && permissionEntry?.permission) {
                            return {
                                ...permissionEntry.permission,
                                ...permissionFromResult,
                                allowedTools: permissionFromResult.allowedTools ?? permissionEntry.permission.allowedTools,
                                decision: permissionFromResult.decision ?? permissionEntry.permission.decision
                            } satisfies ToolPermission
                        }
                        return permissionFromResult ?? permissionEntry?.permission
                    })()

                    const block = ensureToolBlock(blocks, toolBlocksById, c.tool_use_id, {
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: permissionEntry?.toolName ?? 'Tool',
                        input: permissionEntry?.input ?? null,
                        description: null,
                        permission
                    })

                    block.tool.result = c.content
                    block.tool.completedAt = msg.createdAt
                    block.tool.state = c.is_error ? 'error' : 'completed'
                    continue
                }

                if (c.type === 'sidechain') {
                    blocks.push({
                        kind: 'user-text',
                        id: `${msg.id}:${idx}`,
                        localId: null,
                        createdAt: msg.createdAt,
                        text: c.prompt
                    })
                }
            }
        }
    }

    return {
        blocks: mergeAgentReasoningBlocks(mergeAgentTextBlocks(dedupeResultTextBlocks(mergeCliOutputBlocks(blocks)))),
        toolBlocksById,
        hasReadyEvent
    }
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    timestamp: number
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null } {
    const permissionsById = getPermissions(agentState)
    const toolIdsInMessages = collectToolIdsFromMessages(normalized)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else {
            root.push(msg)
        }
    }

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = { permissionsById, groups, consumedGroupIds, titleChangesByToolUseId, emittedTitleChangeToolUseIds }
    const rootResult = reduceTimeline(root, reducerContext)
    let hasReadyEvent = rootResult.hasReadyEvent

    // If a group couldn't be attached to a Task tool call (e.g. legacy shapes), keep it visible.
    for (const [taskMessageId, sidechainMessages] of groups) {
        if (consumedGroupIds.has(taskMessageId)) continue
        if (sidechainMessages.length === 0) continue
        const child = reduceTimeline(sidechainMessages, reducerContext)
        hasReadyEvent = hasReadyEvent || child.hasReadyEvent
        rootResult.blocks.push({
            kind: 'agent-event',
            id: `sidechain:${taskMessageId}`,
            createdAt: sidechainMessages[0].createdAt,
            event: { type: 'message', message: 'Task sidechain' }
        })
        rootResult.blocks.push(...child.blocks)
    }

    // Only create permission-only tool cards when there is no tool call/result in the transcript.
    for (const [id, entry] of permissionsById) {
        if (toolIdsInMessages.has(id)) continue
        if (rootResult.toolBlocksById.has(id)) continue

        const createdAt = entry.permission.createdAt ?? Date.now()
        const block = ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })

        if (entry.permission.status === 'approved') {
            block.tool.state = 'completed'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined) {
                block.tool.result = 'Approved'
            }
        } else if (entry.permission.status === 'denied' || entry.permission.status === 'canceled') {
            block.tool.state = 'error'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined && entry.permission.reason) {
                block.tool.result = { error: entry.permission.reason }
            }
        }
    }

    // Calculate latest usage from messages (find the most recent message with usage data)
    // NOTE: usage.input_tokens already represents the full context size for that API call,
    // so we only need the latest value, not cumulative sum.
    // This matches backend logic in server/src/sync/syncEngine.ts:getLastUsageForSession
    let latestUsage: LatestUsage | null = null

    // Find the last message with actual usage data
    // Prioritize 'result' messages (cumulative usage) over 'assistant' messages (per-turn usage)
    // Skip messages where usage exists but all values are 0
    let resultUsage: LatestUsage | null = null
    let assistantUsage: LatestUsage | null = null
    let fallbackUsage: LatestUsage | null = null

    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage) {
            const inputTokens = msg.usage.input_tokens
            const cacheCreation = msg.usage.cache_creation_input_tokens || 0
            const cacheRead = msg.usage.cache_read_input_tokens || 0

            console.log('[Context Debug] Found message with usage:', {
                index: i,
                role: msg.role,
                contentType: msg.content && typeof msg.content === 'object' && 'type' in msg.content ? msg.content.type : 'unknown',
                usage: {
                    input_tokens: inputTokens,
                    cache_creation: cacheCreation,
                    cache_read: cacheRead,
                    output_tokens: msg.usage.output_tokens
                },
                rawUsage: msg.usage
            })

            // Skip if all values are 0 (continue searching)
            if (inputTokens === 0 && cacheCreation === 0 && cacheRead === 0) {
                console.log('[Context Debug] Skipping message with all zeros')
                continue
            }

            // Context size = sum of all input token types
            // Per Anthropic API spec: input_tokens, cache_creation_input_tokens, and
            // cache_read_input_tokens are separate and must be summed for total context
            // Example from actual data: input=6, cache_read=806111, cache_creation=4972 → total=811089
            const contextSize = inputTokens + cacheCreation + cacheRead
            const usage = {
                inputTokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation,
                cacheRead,
                contextSize,
                timestamp: msg.createdAt
            }

            if (!fallbackUsage) {
                fallbackUsage = usage
            }

            // Check if this is a result message (contains cumulative usage)
            if (msg.role === 'event' && msg.content && typeof msg.content === 'object' && 'type' in msg.content && msg.content.type === 'session-result') {
                console.log('[Context Debug] Found result message (cumulative usage)')
                if (!resultUsage) {
                    resultUsage = usage
                }
                if (assistantUsage) {
                    break
                }
                continue
            }

            // Store assistant message usage as fallback
            if (!assistantUsage && msg.role === 'agent') {
                console.log('[Context Debug] Found assistant message (per-turn usage)')
                assistantUsage = usage
                if (resultUsage) {
                    break
                }
            }
        }
    }

    // Prefer assistant turn usage over session-result cumulative usage.
    latestUsage = assistantUsage ?? resultUsage ?? fallbackUsage

    console.log('[Context Debug] Final usage decision:', {
        resultUsage: resultUsage ? {
            contextSize: resultUsage.contextSize,
            inputTokens: resultUsage.inputTokens,
            cacheCreation: resultUsage.cacheCreation,
            cacheRead: resultUsage.cacheRead
        } : null,
        assistantUsage: assistantUsage ? {
            contextSize: assistantUsage.contextSize,
            inputTokens: assistantUsage.inputTokens,
            cacheCreation: assistantUsage.cacheCreation,
            cacheRead: assistantUsage.cacheRead
        } : null,
        chosen: latestUsage ? {
            contextSize: latestUsage.contextSize,
            inputTokens: latestUsage.inputTokens,
            cacheCreation: latestUsage.cacheCreation,
            cacheRead: latestUsage.cacheRead
        } : null
    })

    // Sort blocks by createdAt to ensure permission-only blocks appear in correct order.
    // We use a stable sort by adding original index as tiebreaker for equal createdAt values.
    // This preserves message order for streaming chunks that may have the same timestamp.
    const indexedBlocks = rootResult.blocks.map((block, index) => ({ block, index }))
    indexedBlocks.sort((a, b) => {
        const timeDiff = a.block.createdAt - b.block.createdAt
        if (timeDiff !== 0) return timeDiff
        // Stable sort: preserve original order for equal createdAt
        return a.index - b.index
    })
    const sortedBlocks = indexedBlocks.map(({ block }) => block)

    return { blocks: dedupeResultTextBlocks(dedupeAgentEvents(sortedBlocks)), hasReadyEvent, latestUsage }
}
