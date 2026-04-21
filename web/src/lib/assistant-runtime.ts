import { useCallback, useMemo } from 'react'
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import { useExternalMessageConverter, useExternalStoreRuntime } from '@assistant-ui/react'
import { deriveBrainMessageDelivery } from '@/chat/brainDelivery'
import { deriveStableMessageId } from '@/chat/ids'
import { activeItem, buildDisplayTurns, renderEventLabel, type DisplayItem, type DisplayTurn } from '@/chat/presentation'
import type { ChatBlock, CliOutputBlock } from '@/chat/types'
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
    displayTurnId?: string
    activeItemId?: string | null
    activeItemKind?: DisplayItem['kind'] | null
    localId?: string | null
    originalText?: string
    toolCallId?: string
    event?: AgentEvent
    source?: CliOutputBlock['source']
}

type ThreadMessageParts = Exclude<ThreadMessageLike['content'], string>
type AssistantBlock = Extract<ChatBlock, { kind: 'agent-text' | 'agent-reasoning' | 'tool-call' }>

function createUserThreadMessage(
    block: Extract<ChatBlock, { kind: 'user-text' }>,
    brainDelivery?: BrainMessageDelivery,
    turn?: DisplayTurn,
): ThreadMessageLike {
    const active = turn ? activeItem(turn) : null
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
                displayTurnId: turn?.id,
                activeItemId: active?.id ?? null,
                activeItemKind: active?.kind ?? null,
                localId: block.localId,
                originalText: block.originalText
            } satisfies YohoRemoteChatMessageMetadata
        }
    }
}

function createEventThreadMessage(block: Extract<ChatBlock, { kind: 'agent-event' }>, turn?: DisplayTurn): ThreadMessageLike {
    const active = turn ? activeItem(turn) : null
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
            custom: {
                kind: 'event',
                event: block.event,
                displayTurnId: turn?.id,
                activeItemId: active?.id ?? null,
                activeItemKind: active?.kind ?? null,
            } satisfies YohoRemoteChatMessageMetadata
        }
    }
}

function createCliOutputThreadMessage(block: Extract<ChatBlock, { kind: 'cli-output' }>, turn?: DisplayTurn): ThreadMessageLike {
    const active = turn ? activeItem(turn) : null
    return {
        role: block.source === 'user' ? 'user' : 'assistant',
        id: `cli:${block.id}`,
        createdAt: new Date(block.createdAt),
        content: [{ type: 'text', text: block.text }],
        metadata: {
            custom: {
                kind: 'cli-output',
                source: block.source,
                displayTurnId: turn?.id,
                activeItemId: active?.id ?? null,
                activeItemKind: active?.kind ?? null,
            } satisfies YohoRemoteChatMessageMetadata
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

function createAssistantThreadMessage(blocks: readonly AssistantBlock[], turn: DisplayTurn): ThreadMessageLike {
    const active = activeItem(turn)
    const message: ThreadMessageLike = {
        role: 'assistant',
        id: `assistant:${deriveTurnId(blocks)}`,
        createdAt: new Date(blocks[0]!.createdAt),
        content: [] as ThreadMessageParts,
        metadata: {
            custom: {
                kind: 'assistant',
                displayTurnId: turn.id,
                activeItemId: active?.id ?? null,
                activeItemKind: active?.kind ?? null,
            } satisfies YohoRemoteChatMessageMetadata
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
    const turns = buildDisplayTurns(blocks, session)

    for (const turn of turns) {
        const pendingAssistantBlocks: AssistantBlock[] = []

        const flushAssistant = () => {
            if (pendingAssistantBlocks.length === 0) {
                return
            }
            messages.push(createAssistantThreadMessage(pendingAssistantBlocks, turn))
            pendingAssistantBlocks.length = 0
        }

        for (const item of turn.items) {
            const block = item.block

            if (block.kind === 'agent-text' || block.kind === 'agent-reasoning' || block.kind === 'tool-call') {
                pendingAssistantBlocks.push(block)
                continue
            }

            flushAssistant()

            if (block.kind === 'user-text') {
                messages.push(createUserThreadMessage(block, deriveBrainMessageDelivery(block, item.index, blocks, session), turn))
                continue
            }

            if (block.kind === 'agent-event') {
                messages.push(createEventThreadMessage(block, turn))
                continue
            }

            messages.push(createCliOutputThreadMessage(block, turn))
        }

        flushAssistant()
    }
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
