import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { getPlatform } from './usePlatform'
import { getClientId } from '@/lib/client-identity'
import type { ApiClient } from '@/api/client'

const NOTIFICATION_PERMISSION_KEY = 'yr-notification-enabled'
const PENDING_NOTIFICATION_KEY = 'yr-pending-notification'
const PUSH_SUBSCRIPTION_KEY = 'yr-push-subscription-endpoint'

export type PendingNotification = {
    sessionId: string
    timestamp: number
}

export function getPendingNotification(): PendingNotification | null {
    try {
        const raw = localStorage.getItem(PENDING_NOTIFICATION_KEY)
        if (!raw) return null
        const pending = JSON.parse(raw) as PendingNotification
        // 5分钟内有效
        if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
            localStorage.removeItem(PENDING_NOTIFICATION_KEY)
            return null
        }
        return pending
    } catch {
        return null
    }
}

export function clearPendingNotification(): void {
    try {
        localStorage.removeItem(PENDING_NOTIFICATION_KEY)
    } catch {
        // ignore
    }
}

function setPendingNotification(sessionId: string): void {
    try {
        localStorage.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify({
            sessionId,
            timestamp: Date.now()
        }))
    } catch {
        // ignore
    }
}

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

function getStoredPreference(): boolean {
    try {
        return localStorage.getItem(NOTIFICATION_PERMISSION_KEY) === 'true'
    } catch {
        return false
    }
}

function hasStoredPreference(): boolean {
    try {
        return localStorage.getItem(NOTIFICATION_PERMISSION_KEY) !== null
    } catch {
        return false
    }
}

function setStoredPreference(enabled: boolean): void {
    try {
        localStorage.setItem(NOTIFICATION_PERMISSION_KEY, String(enabled))
    } catch {
        // Ignore storage errors
    }
}

export function useNotificationPermission() {
    const [permission, setPermission] = useState<NotificationPermissionState>(() => {
        if (typeof window === 'undefined' || !('Notification' in window)) {
            return 'unsupported'
        }
        return Notification.permission as NotificationPermissionState
    })
    const [enabled, setEnabled] = useState(() => getStoredPreference())

    useEffect(() => {
        if (permission !== 'granted') return
        if (hasStoredPreference()) return
        setEnabled(true)
        setStoredPreference(true)
    }, [permission])

    const requestPermission = useCallback(async () => {
        if (!('Notification' in window)) {
            return 'unsupported' as const
        }

        try {
            const result = await Notification.requestPermission()
            setPermission(result as NotificationPermissionState)
            if (result === 'granted') {
                setEnabled(true)
                setStoredPreference(true)
            }
            return result as NotificationPermissionState
        } catch {
            return 'denied' as const
        }
    }, [])

    const toggleEnabled = useCallback((value: boolean) => {
        setEnabled(value)
        setStoredPreference(value)
    }, [])

    return {
        permission,
        enabled,
        setEnabled: toggleEnabled,
        requestPermission,
        isSupported: permission !== 'unsupported',
    }
}

export type TaskCompleteNotification = {
    sessionId: string
    title: string
    project?: string
    onClick?: () => void
}

/**
 * 显示任务完成通知
 * - App 在前台时：显示 Toast 卡片
 * - App 在后台时：显示系统推送通知
 */
export function notifyTaskComplete(notification: TaskCompleteNotification): void {
    const { sessionId, title, project, onClick } = notification
    const platform = getPlatform()
    const isVisible = document.visibilityState === 'visible'
    const isEnabled = getStoredPreference()
    const hasNotificationAPI = 'Notification' in window
    const notificationPermission = hasNotificationAPI ? Notification.permission : 'unsupported'

    console.log('[notification] notifyTaskComplete', {
        isVisible,
        isEnabled,
        hasNotificationAPI,
        notificationPermission,
        sessionId
    })

    if (isVisible) {
        // App 在前台 - 显示 Toast（始终显示，不受 enabled 开关控制）
        platform.haptic.notification('success')
        const toastId = `task-complete-${sessionId}`
        toast.custom(
            (t) => createElement(
                'div',
                {
                    onClick: () => {
                        toast.dismiss(t.id)
                        onClick?.()
                    },
                    style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px',
                        background: 'var(--app-bg)',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                        borderRadius: '12px',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                        cursor: 'pointer',
                        maxWidth: '350px',
                        width: '100%',
                    }
                },
                // 成功图标
                createElement(
                    'div',
                    {
                        style: {
                            width: '20px',
                            height: '20px',
                            borderRadius: '50%',
                            background: '#10b981',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                        }
                    },
                    createElement(
                        'svg',
                        {
                            width: '12',
                            height: '12',
                            viewBox: '0 0 12 12',
                            fill: 'none',
                            style: { color: 'white' }
                        },
                        createElement('path', {
                            d: 'M10 3L4.5 8.5L2 6',
                            stroke: 'currentColor',
                            strokeWidth: '2',
                            strokeLinecap: 'round',
                            strokeLinejoin: 'round'
                        })
                    )
                ),
                // 内容
                createElement(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    createElement(
                        'div',
                        {
                            style: {
                                fontSize: '14px',
                                fontWeight: 500,
                                color: 'var(--app-fg)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }
                        },
                        project || 'Task completed'
                    ),
                    createElement(
                        'div',
                        {
                            style: {
                                fontSize: '12px',
                                color: 'var(--app-hint)',
                                marginTop: '2px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }
                        },
                        title
                    )
                )
            ),
            { id: toastId, duration: 4000 }
        )
    } else if (isEnabled && hasNotificationAPI && notificationPermission === 'granted') {
        // App 在后台 - 显示系统通知
        const notifTitle = project ? `${project} Session completed` : 'Session completed'
        const options: NotificationOptions & { renotify?: boolean } = {
            body: title,
            icon: '/pwa-192x192.png',
            badge: '/pwa-64x64.png',
            tag: `task-complete-${sessionId}`,
            renotify: true,
            data: { sessionId }
        }
        console.log('[notification] creating system notification', { notifTitle, options })
        void (async () => {
            try {
                // 存储待跳转信息，用于 iOS PWA 点击通知后恢复 app 时自动跳转
                setPendingNotification(sessionId)

                if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
                    let registration = await navigator.serviceWorker.getRegistration()
                    if (!registration) {
                        try {
                            registration = await Promise.race([
                                navigator.serviceWorker.ready,
                                new Promise<ServiceWorkerRegistration | undefined>((resolve) => {
                                    setTimeout(() => resolve(undefined), 2000)
                                })
                            ]) as ServiceWorkerRegistration | undefined
                        } catch {
                            registration = undefined
                        }
                    }
                    if (registration?.showNotification) {
                        await registration.showNotification(notifTitle, options)
                        console.log('[notification] service worker notification created')
                        return
                    }
                }

                const notif = new Notification(notifTitle, options)
                console.log('[notification] system notification created', notif)

                notif.onclick = () => {
                    console.log('[notification] system notification clicked')
                    clearPendingNotification()
                    window.focus()
                    onClick?.()
                    notif.close()
                }
            } catch (error) {
                console.error('[notification] failed to create notification', error)
            }
        })()
    }
}

/**
 * Hook 版本，自动获取当前路由导航能力
 */
export function useTaskCompleteNotification() {
    const notify = useCallback((notification: TaskCompleteNotification) => {
        notifyTaskComplete(notification)
    }, [])

    return { notify }
}

// ==================== Web Push 订阅 ====================

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/')

    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return window.btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

function getStoredPushEndpoint(): string | null {
    try {
        return localStorage.getItem(PUSH_SUBSCRIPTION_KEY)
    } catch {
        return null
    }
}

function setStoredPushEndpoint(endpoint: string | null): void {
    try {
        if (endpoint) {
            localStorage.setItem(PUSH_SUBSCRIPTION_KEY, endpoint)
        } else {
            localStorage.removeItem(PUSH_SUBSCRIPTION_KEY)
        }
    } catch {
        // ignore
    }
}

export type PushSubscriptionState = 'unsupported' | 'not-subscribed' | 'subscribed' | 'error'

/**
 * Hook for managing Web Push subscriptions
 * This enables true background push notifications on iOS (16.4+) and other platforms
 */
export function useWebPushSubscription(apiClient: ApiClient | null) {
    const [state, setState] = useState<PushSubscriptionState>('unsupported')
    const [isSubscribing, setIsSubscribing] = useState(false)
    const subscribeAttemptedRef = useRef(false)

    // Check initial state
    useEffect(() => {
        if (!apiClient) return
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            setState('unsupported')
            return
        }

        const checkSubscription = async () => {
            try {
                const registration = await navigator.serviceWorker.ready
                const subscription = await registration.pushManager.getSubscription()
                setState(subscription ? 'subscribed' : 'not-subscribed')
            } catch {
                setState('error')
            }
        }

        void checkSubscription()
    }, [apiClient])

    // Auto-subscribe when permission is granted
    useEffect(() => {
        if (!apiClient) return
        if (state !== 'not-subscribed') return
        if (subscribeAttemptedRef.current) return
        if (Notification.permission !== 'granted') return
        if (!getStoredPreference()) return

        subscribeAttemptedRef.current = true
        void subscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiClient, state])

    const subscribe = useCallback(async (): Promise<boolean> => {
        if (!apiClient) return false
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.log('[webpush] not supported')
            return false
        }

        setIsSubscribing(true)
        try {
            // Get VAPID public key from server
            const { publicKey } = await apiClient.getPushVapidPublicKey()
            if (!publicKey) {
                console.log('[webpush] server has no VAPID key configured')
                setState('not-subscribed')
                return false
            }

            // Get or wait for service worker
            const registration = await navigator.serviceWorker.ready

            // Check existing subscription
            let subscription = await registration.pushManager.getSubscription()

            // If no subscription, create one
            if (!subscription) {
                console.log('[webpush] creating new subscription...')
                const applicationServerKey = urlBase64ToUint8Array(publicKey)
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: applicationServerKey.buffer as ArrayBuffer
                })
            }

            // Send subscription to server
            const p256dh = subscription.getKey('p256dh')
            const auth = subscription.getKey('auth')

            if (!p256dh || !auth) {
                console.error('[webpush] subscription missing keys')
                setState('error')
                return false
            }

            const result = await apiClient.subscribePush({
                endpoint: subscription.endpoint,
                keys: {
                    p256dh: arrayBufferToBase64(p256dh),
                    auth: arrayBufferToBase64(auth)
                },
                clientId: getClientId()
            })

            if (result.ok) {
                console.log('[webpush] subscribed successfully', result.subscriptionId)
                setStoredPushEndpoint(subscription.endpoint)
                setState('subscribed')
                return true
            } else {
                console.error('[webpush] server rejected subscription')
                setState('error')
                return false
            }
        } catch (error) {
            // Only log for unexpected errors, not abort errors which are common when push service is unavailable
            if (error instanceof Error && error.name === 'AbortError') {
                console.log('[webpush] subscription aborted (push service unavailable)')
            } else {
                console.warn('[webpush] subscription failed:', error)
            }
            setState('error')
            return false
        } finally {
            setIsSubscribing(false)
        }
    }, [apiClient])

    const unsubscribe = useCallback(async (): Promise<boolean> => {
        if (!apiClient) return false
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            return false
        }

        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()

            if (subscription) {
                // Unsubscribe locally
                await subscription.unsubscribe()

                // Notify server
                await apiClient.unsubscribePush(subscription.endpoint)
            }

            setStoredPushEndpoint(null)
            setState('not-subscribed')
            console.log('[webpush] unsubscribed')
            return true
        } catch (error) {
            console.error('[webpush] unsubscribe failed:', error)
            return false
        }
    }, [apiClient])

    return {
        state,
        isSubscribed: state === 'subscribed',
        isSupported: state !== 'unsupported',
        isSubscribing,
        subscribe,
        unsubscribe
    }
}
