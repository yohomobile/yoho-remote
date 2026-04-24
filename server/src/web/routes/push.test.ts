import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'

const fakeWebPush = {
    isConfigured: () => true,
    getVapidPublicKey: () => 'public-key',
    subscribe: mock(async (_orgId: string, _endpoint: string, _keys: { p256dh: string; auth: string }, _userAgent?: string, _clientId?: string) => ({
        id: 1,
        namespace: _orgId,
        endpoint: _endpoint,
        keys: _keys,
        clientId: _clientId ?? null,
        chatId: null,
        userAgent: _userAgent ?? null,
        createdAt: 1,
        updatedAt: 1,
    })),
    unsubscribe: mock(async () => true),
    getSubscriptions: mock(async () => [{
        id: 1,
        endpoint: 'https://push.example/sub-1',
        createdAt: 1,
    }]),
    sendToNamespace: mock(async () => ({
        success: 1,
        failed: 0,
        removed: 0,
    })),
    sendToSubscription: mock(async () => ({ success: true, shouldRemove: false })),
}

mock.module('../../services/webPush', () => ({
    getWebPushService: () => fakeWebPush,
}))

function createPushApp(options?: { role?: 'developer' | 'operator'; orgId?: string; orgRole?: 'member' | 'owner' | 'admin' }) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('namespace', 'default')
        if (options?.role) {
            c.set('role', options.role)
        }
        if (options?.orgId) {
            c.set('orgs', [{
                id: options.orgId,
                name: 'Org A',
                role: options.orgRole ?? 'member',
            }])
        }
        await next()
    })
    return app
}

describe('createPushRoutes', () => {
    it('subscribes within the requested org scope', async () => {
        fakeWebPush.subscribe.mockClear()
        const { createPushRoutes } = await import('./push')
        const app = createPushApp({
            role: 'developer',
            orgId: 'org-a',
            orgRole: 'member',
        })
        app.route('/api', createPushRoutes())

        const response = await app.request('/api/push/subscribe?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                endpoint: 'https://push.example/sub-1',
                keys: {
                    p256dh: 'p256dh-key',
                    auth: 'auth-key',
                },
                clientId: 'client-1',
            }),
        })

        expect(response.status).toBe(200)
        expect(fakeWebPush.subscribe).toHaveBeenCalledWith(
            'org-a',
            'https://push.example/sub-1',
            { p256dh: 'p256dh-key', auth: 'auth-key' },
            undefined,
            'client-1',
        )
    })

    it('rejects subscription inspection for non-managers', async () => {
        const { createPushRoutes } = await import('./push')
        const app = createPushApp({
            role: 'developer',
            orgId: 'org-a',
            orgRole: 'member',
        })
        app.route('/api', createPushRoutes())

        const response = await app.request('/api/push/subscriptions?orgId=org-a')

        expect(response.status).toBe(403)
    })

    it('sends test notifications only for org managers', async () => {
        fakeWebPush.sendToNamespace.mockClear()
        const { createPushRoutes } = await import('./push')
        const app = createPushApp({
            role: 'developer',
            orgId: 'org-a',
            orgRole: 'owner',
        })
        app.route('/api', createPushRoutes())

        const response = await app.request('/api/push/test?orgId=org-a', {
            method: 'POST',
        })

        expect(response.status).toBe(200)
        expect(fakeWebPush.sendToNamespace).toHaveBeenCalledWith(
            'org-a',
            expect.objectContaining({
                title: '🎉 Yoho Remote 测试通知',
            }),
        )
    })
})
