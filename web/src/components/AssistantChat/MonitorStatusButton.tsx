import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ActiveMonitor } from '@/chat/activeMonitors'

function EyeIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    )
}

function formatElapsed(ms: number): string {
    if (ms < 0) ms = 0
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
}

function formatTimeout(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`
    return `${Math.round(ms / 60_000)} min`
}

function useNow(enabled: boolean): number {
    const [now, setNow] = useState<number>(() => Date.now())
    useEffect(() => {
        if (!enabled) return
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
    }, [enabled])
    return now
}

export function MonitorStatusButton(props: { monitors: ActiveMonitor[] }) {
    const [open, setOpen] = useState(false)
    const count = props.monitors.length
    const unknownCount = props.monitors.filter((monitor) => monitor.state === 'unknown').length

    if (count === 0) return null

    return (
        <>
            <button
                type="button"
                aria-label={unknownCount > 0
                    ? `${count} monitors tracked, ${unknownCount} uncertain`
                    : `${count} monitor${count > 1 ? 's' : ''} running`}
                title={unknownCount > 0
                    ? `${count} monitors tracked, ${unknownCount} uncertain`
                    : `${count} monitor${count > 1 ? 's' : ''} running`}
                className="relative flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-link)]"
                onClick={() => setOpen(true)}
            >
                <EyeIcon />
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--app-link)] px-1 text-[10px] font-semibold leading-none text-white">
                    {count}
                </span>
            </button>
            <MonitorStatusDialog open={open} onOpenChange={setOpen} monitors={props.monitors} />
        </>
    )
}

function MonitorStatusDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    monitors: ActiveMonitor[]
}) {
    const now = useNow(props.open)

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>后台 Monitor ({props.monitors.length})</DialogTitle>
                </DialogHeader>
                <div className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto">
                    {props.monitors.map(m => (
                        <MonitorCard key={m.id} monitor={m} now={now} />
                    ))}
                </div>
                <p className="mt-3 text-xs text-[var(--app-hint)]">
                    running 表示服务端确认任务仍在运行；unknown 表示会话已断开或超时，服务端不再确认其真实状态。
                </p>
            </DialogContent>
        </Dialog>
    )
}

function MonitorCard(props: { monitor: ActiveMonitor; now: number }) {
    const { monitor, now } = props
    const elapsed = now - monitor.startedAt
    return (
        <div className="rounded-lg border border-[var(--app-fg)]/10 bg-[var(--app-bg)] p-3">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 text-sm font-medium text-[var(--app-fg)]">
                    {monitor.description || '(no description)'}
                </div>
                <div className={`shrink-0 text-xs font-mono ${monitor.state === 'unknown' ? 'text-amber-500' : 'text-[var(--app-link)]'}`}>
                    {formatElapsed(elapsed)}
                </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${monitor.state === 'unknown' ? 'bg-amber-500/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-400'}`}>
                    {monitor.state}
                </span>
                {monitor.persistent ? (
                    <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-purple-400">
                        persistent
                    </span>
                ) : monitor.timeoutMs !== null ? (
                    <span className="rounded bg-[var(--app-fg)]/10 px-1.5 py-0.5 text-[10px] text-[var(--app-fg)]/60">
                        timeout {formatTimeout(monitor.timeoutMs)}
                    </span>
                ) : null}
                <span className="rounded bg-[var(--app-fg)]/5 px-1.5 py-0.5 font-mono text-[10px] text-[var(--app-fg)]/50">
                    id {monitor.id.slice(0, 8)}
                </span>
            </div>
            {monitor.command ? (
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-black/30 p-2 font-mono text-xs text-[var(--app-fg)]/80">
                    {monitor.command}
                </pre>
            ) : null}
        </div>
    )
}
