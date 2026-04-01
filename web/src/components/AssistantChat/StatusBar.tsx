import { useEffect, useMemo, useState } from 'react'
import type { AgentState, ModelMode, PermissionMode, TypingUser } from '@/types/api'
import { getContextBudgetTokens } from '@/chat/modelConfig'

const PERMISSION_MODE_LABELS: Record<string, string> = {
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo'
}

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

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
    const percentageRemaining = Math.max(0, 100 - percentageUsed)

    console.log('[StatusBar Debug] Context calculation:')
    console.log('  - contextSize:', contextSize)
    console.log('  - maxContextSize:', maxContextSize)
    console.log('  - percentageUsed:', percentageUsed.toFixed(2) + '%')
    console.log('  - percentageRemaining:', percentageRemaining.toFixed(2) + '%')

    if (percentageRemaining <= 5) {
        return { text: `${Math.round(percentageUsed)}% used`, color: 'text-red-500' }
    } else if (percentageRemaining <= 10) {
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

function useVibingMessage(thinking: boolean): string {
    const [index, setIndex] = useState(() => Math.floor(Math.random() * VIBING_MESSAGES.length))

    useEffect(() => {
        if (!thinking) return
        const interval = setInterval(() => {
            setIndex(Math.floor(Math.random() * VIBING_MESSAGES.length))
        }, 3000)
        return () => clearInterval(interval)
    }, [thinking])

    return VIBING_MESSAGES[index].toLowerCase() + '…'
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    contextSize?: number
    modelMode?: ModelMode
    permissionMode?: PermissionMode
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
            if (props.agentFlavor && props.agentFlavor !== 'claude') return null
            const maxContextSize = getContextBudgetTokens(props.modelMode)
            if (!maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize)
        },
        [props.contextSize, props.modelMode, props.agentFlavor]
    )

    const permissionMode = props.permissionMode
    // Only show permission mode for non-Claude non-gemini sessions (Codex modes)
    const shouldShowPermissionMode = props.agentFlavor !== 'gemini'
        && props.agentFlavor !== 'claude'
        && props.agentFlavor !== null
        && props.agentFlavor !== undefined
        && permissionMode
        && permissionMode !== 'bypassPermissions'

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

            {shouldShowPermissionMode ? (
                <span className={`text-xs ${
                    permissionMode === 'read-only' ? 'text-amber-500' :
                    permissionMode === 'safe-yolo' ? 'text-amber-500' :
                    permissionMode === 'yolo' ? 'text-red-500' :
                    'text-[var(--app-hint)]'
                }`}>
                    {PERMISSION_MODE_LABELS[permissionMode]}
                </span>
            ) : null}
        </div>
    )
}
