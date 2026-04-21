import type { ReactNode } from 'react'
import type { AgentEvent, PlanTodoReminderItem } from '@/chat/types'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'

function todoStatusTone(status: PlanTodoReminderItem['status']): string {
    if (status === 'completed') return 'text-emerald-600'
    if (status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function todoStatusIcon(status: PlanTodoReminderItem['status']): string {
    if (status === 'completed') return '☑'
    if (status === 'in_progress') return '◉'
    return '☐'
}

function isPlanModeEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'plan-mode' }> {
    return event.type === 'plan-mode'
}

function isTodoReminderEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'todo-reminder' }> {
    return event.type === 'todo-reminder'
}

function isPlanFileEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'plan-file' }> {
    return event.type === 'plan-file'
}

export function renderStructuredAgentEvent(event: AgentEvent): ReactNode {
    if (isPlanModeEvent(event)) {
        const title = event.isSubAgent ? 'Subagent plan mode' : 'Plan mode active'
        const detail = event.planExists ? 'Editing existing plan file.' : 'Claude is drafting a plan for approval.'

        return (
            <div className="mx-auto w-full max-w-[92%] rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 shadow-sm">
                <div className="text-sm font-medium text-[var(--app-fg)]">{title}</div>
                <div className="mt-1 text-xs text-[var(--app-hint)]">{detail}</div>
                {event.planFilePath ? (
                    <div className="mt-2 break-all font-mono text-xs text-[var(--app-hint)]">
                        {event.planFilePath}
                    </div>
                ) : null}
            </div>
        )
    }

    if (isTodoReminderEvent(event)) {
        const total = event.itemCount || event.items.length
        return (
            <div className="mx-auto w-full max-w-[92%] rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-[var(--app-fg)]">Plan progress</div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {event.completedCount}/{total}
                    </div>
                </div>
                <div className="mt-2 flex flex-col gap-2">
                    {event.items.map((item, index) => (
                        <div key={`${item.content}:${index}`} className={`text-sm ${todoStatusTone(item.status)}`}>
                            <div className="flex items-start gap-2">
                                <span className="mt-0.5 w-4 shrink-0 text-center">{todoStatusIcon(item.status)}</span>
                                <div className="min-w-0 flex-1">
                                    <div className={item.status === 'completed' ? 'line-through opacity-80' : undefined}>
                                        {item.content}
                                    </div>
                                    {item.status === 'in_progress' && item.activeForm ? (
                                        <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                                            {item.activeForm}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        )
    }

    if (isPlanFileEvent(event)) {
        return (
            <div className="mx-auto w-full max-w-[92%] rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 shadow-sm">
                <div className="text-sm font-medium text-[var(--app-fg)]">Saved plan</div>
                {event.planFilePath ? (
                    <div className="mt-2 break-all font-mono text-xs text-[var(--app-hint)]">
                        {event.planFilePath}
                    </div>
                ) : null}
                {event.planContent ? (
                    <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-[var(--app-link)]">
                            Show saved plan
                        </summary>
                        <div className="mt-2">
                            <MarkdownRenderer content={event.planContent} />
                        </div>
                    </details>
                ) : null}
            </div>
        )
    }

    return null
}
