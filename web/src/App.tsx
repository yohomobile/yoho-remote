import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { initializeTheme } from '@/hooks/useTheme'
import { useAuth } from '@/providers/KeycloakAuthProvider'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { useSyncingState } from '@/hooks/useSyncingState'
import type { SyncEvent, SessionSummary, Project } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { AppContextProvider, useAppContext, getStoredOrgId, setStoredOrgId } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { OfflineBanner } from '@/components/OfflineBanner'
import { SyncingBanner } from '@/components/SyncingBanner'
import { UpdateBanner } from '@/components/UpdateBanner'
import { LicenseBanner } from '@/components/LicenseBanner'
import { LoadingState } from '@/components/LoadingState'
import { Toaster } from '@/components/ui/toaster'
import { useVersionCheck } from '@/hooks/useVersionCheck'
import { notifyTaskComplete, getPendingNotification, clearPendingNotification, useWebPushSubscription } from '@/hooks/useNotification'
import { getAccessTokenSync } from '@/services/keycloak'
import { useMyOrgs } from '@/hooks/queries/useOrgs'
import { OrgSetup } from '@/components/OrgSetup'
import { shouldBypassOrgGate } from '@/lib/org-gate'

export function App() {
    const { baseUrl } = useServerUrl()
    const { user, isAuthenticated, isLoading: isAuthLoading, error: authError, api, login } = useAuth()
    const { hasUpdate: hasApiUpdate, refresh: refreshApp, dismiss: dismissUpdate } = useVersionCheck({ baseUrl })

    // Service Worker update state
    const [hasSwUpdate, setHasSwUpdate] = useState(false)

    useEffect(() => {
        const handleSwUpdate = () => {
            setHasSwUpdate(true)
        }
        window.addEventListener('sw-update-available', handleSwUpdate)
        return () => window.removeEventListener('sw-update-available', handleSwUpdate)
    }, [])

    const hasUpdate = hasApiUpdate || hasSwUpdate

    const handleDismiss = useCallback(() => {
        setHasSwUpdate(false)
        dismissUpdate()
    }, [dismissUpdate])

    // Current org state (must be before any conditional returns)
    const [currentOrgId, setCurrentOrgIdState] = useState<string | null>(() => getStoredOrgId())
    const setCurrentOrgId = useCallback((id: string | null) => {
        setCurrentOrgIdState(id)
        setStoredOrgId(id)
    }, [])

    // Subscribe to Web Push notifications when authenticated
    useWebPushSubscription(api)
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const pathname = useLocation({ select: (location) => location.pathname })
    const matchRoute = useMatchRoute()

    useEffect(() => {
        initializeTheme()
    }, [])

    // Redirect to login if not authenticated (must be before any conditional returns)
    const isPublicRoute = pathname === '/login' || pathname.startsWith('/auth/')
    useEffect(() => {
        if (!isAuthLoading && !isAuthenticated && !isPublicRoute) {
            // Use window.location.href instead of navigate() to force a real page navigation
            // This bypasses Service Worker cache in PWA mode where client-side navigation
            // can get stuck serving cached "Redirecting..." state
            window.location.href = '/login'
        }
    }, [isAuthLoading, isAuthenticated, isPublicRoute])

    useEffect(() => {
        const preventDefault = (event: Event) => {
            event.preventDefault()
        }

        const lastInputValues = new WeakMap<EventTarget, string>()

        const readInputValue = (target: EventTarget | null): string | null => {
            if (!target || !(target instanceof HTMLElement)) {
                return null
            }
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                return target.value
            }
            if (target.isContentEditable) {
                return target.textContent ?? ''
            }
            return null
        }

        const writeInputValue = (target: EventTarget | null, value: string): void => {
            if (!target || !(target instanceof HTMLElement)) {
                return
            }
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                target.value = value
                return
            }
            if (target.isContentEditable) {
                target.textContent = value
            }
        }

        const isHistoryInputType = (event: Event): boolean => {
            const inputEvent = event as InputEvent
            return inputEvent.inputType === 'historyUndo' || inputEvent.inputType === 'historyRedo'
        }

        const onBeforeInput = (event: Event) => {
            if (isHistoryInputType(event)) {
                event.preventDefault()
                event.stopImmediatePropagation()
                return
            }
            const target = event.target
            if (!target) {
                return
            }
            const value = readInputValue(target)
            if (value !== null) {
                lastInputValues.set(target, value)
            }
        }

        const onInput = (event: Event) => {
            if (isHistoryInputType(event)) {
                const target = event.target
                if (!target) {
                    return
                }
                const previous = lastInputValues.get(target)
                if (previous !== undefined) {
                    writeInputValue(target, previous)
                }
                return
            }
            const target = event.target
            if (!target) {
                return
            }
            const value = readInputValue(target)
            if (value !== null) {
                lastInputValues.set(target, value)
            }
        }

        const docWithCommand = document as Document & { execCommand?: typeof document.execCommand }
        const originalExecCommand = docWithCommand.execCommand?.bind(document)
        if (originalExecCommand) {
            docWithCommand.execCommand = (commandId: string, showUI?: boolean, value?: string) => {
                if (typeof commandId === 'string') {
                    const normalized = commandId.toLowerCase()
                    if (normalized === 'undo' || normalized === 'redo') {
                        return false
                    }
                }
                return originalExecCommand(commandId, showUI, value)
            }
        }

        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey) {
                event.preventDefault()
            }
        }

        const onKeyDown = (event: KeyboardEvent) => {
            const modifier = event.ctrlKey || event.metaKey
            if (!modifier) return
            if (event.key === '+' || event.key === '-' || event.key === '=' || event.key === '0') {
                event.preventDefault()
            }
        }

        document.addEventListener('gesturestart', preventDefault as EventListener, { passive: false })
        document.addEventListener('gesturechange', preventDefault as EventListener, { passive: false })
        document.addEventListener('gestureend', preventDefault as EventListener, { passive: false })
        document.addEventListener('beforeinput', onBeforeInput as EventListener, { capture: true })
        document.addEventListener('input', onInput as EventListener, { capture: true })

        window.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('keydown', onKeyDown)

        return () => {
            document.removeEventListener('gesturestart', preventDefault as EventListener)
            document.removeEventListener('gesturechange', preventDefault as EventListener)
            document.removeEventListener('gestureend', preventDefault as EventListener)
            document.removeEventListener('beforeinput', onBeforeInput as EventListener, { capture: true })
            document.removeEventListener('input', onInput as EventListener, { capture: true })

            window.removeEventListener('wheel', onWheel)
            window.removeEventListener('keydown', onKeyDown)

            if (originalExecCommand) {
                docWithCommand.execCommand = originalExecCommand
            }
        }
    }, [])

    const queryClient = useQueryClient()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId' })
    const selectedSessionId = sessionMatch ? sessionMatch.sessionId : null
    const { isSyncing, startSync, endSync } = useSyncingState()
    const syncTokenRef = useRef(0)
    const isFirstConnectRef = useRef(true)
    const baseUrlRef = useRef(baseUrl)
    const lastSseConnectRef = useRef(0)
    const sseConnectDebounceMs = 5000

    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        queryClient.clear()
    }, [baseUrl, queryClient])

    const handleSseConnect = useCallback(() => {
        const now = Date.now()
        const timeSinceLastConnect = now - lastSseConnectRef.current

        if (timeSinceLastConnect < sseConnectDebounceMs && !isFirstConnectRef.current) {
            if (import.meta.env.DEV) {
                console.log('[sse] skipping invalidation - reconnected too quickly', {
                    timeSinceLastConnect,
                    debounceMs: sseConnectDebounceMs
                })
            }
            return
        }

        lastSseConnectRef.current = now

        const token = ++syncTokenRef.current

        if (isFirstConnectRef.current) {
            isFirstConnectRef.current = false
            startSync({ force: true })
        } else {
            startSync()
        }
        if (import.meta.env.DEV) {
            console.log('[sse] connect', {
                selectedSessionId,
                invalidateSession: Boolean(selectedSessionId)
            })
        }

        const invalidations = [
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            ...(selectedSessionId ? [
                queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedSessionId) })
            ] : [])
        ]
        Promise.all(invalidations)
            .catch((error) => {
                console.error('Failed to invalidate queries on SSE connect:', error)
            })
            .finally(() => {
                if (syncTokenRef.current === token) {
                    endSync()
                }
            })
    }, [queryClient, selectedSessionId, startSync, endSync])

    const handleSseEvent = useCallback((event: SyncEvent) => {
        if (event.type === 'online-users-changed') {
            queryClient.setQueryData(queryKeys.onlineUsers, { users: event.users })
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            return
        }

        if (event.type === 'session-updated') {
            const data = ('data' in event ? event.data : null) as { active?: boolean; thinking?: boolean; wasThinking?: boolean; terminationReason?: string } | null

            // License kill notification
            if (data?.active === false && typeof data.terminationReason === 'string' && data.terminationReason.startsWith('LICENSE_')) {
                const sessionsData = queryClient.getQueryData<{ sessions: SessionSummary[] }>([...queryKeys.sessions, currentOrgId ?? 'all'])
                const killedSession = sessionsData?.sessions.find(s => s.id === event.sessionId)
                const label = killedSession?.metadata?.summary?.text || killedSession?.metadata?.name || 'A session'
                const reasonLabel = data.terminationReason === 'LICENSE_SUSPENDED' ? 'License suspended' : 'License expired'
                notifyTaskComplete({
                    sessionId: event.sessionId,
                    title: `${reasonLabel} — ${label}`,
                    project: undefined,
                    onClick: () => navigate({ to: '/sessions/$sessionId', params: { sessionId: event.sessionId } }),
                })
                return
            }

            if (data?.wasThinking && data.thinking === false) {
                const isCurrentSession = event.sessionId === selectedSessionId
                const isAppVisible = document.visibilityState === 'visible'
                console.log('[notification] task complete detected', { isCurrentSession, isAppVisible, selectedSessionId })

                if (isCurrentSession && isAppVisible) {
                    console.log('[notification] skipping - current session in foreground')
                    return
                }

                const sessionsData = queryClient.getQueryData<{ sessions: SessionSummary[] }>([...queryKeys.sessions, currentOrgId ?? 'all'])
                const session = sessionsData?.sessions.find(s => s.id === event.sessionId)

                if (!session) {
                    console.log('[notification] skipping - session not in user list', event.sessionId)
                    return
                }

                const title = session.metadata?.summary?.text || session.metadata?.name || 'Task completed'

                const projectsData = queryClient.getQueryData<{ projects: Project[] }>(['projects'])
                const sessionPath = session?.metadata?.path
                const project = sessionPath
                    ? projectsData?.projects.find(p => sessionPath.startsWith(p.path))
                    : undefined

                console.log('[notification] showing notification', { title, project: project?.name, sessionId: event.sessionId })

                notifyTaskComplete({
                    sessionId: event.sessionId,
                    title,
                    project: project?.name,
                    onClick: () => {
                        navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId: event.sessionId }
                        })
                    }
                })
            }
            return
        }

        if (event.type !== 'session-removed') {
            return
        }
        if (!selectedSessionId || event.sessionId !== selectedSessionId) {
            return
        }
        navigate({ to: '/sessions', replace: true })
    }, [navigate, selectedSessionId, queryClient])

    const eventSubscription = useMemo(() => {
        if (selectedSessionId && selectedSessionId !== 'new') {
            return { sessionId: selectedSessionId, all: true }
        }
        return { all: true }
    }, [selectedSessionId])

    const token = getAccessTokenSync()

    useSSE({
        enabled: Boolean(api && token && isAuthenticated),
        token: token ?? '',
        baseUrl,
        subscription: eventSubscription,
        onConnect: handleSseConnect,
        onEvent: handleSseEvent,
    })

    // Handle pending notification on visibility change
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                const pending = getPendingNotification()
                if (pending) {
                    if (selectedSessionId && selectedSessionId !== pending.sessionId) {
                        console.log('[notification] skipping auto-navigate - user is viewing different session', {
                            current: selectedSessionId,
                            pending: pending.sessionId
                        })
                        clearPendingNotification()
                        return
                    }

                    console.log('[notification] handling pending notification', pending.sessionId)
                    clearPendingNotification()
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId: pending.sessionId }
                    })
                }
            }
        }

        document.addEventListener('visibilitychange', handleVisibilityChange)
        handleVisibilityChange()

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [navigate, selectedSessionId])

    // Skip auth checks for public routes (login, callback)
    if (isPublicRoute) {
        return <Outlet />
    }

    // Loading auth state
    if (isAuthLoading) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label="Loading..." className="text-sm" />
            </div>
        )
    }

    // Not authenticated - show redirecting message (actual redirect happens in useEffect above)
    if (!isAuthenticated || !api) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label="Redirecting to login..." className="text-sm" />
            </div>
        )
    }

    return (
        <AppContextProvider value={{ api, token: token ?? '', userEmail: user?.email ?? null, currentOrgId, setCurrentOrgId }}>
            {hasUpdate && <UpdateBanner onDismiss={handleDismiss} />}
            <SyncingBanner isSyncing={isSyncing} />
            <OfflineBanner />
            <LicenseBanner />
            <div className="h-full flex flex-col">
                <OrgGate>
                    <Outlet />
                </OrgGate>
            </div>
            <Toaster />
        </AppContextProvider>
    )
}

/**
 * OrgGate - 检查用户是否属于至少一个组织
 * 如果没有组织，显示创建/加入引导页面
 */
function OrgGate({ children }: { children: React.ReactNode }) {
    const { api, currentOrgId, setCurrentOrgId } = useAppContext()
    const { orgs, isLoading } = useMyOrgs(api)
    const [setupDismissed, setSetupDismissed] = useState(false)
    const pathname = useLocation({ select: (location) => location.pathname })

    // Auto-set default org when orgs load
    useEffect(() => {
        if (orgs.length === 0) return
        // If no org selected, or selected org no longer valid, pick first
        if (!currentOrgId || !orgs.find(o => o.id === currentOrgId)) {
            setCurrentOrgId(orgs[0].id)
        }
    }, [orgs, currentOrgId, setCurrentOrgId])

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label="Loading..." className="text-sm" />
            </div>
        )
    }

    if (shouldBypassOrgGate(pathname)) {
        return <>{children}</>
    }

    if (orgs.length === 0 && !setupDismissed) {
        return <OrgSetup onComplete={() => setSetupDismissed(true)} />
    }

    return <>{children}</>
}
