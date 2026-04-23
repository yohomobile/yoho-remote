import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useYohoRemoteChatContext } from '@/components/AssistantChat/context'
import type { YohoRemoteChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import type { MessageActorAttribution } from '@/chat/identityAttribution'

export function MessageAttributionLine(props: { attribution: MessageActorAttribution }) {
    return (
        <div
            className="mb-1 flex min-w-0 max-w-full flex-wrap items-center gap-1 text-[11px] leading-4 text-[var(--app-muted-fg)]"
            title={props.attribution.title}
            aria-label={props.attribution.title}
        >
            <span className="min-w-0 max-w-full truncate font-medium text-[var(--app-fg)]">
                {props.attribution.label}
            </span>
            <span className="shrink-0 rounded bg-[var(--app-bg)] px-1 py-0 text-[10px] leading-4">
                {props.attribution.detail}
            </span>
        </div>
    )
}

export function YohoRemoteUserMessage() {
    const ctx = useYohoRemoteChatContext()
    const messageId = useAssistantState(({ message }) => message.id)
    const role = useAssistantState(({ message }) => message.role)
    const text = useAssistantState(({ message }) => {
        if (message.role !== 'user') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const status = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.status
    })
    const brainDelivery = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.brainDelivery
    })
    const localId = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.localId ?? null
    })
    const actorAttribution = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.actorAttribution ?? null
    })
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    if (role !== 'user') return null
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined

    const userBubbleClass = 'w-fit min-w-0 max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden" data-message-id={messageId}>
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root className={userBubbleClass} data-message-id={messageId}>
            <div className="min-w-0">
                {actorAttribution ? <MessageAttributionLine attribution={actorAttribution} /> : null}
                <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0">
                        <LazyRainbowText text={text} />
                    </div>
                    {status || brainDelivery ? (
                        <div className="shrink-0 self-end pb-0.5">
                            <MessageStatusIndicator status={status} brainDelivery={brainDelivery} onRetry={onRetry} />
                        </div>
                    ) : null}
                </div>
            </div>
        </MessagePrimitive.Root>
    )
}
