/**
 * Keycloak Admin API lookup for user linking.
 * Uses service account (yoho-admin-api) with client_credentials grant.
 */

export interface KeycloakUserInfo {
    keycloakId: string
    email: string
    firstName: string | null
    lastName: string | null
    username: string
    attributes: {
        nickname?: string
        jobTitle?: string
        locale?: string
        [key: string]: string | undefined
    }
}

const KC_TOKEN_URL = 'https://auth.yohomobile.dev/realms/master/protocol/openid-connect/token'
const KC_USERS_URL = 'https://auth.yohomobile.dev/admin/realms/yoho/users'
const KC_CLIENT_ID = 'yoho-admin-api'
const KC_CLIENT_SECRET = 'xm578yzsAunT8KgZKOKvsHLilcgqxmKU'

let tokenCache: { value: string; expiresAt: number } | null = null

async function getAdminToken(): Promise<string> {
    if (tokenCache && Date.now() < tokenCache.expiresAt) {
        return tokenCache.value
    }

    const resp = await fetch(KC_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: KC_CLIENT_ID,
            client_secret: KC_CLIENT_SECRET,
        }),
    })

    if (!resp.ok) throw new Error(`Keycloak token failed: ${resp.status}`)
    const data = await resp.json() as { access_token: string; expires_in: number }

    tokenCache = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    }
    return data.access_token
}

/**
 * Lookup a Keycloak user by email in the yoho realm.
 * Returns null if not found or Keycloak is unavailable (silent degradation).
 */
export async function lookupKeycloakUserByEmail(email: string): Promise<KeycloakUserInfo | null> {
    try {
        const token = await getAdminToken()
        const ctrl = new AbortController()
        const timeout = setTimeout(() => ctrl.abort(), 3_000)
        const resp = await fetch(`${KC_USERS_URL}?email=${encodeURIComponent(email)}&exact=true`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: ctrl.signal,
        }).finally(() => clearTimeout(timeout))

        if (!resp.ok) return null
        const users = await resp.json() as Array<{
            id: string
            username: string
            email: string
            firstName?: string
            lastName?: string
            attributes?: Record<string, string[]>
        }>

        if (users.length === 0) return null
        const u = users[0]

        const attrs: Record<string, string | undefined> = {}
        if (u.attributes) {
            for (const [key, val] of Object.entries(u.attributes)) {
                attrs[key] = Array.isArray(val) ? val[0] : val as string
            }
        }

        return {
            keycloakId: u.id,
            email: u.email,
            firstName: u.firstName || null,
            lastName: u.lastName || null,
            username: u.username,
            attributes: attrs as KeycloakUserInfo['attributes'],
        }
    } catch (err) {
        console.warn('[KeycloakLookup] Failed:', email, err)
        return null
    }
}
