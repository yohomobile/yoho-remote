import type { BrainMessageDelivery, MessageStatus } from '@/types/api'

function ErrorIcon() {
    return (
        <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function SendingIcon() {
    return (
        <svg className="h-[14px] w-[14px] animate-spin" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
            <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
        </svg>
    )
}

export function MessageStatusIndicator(props: {
    status?: MessageStatus
    brainDelivery?: BrainMessageDelivery
    onRetry?: () => void
}) {
    if (props.status === 'sending') {
        return (
            <span className="inline-flex items-center text-[var(--app-hint)]">
                <SendingIcon />
            </span>
        )
    }

    if (props.brainDelivery) {
        const presentation = (() => {
            switch (props.brainDelivery.phase) {
                case 'queued':
                    return {
                        text: '已入队',
                        className: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
                    }
                case 'pending_consume':
                    return {
                        text: '待消费',
                        className: 'border-sky-500/30 bg-sky-500/10 text-sky-600',
                    }
                case 'consuming':
                    return {
                        text: '消费中',
                        className: 'border-blue-500/30 bg-blue-500/10 text-blue-600',
                    }
                case 'merged':
                    return {
                        text: '已合并',
                        className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
                    }
            }
        })()

        return (
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${presentation.className}`}>
                {presentation.text}
            </span>
        )
    }

    if (props.status !== 'failed') {
        return null
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-red-500">
                <ErrorIcon />
            </span>
            {props.onRetry ? (
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="text-xs text-blue-500 hover:underline"
                >
                    Retry
                </button>
            ) : null}
        </span>
    )
}
