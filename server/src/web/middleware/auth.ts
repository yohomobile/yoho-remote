import type { MiddlewareHandler } from 'hono'
import { verifyKeycloakToken, extractUserFromToken } from '../keycloak'
import type { UserRole, OrgRole, IStore, ResolvedActorContext } from '../../store'

export type UserOrgInfo = {
    id: string
    name: string
    role: OrgRole
}

export type WebAppEnv = {
    Variables: {
        userId: string  // Keycloak sub (UUID)
        namespace: string
        email?: string
        name?: string
        role: UserRole  // Role from Keycloak token (developer or operator)
        clientId?: string  // Client identifier for SSE connections
        deviceType?: string  // Device type for SSE connections
        orgs: UserOrgInfo[]  // User's organizations with roles
        identityActor?: ResolvedActorContext
    }
}

// Paths that don't require authentication
const publicPaths = [
    '/api/auth/keycloak',
    '/api/auth/keycloak/callback',
    '/api/auth/keycloak/refresh',
    '/api/auth/keycloak/logout',
]

export function createAuthMiddleware(store: IStore): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path

        // Skip auth for public paths
        if (publicPaths.some(p => path.startsWith(p))) {
            await next()
            return
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        // Support token in URL query for SSE and direct file access
        const allowTokenInQuery = path === '/api/events' || path.includes('/file') || path.includes('/server-uploads/') || path.includes('/server-downloads/')
        const tokenFromQuery = allowTokenInQuery ? c.req.query().token : undefined
        const token = tokenFromHeader ?? tokenFromQuery
        const clientIdHeader = c.req.header('x-client-id')?.trim()

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        try {
            // Verify Keycloak JWT token
            const payload = await verifyKeycloakToken(token)
            const user = extractUserFromToken(payload)

            c.set('userId', user.sub)
            c.set('namespace', 'default')  // All Keycloak users share the same namespace
            c.set('email', user.email)
            c.set('name', user.name ?? undefined)
            c.set('role', user.role)  // Set role from Keycloak token
            if (clientIdHeader) {
                c.set('clientId', clientIdHeader)
            }

            // Load user's organizations (single query with JOIN)
            const userOrgs = await store.getOrganizationsForUser(user.email)
            const orgsWithRoles: UserOrgInfo[] = userOrgs.map((org) => ({
                id: org.id,
                name: org.name,
                role: org.myRole,
            }))
            c.set('orgs', orgsWithRoles)

            if (typeof store.resolveActorByIdentityObservation === 'function') {
                try {
                    const requestedOrgId = c.req.query('orgId') || null
                    const identityOrgId = requestedOrgId && orgsWithRoles.some((org) => org.id === requestedOrgId)
                        ? requestedOrgId
                        : null
                    const actor = await store.resolveActorByIdentityObservation({
                        namespace: 'default',
                        orgId: identityOrgId,
                        channel: 'keycloak',
                        externalId: user.sub,
                        canonicalEmail: user.email,
                        displayName: user.name ?? user.email,
                        accountType: 'human',
                        assurance: 'high',
                    })
                    c.set('identityActor', actor)
                } catch (error) {
                    console.warn('[Auth] Identity graph resolution failed:', error)
                }
            }

            await next()
            return
        } catch (error) {
            console.error('[Auth] Token verification failed:', error)
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}
