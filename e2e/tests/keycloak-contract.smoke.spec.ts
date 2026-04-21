import { createRemoteJWKSet, jwtVerify } from 'jose'
import { expect, test } from '../src/fixtures'

test.describe('P0 fake Keycloak contract smoke', () => {
    test('exposes JWKS and signs tokens with the server-compatible issuer and azp', async ({ api, e2eEnv }) => {
        const loginResponse = await api.post('/api/auth/keycloak', {
            data: { redirectUri: `${e2eEnv.webBaseUrl}/auth/callback` },
        })
        expect(loginResponse.ok()).toBeTruthy()
        const loginBody = await loginResponse.json() as { loginUrl: string }
        expect(loginBody.loginUrl).toContain(`/realms/${e2eEnv.keycloakRealm}/protocol/openid-connect/auth`)

        const authResponse = await api.get(loginBody.loginUrl, { maxRedirects: 0 })
        expect(authResponse.status()).toBe(302)
        const location = authResponse.headers().location
        expect(location).toBeTruthy()
        const code = new URL(location!).searchParams.get('code')
        expect(code).toBeTruthy()

        const callbackResponse = await api.post('/api/auth/keycloak/callback', {
            data: { code, redirectUri: `${e2eEnv.webBaseUrl}/auth/callback` },
        })
        expect(callbackResponse.ok()).toBeTruthy()
        const callbackBody = await callbackResponse.json() as { accessToken: string; user: { email: string } }
        expect(callbackBody.user.email).toBe('e2e.operator@example.com')

        const jwks = createRemoteJWKSet(new URL(`${e2eEnv.mockApiUrl}/realms/${e2eEnv.keycloakRealm}/protocol/openid-connect/certs`))
        const { payload } = await jwtVerify(callbackBody.accessToken, jwks, {
            issuer: `${e2eEnv.mockApiUrl}/realms/${e2eEnv.keycloakRealm}`,
        })
        expect(payload.azp).toBe(e2eEnv.keycloakClientId)
        expect(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).toContain(e2eEnv.keycloakClientId)
        expect(payload.email).toBe('e2e.operator@example.com')
    })
})
