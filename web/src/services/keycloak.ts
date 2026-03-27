/**
 * Keycloak authentication service for yoho-remote web client
 * Handles OAuth2/OIDC login flow with token storage and refresh
 *
 * Uses IndexedDB for token storage to support Service Worker access in PWA mode
 */

export interface KeycloakUser {
    email: string
    name: string | null
    sub: string
}

export interface KeycloakAuthResponse {
    accessToken: string
    refreshToken: string
    expiresIn: number
    user: KeycloakUser
}

// Import IndexedDB token storage
import * as tokenStorage from './tokenStorage'

const {
    saveTokens: saveTokensToDB,
    clearTokens: clearTokensFromDB,
    getRefreshToken,
} = tokenStorage

/**
 * Get Keycloak login URL from backend
 */
export async function getLoginUrl(baseUrl: string, redirectUri: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/keycloak`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ redirectUri }),
    })

    if (!response.ok) {
        throw new Error('Failed to get login URL')
    }

    const data = await response.json()
    return data.loginUrl
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(
    baseUrl: string,
    code: string,
    redirectUri: string
): Promise<KeycloakAuthResponse> {
    const response = await fetch(`${baseUrl}/api/auth/keycloak/callback`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code, redirectUri }),
    })

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Token exchange failed' }))
        throw new Error(error.error || error.details || 'Token exchange failed')
    }

    return response.json()
}

/**
 * Refresh access token using refresh token
 */
export async function refreshToken(baseUrl: string): Promise<KeycloakAuthResponse | null> {
    const refreshTokenValue = await getRefreshToken()
    if (!refreshTokenValue) {
        return null
    }

    try {
        const response = await fetch(`${baseUrl}/api/auth/keycloak/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken: refreshTokenValue }),
        })

        if (!response.ok) {
            // Token refresh failed, clear tokens
            clearTokens()
            return null
        }

        const data: KeycloakAuthResponse = await response.json()
        await saveTokensToDB(data)
        return data
    } catch (error) {
        console.error('[Keycloak] Token refresh failed:', error)
        clearTokens()
        return null
    }
}

/**
 * Get logout URL from backend
 */
export async function getLogoutUrl(baseUrl: string, redirectUri: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/keycloak/logout`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ redirectUri }),
    })

    if (!response.ok) {
        throw new Error('Failed to get logout URL')
    }

    const data = await response.json()
    return data.logoutUrl
}

/**
 * Save tokens to IndexedDB
 */
export async function saveTokens(data: KeycloakAuthResponse): Promise<void> {
    return saveTokensToDB(data)
}

/**
 * Clear all tokens from IndexedDB
 */
export async function clearTokens(): Promise<void> {
    return clearTokensFromDB()
}

// Re-export all token storage functions
export {
    getAccessToken,
    getCurrentUser,
    getExpiresAt,
    isTokenExpired,
    isAuthenticated,
    getAccessTokenSync,
    getCurrentUserSync,
    getExpiresAtSync,
    isTokenExpiredSync,
    isAuthenticatedSync,
} from './tokenStorage'

/**
 * Ensure we have a valid token, refresh if needed
 */
export async function ensureValidToken(baseUrl: string): Promise<string | null> {
    const token = await tokenStorage.getAccessToken()
    if (!token) return null

    // If token is expired or will expire within 5 minutes, refresh it
    const expiresAt = await tokenStorage.getExpiresAt()
    if (expiresAt && Date.now() >= expiresAt - 5 * 60 * 1000) {
        const result = await refreshToken(baseUrl)
        if (result) {
            return result.accessToken
        }
        return null
    }

    return token
}
