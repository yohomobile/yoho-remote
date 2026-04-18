import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { YohoRemoteToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import type { YohoRemoteChatMessageMetadata } from '@/lib/assistant-runtime'

const TOOL_COMPONENTS = {
    Fallback: YohoRemoteToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function YohoRemoteAssistantMessage() {
    const messageId = useAssistantState(({ message }) => message.id)
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'px-1 min-w-0 max-w-full overflow-x-hidden'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden" data-message-id={messageId}>
                <CliOutputBlock text={cliText} />
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root className={rootClass} data-message-id={messageId}>
            <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
        </MessagePrimitive.Root>
    )
}
