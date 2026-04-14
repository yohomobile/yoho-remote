import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { exchangeCodeForToken, saveTokens } from '@/services/keycloak'
import { consumePostLoginRedirect } from '@/services/postLoginRedirect'
import { useServerUrl } from '@/hooks/useServerUrl'

export function AuthCallbackPage() {
    const navigate = useNavigate()
    const { baseUrl } = useServerUrl()
    const [error, setError] = useState<string | null>(null)
    const [isProcessing, setIsProcessing] = useState(true)

    useEffect(() => {
        const processCallback = async () => {
            // Get query parameters from URL
            const urlParams = new URLSearchParams(window.location.search)
            const code = urlParams.get('code')
            const errorParam = urlParams.get('error')
            const errorDescription = urlParams.get('error_description')

            if (errorParam) {
                setError(errorDescription || errorParam)
                setIsProcessing(false)
                return
            }

            if (!code) {
                setError('No authorization code received')
                setIsProcessing(false)
                return
            }

            try {
                const redirectUri = `${window.location.origin}/auth/callback`
                const authResponse = await exchangeCodeForToken(baseUrl, code, redirectUri)
                await saveTokens(authResponse)

                // Force page reload to ensure KeycloakAuthProvider re-initializes with new token
                // This fixes the issue where isAuthenticated state isn't updated immediately after login
                window.location.href = consumePostLoginRedirect() ?? '/sessions'
            } catch (e) {
                console.error('[AuthCallback] Token exchange failed:', e)
                setError(e instanceof Error ? e.message : 'Authentication failed')
                setIsProcessing(false)
            }
        }

        processCallback()
    }, [baseUrl, navigate])

    if (error) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-4 bg-[var(--app-bg)]">
                <div className="w-full max-w-sm space-y-6">
                    <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                            <svg className="h-6 w-6 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </div>
                        <h2 className="text-xl font-semibold text-[var(--app-fg)]">Authentication Failed</h2>
                        <p className="text-sm text-[var(--app-hint)] text-center">{error}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/login', replace: true })}
                        className="w-full flex items-center justify-center h-11 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-medium shadow-md hover:shadow-lg transition-all hover:scale-[1.02]"
                    >
                        Try Again
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className="h-full flex flex-col items-center justify-center p-4 bg-[var(--app-bg)]">
            <div className="text-center space-y-4">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent mx-auto"></div>
                <p className="text-sm text-[var(--app-hint)]">
                    {isProcessing ? 'Completing sign in...' : 'Redirecting...'}
                </p>
            </div>
        </div>
    )
}
