import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { getLoginUrl, isAuthenticatedSync } from '@/services/keycloak'
import { consumePostLoginRedirect } from '@/services/postLoginRedirect'
import { useServerUrl } from '@/hooks/useServerUrl'

export function LoginPage() {
    const navigate = useNavigate()
    const { baseUrl } = useServerUrl()
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // If already authenticated, redirect to sessions
    useEffect(() => {
        if (isAuthenticatedSync()) {
            window.location.href = consumePostLoginRedirect() ?? '/sessions'
        }
    }, [navigate])

    const handleLogin = useCallback(async () => {
        setIsLoading(true)
        setError(null)

        try {
            // Build callback URL
            const callbackUrl = `${window.location.origin}/auth/callback`
            const loginUrl = await getLoginUrl(baseUrl, callbackUrl)

            // Redirect to Keycloak login page
            window.location.href = loginUrl
        } catch (err) {
            console.error('[Login] Failed to get login URL:', err)
            setError('Failed to connect to authentication server')
            setIsLoading(false)
        }
    }, [baseUrl])

    return (
        <div className="h-full flex flex-col items-center justify-center p-4 bg-[var(--app-bg)]">
            <div className="w-full max-w-sm space-y-6">
                {/* Logo */}
                <div className="flex flex-col items-center gap-3">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="white"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-8 w-8"
                        >
                            <circle cx="12" cy="12" r="10" />
                            <path d="M2 12h20" />
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                    </div>
                    <h1 className="text-2xl font-bold yoho-brand-text">Yoho Remote</h1>
                    <p className="text-sm text-[var(--app-hint)]">
                        Sign in to continue
                    </p>
                </div>

                {/* Error message */}
                {error && (
                    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
                        {error}
                    </div>
                )}

                {/* Login button */}
                <button
                    type="button"
                    onClick={handleLogin}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2 h-11 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-medium shadow-md hover:shadow-lg transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                >
                    {isLoading ? (
                        <>
                            <svg
                                className="animate-spin h-5 w-5"
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                            >
                                <circle
                                    className="opacity-25"
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                />
                                <path
                                    className="opacity-75"
                                    fill="currentColor"
                                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                />
                            </svg>
                            <span>Redirecting...</span>
                        </>
                    ) : (
                        <span>Continue with SSO</span>
                    )}
                </button>

                <p className="text-xs text-center text-[var(--app-hint)]">
                    You will be redirected to the company authentication portal
                </p>
            </div>
        </div>
    )
}
