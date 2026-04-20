import { describe, it, expect } from 'bun:test'
import { Hono } from 'hono'
import { internalAuthMiddleware } from '../middleware/internal-auth'

function makeApp(expectedToken: string) {
    const app = new Hono()
    app.use('*', internalAuthMiddleware(expectedToken))
    app.all('/test', (c) => c.json({ ok: true }))
    return app
}

describe('internalAuthMiddleware', () => {
    it('rejects request with no X-Worker-Token header → 401', async () => {
        const app = makeApp('secret-token')
        const res = await app.request('/test', { method: 'POST' })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'unauthorized' })
    })

    it('rejects request with wrong token → 401', async () => {
        const app = makeApp('secret-token')
        const res = await app.request('/test', {
            method: 'POST',
            headers: { 'X-Worker-Token': 'wrong-token' },
        })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'unauthorized' })
    })

    it('allows request with correct token → next()', async () => {
        const app = makeApp('secret-token')
        const res = await app.request('/test', {
            method: 'POST',
            headers: { 'X-Worker-Token': 'secret-token' },
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
    })

    it('is case-sensitive: different casing is rejected (timingSafeEqual is byte-level)', async () => {
        const app = makeApp('Secret-Token')
        const res = await app.request('/test', {
            method: 'POST',
            headers: { 'X-Worker-Token': 'secret-token' },
        })
        expect(res.status).toBe(401)
    })

    it('rejects all requests when expectedToken is empty string (default-deny)', async () => {
        const app = makeApp('')
        const resWithToken = await app.request('/test', {
            method: 'POST',
            headers: { 'X-Worker-Token': 'anything' },
        })
        expect(resWithToken.status).toBe(401)

        const resNoToken = await app.request('/test', { method: 'POST' })
        expect(resNoToken.status).toBe(401)
    })
})
