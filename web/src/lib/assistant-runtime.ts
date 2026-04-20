import { useCallback, useMemo } from 'react'
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import { useExternalMessageConverter, useExternalStoreRuntime } from '@assistant-ui/react'
import { deriveStableMessageId } from '@/chat/ids'
import { renderEventLabel } from '@/chat/presentation'
import type { ChatBlock, CliOutputBlock, UserTextBlock } from '@/chat/types'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import { hashStableValueSync } from '@/lib/hash'
import type { BrainMessageDelivery, MessageStatus as YohoRemoteMessageStatus, Session } from '@/types/api'
import { canQueueMessagesWhenInactive } from '@/lib/sessionActivity'

function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        const stringified = JSON.stringify(value, null, 2)
        return typeof stringified === 'string' ? stringified : String(value)
    } catch {
        return String(value)
    }
}

export type YohoRemoteChatMessageMetadata = {
    kind: 'user' | 'assistant' | 'tool' | 'event' | 'cli-output'
    status?: YohoRemoteMessageStatus
    brainDelivery?: BrainMessageDelivery
    localId?: string | null
    originalText?: string
    toolCallId?: string
    event?: AgentEvent
    source?: CliOutputBlock['source']
}

type ThreadMessageParts = Exclude<ThreadMessageLike['content'], string>
type AssistantBlock = Extract<ChatBlock, { kind: 'agent-text' | 'agent-reasoning' | 'tool-call' }>

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function readBrainDelivery(block: UserTextBlock): BrainMessageDelivery | undefined {
    if (!isRecord(block.meta)) {
        return undefined
    }
    const raw = block.meta.brainDelivery
    if (!isRecord(raw)) {
        return undefined
    }
    const phase = raw.phase
    const acceptedAt = raw.acceptedAt
    if (
        phase !== 'queued'
        && phase !== 'pending_consume'
        && phase !== 'consuming'
        && phase !== 'merged'
    ) {
        return undefined
    }
    if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt)) {
        return undefined
    }
    return { phase, acceptedAt }
}

function isConsumptionBoundary(block: ChatBlock): boolean {
    if (block.kind === 'agent-text' || block.kind === 'agent-reasoning' || block.kind === 'tool-call') {
        return true
    }
    return block.kind === 'agent-event' && block.event.type === 'brain-child-callback'
}

function countConsumptionBoundariesAfter(
    index: number,
    blocks: readonly ChatBlock[],
): number {
    let boundaries = 0
    for (let i = index + 1; i < blocks.length; i += 1) {
        const next = blocks[i]
        if (!next) continue
        if (next.kind === 'user-text') {
            break
        }
        if (isConsumptionBoundary(next)) {
            boundaries += 1
        }
    }
    return boundaries
}

function deriveBrainDelivery(
    block: UserTextBlock,
    index: number,
    blocks: readonly ChatBlock[],
    session?: Session,
): BrainMessageDelivery | undefined {
    const raw = readBrainDelivery(block)
    if (!raw) {
        return undefined
    }

    const boundaries = countConsumptionBoundariesAfter(index, blocks)
    const requiredBoundaries = raw.phase === 'pending_consume' ? 2 : 1
    if (boundaries >= requiredBoundaries) {
        return {
            ...raw,
            phase: 'merged',
        }
    }

    if (!session) {
        return raw
    }
    if (!session.active) {
        return {
            ...raw,
            phase: 'queued',
        }
    }
    if (raw.phase === 'pending_consume') {
        if (boundaries >= 1 || !session.thinking) {
            return {
                ...raw,
                phase: 'consuming',
            }
        }
        return {
            ...raw,
            phase: 'pending_consume',
        }
    }
    if (raw.phase === 'consuming') {
        return {
            ...raw,
            phase: 'consuming',
        }
    }
    return {
        ...raw,
        phase: 'consuming',
    }
}

function createUserThreadMessage(
    block: Extract<ChatBlock, { kind: 'user-text' }>,
    brainDelivery?: BrainMessageDelivery,
): ThreadMessageLike {
    return {
        role: 'user',
        id: `user:${block.id}`,
        createdAt: new Date(block.createdAt),
        content: [{ type: 'text', text: block.text }],
        metadata: {
            custom: {
                kind: 'user',
                status: block.status,
                brainDelivery,
                localId: block.localId,
                originalText: block.originalText
            } satisfies YohoRemoteChatMessageMetadata
        }
    }
}

function createEventThreadMessage(block: Extract<ChatBlock, { kind: 'agent-event' }>): ThreadMessageLike {
    const eventText = renderEventLabel(block.event)
    const eventVersion = hashStableValueSync({
        event: block.event,
        text: eventText,
    })
    return {
        role: 'system',
        id: `event:${block.id}:${eventVersion}`,
        createdAt: new Date(block.createdAt),
        content: [{ type: 'text', text: eventText }],
        metadata: {
            custom: { kind: 'event', event: block.event } satisfies YohoRemoteChatMessageMetadata
        }
    }
}

function createCliOutputThreadMessage(block: Extract<ChatBlock, { kind: 'cli-output' }>): ThreadMessageLike {
    return {
        role: block.source === 'user' ? 'user' : 'assistant',
        id: `cli:${block.id}`,
        createdAt: new Date(block.createdAt),
        content: [{ type: 'text', text: block.text }],
        metadata: {
            custom: { kind: 'cli-output', source: block.source } satisfies YohoRemoteChatMessageMetadata
        }
    }
}

function getBlockParentToolUseId(block: AssistantBlock): string | null {
    if (block.kind === 'tool-call') {
        const parentUUID = block.tool.parentUUID
        return typeof parentUUID === 'string' && parentUUID.length > 0 ? parentUUID : null
    }

    return typeof block.parentUUID === 'string' && block.parentUUID.length > 0 ? block.parentUUID : null
}

export function deriveTurnId(blocks: readonly ChatBlock[]): string {
    const assistantBlocks = blocks as readonly AssistantBlock[]
    if (assistantBlocks.length === 0) {
        return 'assistant'
    }

    const firstParentToolUseId = getBlockParentToolUseId(assistantBlocks[0]!)
    if (
        firstParentToolUseId
        && assistantBlocks.every((block) => getBlockParentToolUseId(block) === firstParentToolUseId)
    ) {
        return firstParentToolUseId
    }

    return deriveStableMessageId(assistantBlocks[0]!)
}

function createAssistantThreadMessage(blocks: readonly AssistantBlock[]): ThreadMessageLike {
    const message: ThreadMessageLike = {
        role: 'assistant',
        id: `assistant:${deriveTurnId(blocks)}`,
        createdAt: new Date(blocks[0]!.createdAt),
        content: [] as ThreadMessageParts,
        metadata: {
            custom: { kind: 'assistant' } satisfies YohoRemoteChatMessageMetadata
        }
    }

    for (const block of blocks) {
        appendAssistantBlock(message, block)
    }
    return message
}

function appendAssistantBlock(
    message: ThreadMessageLike,
    block: Extract<ChatBlock, { kind: 'agent-text' | 'agent-reasoning' | 'tool-call' }>
): void {
    if (message.role !== 'assistant') {
        return
    }

    if (!Array.isArray(message.content)) {
        return
    }

    if (block.kind === 'agent-text') {
        message.content.push({ type: 'text', text: block.text })
        return
    }

    if (block.kind === 'agent-reasoning') {
        message.content.push({ type: 'reasoning', text: block.text })
        return
    }

    const toolBlock: ToolCallBlock = block
    message.content.push({
        type: 'tool-call',
        toolCallId: toolBlock.id,
        toolName: toolBlock.tool.name,
        argsText: safeStringify(toolBlock.tool.input),
        result: toolBlock.tool.result,
        isError: toolBlock.tool.state === 'error',
        artifact: toolBlock
    })
}

export function convertBlocksToThreadMessages(
    blocks: readonly ChatBlock[],
    session?: Session,
): ThreadMessageLike[] {
    const messages: ThreadMessageLike[] = []
    let pendingAssistantBlocks: AssistantBlock[] = []

    const flushAssistant = () => {
        if (pendingAssistantBlocks.length === 0) {
            return
        }
        messages.push(createAssistantThreadMessage(pendingAssistantBlocks))
        pendingAssistantBlocks = []
    }

    for (const [index, block] of blocks.entries()) {
        if (block.kind === 'agent-text' || block.kind === 'agent-reasoning' || block.kind === 'tool-call') {
            pendingAssistantBlocks.push(block)
            continue
        }

        flushAssistant()

        if (block.kind === 'user-text') {
            messages.push(createUserThreadMessage(block, deriveBrainDelivery(block, index, blocks, session)))
            continue
        }

        if (block.kind === 'agent-event') {
            messages.push(createEventThreadMessage(block))
            continue
        }

        messages.push(createCliOutputThreadMessage(block))
    }

    flushAssistant()
    return messages
}

function getTextFromAppendMessage(message: AppendMessage): string | null {
    if (message.role !== 'user') return null

    const parts = message.content
    const text = parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()

    return text.length > 0 ? text : null
}

export function useYohoRemoteRuntime(props: {
    session: Session
    blocks: readonly ChatBlock[]
    isSending: boolean
    onSendMessage: (text: string) => void
    onAbort: () => Promise<void>
}) {
    const groupedMessages = useMemo(
        () => convertBlocksToThreadMessages(props.blocks, props.session),
        [props.blocks, props.session]
    )
    const convertedMessages = useExternalMessageConverter<ThreadMessageLike>({
        callback: (message) => message,
        messages: groupedMessages,
        isRunning: props.session.thinking,
    })

    const onNew = useCallback(async (message: AppendMessage) => {
        const text = getTextFromAppendMessage(message)
        if (!text) return
        props.onSendMessage(text)
    }, [props.onSendMessage])

    const onCancel = useCallback(async () => {
        await props.onAbort()
    }, [props.onAbort])

    // Memoize the adapter to avoid recreating on every render
    // useExternalStoreRuntime may use adapter identity for subscriptions
    const adapter = useMemo(() => ({
        isDisabled: (!props.session.active && !canQueueMessagesWhenInactive(props.session)) || props.isSending,
        isRunning: props.session.thinking,
        messages: convertedMessages,
        onNew,
        onCancel,
        unstable_capabilities: { copy: true }
    }), [props.session, props.isSending, convertedMessages, onNew, onCancel])

    return useExternalStoreRuntime(adapter)
}
