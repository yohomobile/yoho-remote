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

function truncateEventText(text: string, maxLen = 120): string {
    const firstLine = text.split('\n')[0]
    if (firstLine.length < text.length) text = firstLine
    if (text.length > maxLen) text = text.slice(0, maxLen - 3) + '...'
    return text
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
    if (event.type === 'limit-reached') {
        const endsAt = typeof event.endsAt === 'number' ? event.endsAt : null
        return { icon: '⏳', text: endsAt ? `Usage limit reached until ${formatUnixTimestamp(endsAt)}` : 'Usage limit reached' }
    }
    if (event.type === 'message') {
        return { icon: null, text: typeof event.message === 'string' ? event.message : 'Message' }
    }
    if (event.type === 'turn-duration') {
        const e = event as Record<string, unknown>
        const ms = typeof e.durationMs === 'number' ? e.durationMs : 0
        const parts = [`Turn: ${formatDuration(ms)}`]
        if (typeof e.numTurns === 'number') parts.push(`${e.numTurns} turns`)
        if (typeof e.cost === 'number') parts.push(`$${(e.cost as number).toFixed(4)}`)
        const isError = e.isError === true
        const terminalReason = typeof e.terminalReason === 'string' ? e.terminalReason : null
        if (isError && terminalReason) parts.push(terminalReason)
        return { icon: isError ? '❌' : '⏱️', text: parts.join(' · ') }
    }

    if (event.type === 'plan-mode') {
        const path = typeof event.planFilePath === 'string' ? event.planFilePath : null
        return { icon: '🧭', text: path ? `Plan mode active · ${path}` : 'Plan mode active' }
    }

    if (event.type === 'todo-reminder') {
        const total = typeof event.itemCount === 'number'
            ? event.itemCount
            : Array.isArray(event.items)
                ? event.items.length
                : 0
        const completed = typeof event.completedCount === 'number' ? event.completedCount : 0
        return { icon: '📝', text: total > 0 ? `Plan progress ${completed}/${total}` : 'Plan progress' }
    }

    if (event.type === 'plan-file') {
        const path = typeof event.planFilePath === 'string' ? event.planFilePath : null
        return { icon: '📄', text: path ? `Saved plan · ${path}` : 'Saved plan' }
    }

    // --- New SDK event types ---

    if (event.type === 'rate-limit') {
        const status = (event as Record<string, unknown>).status
        const resetsAt = (event as Record<string, unknown>).resetsAt
        if (status === 'rejected' && typeof resetsAt === 'number') {
            return { icon: '⏳', text: `Rate limited until ${formatUnixTimestamp(resetsAt)}` }
        }
        if (status === 'allowed_warning') {
            return { icon: '⚠️', text: 'Approaching rate limit' }
        }
        return { icon: '⏳', text: 'Rate limited' }
    }

    if (event.type === 'tool-progress') {
        const toolName = (event as Record<string, unknown>).toolName
        const elapsed = (event as Record<string, unknown>).elapsedSeconds
        const name = typeof toolName === 'string' && toolName ? toolName : 'Tool'
        const time = typeof elapsed === 'number' ? ` (${formatDuration(elapsed * 1000)})` : ''
        return { icon: '⏳', text: `${name} running${time}` }
    }

    if (event.type === 'task-notification') {
        const summary = (event as Record<string, unknown>).summary
        const status = (event as Record<string, unknown>).status
        const text = typeof summary === 'string' && summary ? truncateEventText(summary) : `Task ${status ?? 'completed'}`
        return { icon: '📋', text }
    }

    if (event.type === 'task-started') {
        const e = event as Record<string, unknown>
        const desc = e.description
        const status = typeof e.status === 'string' ? e.status : null
        const text = typeof desc === 'string' && desc ? truncateEventText(desc) : 'Background task started'
        const icon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🚀'
        return { icon, text }
    }

    if (event.type === 'task-progress') {
        const desc = (event as Record<string, unknown>).description
        const lastTool = (event as Record<string, unknown>).lastToolName
        let text = typeof desc === 'string' && desc ? desc : 'Task running'
        if (typeof lastTool === 'string' && lastTool) text += ` (${lastTool})`
        return { icon: '⏳', text }
    }

    if (event.type === 'task-updated') {
        const status = (event as Record<string, unknown>).status
        const icon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '📋'
        const text = `Task ${status ?? 'updated'}`
        return { icon, text }
    }

    if (event.type === 'compact-boundary') {
        return { icon: '📦', text: 'Context compacted' }
    }

    if (event.type === 'status') {
        const status = (event as Record<string, unknown>).status
        if (status === 'compacting') return { icon: '📦', text: 'Compacting context...' }
        return { icon: null, text: typeof status === 'string' ? status : 'Processing...' }
    }

    if (event.type === 'hook-event') {
        const hookName = (event as Record<string, unknown>).hookName
        const subtype = (event as Record<string, unknown>).subtype
        const name = typeof hookName === 'string' && hookName ? hookName : 'Hook'
        if (subtype === 'hook_started') return { icon: '🔗', text: `${name} started` }
        if (subtype === 'hook_response') return { icon: '🔗', text: `${name} completed` }
        return { icon: '🔗', text: `${name} running` }
    }

    if (event.type === 'api-retry') {
        const attempt = (event as Record<string, unknown>).attempt
        const maxRetries = (event as Record<string, unknown>).maxRetries
        const error = (event as Record<string, unknown>).error
        let text = 'API retry'
        if (typeof attempt === 'number') {
            text += typeof maxRetries === 'number' ? ` (${attempt}/${maxRetries})` : ` (attempt ${attempt})`
        }
        if (typeof error === 'string' && error) text += `: ${error}`
        return { icon: '🔄', text }
    }

    if (event.type === 'session-result') {
        const e = event as Record<string, unknown>
        const parts: string[] = []
        if (typeof e.numTurns === 'number') parts.push(`${e.numTurns} turns`)
        if (typeof e.cost === 'number') parts.push(`$${(e.cost as number).toFixed(4)}`)
        if (typeof e.durationMs === 'number') parts.push(formatDuration(e.durationMs as number))
        const isError = e.isError === true
        const terminalReason = typeof e.terminalReason === 'string' ? e.terminalReason : null
        if (isError && terminalReason) {
            parts.push(terminalReason)
        }
        const icon = isError ? '❌' : '📊'
        return { icon, text: parts.length > 0 ? `Session: ${parts.join(' · ')}` : 'Session completed' }
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
