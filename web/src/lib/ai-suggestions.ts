const AI_SUGGESTIONS_ENABLED_KEY = 'yr-ai-suggestions-enabled'
const AI_SUGGESTIONS_EVENT = 'yr-ai-suggestions-changed'

export function getAiSuggestionsEnabled(): boolean {
    if (typeof window === 'undefined') {
        return true
    }
    try {
        const stored = localStorage.getItem(AI_SUGGESTIONS_ENABLED_KEY)
        if (stored === null) {
            return true
        }
        return stored === 'true'
    } catch {
        return true
    }
}

export function setAiSuggestionsEnabled(enabled: boolean): void {
    if (typeof window === 'undefined') {
        return
    }
    try {
        localStorage.setItem(AI_SUGGESTIONS_ENABLED_KEY, String(enabled))
    } catch {
        // ignore storage errors
    }
    try {
        window.dispatchEvent(new Event(AI_SUGGESTIONS_EVENT))
    } catch {
        // ignore event errors
    }
}

export function subscribeAiSuggestionsEnabled(listener: () => void): () => void {
    if (typeof window === 'undefined') {
        return () => undefined
    }

    const handleStorage = (event: StorageEvent) => {
        if (event.key === AI_SUGGESTIONS_ENABLED_KEY) {
            listener()
        }
    }

    const handleCustom = () => listener()

    window.addEventListener('storage', handleStorage)
    window.addEventListener(AI_SUGGESTIONS_EVENT, handleCustom as EventListener)

    return () => {
        window.removeEventListener('storage', handleStorage)
        window.removeEventListener(AI_SUGGESTIONS_EVENT, handleCustom as EventListener)
    }
}
