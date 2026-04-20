import type { DecryptedMessage } from '@/types/api'

const STORAGE_KEY = 'yr:brainReadyMarkers'
const INIT_PROMPT_PREFIX = '#InitPrompt-'

export type BrainReadyMarker = {
    createdAt: number
}

export type BrainCreationReadyPhase = 'created' | 'initializing' | 'ready'

function getStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null
    } catch {
        return null
    }
}

function readMarkers(): Record<string, BrainReadyMarker> {
    const storage = getStorage()
    if (!storage) {
        return {}
    }

    try {
        const raw = storage.getItem(STORAGE_KEY)
        if (!raw) {
            return {}
        }
        const parsed = JSON.parse(raw) as Record<string, BrainReadyMarker> | null
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function writeMarkers(markers: Record<string, BrainReadyMarker>): void {
    const storage = getStorage()
    if (!storage) {
        return
    }

    try {
        if (Object.keys(markers).length === 0) {
            storage.removeItem(STORAGE_KEY)
            return
        }
        storage.setItem(STORAGE_KEY, JSON.stringify(markers))
    } catch {
        // Ignore storage failures.
    }
}

function asRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : null
}

export function markBrainSessionPendingReady(sessionId: string, createdAt: number = Date.now()): void {
    if (!sessionId) {
        return
    }

    const markers = readMarkers()
    markers[sessionId] = { createdAt }
    writeMarkers(markers)
}

export function getBrainSessionReadyMarker(sessionId: string): BrainReadyMarker | null {
    if (!sessionId) {
        return null
    }

    return readMarkers()[sessionId] ?? null
}

export function clearBrainSessionReadyMarker(sessionId: string): void {
    if (!sessionId) {
        return
    }

    const markers = readMarkers()
    if (!(sessionId in markers)) {
        return
    }
    delete markers[sessionId]
    writeMarkers(markers)
}

export function deriveBrainCreationReadyPhase(args: {
    source?: string | null
    active: boolean
    thinking: boolean
    marker: BrainReadyMarker | null
}): BrainCreationReadyPhase | null {
    if (args.source !== 'brain' || !args.marker) {
        return null
    }
    if (!args.active) {
        return 'created'
    }
    if (args.thinking) {
        return 'initializing'
    }
    return 'ready'
}

export function extractDecryptedMessageText(message: Pick<DecryptedMessage, 'content'>): string | null {
    const content = message.content
    if (typeof content === 'string') {
        return content
    }
    if (!asRecord(content)) {
        return null
    }
    if (typeof content.content === 'string') {
        return content.content
    }
    if (content.type === 'text' && typeof content.text === 'string') {
        return content.text
    }
    return null
}

export function extractDecryptedMessageRole(message: Pick<DecryptedMessage, 'content'>): string | null {
    const content = message.content
    if (!asRecord(content)) {
        return null
    }

    return asNonEmptyString(content.role)
}

export function isInitPromptText(text: string | null | undefined): boolean {
    return typeof text === 'string' && text.startsWith(INIT_PROMPT_PREFIX)
}

export function hasBrainReadyFollowUpActivity(messages: readonly Pick<DecryptedMessage, 'content'>[]): boolean {
    return messages.some((message) => {
        if (extractDecryptedMessageRole(message) !== 'user') {
            return false
        }
        return !isInitPromptText(extractDecryptedMessageText(message))
    })
}
