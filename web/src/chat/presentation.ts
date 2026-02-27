import type { AgentEvent } from '@/chat/types'

export function formatUnixTimestamp(value: number): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `${mins}m ${secs}s`
}

export type EventPresentation = {
    icon: string | null
    text: string
}

export function getEventPresentation(event: AgentEvent): EventPresentation {
    if (event.type === 'switch') {
        const mode = event.mode === 'local' ? 'local' : 'remote'
        return { icon: '🔄', text: `Switched to ${mode}` }
    }
    if (event.type === 'title-changed') {
        const title = typeof event.title === 'string' ? event.title : ''
        return { icon: null, text: title ? `Title changed to "${title}"` : 'Title changed' }
    }
    if (event.type === 'permission-mode-changed') {
        const modeValue = (event as Record<string, unknown>).mode
        const mode = typeof modeValue === 'string' ? modeValue : 'default'
        return { icon: '🔐', text: `Permission mode: ${mode}` }
    }
    if (event.type === 'limit-reached') {
        const endsAt = typeof event.endsAt === 'number' ? event.endsAt : null
        return { icon: '⏳', text: endsAt ? `Usage limit reached until ${formatUnixTimestamp(endsAt)}` : 'Usage limit reached' }
    }
    if (event.type === 'message') {
        return { icon: null, text: typeof event.message === 'string' ? event.message : 'Message' }
    }
    if (event.type === 'turn-duration') {
        const ms = typeof event.durationMs === 'number' ? event.durationMs : 0
        return { icon: '⏱️', text: `Turn: ${formatDuration(ms)}` }
    }
    try {
        return { icon: null, text: JSON.stringify(event) }
    } catch {
        return { icon: null, text: String(event.type) }
    }
}

export function renderEventLabel(event: AgentEvent): string {
    return getEventPresentation(event).text
}
