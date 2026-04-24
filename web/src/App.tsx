import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { initializeTheme } from '@/hooks/useTheme'
import { useAuth } from '@/providers/KeycloakAuthProvider'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import {
    getSessionCompletionNotificationKind,
    mergeSessionNotificationState,
    shouldSuppressNotificationWithoutPreviousState,
    toSessionNotificationState,
    type SessionNotificationState,
    type SessionStatusUpdateData,
} from '@/hooks/useSSE.utils'
import { useSyncingState } from '@/hooks/useSyncingState'
import type { Project, SessionResponse, SessionSummary, SyncEvent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { AppContextProvider, useAppContext, getStoredOrgId, setStoredOrgId } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { OfflineBanner } from '@/components/OfflineBanner'
import { SyncingBanner } from '@/components/SyncingBanner'
import { UpdateBanner } from '@/components/UpdateBanner'
import { LicenseBanner } from '@/components/LicenseBanner'
import { PendingInvitationsBanner } from '@/components/PendingInvitationsBanner'
import { LoadingState } from '@/components/LoadingState'
import { Toaster } from '@/components/ui/toaster'
import { useVersionCheck } from '@/hooks/useVersionCheck'
import { notifyTaskComplete, getPendingNotification, clearPendingNotification, useWebPushSubscription } from '@/hooks/useNotification'
import { getAccessTokenSync } from '@/services/keycloak'
import { useMyOrgs } from '@/hooks/queries/useOrgs'
import { OrgSetup } from '@/components/OrgSetup'
import { shouldBypassOrgGate } from '@/lib/org-gate'
import { isLicenseTermination, getLicenseTerminationLabel } from '@/lib/license'
import { useFlutterBridge } from '@/hooks/useFlutterBridge'

function matchesQueryKey(queryKey: readonly unknown[], expected: readonly unknown[]): boolean {
    return queryKey.length === expected.length
        && queryKey.every((value, index) => value === expected[index])
}

function isAutomaticSuccessfulQueryUpdate(event: unknown): event is {
    type: 'updated'
    query: { queryKey: readonly unknown[] }
    action: { type: 'success'; manual?: boolean }
} {
    if (!event || typeof event !== 'object') {
        return false
    }
    const queryEvent = event as {
        type?: unknown
        query?: { queryKey?: unknown }
        action?: { type?: unknown; manual?: unknown }
    }
    return queryEvent.type === 'updated'
        && Array.isArray(queryEvent.query?.queryKey)
        && queryEvent.action?.type === 'success'
        && queryEvent.action.manual !== true
}

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
    const sessionNotificationStateRef = useRef<Map<string, SessionNotificationState>>(new Map())
    const notificationBaselineReadyRef = useRef(false)
    const sseConnectDebounceMs = 2000
    const completionReplayGuardMs = 5000
    const sessionsListQueryKey = useMemo(() => [...queryKeys.sessions, currentOrgId ?? 'all'] as const, [currentOrgId])
    const selectedSessionQueryKey = useMemo(() => (
        selectedSessionId ? queryKeys.session(selectedSessionId) : null
    ), [selectedSessionId])

    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        sessionNotificationStateRef.current = new Map()
        notificationBaselineReadyRef.current = false
        queryClient.clear()
    }, [baseUrl, queryClient])

    const syncSessionNotificationStateFromCache = useCallback(() => {
        const nextState = new Map(sessionNotificationStateRef.current)
        const sessionsData = queryClient.getQueryData<{ sessions: SessionSummary[] }>(sessionsListQueryKey)
        for (const session of sessionsData?.sessions ?? []) {
            nextState.set(session.id, toSessionNotificationState(session)!)
        }

        if (selectedSessionQueryKey) {
            const sessionData = queryClient.getQueryData<SessionResponse>(selectedSessionQueryKey)
            if (sessionData?.session) {
                nextState.set(sessionData.session.id, toSessionNotificationState(sessionData.session)!)
            }
        }

        sessionNotificationStateRef.current = nextState
    }, [queryClient, selectedSessionQueryKey, sessionsListQueryKey])

    const refreshNotificationBaselineReady = useCallback(() => {
        const sessionsQueryState = queryClient.getQueryState<{ sessions: SessionSummary[] }>(sessionsListQueryKey)
        const selectedSessionState = selectedSessionQueryKey
            ? queryClient.getQueryState<SessionResponse>(selectedSessionQueryKey)
            : undefined
        notificationBaselineReadyRef.current = sessionsQueryState?.status === 'success'
            || selectedSessionState?.status === 'success'
    }, [queryClient, selectedSessionQueryKey, sessionsListQueryKey])

    useEffect(() => {
        syncSessionNotificationStateFromCache()
        refreshNotificationBaselineReady()
    }, [refreshNotificationBaselineReady, syncSessionNotificationStateFromCache])

    useEffect(() => {
        const queryCache = queryClient.getQueryCache()
        return queryCache.subscribe((event) => {
            if (!isAutomaticSuccessfulQueryUpdate(event)) {
                return
            }
            const isSessionsBaselineUpdate = matchesQueryKey(event.query.queryKey, sessionsListQueryKey)
            const isSelectedSessionBaselineUpdate = selectedSessionQueryKey
                ? matchesQueryKey(event.query.queryKey, selectedSessionQueryKey)
                : false
            if (!isSessionsBaselineUpdate && !isSelectedSessionBaselineUpdate) {
                return
            }

            syncSessionNotificationStateFromCache()
            refreshNotificationBaselineReady()
        })
    }, [queryClient, refreshNotificationBaselineReady, selectedSessionQueryKey, sessionsListQueryKey, syncSessionNotificationStateFromCache])

    const handleSseConnect = useCallback(() => {
        notificationBaselineReadyRef.current = false
        syncSessionNotificationStateFromCache()
        refreshNotificationBaselineReady()
        const now = Date.now()
        const timeSinceLastConnect = now - lastSseConnectRef.current
        const shouldDebounceSyncUi = timeSinceLastConnect < sseConnectDebounceMs && !isFirstConnectRef.current

        lastSseConnectRef.current = now

        const token = ++syncTokenRef.current

        if (isFirstConnectRef.current) {
            isFirstConnectRef.current = false
            startSync({ force: true })
        } else if (!shouldDebounceSyncUi) {
            startSync()
        }
        if (import.meta.env.DEV) {
            console.log('[sse] connect', {
                selectedSessionId,
                invalidateSession: Boolean(selectedSessionId),
                shouldDebounceSyncUi,
            })
        }

        // EventSource reconnects can miss messages even when the outage is very short.
        // Always backfill queries on every successful open; only debounce the syncing UI.
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
                if (!shouldDebounceSyncUi && syncTokenRef.current === token) {
                    endSync()
                }
            })
    }, [endSync, queryClient, refreshNotificationBaselineReady, selectedSessionId, startSync, syncSessionNotificationStateFromCache])

    const handleSseEvent = useCallback((event: SyncEvent) => {
        if (event.type === 'online-users-changed') {
            if (event.orgId) {
                queryClient.setQueryData(queryKeys.onlineUsers(event.orgId), { users: event.users })
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            return
        }

        if (event.type === 'session-updated') {
            const data = ('data' in event ? event.data : null) as SessionStatusUpdateData | null
            const previousState = sessionNotificationStateRef.current.get(event.sessionId)
            const notificationKind = getSessionCompletionNotificationKind({
                previousState,
                data,
                suppressWithoutPreviousState: shouldSuppressNotificationWithoutPreviousState({
                    previousState,
                    baselineReady: notificationBaselineReadyRef.current,
                    lastConnectAt: lastSseConnectRef.current,
                    replayGuardMs: completionReplayGuardMs,
                }),
            })
            const nextState = mergeSessionNotificationState(previousState, data)
            if (nextState) {
                sessionNotificationStateRef.current.set(event.sessionId, nextState)
            }

            // License kill notification
            if (notificationKind === 'license-terminated' && data?.active === false && isLicenseTermination(data.terminationReason)) {
                const sessionsData = queryClient.getQueryData<{ sessions: SessionSummary[] }>([...queryKeys.sessions, currentOrgId ?? 'all'])
                const killedSession = sessionsData?.sessions.find(s => s.id === event.sessionId)
                const label = killedSession?.metadata?.summary?.text || killedSession?.metadata?.name || 'A session'
                const reasonLabel = getLicenseTerminationLabel(data.terminationReason!)
                notifyTaskComplete({
                    sessionId: event.sessionId,
                    title: `${reasonLabel} — ${label}`,
                    project: undefined,
                    onClick: () => navigate({ to: '/sessions/$sessionId', params: { sessionId: event.sessionId } }),
                })
                return
            }

            if (notificationKind === 'task-completed') {
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
        sessionNotificationStateRef.current.delete(event.sessionId)
        if (!selectedSessionId || event.sessionId !== selectedSessionId) {
            return
        }
        navigate({ to: '/sessions', replace: true })
    }, [completionReplayGuardMs, currentOrgId, navigate, queryClient, selectedSessionId])

    const eventSubscription = useMemo(() => {
        if (selectedSessionId && selectedSessionId !== 'new') {
            return { sessionId: selectedSessionId, all: true, orgId: currentOrgId }
        }
        return { all: true, orgId: currentOrgId }
    }, [currentOrgId, selectedSessionId])

    const token = getAccessTokenSync()

    useSSE({
        enabled: Boolean(api && token && isAuthenticated && currentOrgId),
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
            <FlutterBridgeBootstrap />
            {hasUpdate && <UpdateBanner onDismiss={handleDismiss} />}
            <SyncingBanner isSyncing={isSyncing} />
            <OfflineBanner />
            <LicenseBanner />
            <PendingInvitationsBanner />
            <div className="h-full flex flex-col">
                <OrgGate>
                    <Outlet />
                </OrgGate>
            </div>
            <Toaster />
        </AppContextProvider>
    )
}

function FlutterBridgeBootstrap() {
    useFlutterBridge()
    return null
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
