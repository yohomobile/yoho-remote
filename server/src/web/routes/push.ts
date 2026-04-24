/**
 * Push Notification Routes
 *
 * Handles Web Push subscription management and VAPID key retrieval.
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { getWebPushService } from '../../services/webPush'

const subscribeSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1)
    }),
    clientId: z.string().optional()
})

const unsubscribeSchema = z.object({
    endpoint: z.string().url()
})

function normalizeRequestedOrgId(raw: string | undefined): string | null {
    const trimmed = raw?.trim()
    return trimmed ? trimmed : null
}

function canManageOrg(role: 'owner' | 'admin' | 'member' | null): boolean {
    return role === 'owner' || role === 'admin'
}

function requirePushOrgAccess(c: Context<WebAppEnv>): { orgId: string; orgRole: 'owner' | 'admin' | 'member' | null } | Response {
    const orgId = normalizeRequestedOrgId(c.req.query('orgId'))
    if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400)
    }

    const userRole = c.get('role')
    if (!userRole) {
        return c.json({ error: 'Unauthorized' }, 401)
    }
    if (userRole === 'operator') {
        return { orgId, orgRole: 'owner' }
    }

    const orgs = c.get('orgs') || []
    const membership = orgs.find((org: { id: string; role: 'owner' | 'admin' | 'member' }) => org.id === orgId)
    if (!membership) {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }

    return { orgId, orgRole: membership.role }
}

export function createPushRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Get VAPID public key (needed by clients to subscribe)
    app.get('/push/vapid-public-key', (c) => {
        const webPush = getWebPushService()
        if (!webPush || !webPush.isConfigured()) {
            return c.json({ error: 'Push notifications not configured' }, 503)
        }

        const publicKey = webPush.getVapidPublicKey()
        return c.json({ publicKey })
    })

    // Subscribe to push notifications
    app.post('/push/subscribe', async (c) => {
        const webPush = getWebPushService()
        if (!webPush || !webPush.isConfigured()) {
            return c.json({ error: 'Push notifications not configured' }, 503)
        }

        const access = requirePushOrgAccess(c)
        if (access instanceof Response) {
            return access
        }

        const json = await c.req.json().catch(() => null)
        const parsed = subscribeSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid subscription data', details: parsed.error.issues }, 400)
        }

        const userAgent = c.req.header('user-agent')
        const clientId = parsed.data.clientId

        // keys 为空会导致崩溃，提前校验
        if (!parsed.data.keys?.p256dh || !parsed.data.keys?.auth) {
            return c.json({ error: 'Invalid subscription keys' }, 400)
        }

        const subscription = await webPush.subscribe(
            access.orgId,
            parsed.data.endpoint,
            parsed.data.keys,
            userAgent,
            clientId
        ).catch((err) => {
            console.error('[push] failed to save subscription:', err)
            return null
        })

        if (!subscription) {
            return c.json({ error: 'Failed to save subscription' }, 500)
        }

        console.log('[push] new subscription:', {
            orgId: access.orgId,
            endpoint: parsed.data.endpoint.slice(0, 60) + '...'
        })

        // 订阅成功后立即发送测试通知
        webPush.sendToSubscription(subscription, {
            title: '🎉 订阅成功',
            body: '推送通知已启用，任务完成时你将收到通知',
            icon: '/pwa-192x192.png',
            badge: '/pwa-64x64.png',
            tag: 'subscription-success',
            data: {
                type: 'subscription-success',
                timestamp: Date.now()
            }
        }).then(result => {
            console.log('[push] welcome notification sent:', result)
        }).catch(err => {
            console.error('[push] welcome notification failed:', err)
        })

        return c.json({ ok: true, subscriptionId: subscription.id })
    })

    // Unsubscribe from push notifications
    app.post('/push/unsubscribe', async (c) => {
        const webPush = getWebPushService()
        if (!webPush) {
            return c.json({ error: 'Push notifications not configured' }, 503)
        }

        const access = requirePushOrgAccess(c)
        if (access instanceof Response) {
            return access
        }

        const json = await c.req.json().catch(() => null)
        const parsed = unsubscribeSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid endpoint' }, 400)
        }

        const success = await webPush.unsubscribe(access.orgId, parsed.data.endpoint)

        console.log('[push] unsubscribe:', {
            orgId: access.orgId,
            endpoint: parsed.data.endpoint.slice(0, 60) + '...',
            success
        })

        return c.json({ ok: true, removed: success })
    })

    // Get subscription count (for debugging/admin)
    app.get('/push/subscriptions', async (c) => {
        const webPush = getWebPushService()
        if (!webPush) {
            return c.json({ error: 'Push notifications not configured' }, 503)
        }

        const access = requirePushOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        if (!canManageOrg(access.orgRole)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const subscriptions = await webPush.getSubscriptions(access.orgId)

        return c.json({
            count: subscriptions.length,
            subscriptions: subscriptions.map(s => ({
                id: s.id,
                endpoint: s.endpoint.slice(0, 60) + '...',
                createdAt: s.createdAt
            }))
        })
    })

    // Send test notification to all subscriptions in namespace
    app.post('/push/test', async (c) => {
        const webPush = getWebPushService()
        if (!webPush || !webPush.isConfigured()) {
            return c.json({ error: 'Push notifications not configured' }, 503)
        }

        const access = requirePushOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        if (!canManageOrg(access.orgRole)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const result = await webPush.sendToNamespace(access.orgId, {
            title: '🎉 Yoho Remote 测试通知',
            body: '如果你看到这条通知，说明 Web Push 功能正常工作！',
            tag: 'test-notification',
            data: {
                type: 'test',
                timestamp: Date.now()
            }
        })

        console.log('[push] test notification sent:', result)

        return c.json({
            ok: true,
            sent: result.success,
            failed: result.failed,
            removed: result.removed
        })
    })

    return app
}
