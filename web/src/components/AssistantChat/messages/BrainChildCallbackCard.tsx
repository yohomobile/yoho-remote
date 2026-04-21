import type { ApiClient } from '@/api/client'
import type { BrainChildCallbackEvent } from '@/chat/brainChildCallback'
import { BrainChildCallbackActions } from '@/components/BrainChildActions'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

export function BrainChildCallbackCard(props: {
    api: ApiClient
    event: BrainChildCallbackEvent
}) {
    const { event } = props

    return (
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
                    api={props.api}
                    sessionId={event.sessionId}
                />
            ) : null}

            {event.previousSummary ? (
                <details className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/65 px-3 py-2">
                    <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--app-hint)]">
                        上次总结
                    </summary>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--app-fg)]">
                        {event.previousSummary}
                    </div>
                </details>
            ) : null}

            {event.details.length > 0 ? (
                <details className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/65 px-3 py-2">
                    <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--app-hint)]">
                        运行信息 ({event.details.length})
                    </summary>
                    <div className="mt-1 flex flex-col gap-1 text-xs text-[var(--app-hint)]">
                        {event.details.map((detail, index) => (
                            <div key={`${detail}:${index}`} className="whitespace-pre-wrap">
                                {detail}
                            </div>
                        ))}
                    </div>
                </details>
            ) : null}

            {event.report ? (
                <details className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/85 px-3 py-3">
                    <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--app-hint)]">
                        执行报告
                    </summary>
                    <div className="mt-2">
                        <MarkdownRenderer content={event.report} />
                    </div>
                </details>
            ) : null}
        </div>
    )
}
