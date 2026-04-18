import { useAssistantState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import type { YohoRemoteChatMessageMetadata } from '@/lib/assistant-runtime'

export function YohoRemoteSystemMessage() {
    const messageId = useAssistantState(({ message }) => message.id)
    const role = useAssistantState(({ message }) => message.role)
    const text = useAssistantState(({ message }) => {
        if (message.role !== 'system') return ''
        return message.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
    })
    const icon = useAssistantState(({ message }) => {
        if (message.role !== 'system') return null
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        const event = custom?.kind === 'event' ? custom.event : undefined
        return event ? getEventPresentation(event).icon : null
    })

    if (role !== 'system') return null

    return (
        <div className="py-1" data-message-id={messageId}>
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1">
                    {icon ? <span aria-hidden="true">{icon}</span> : null}
                    <span>{text}</span>
                </span>
            </div>
        </div>
    )
}
