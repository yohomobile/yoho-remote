import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { ApiClient } from '@/api/client'
import { getClientId } from '@/lib/client-identity'
import * as keycloak from '@/services/keycloak'
import { isStorageInitialized } from '@/services/tokenStorage'
import type { KeycloakUser } from '@/services/keycloak'

interface AuthContextValue {
    user: KeycloakUser | null
    isAuthenticated: boolean
    isLoading: boolean
    error: string | null
    api: ApiClient | null
    login: () => Promise<void>
    logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

interface KeycloakAuthProviderProps {
    children: React.ReactNode
    baseUrl: string
}

export function KeycloakAuthProvider({ children, baseUrl }: KeycloakAuthProviderProps) {
    const [user, setUser] = useState<KeycloakUser | null>(() => keycloak.getCurrentUserSync())
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [storageInitDone, setStorageInitDone] = useState(false)
    const tokenRef = useRef<string | null>(null)

    // Check authentication status on mount
    useEffect(() => {
        let isCancelled = false

        const checkAuth = async () => {
            setIsLoading(true)
            try {
                const isAuth = await keycloak.isAuthenticated()
                if (isAuth) {
                    const token = await keycloak.ensureValidToken(baseUrl)
                    if (token) {
                        tokenRef.current = token
                        const currentUser = await keycloak.getCurrentUser()
                        setUser(currentUser)
                        setError(null)
                    } else {
                        // Token refresh failed
                        await keycloak.clearTokens()
                        setUser(null)
                    }
                } else {
                    setUser(null)
                }
            } catch (e) {
                console.warn('[KeycloakAuth] Auth check failed (likely network issue), keeping tokens:', e)
                // Network errors during init should not clear tokens
                // The token refresh timer will retry later
            } finally {
                if (!isCancelled) {
                    setStorageInitDone(true)
                    setIsLoading(false)
                }
            }
        }

        checkAuth()

        return () => {
            isCancelled = true
        }
    }, [baseUrl])

    // Auto-refresh token before expiry.
    //
    // Schedules a single timer targeting ~30s before the stored expiresAt
    // (which already accounts for the 60s buffer in tokenStorage.saveTokens).
    // After a successful refresh, we re-schedule from the new expiresAt.
    //
    // visibilitychange only triggers a refresh if the stored token is actually
    // expired — otherwise it would fire on every tab focus.
    useEffect(() => {
        if (!user) return

        let isCancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const runRefresh = async () => {
            try {
                const token = await keycloak.ensureValidToken(baseUrl)
                if (isCancelled) return
                if (token) {
                    tokenRef.current = token
                    const currentUser = await keycloak.getCurrentUser()
                    if (!isCancelled) setUser(currentUser)
                } else {
                    await keycloak.clearTokens()
                    if (!isCancelled) setUser(null)
                }
            } catch (e) {
                // Network error — don't clear tokens, next schedule/visibility will retry
                console.warn('[KeycloakAuth] Token refresh failed (network), will retry:', e)
            }
        }

        const schedule = () => {
            if (isCancelled) return
            const expiresAt = keycloak.getExpiresAtSync()
            if (!expiresAt) return
            const delay = Math.max(0, expiresAt - Date.now() - 30_000)
            timer = setTimeout(async () => {
                if (isCancelled) return
                await runRefresh()
                schedule()
            }, delay)
        }

        schedule()

        const handleVisibilityChange = async () => {
            if (document.visibilityState !== 'visible') return
            if (!keycloak.isTokenExpiredSync()) return
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
            await runRefresh()
            schedule()
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            isCancelled = true
            if (timer) clearTimeout(timer)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [baseUrl, user])

    const login = useCallback(async () => {
        setIsLoading(true)
        setError(null)
        try {
            const redirectUri = `${window.location.origin}/auth/callback`
            const loginUrl = await keycloak.getLoginUrl(baseUrl, redirectUri)
            window.location.href = loginUrl
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to initiate login')
            setIsLoading(false)
        }
    }, [baseUrl])

    const logout = useCallback(async () => {
        setIsLoading(true)
        try {
            const redirectUri = window.location.origin
            const logoutUrl = await keycloak.getLogoutUrl(baseUrl, redirectUri)
            await keycloak.clearTokens()
            setUser(null)
            window.location.href = logoutUrl
        } catch (e) {
            // Even if getting logout URL fails, clear local tokens
            await keycloak.clearTokens()
            setUser(null)
            setIsLoading(false)
        }
    }, [baseUrl])

    const api = useMemo(() => {
        const token = keycloak.getAccessTokenSync()
        if (!token) return null

        return new ApiClient(token, {
            baseUrl,
            getToken: () => keycloak.getAccessTokenSync(),
            getClientId: () => getClientId(),
            onUnauthorized: async (): Promise<string | null> => {
                const newToken = await keycloak.ensureValidToken(baseUrl)
                if (!newToken) {
                    await keycloak.clearTokens()
                    setUser(null)
                    return null
                }
                return newToken
            },
        })
    }, [baseUrl, user]) // Recreate when user changes

    const value: AuthContextValue = {
        user,
        isAuthenticated: !!user && keycloak.isAuthenticatedSync(),
        // 如果存储还没初始化完成，继续显示loading状态
        isLoading: isLoading || !storageInitDone,
        error,
        api,
        login,
        logout,
    }

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext)
    if (!context) {
        throw new Error('useAuth must be used within a KeycloakAuthProvider')
    }
    return context
}

// Re-export for convenience
export { keycloak as keycloakService }
export type { KeycloakUser } from '@/services/keycloak'
