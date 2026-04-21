import { useAssistantState } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import { getEventPresentation } from '@/chat/presentation'
import type { AgentEvent } from '@/chat/types'
import type { BrainChildCallbackEvent } from '@/chat/brainChildCallback'
import { BrainChildCallbackCard } from '@/components/AssistantChat/messages/BrainChildCallbackCard'
import { renderStructuredAgentEvent } from '@/components/AssistantChat/messages/StructuredAgentEvent'
import type { YohoRemoteChatMessageMetadata } from '@/lib/assistant-runtime'
import { useAppContext } from '@/lib/app-context'

function isBrainChildCallbackEvent(event: AgentEvent): event is BrainChildCallbackEvent {
    return event.type === 'brain-child-callback'
}

export function YohoRemoteSystemEvent(props: {
    api: ApiClient
    messageId: string
    event: AgentEvent
}) {
    const event = props.event
    if (isBrainChildCallbackEvent(event)) {
        return (
            <div className="py-1" data-message-id={props.messageId}>
                <BrainChildCallbackCard api={props.api} event={event} />
            </div>
        )
    }

    const structured = renderStructuredAgentEvent(event)
    if (structured) {
        return (
            <div className="py-1" data-message-id={props.messageId}>
                {structured}
            </div>
        )
    }

    const presentation = getEventPresentation(event)

    return (
        <div className="py-1" data-message-id={props.messageId}>
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1">
                    {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
                    <span>{presentation.text}</span>
                </span>
            </div>
        </div>
    )
}

export function YohoRemoteSystemMessage() {
    const { api } = useAppContext()
    const messageId = useAssistantState(({ message }) => message.id)
    const role = useAssistantState(({ message }) => message.role)
    const event = useAssistantState(({ message }) => {
        if (message.role !== 'system') return undefined
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.kind === 'event' ? custom.event : undefined
    })

    if (role !== 'system') return null
    if (!event) return null

    return <YohoRemoteSystemEvent api={api} messageId={messageId} event={event} />
}
