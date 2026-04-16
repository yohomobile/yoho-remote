/**
 * Keycloak integration for yoho-remote server
 * Handles SSO authentication via Keycloak OAuth2/OIDC
 */

import * as jose from 'jose';

// Keycloak configuration
export const KEYCLOAK_CONFIG = {
    url: process.env.KEYCLOAK_URL || 'https://auth.yohomobile.dev',
    // Internal URL for server-to-Keycloak communication (bypasses Cloudflare)
    internalUrl: process.env.KEYCLOAK_INTERNAL_URL || process.env.KEYCLOAK_URL || 'https://auth.yohomobile.dev',
    realm: process.env.KEYCLOAK_REALM || 'yoho',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'yoho-remote',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
};

function getRequiredClientSecret(): string {
    const secret = KEYCLOAK_CONFIG.clientSecret.trim();
    if (!secret) {
        throw new Error('KEYCLOAK_CLIENT_SECRET is required for Keycloak code exchange and refresh');
    }
    return secret;
}

// JWKS client for JWT signature verification
let jwksClient: jose.JWTVerifyGetKey | null = null;

function getJwksClient(): jose.JWTVerifyGetKey {
    if (!jwksClient) {
        const jwksUri = `${KEYCLOAK_CONFIG.internalUrl}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/certs`;
        jwksClient = jose.createRemoteJWKSet(new URL(jwksUri));
    }
    return jwksClient;
}

export interface KeycloakTokenPayload {
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    preferred_username?: string;
    given_name?: string;
    family_name?: string;
    azp?: string; // authorized party (client_id)
    realm_access?: {
        roles: string[];
    };
    resource_access?: {
        [clientId: string]: {
            roles: string[];
        };
    };
    exp: number;
    iat: number;
}

/**
 * Verify Keycloak JWT Token
 * Note: Keycloak access_token's aud may be ['realm-management', 'account'],
 * not the client_id. So we only verify issuer and manually check azp.
 */
export async function verifyKeycloakToken(token: string): Promise<KeycloakTokenPayload> {
    const jwks = getJwksClient();
    // Token is exchanged via public url, so issuer matches KEYCLOAK_URL
    // internalUrl is only used for JWKS key fetching (no session context needed)
    const issuer = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}`;

    const { payload } = await jose.jwtVerify(token, jwks, {
        issuer,
        // Don't verify audience since Keycloak access_token's aud may not include client_id
    });

    const typedPayload = payload as unknown as KeycloakTokenPayload;

    // Manually verify azp (authorized party) matches client_id
    if (typedPayload.azp && typedPayload.azp !== KEYCLOAK_CONFIG.clientId) {
        throw new Error(`Invalid azp claim: expected ${KEYCLOAK_CONFIG.clientId}, got ${typedPayload.azp}`);
    }

    return typedPayload;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<{
    access_token: string;
    refresh_token: string;
    id_token: string;
    expires_in: number;
    token_type: string;
}> {
    // Use public url for code exchange — the authorization code was issued under the public domain's session,
    // so it must be exchanged at the same domain. Using internalUrl would fail with "Code not valid".
    const tokenUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/token`;

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: KEYCLOAK_CONFIG.clientId,
            client_secret: getRequiredClientSecret(),
            code,
            redirect_uri: redirectUri,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to exchange code for token: ${error}`);
    }

    return response.json() as Promise<{
        access_token: string;
        refresh_token: string;
        id_token: string;
        expires_in: number;
        token_type: string;
    }>;
}

/**
 * Refresh token
 */
export async function refreshKeycloakToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
}> {
    // Use public url — refresh token was issued under the public domain's session
    const tokenUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/token`;

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: KEYCLOAK_CONFIG.clientId,
            client_secret: getRequiredClientSecret(),
            refresh_token: refreshToken,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to refresh token: ${error}`);
    }

    return response.json() as Promise<{
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
    }>;
}

/**
 * Get Keycloak login URL
 */
export function getKeycloakLoginUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
        client_id: KEYCLOAK_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid profile email',
    });

    if (state) {
        params.append('state', state);
    }

    return `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/auth?${params}`;
}

/**
 * Get Keycloak logout URL
 */
export function getKeycloakLogoutUrl(redirectUri: string): string {
    const params = new URLSearchParams({
        client_id: KEYCLOAK_CONFIG.clientId,
        post_logout_redirect_uri: redirectUri,
    });

    return `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/logout?${params}`;
}

/**
 * Extract user role from token payload
 * Checks realm_access.roles and resource_access[clientId].roles for 'operator' role
 * Defaults to 'developer' if no operator role found
 */
export function extractUserRole(payload: KeycloakTokenPayload): 'developer' | 'operator' {
    // Check realm-level roles
    const realmRoles = payload.realm_access?.roles ?? [];
    if (realmRoles.includes('operator')) {
        return 'operator';
    }

    // Check client-specific roles
    const clientRoles = payload.resource_access?.[KEYCLOAK_CONFIG.clientId]?.roles ?? [];
    if (clientRoles.includes('operator')) {
        return 'operator';
    }

    // Default to developer
    return 'developer';
}

/**
 * Extract user info from token payload
 */
export function extractUserFromToken(payload: KeycloakTokenPayload): {
    email: string;
    name: string | null;
    sub: string;
    role: 'developer' | 'operator';
} {
    return {
        email: payload.email.trim().toLowerCase(),
        name: payload.name || payload.preferred_username || null,
        sub: payload.sub,
        role: extractUserRole(payload),
    };
}
