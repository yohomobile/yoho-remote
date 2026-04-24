/**
 * Keycloak authentication hook for yoho-remote web client
 * Replaces the legacy useAuth + useAuthSource hooks with SSO-based authentication
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '@/api/client'
import * as keycloak from '@/services/keycloak'
import { isStorageInitialized } from '@/services/tokenStorage'
import type { KeycloakUser } from '@/services/keycloak'

export interface UseKeycloakAuthResult {
    /** Keycloak access token for API calls */
    token: string | null
    /** Current authenticated user */
    user: KeycloakUser | null
    /** Pre-configured API client with token */
    api: ApiClient | null
    /** Whether authentication is being verified */
    isLoading: boolean
    /** Whether user is authenticated */
    isAuthenticated: boolean
    /** Error message if auth failed */
    error: string | null
    /** Logout and redirect to Keycloak logout */
    logout: () => void
}

export function useKeycloakAuth(baseUrl: string): UseKeycloakAuthResult {
    const [token, setToken] = useState<string | null>(() => keycloak.getAccessTokenSync())
    const [user, setUser] = useState<KeycloakUser | null>(() => keycloak.getCurrentUserSync())
    const [isLoading, setIsLoading] = useState<boolean>(true)
    const [error, setError] = useState<string | null>(null)
    const [storageInitDone, setStorageInitDone] = useState(false)
    const tokenRef = useRef<string | null>(token)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)

    tokenRef.current = token

    // Initial authentication check (async to load from IndexedDB)
    useEffect(() => {
        let isCancelled = false

        const checkAuth = async () => {
            // First use sync values for immediate UI
            const syncToken = keycloak.getAccessTokenSync()
            const syncUser = keycloak.getCurrentUserSync()
            const syncIsAuth = keycloak.isAuthenticatedSync()

            if (syncIsAuth) {
                setToken(syncToken)
                setUser(syncUser)
                setError(null)
            } else {
                setToken(null)
                setUser(null)
            }

            // Then async load from IndexedDB to ensure fresh data
            try {
                const [asyncToken, asyncUser, asyncIsAuth] = await Promise.all([
                    keycloak.getAccessToken(),
                    keycloak.getCurrentUser(),
                    keycloak.isAuthenticated(),
                ])

                if (!isCancelled) {
                    if (asyncIsAuth && asyncToken) {
                        setToken(asyncToken)
                        setUser(asyncUser)
                        setError(null)
                    } else {
                        setToken(null)
                        setUser(null)
                    }
                    setStorageInitDone(true)
                    setIsLoading(false)
                }
            } catch (err) {
                console.error('[Keycloak] Failed to load auth state:', err)
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
    }, [])

    // Refresh token handler
    const refreshAuth = useCallback(async (): Promise<string | null> => {
        // Deduplicate concurrent refresh calls
        if (refreshPromiseRef.current) {
            return refreshPromiseRef.current
        }

        const run = async (): Promise<string | null> => {
            try {
                const result = await keycloak.refreshToken(baseUrl)
                if (result) {
                    tokenRef.current = result.accessToken
                    setToken(result.accessToken)
                    setUser(result.user)
                    setError(null)
                    return result.accessToken
                }
                // Refresh failed - user needs to login again
                setToken(null)
                setUser(null)
                return null
            } catch (e) {
                console.error('[Keycloak] Token refresh failed:', e)
                setToken(null)
                setUser(null)
                return null
            }
        }

        const promise = run()
        refreshPromiseRef.current = promise

        try {
            return await promise
        } finally {
            if (refreshPromiseRef.current === promise) {
                refreshPromiseRef.current = null
            }
        }
    }, [baseUrl])

    // Sync local token state with whatever is currently in tokenStorage.
    //
    // The Provider (KeycloakAuthProvider) owns proactive refresh scheduling;
    // we deliberately do NOT schedule refreshes here. Instead we watch the
    // sync cache via visibilitychange/focus and pull the latest access token
    // if it has changed underneath us. The `onUnauthorized` path still handles
    // 401 recovery at request time.
    useEffect(() => {
        if (!token) return

        const syncFromCache = () => {
            const latest = keycloak.getAccessTokenSync()
            if (latest && latest !== tokenRef.current) {
                tokenRef.current = latest
                setToken(latest)
                setUser(keycloak.getCurrentUserSync())
            }
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return
            syncFromCache()
        }
        const handleFocus = () => syncFromCache()

        window.addEventListener('focus', handleFocus)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleFocus)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [token])

    // Create API client with auto-refresh capability
    const api = useMemo(() => {
        if (!token) return null

        return new ApiClient(token, {
            baseUrl,
            getToken: () => tokenRef.current,
            onUnauthorized: async () => {
                const newToken = await refreshAuth()
                return newToken
            },
        })
    }, [token, baseUrl, refreshAuth])

    // Logout handler
    const logout = useCallback(async () => {
        await keycloak.clearTokens()
        setToken(null)
        setUser(null)
        setError(null)
        // Navigate to login page - the App component will handle the redirect
    }, [])

    return {
        token,
        user,
        api,
        // 如果存储还没初始化完成，继续显示loading状态
        isLoading: isLoading || !storageInitDone,
        isAuthenticated: Boolean(token && user),
        error,
        logout,
    }
}
