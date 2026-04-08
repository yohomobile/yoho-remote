import { useMemo } from 'react'
import type { AgentState, ModelMode, TypingUser } from '@/types/api'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { useVibingMessage } from '@/hooks/useVibingMessage'

function formatCompactTokenCount(value: number): string {
    if (value >= 1_000_000) {
        const compact = value >= 10_000_000 ? Math.round(value / 1_000_000) : Math.round((value / 100_000)) / 10
        return `${compact}M`
    }

    if (value >= 1_000) {
        const compact = value >= 100_000 ? Math.round(value / 1_000) : Math.round((value / 100)) / 10
        return `${compact}K`
    }

    return String(value)
}

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    if (!active) {
        return {
            text: 'offline',
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: 'permission required',
            color: 'text-[#FF9500]',
            dotColor: 'bg-[#FF9500]',
            isPulsing: true
        }
    }

    if (thinking) {
        return {
            text: '', // filled by useVibingMessage hook
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    return {
        text: 'online',
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

function getContextWarning(contextSize: number, maxContextSize: number): { text: string; color: string } | null {
    const percentageUsed = (contextSize / maxContextSize) * 100

    console.log('[StatusBar Debug] Context calculation:')
    console.log('  - contextSize:', contextSize)
    console.log('  - maxContextSize:', maxContextSize)
    console.log('  - percentageUsed:', percentageUsed.toFixed(2) + '%')

    if (percentageUsed >= 95) {
        return { text: `${Math.round(percentageUsed)}% used`, color: 'text-red-500' }
    } else if (percentageUsed >= 90) {
        return { text: `${Math.round(percentageUsed)}% used`, color: 'text-amber-500' }
    } else {
        return { text: `${Math.round(percentageUsed)}% used`, color: 'text-[var(--app-hint)]' }
    }
}

// Get display name from email (first part before @)
function getDisplayName(email: string): string {
    const atIndex = email.indexOf('@')
    if (atIndex === -1) return email
    const name = email.slice(0, atIndex)
    return name.length > 0 ? name : email
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    contextSize?: number
    modelMode?: ModelMode
    agentFlavor?: string | null
    otherUserTyping?: TypingUser | null
}) {
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState),
        [props.active, props.thinking, props.agentState]
    )

    const vibingMessage = useVibingMessage(props.thinking)
    const statusText = props.thinking && props.active ? vibingMessage : connectionStatus.text

    const contextWarning = useMemo(
        () => {
            if (props.contextSize === undefined) return null
            if (props.agentFlavor === 'codex') {
                return { text: `${formatCompactTokenCount(props.contextSize)} input tokens`, color: 'text-[var(--app-hint)]' }
            }
            if (props.agentFlavor && props.agentFlavor !== 'claude') return null
            const maxContextSize = getContextBudgetTokens(props.modelMode)
            if (!maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize)
        },
        [props.contextSize, props.modelMode, props.agentFlavor]
    )

    return (
        <div className="flex items-center justify-between px-2 pb-1">
            <div className="flex items-baseline gap-3">
                <div className="flex items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`text-xs ${connectionStatus.color}`}>
                        {statusText}
                    </span>
                </div>
                {contextWarning ? (
                    <span className={`text-[10px] ${contextWarning.color}`}>
                        {contextWarning.text}
                    </span>
                ) : null}
                {props.otherUserTyping ? (
                    <span className="text-[10px] text-[var(--app-hint)] italic">
                        {getDisplayName(props.otherUserTyping.email)} typing…
                    </span>
                ) : null}
            </div>

        </div>
    )
}
