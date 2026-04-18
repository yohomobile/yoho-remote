import type { AgentState } from '@/types/api'
import type { AgentEvent, ChatBlock, ChatToolCall, CliOutputBlock, NormalizedMessage, ToolCallBlock, ToolPermission, UsageData } from '@/chat/types'
import { parseLocalIdPrefix } from '@/chat/ids'
import { traceMessages, type TracedMessage } from '@/chat/tracer'

const CLI_TAG_REGEX = /<(?:local-command-[a-z-]+|command-(?:name|message|args))>/i
const CLI_COMMAND_NAME_REGEX = /<command-name>/i
const CLI_COMMAND_OUTPUT_REGEX = /<local-command-(?:stdout|stderr)>/i

const logger = {
    debug: (...args: unknown[]) => console.debug(...args)
}

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
 * (message id ending with ":result-text") so that codex responses are visible
 * even when the separate assistant message was lost.  The reducer appends the
 * content index (":0") when turning that message into a ChatBlock, so we strip
 * the last segment before checking the suffix.  For claude sessions the
 * assistant text message already exists, so we need to strip the duplicate.
 *
 * Strategy: group blocks by turn (between user-text boundaries).  Within each
 * turn, if both result-text AND non-result-text agent-text blocks exist, drop
 * the result-text blocks.  This handles both orderings (result before or after
 * assistant) since the CLI can deliver them in either order.
 */
function isResultTextBlockId(id: string): boolean {
    const messageId = id.includes(':') ? id.slice(0, id.lastIndexOf(':')) : id
    return messageId.endsWith(':result-text')
}

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
                    if (isResultTextBlockId(b.id)) {
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

        // Drop turn-duration when it follows session-result.
        // Why: CLI emits `result` (→ session-result) first, then manually emits
        // `system/turn_duration` (→ turn-duration) right after. session-result's
        // durationMs already covers the turn, so turn-duration is redundant noise.
        if (event.type === 'turn-duration') {
            const prev = result.length > 0 ? result[result.length - 1] : null
            if (prev && prev.kind === 'agent-event') {
                const prevEvent = prev.event as { type: string }
                if (prevEvent.type === 'session-result') {
                    continue
                }
            }
        }

        // session-result: show standalone.
        if (event.type === 'session-result') {
            result.push(block)
            prevEventKey = `event:session-result`
            prevTitleChangedTo = null
            continue
        }

        // Merge task-notification into the matching task-started (same taskId).
        // Why: Task lifecycle emits task_started (description) then task_notification
        // (summary) and both often carry the same text — the UI was rendering them
        // as two separate lines (🚀 description, 📋 summary). Instead, fold the
        // status from the notification into the original task-started block so the
        // single entry updates from 🚀 to ✅/❌ on completion.
        if (event.type === 'task-notification') {
            const taskId = typeof event.taskId === 'string' ? event.taskId : undefined
            if (taskId) {
                for (let i = result.length - 1; i >= 0; i--) {
                    const b = result[i]
                    if (b.kind !== 'agent-event') continue
                    const e = b.event as { type: string; taskId?: unknown; status?: unknown; toolUseId?: unknown }
                    if (e.type === 'task-started' && e.taskId === taskId) {
                        const notifToolUseId = typeof event.toolUseId === 'string' ? event.toolUseId : undefined
                        result[i] = {
                            ...b,
                            event: {
                                ...e,
                                status: typeof event.status === 'string' ? event.status : e.status,
                                toolUseId: notifToolUseId ?? e.toolUseId
                            }
                        } as ChatBlock
                        break
                    }
                }
                continue
            }
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

function hasLocalCommandOutputTag(text: string): boolean {
    return CLI_COMMAND_OUTPUT_REGEX.test(text)
}

function isCliCommandHeader(text: string): boolean {
    return hasCommandNameTag(text)
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
    let activeCommandId: string | null = null
    let activeCommandSource: CliOutputBlock['source'] | null = null

    for (const block of blocks) {
        if (block.kind !== 'cli-output') {
            merged.push(block)
            activeCommandId = null
            activeCommandSource = null
            continue
        }

        const prev = merged[merged.length - 1]
        const hasCommandHeader = isCliCommandHeader(block.text)
        const hasCommandOutput = hasLocalCommandOutputTag(block.text)
        if (
            !hasCommandHeader
            && activeCommandId !== null
            && activeCommandSource === block.source
            && hasCommandOutput
            && prev
            && prev.kind === 'cli-output'
            && prev.source === block.source
        ) {
            const separator = prev.text.endsWith('\n') || block.text.startsWith('\n') ? '' : '\n'
            merged[merged.length - 1] = { ...prev, text: `${prev.text}${separator}${block.text}` }
            continue
        }

        merged.push(block)

        if (hasCommandHeader) {
            activeCommandId = block.id
            activeCommandSource = block.source
            continue
        }

        if (hasCommandOutput && activeCommandId !== null && activeCommandSource === block.source) {
            continue
        }

        activeCommandId = null
        activeCommandSource = null
    }

    return merged
}

// Maximum time gap (ms) between consecutive agent-text blocks to be considered same turn
const STREAMING_MERGE_GAP_MS = 2000
const USER_ECHO_DEDUPE_GAP_MS = 10_000

function isTextMergeTransparentBlock(block: ChatBlock): boolean {
    return block.kind === 'agent-event'
}

function findPreviousVisibleTextBlock<T extends ChatBlock['kind']>(
    blocks: ChatBlock[],
    kind: T
): Extract<ChatBlock, { kind: T }> | null {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i]
        if (block.kind === kind) {
            return block as Extract<ChatBlock, { kind: T }>
        }
        if (!isTextMergeTransparentBlock(block)) {
            return null
        }
    }
    return null
}

function removeBlockById(blocks: ChatBlock[], id: string): void {
    const index = blocks.findIndex((block) => block.id === id)
    if (index >= 0) {
        blocks.splice(index, 1)
    }
}

function dedupeUserEchoBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const deduped: ChatBlock[] = []

    for (const block of blocks) {
        if (block.kind !== 'user-text') {
            deduped.push(block)
            continue
        }

        const prev = findPreviousVisibleTextBlock(deduped, 'user-text')
        if (
            prev
            && prev.text === block.text
            && Math.abs(block.createdAt - prev.createdAt) < USER_ECHO_DEDUPE_GAP_MS
        ) {
            const prevSentFrom = getMetaSentFrom(prev.meta)
            const nextSentFrom = getMetaSentFrom(block.meta)
            const hasCliEcho = prevSentFrom === 'cli' || nextSentFrom === 'cli'
            const hasUserOrigin = prevSentFrom === 'webapp'
                || prevSentFrom === 'telegram-bot'
                || prevSentFrom === 'brain'
                || nextSentFrom === 'webapp'
                || nextSentFrom === 'telegram-bot'
                || nextSentFrom === 'brain'

            if (hasCliEcho && hasUserOrigin) {
                if (prevSentFrom === 'cli' && nextSentFrom !== 'cli') {
                    removeBlockById(deduped, prev.id)
                    deduped.push(block)
                }
                continue
            }
        }

        deduped.push(block)
    }

    return deduped
}

function mergeAgentTextBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const merged: ChatBlock[] = []

    for (const block of blocks) {
        if (block.kind !== 'agent-text') {
            merged.push(block)
            continue
        }

        const prev = findPreviousVisibleTextBlock(merged, 'agent-text')
        if (prev) {
            // Check if they belong to the same message (same base id before the index suffix)
            // IDs are like "msg-123:0", "msg-123:1" - same message has same base id
            const prevBaseId = parseLocalIdPrefix(prev.id)
            const currBaseId = parseLocalIdPrefix(block.id)
            if (prevBaseId === currBaseId) {
                if (block.text === prev.text) {
                    removeBlockById(merged, prev.id)
                    merged.push(block)
                    continue
                }
                if (block.text.startsWith(prev.text)) {
                    removeBlockById(merged, prev.id)
                    merged.push(block)
                    continue
                }
                if (prev.text.startsWith(block.text)) {
                    continue
                }
                // Merge consecutive agent-text blocks from the same message (for streaming deltas)
                removeBlockById(merged, prev.id)
                merged.push({ ...block, text: prev.text + block.text })
                continue
            }

            // For streaming backends, merge blocks with small time gaps
            // This handles cases where each streaming chunk has a unique message ID
            const timeGap = block.createdAt - prev.createdAt
            const prevSentFrom = getMetaSentFrom(prev.meta)
            const nextSentFrom = getMetaSentFrom(block.meta)
            if (prevSentFrom === 'cli' && nextSentFrom === 'cli' && timeGap >= 0 && timeGap < STREAMING_MERGE_GAP_MS) {
                if (block.text === prev.text) {
                    removeBlockById(merged, prev.id)
                    merged.push(block)
                    continue
                }
                if (block.text.startsWith(prev.text)) {
                    removeBlockById(merged, prev.id)
                    merged.push(block)
                    continue
                }
                if (prev.text.startsWith(block.text)) {
                    continue
                }
                removeBlockById(merged, prev.id)
                merged.push({ ...block, text: prev.text + block.text })
                continue
            }
        }

        merged.push(block)
    }

    return merged
}

function getReasoningGroupKey(block: Extract<ChatBlock, { kind: 'agent-reasoning' }>): string {
    return block.reasoningId ?? block.id
}

function getReasoningSeq(block: Extract<ChatBlock, { kind: 'agent-reasoning' }>): number {
    return typeof block.seq === 'number' && Number.isFinite(block.seq) ? block.seq : Number.MAX_SAFE_INTEGER
}

function mergeReasoningGroup(blocks: Extract<ChatBlock, { kind: 'agent-reasoning' }>[]): Extract<ChatBlock, { kind: 'agent-reasoning' }>[] {
    if (blocks.length <= 1) {
        return blocks
    }

    const sorted = [...blocks].sort((a, b) => {
        const seqDiff = getReasoningSeq(a) - getReasoningSeq(b)
        if (seqDiff !== 0) return seqDiff
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id.localeCompare(b.id)
    })

    const merged: Extract<ChatBlock, { kind: 'agent-reasoning' }>[] = []
    let committedSeq = Number.NEGATIVE_INFINITY

    for (const block of sorted) {
        const seq = typeof block.seq === 'number' && Number.isFinite(block.seq) ? block.seq : null
        const reasoningId = getReasoningGroupKey(block)

        if (seq !== null && seq <= committedSeq) {
            logger.debug('reasoning dup dropped', {
                reasoningId,
                seq,
                committedSeq,
                blockId: block.id
            })
            continue
        }

        const prev = merged[merged.length - 1]
        if (!prev) {
            merged.push({ ...block, isDelta: Boolean(block.isDelta) })
            if (seq !== null) {
                committedSeq = seq
            }
            continue
        }

        if (block.text === prev.text) {
            merged[merged.length - 1] = {
                ...block,
                isDelta: Boolean(block.isDelta)
            }
            if (seq !== null) {
                committedSeq = seq
            }
            continue
        }

        if (block.text.startsWith(prev.text)) {
            merged[merged.length - 1] = {
                ...block,
                isDelta: Boolean(block.isDelta)
            }
            if (seq !== null) {
                committedSeq = seq
            }
            continue
        }

        if (prev.text.startsWith(block.text)) {
            if (seq !== null) {
                committedSeq = seq
            }
            continue
        }

        merged[merged.length - 1] = {
            ...prev,
            text: `${prev.text}${block.text}`,
            isDelta: Boolean(prev.isDelta || block.isDelta)
        }
        if (seq !== null) {
            committedSeq = seq
        }
    }

    return merged
}

function mergeAgentReasoningBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const merged: ChatBlock[] = []
    const reasoningGroups = new Map<string, { firstIndex: number; blocks: Extract<ChatBlock, { kind: 'agent-reasoning' }>[] }>()

    for (const block of blocks) {
        if (block.kind !== 'agent-reasoning') {
            merged.push(block)
            continue
        }

        const key = getReasoningGroupKey(block)
        const group = reasoningGroups.get(key)
        if (group) {
            group.blocks.push(block)
        } else {
            reasoningGroups.set(key, {
                firstIndex: merged.length,
                blocks: [block]
            })
        }
    }

    if (reasoningGroups.size === 0) {
        return merged
    }

    const groupedReasoning = Array.from(reasoningGroups.entries())
        .sort((left, right) => left[1].firstIndex - right[1].firstIndex || left[0].localeCompare(right[0]))

    const result: ChatBlock[] = []
    let groupIndex = 0

    for (let index = 0; index <= merged.length; index += 1) {
        while (groupIndex < groupedReasoning.length && groupedReasoning[groupIndex]![1].firstIndex === index) {
            result.push(...mergeReasoningGroup(groupedReasoning[groupIndex]![1].blocks))
            groupIndex += 1
        }

        if (index < merged.length) {
            result.push(merged[index]!)
        }
    }

    while (groupIndex < groupedReasoning.length) {
        result.push(...mergeReasoningGroup(groupedReasoning[groupIndex]![1].blocks))
        groupIndex += 1
    }

    return result
}

function mergeAgentBrowserBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const merged: ChatBlock[] = []
    let runStart = -1

    function isAgentBrowserBlock(block: ChatBlock): boolean {
        if (block.kind !== 'tool-call') return false
        if (block.tool.name !== 'Bash') return false
        const command =
            typeof block.tool.input === 'object' && block.tool.input !== null
                ? (block.tool.input as Record<string, unknown>).command
                : undefined
        return typeof command === 'string' && command.trim().startsWith('agent-browser')
    }

    function flushRun() {
        if (runStart === -1) return
        const run = merged.slice(runStart) as ToolCallBlock[]
        merged.length = runStart
        const first = run[0]
        const last = run[run.length - 1]

        let state: ChatToolCall['state'] = 'completed'
        let completedAt: number | null = null
        for (const b of run) {
            if (b.tool.state === 'error') {
                state = 'error'
                break
            }
            if (b.tool.state === 'running' || b.tool.state === 'pending') {
                state = 'running'
            }
        }
        if (state === 'completed') {
            for (const b of run) {
                if (b.tool.completedAt && (!completedAt || b.tool.completedAt > completedAt)) {
                    completedAt = b.tool.completedAt
                }
            }
        }

        merged.push({
            kind: 'tool-call',
            id: `browser-agent:${first.id}`,
            localId: first.localId,
            createdAt: first.createdAt,
            tool: {
                id: `browser-agent:${first.tool.id}`,
                name: 'BrowserAgent',
                state,
                input: { command: 'agent-browser' },
                createdAt: first.tool.createdAt,
                startedAt: first.tool.startedAt,
                completedAt,
                description: null
            },
            children: run,
            meta: first.meta
        })
        runStart = -1
    }

    for (const block of blocks) {
        if (isAgentBrowserBlock(block)) {
            if (runStart === -1) {
                runStart = merged.length
            }
            merged.push(block)
        } else {
            flushRun()
            merged.push(block)
        }
    }
    flushRun()
    return merged
}

function ensureToolBlock(
    blocks: ChatBlock[],
    toolBlocksById: Map<string, ToolCallBlock>,
    id: string,
    seed: {
        createdAt: number
        seq?: number | null
        localId: string | null
        parentUUID?: string | null
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
        if (typeof seed.seq === 'number' && Number.isFinite(seed.seq)) {
            if (typeof existing.seq !== 'number' || seed.seq < existing.seq) {
                existing.seq = seed.seq
            }
        }
        if (typeof seed.parentUUID === 'string' && seed.parentUUID.length > 0 && !existing.tool.parentUUID) {
            existing.tool.parentUUID = seed.parentUUID
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
        parentUUID: seed.parentUUID,
        permission: seed.permission
    }

    const block: ToolCallBlock = {
        kind: 'tool-call',
        id,
        localId: seed.localId,
        createdAt: seed.createdAt,
        seq: typeof seed.seq === 'number' && Number.isFinite(seed.seq) ? seed.seq : null,
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
                        seq: msg.seq ?? null,
                        text: c.text,
                        parentUUID: c.parentUUID,
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
                        seq: msg.seq ?? null,
                        text: c.text,
                        reasoningId: c.uuid,
                        parentUUID: c.parentUUID,
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

                    if (import.meta.env.DEV && (c.name === 'AskUserQuestion' || c.name === 'ask_user_question') && !permission) {
                        console.warn('[reducer] AskUserQuestion tool-call without matching permission', {
                            toolId: c.id,
                            toolName: c.name,
                            availablePermissionIds: Array.from(context.permissionsById.keys()),
                        })
                    }

                    const block = ensureToolBlock(blocks, toolBlocksById, c.id, {
                        createdAt: msg.createdAt,
                        seq: msg.seq ?? null,
                        localId: msg.localId,
                        parentUUID: c.parentUUID,
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
                        seq: msg.seq ?? null,
                        localId: msg.localId,
                        parentUUID: c.parentUUID,
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
        blocks: mergeAgentReasoningBlocks(mergeAgentTextBlocks(dedupeResultTextBlocks(mergeAgentBrowserBlocks(mergeCliOutputBlocks(dedupeUserEchoBlocks(blocks)))))),
        toolBlocksById,
        hasReadyEvent
    }
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize?: number
    timestamp: number
    // For Codex new format: model_context_window from token_count event.
    // When present, contextSize / modelContextWindow gives the context usage percentage.
    modelContextWindow?: number
    // reasoning tokens used in the last turn (new Codex format)
    reasoningOutputTokens?: number
    // rate limit primary window usage 0–100 (from token_count rate_limits)
    rateLimitUsedPercent?: number
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null } {
    const permissionsById = getPermissions(agentState)
    const toolIdsInMessages = collectToolIdsFromMessages(normalized)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    if (import.meta.env.DEV) {
        const askToolIdsInMessages = Array.from(toolIdsInMessages).filter((id) => {
            for (const msg of normalized) {
                if (msg.role !== 'agent') continue
                for (const c of msg.content) {
                    if (c.type === 'tool-call' && c.id === id && (c.name === 'AskUserQuestion' || c.name === 'ask_user_question')) {
                        return true
                    }
                }
            }
            return false
        })
        if (askToolIdsInMessages.length > 0) {
            console.log('[reducer] reduceChatBlocks', {
                askToolIdsInMessages,
                permissionIds: Array.from(permissionsById.keys()),
                agentStateRequests: agentState?.requests ? Object.keys(agentState.requests) : [],
                agentStateCompleted: agentState?.completedRequests ? Object.keys(agentState.completedRequests) : [],
            })
        }
    }

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else if (msg.isSidechain) {
            continue
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

    // Find the last assistant message with per-step usage data.
    // IMPORTANT: session-result messages contain CUMULATIVE usage across all turns,
    // which is NOT suitable for context percentage calculation (would show e.g. 13162%).
    // Only per-step assistant usage or Codex token-count data accurately reflects
    // the current context window usage.
    let assistantUsage: LatestUsage | null = null
    // Codex-specific: track the last token-count event.
    // New format has model_context_window for direct percentage calculation.
    let lastTokenCount: LatestUsage | null = null

    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage) {
            const inputTokens = msg.usage.input_tokens
            const cacheCreation = msg.usage.cache_creation_input_tokens || 0
            const cacheRead = msg.usage.cache_read_input_tokens || 0
            const isTokenCount = msg.role === 'event' && msg.content && typeof msg.content === 'object' && 'type' in msg.content && msg.content.type === 'token-count'
            const contextTokensReliable = msg.usage.context_tokens_reliable !== false
            const clearContextUsage = msg.usage.clear_context_usage === true
            const hasNonZeroUsage = inputTokens !== 0
                || msg.usage.output_tokens !== 0
                || cacheCreation !== 0
                || cacheRead !== 0
            const hasRateLimitSignal = msg.usage.rate_limit_used_percent !== undefined
            const hasExplicitCodexContextSignal = isTokenCount && (clearContextUsage || msg.usage.context_tokens_reliable === true)

            if (!hasNonZeroUsage && !hasRateLimitSignal && !hasExplicitCodexContextSignal) {
                continue
            }

            const usage = {
                inputTokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation,
                cacheRead,
                contextSize: contextTokensReliable ? inputTokens + cacheCreation + cacheRead : undefined,
                timestamp: msg.createdAt
            }

            if (isTokenCount) {
                if (clearContextUsage) {
                    if (!lastTokenCount && hasRateLimitSignal) {
                        lastTokenCount = {
                            ...usage,
                            modelContextWindow: msg.usage.model_context_window,
                            reasoningOutputTokens: msg.usage.reasoning_output_tokens || undefined,
                            rateLimitUsedPercent: msg.usage.rate_limit_used_percent
                        }
                    }
                    break
                }

                if (!lastTokenCount) {
                    lastTokenCount = {
                        ...usage,
                        modelContextWindow: msg.usage.model_context_window,
                        reasoningOutputTokens: msg.usage.reasoning_output_tokens || undefined,
                        rateLimitUsedPercent: msg.usage.rate_limit_used_percent
                    }
                }
                continue
            }

            // Skip session-result events — their usage is cumulative across all turns
            // and would produce wildly inflated context percentages
            if (msg.role === 'event' && msg.content && typeof msg.content === 'object' && 'type' in msg.content && msg.content.type === 'session-result') {
                continue
            }

            // Per-step assistant message usage (accurate for context window)
            if (!assistantUsage && msg.role === 'agent') {
                assistantUsage = usage
                break
            }
        }
    }

    // Use per-step assistant usage or Codex token-count data only.
    // Never fall back to cumulative session-result usage for context percentage.
    latestUsage = assistantUsage ?? lastTokenCount ?? null

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

    return { blocks: dedupeAgentEvents(sortedBlocks), hasReadyEvent, latestUsage }
}
