import { describe, expect, it } from 'bun:test'
import { extractUserFromToken, extractUserRole, type KeycloakTokenPayload } from './keycloak'

describe('extractUserFromToken', () => {
    it('normalizes email casing', () => {
        const payload: KeycloakTokenPayload = {
            sub: 'user-1',
            email: ' User.Name@Example.COM ',
            email_verified: true,
            exp: 0,
            iat: 0,
        }

        expect(extractUserFromToken(payload).email).toBe('user.name@example.com')
    })

    it('treats realm operator as operator', () => {
        const payload: KeycloakTokenPayload = {
            sub: 'user-1',
            email: 'operator@example.com',
            email_verified: true,
            realm_access: {
                roles: ['operator'],
            },
            exp: 0,
            iat: 0,
        }

        expect(extractUserRole(payload)).toBe('operator')
    })

    it('treats yoho-remote client operator as operator', () => {
        const payload: KeycloakTokenPayload = {
            sub: 'user-1',
            email: 'operator@example.com',
            email_verified: true,
            resource_access: {
                'yoho-remote': {
                    roles: ['operator'],
                },
            },
            exp: 0,
            iat: 0,
        }

        expect(extractUserRole(payload)).toBe('operator')
    })

    it('treats realm-management realm-admin as operator', () => {
        const payload: KeycloakTokenPayload = {
            sub: 'user-1',
            email: 'admin@example.com',
            email_verified: true,
            resource_access: {
                'realm-management': {
                    roles: ['realm-admin'],
                },
            },
            exp: 0,
            iat: 0,
        }

        expect(extractUserRole(payload)).toBe('operator')
    })

    it('defaults to developer without elevated roles', () => {
        const payload: KeycloakTokenPayload = {
            sub: 'user-1',
            email: 'developer@example.com',
            email_verified: true,
            resource_access: {
                account: {
                    roles: ['manage-account'],
                },
            },
            exp: 0,
            iat: 0,
        }

        expect(extractUserRole(payload)).toBe('developer')
    })
})
