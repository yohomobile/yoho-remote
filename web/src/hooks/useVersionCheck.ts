import { useEffect, useState, useCallback, useRef } from 'react'

const CACHED_VERSION_KEY = 'yr-cached-version'

/**
 * 共享的应用刷新函数
 * 用于版本更新后的页面刷新
 * 使用暴力刷新：清除 Service Worker 和所有缓存
 */
export async function refreshApp(): Promise<void> {
    try {
        // 清除所有 Service Worker
        const registrations = await navigator.serviceWorker?.getRegistrations()
        if (registrations) {
            for (const registration of registrations) {
                await registration.unregister()
            }
        }

        // 清除所有缓存
        const cacheNames = await caches?.keys()
        if (cacheNames) {
            for (const cacheName of cacheNames) {
                await caches.delete(cacheName)
            }
        }
    } catch (error) {
        console.error('Force refresh failed:', error)
    }

    // 确保页面一定会刷新
    window.location.reload()
}

// Get the current version from the build-time injected JS bundle filename
function getCurrentVersion(): string {
    // Look for the index-*.js script tag
    const scripts = document.querySelectorAll('script[src*="index-"]')
    for (const script of scripts) {
        const src = script.getAttribute('src')
        if (src) {
            const match = src.match(/index-([^.]+)\.js/)
            if (match) {
                return match[1]
            }
        }
    }
    return 'unknown'
}

interface UseVersionCheckOptions {
    baseUrl: string
    enabled?: boolean
    checkInterval?: number // in ms, default 5 minutes
}

interface UseVersionCheckResult {
    hasUpdate: boolean
    currentVersion: string
    serverVersion: string | null
    refresh: () => void
    dismiss: () => void
}

/**
 * 版本检查 hook
 * 只负责检测新版本并显示提示，不会自动刷新页面
 * 用户需要手动点击刷新按钮来更新
 */
export function useVersionCheck(options: UseVersionCheckOptions): UseVersionCheckResult {
    const { baseUrl, enabled = true, checkInterval = 5 * 60 * 1000 } = options  // 默认 5 分钟

    const [currentVersion] = useState(() => getCurrentVersion())
    const [serverVersion, setServerVersion] = useState<string | null>(null)
    const [dismissed, setDismissed] = useState(false)
    const initialCheckDone = useRef(false)

    const checkVersion = useCallback(async () => {
        try {
            const response = await fetch(`${baseUrl}/api/version`, {
                cache: 'no-store'
            })
            if (response.ok) {
                const data = await response.json()
                if (data.version) {
                    setServerVersion(data.version)
                    localStorage.setItem(CACHED_VERSION_KEY, data.version)
                }
            }
        } catch {
            // Silently ignore version check failures
        }
    }, [baseUrl])

    useEffect(() => {
        if (!enabled) return

        // Initial check with delay
        const initialTimeout = setTimeout(() => {
            if (!initialCheckDone.current) {
                initialCheckDone.current = true
                checkVersion()
            }
        }, 3000)

        // Periodic checks (不频繁，只是为了显示提示)
        const interval = setInterval(checkVersion, checkInterval)

        return () => {
            clearTimeout(initialTimeout)
            clearInterval(interval)
        }
    }, [enabled, checkInterval, checkVersion])

    const hasUpdate = Boolean(
        serverVersion &&
        currentVersion !== 'unknown' &&
        serverVersion !== 'unknown' &&
        serverVersion !== currentVersion &&
        !dismissed
    )

    // 用户点击刷新时调用
    const refresh = useCallback(() => {
        refreshApp()
    }, [])

    const dismiss = useCallback(() => {
        setDismissed(true)
    }, [])

    return {
        hasUpdate,
        currentVersion,
        serverVersion,
        refresh,
        dismiss
    }
}
