import { describe, expect, it } from 'bun:test'
import { extractUserFromToken, type KeycloakTokenPayload } from './keycloak'

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
})
