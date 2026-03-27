import { useMemo } from 'react'

/**
 * Hook to get app configuration, primarily the base URL for API calls
 */
export function useConfig() {
    const baseUrl = useMemo(() => {
        // Check for stored server URL first
        const stored = localStorage.getItem('yr_server_url')
        if (stored) {
            try {
                const url = new URL(stored)
                return url.origin
            } catch {
                // Invalid URL, fall through
            }
        }
        // Default to current origin
        return window.location.origin
    }, [])

    return { baseUrl }
}
