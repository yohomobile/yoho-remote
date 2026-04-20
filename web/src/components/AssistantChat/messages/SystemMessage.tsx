import { useAssistantState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import type { AgentEvent } from '@/chat/types'
import { BrainChildCallbackActions } from '@/components/BrainChildActions'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { YohoRemoteChatMessageMetadata } from '@/lib/assistant-runtime'
import { useAppContext } from '@/lib/app-context'

function isBrainChildCallbackEvent(event: AgentEvent | undefined): event is Extract<AgentEvent, { type: 'brain-child-callback' }> {
    return event?.type === 'brain-child-callback'
}

export function YohoRemoteSystemMessage() {
    const { api } = useAppContext()
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
    const event = useAssistantState(({ message }) => {
        if (message.role !== 'system') return undefined
        const custom = message.metadata.custom as Partial<YohoRemoteChatMessageMetadata> | undefined
        return custom?.kind === 'event' ? custom.event : undefined
    })

    if (role !== 'system') return null

    if (isBrainChildCallbackEvent(event)) {
        return (
            <div className="py-1" data-message-id={messageId}>
                <div className="mx-auto w-full max-w-[92%] rounded-2xl border border-amber-500/20 bg-gradient-to-b from-amber-500/8 to-[var(--app-secondary-bg)] p-3 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-amber-500/12 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                            子任务回传
                        </span>
                        {event.sessionId ? (
                            <span className="font-mono text-[11px] text-[var(--app-hint)]">
                                {event.sessionId}
                            </span>
                        ) : null}
                    </div>

                    <div className="mt-2 text-sm font-semibold text-[var(--app-fg)]">
                        {event.title ?? '未命名子任务'}
                    </div>

                    {event.sessionId ? (
                        <BrainChildCallbackActions
                            api={api}
                            sessionId={event.sessionId}
                        />
                    ) : null}

                    {event.previousSummary ? (
                        <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/65 px-3 py-2">
                            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--app-hint)]">
                                上次总结
                            </div>
                            <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--app-fg)]">
                                {event.previousSummary}
                            </div>
                        </div>
                    ) : null}

                    {event.details.length > 0 ? (
                        <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/65 px-3 py-2">
                            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--app-hint)]">
                                运行信息
                            </div>
                            <div className="mt-1 flex flex-col gap-1 text-xs text-[var(--app-hint)]">
                                {event.details.map((detail, index) => (
                                    <div key={`${detail}:${index}`} className="whitespace-pre-wrap">
                                        {detail}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}

                    <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/85 px-3 py-3">
                        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--app-hint)]">
                            执行报告
                        </div>
                        <div className="mt-2">
                            <MarkdownRenderer content={event.report ?? '（无文本输出）'} />
                        </div>
                    </div>
                </div>
            </div>
        )
    }

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
