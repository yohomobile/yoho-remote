import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from './auth'

mock.module('../keycloak', () => ({
    verifyKeycloakToken: async (token: string) => {
        if (token !== 'valid-token') {
            throw new Error('invalid token')
        }
        return {
            sub: 'keycloak-user-1',
            email: 'Dev@Example.com',
            email_verified: true,
            name: 'Dev User',
            exp: 1_900_000_000,
            iat: 1_700_000_000,
        }
    },
    extractUserFromToken: (payload: {
        sub: string
        email: string
        name?: string
    }) => ({
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        name: payload.name ?? null,
        role: 'developer',
    }),
}))

describe('createAuthMiddleware identity actor resolution', () => {
    it('resolves a Keycloak user into request identityActor', async () => {
        const observations: Array<Record<string, unknown>> = []
        const actor = {
            identityId: 'identity-1',
            personId: 'person-1',
            channel: 'keycloak',
            resolution: 'auto_verified',
            displayName: 'Dev User',
            email: 'dev@example.com',
            externalId: 'keycloak-user-1',
            accountType: 'human',
        }
        const store = {
            getOrganizationsForUser: async (email: string) => [{
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: email,
                createdAt: 1,
                updatedAt: 1,
                settings: {},
                myRole: 'owner',
            }],
            resolveActorByIdentityObservation: async (observation: Record<string, unknown>) => {
                observations.push(observation)
                return actor
            },
        }
        const { createAuthMiddleware } = await import('./auth')

        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(store as any))
        app.get('/api/private', (c) => c.json({
            userId: c.get('userId'),
            namespace: c.get('namespace'),
            email: c.get('email'),
            name: c.get('name'),
            role: c.get('role'),
            orgs: c.get('orgs'),
            actor: c.get('identityActor'),
        }))

        const response = await app.request('/api/private?orgId=org-a', {
            headers: {
                authorization: 'Bearer valid-token',
            },
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            userId: 'keycloak-user-1',
            namespace: 'default',
            email: 'dev@example.com',
            name: 'Dev User',
            role: 'developer',
            orgs: [{
                id: 'org-a',
                name: 'Org A',
                role: 'owner',
            }],
            actor,
        })
        expect(observations).toEqual([{
            namespace: 'default',
            orgId: 'org-a',
            channel: 'keycloak',
            externalId: 'keycloak-user-1',
            canonicalEmail: 'dev@example.com',
            displayName: 'Dev User',
            accountType: 'human',
            assurance: 'high',
        }])
    })
})
