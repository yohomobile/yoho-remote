import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    createRootRoute,
    createRoute,
    createRouter,
    useNavigate,
    useParams,
} from '@tanstack/react-router'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { NewSession } from '@/components/NewSession'
import { LoadingState } from '@/components/LoadingState'
import { OnlineUsersBadge } from '@/components/OnlineUsersBadge'
import { useAppContext } from '@/lib/app-context'
import { useMyOrgs } from '@/hooks/queries/useOrgs'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useOnlineUsers } from '@/hooks/queries/useOnlineUsers'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useFileSuggestions } from '@/hooks/queries/useFileSuggestions'
import { useSessionViewers } from '@/hooks/queries/useSessionViewers'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useOtherUserTyping } from '@/hooks/useOtherUserTyping'
import { queryKeys } from '@/lib/query-keys'
import SettingsPage from '@/routes/settings'
import OrgDetailPage from '@/routes/orgs'
import AcceptInvitationPage from '@/routes/invitations/accept'
import { LoginPage } from '@/routes/login'
import { AuthCallbackPage } from '@/routes/auth/callback'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function SettingsIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function BrainIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
            <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
            <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
            <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
            <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
            <path d="M6 18a4 4 0 0 1-1.967-.516" />
            <path d="M19.967 17.484A4 4 0 0 1 18 18" />
        </svg>
    )
}

function SessionsPage() {
    const { api, userEmail, currentOrgId, setCurrentOrgId } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { sessions, isLoading, error, refetch } = useSessions(api, currentOrgId)
    const { users: onlineUsers } = useOnlineUsers(api)
    const { orgs } = useMyOrgs(api)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [isCreatingBrain, setIsCreatingBrain] = useState(false)
    const [showOrgPicker, setShowOrgPicker] = useState(false)

    const currentOrg = orgs.find(o => o.id === currentOrgId) ?? orgs[0] ?? null

    const { data: projectsData } = useQuery({
        queryKey: ['projects', currentOrgId],
        queryFn: async () => api.getProjects(undefined, currentOrgId)
    })
    const projects = Array.isArray(projectsData?.projects) ? projectsData.projects : []

    // Fetch user preferences to check if viewOthersSessions is enabled
    const { data: userPreferences } = useQuery({
        queryKey: queryKeys.userPreferences,
        queryFn: async () => api.getUserPreferences()
    })

    const handleRefresh = useCallback(() => {
        void refetch()
    }, [refetch])

    const handleForceRefresh = useCallback(async () => {
        if (isRefreshing) return
        setIsRefreshing(true)

        try {
            // 用户主动触发的强制刷新
            // 清除 Service Worker 和缓存以获取最新版本
            const registrations = await navigator.serviceWorker?.getRegistrations()
            if (registrations) {
                for (const registration of registrations) {
                    await registration.unregister()
                }
            }

            const cacheNames = await caches?.keys()
            if (cacheNames) {
                for (const cacheName of cacheNames) {
                    await caches.delete(cacheName)
                }
            }

            window.location.reload()
        } catch (error) {
            console.error('Force refresh failed:', error)
            window.location.reload()
        }
    }, [isRefreshing])

    const handleCreateBrainSession = useCallback(async () => {
        if (isCreatingBrain) return
        setIsCreatingBrain(true)
        try {
            const result = await api.createBrainSession(currentOrgId)
            if (result.type === 'success' && result.sessionId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: result.sessionId },
                })
            }
        } catch (err) {
            console.error('Failed to create brain session:', err)
        } finally {
            setIsCreatingBrain(false)
        }
    }, [api, isCreatingBrain, navigate, queryClient])

    const projectCount = new Set(sessions.map(s => s.metadata?.path ?? 'Other')).size
    const gitCommitHash = typeof __GIT_COMMIT_HASH__ !== 'undefined' ? __GIT_COMMIT_HASH__ : 'dev'
    const gitCommitMessage = typeof __GIT_COMMIT_MESSAGE__ !== 'undefined' ? __GIT_COMMIT_MESSAGE__ : ''

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center justify-between gap-2 sm:py-1.5">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => orgs.length > 1 ? setShowOrgPicker(!showOrgPicker) : undefined}
                                className={`flex items-center gap-2 min-w-0 ${orgs.length > 1 ? 'cursor-pointer' : ''}`}
                            >
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 shadow-sm text-white text-xs font-bold">
                                    {currentOrg?.name?.charAt(0)?.toUpperCase() ?? 'Y'}
                                </div>
                                <div className="flex flex-col items-start justify-center min-w-0">
                                    <span className="max-w-[160px] truncate text-sm font-bold leading-tight yoho-brand-text sm:max-w-none">
                                        {currentOrg?.name ?? 'Yoho Remote'}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); handleForceRefresh() }}
                                        disabled={isRefreshing}
                                        className="mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                                        title={`${gitCommitMessage}\n\nClick to force refresh`}
                                    >
                                        {isRefreshing ? '...' : gitCommitHash}
                                    </button>
                                </div>
                                {orgs.length > 1 && (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--app-hint)]"><polyline points="6 9 12 15 18 9" /></svg>
                                )}
                            </button>
                            {showOrgPicker && orgs.length > 1 && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setShowOrgPicker(false)} />
                                    <div className="absolute left-0 top-full mt-1 z-50 w-48 rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] shadow-lg overflow-hidden">
                                        {orgs.map((org) => (
                                            <button
                                                key={org.id}
                                                type="button"
                                                onClick={() => { setCurrentOrgId(org.id); setShowOrgPicker(false) }}
                                                className={`w-full px-3 py-2 flex items-center gap-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] transition-colors ${org.id === currentOrgId ? 'bg-[var(--app-subtle-bg)] font-medium' : ''}`}
                                            >
                                                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-[10px] font-bold">
                                                    {org.name.charAt(0).toUpperCase()}
                                                </div>
                                                <span className="truncate">{org.name}</span>
                                                {org.id === currentOrgId && (
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 ml-auto text-green-500"><polyline points="20 6 9 17 4 12" /></svg>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <OnlineUsersBadge users={onlineUsers} />
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                            <span className="sm:hidden">{sessions.filter(s => s.active).length}</span>
                            <span className="hidden sm:inline">{sessions.filter(s => s.active).length} sessions</span>
                        </span>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/settings' })}
                            className="flex items-center justify-center h-7 w-7 rounded-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                            title="Settings"
                        >
                            <SettingsIcon />
                        </button>
                        <button
                            type="button"
                            onClick={handleCreateBrainSession}
                            disabled={isCreatingBrain}
                            className="flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm hover:shadow-md transition-all hover:scale-105 disabled:opacity-50"
                            title="New Brain Session"
                        >
                            <BrainIcon className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions/new' })}
                            className="session-list-new-button flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-sm hover:shadow-md transition-all hover:scale-105"
                            title="New Session"
                        >
                            <PlusIcon className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                {error ? (
                    <div className="mx-auto w-full max-w-content px-3 py-2">
                        <div className="text-sm text-red-600">{error}</div>
                    </div>
                ) : null}
                <SessionList
                    sessions={sessions}
                    projects={projects}
                    currentUserEmail={userEmail}
                    viewOthersSessions={userPreferences?.viewOthersSessions}
                    onSelect={(sessionId) => navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId },
                    })}
                    onNewSession={() => navigate({ to: '/sessions/new' })}
                    onRefresh={handleRefresh}
                    isLoading={isLoading}
                    renderHeader={false}
                />
            </div>
        </div>
    )
}

function SessionPage() {
    const { api, currentOrgId } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const viewers = useSessionViewers(api, sessionId)
    const {
        session,
        notFound,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
    } = useMessages(api, sessionId)
    const {
        sendMessage: rawSendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId)

    // Wrap sendMessage to intercept client-side slash commands
    const sendMessage = useCallback((text: string) => {
        const trimmed = text.trim().toLowerCase()

        // Handle /fast - toggle fast mode (Claude only)
        if (trimmed === '/fast') {
            const flavor = session?.metadata?.flavor ?? 'claude'
            if (flavor === 'claude' && api && sessionId) {
                const newFastMode = !session?.fastMode
                localStorage.setItem('yr-fast-mode', String(newFastMode))
                api.setFastMode(sessionId, newFastMode).catch(console.error)
            }
            return
        }

        // All other messages go to the agent
        rawSendMessage(text)
    }, [rawSendMessage, navigate, api, sessionId, session])

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)

    // File suggestions for @ mentions
    const {
        getSuggestions: getFileSuggestions,
    } = useFileSuggestions(api, sessionId)

    // 其他用户正在输入
    const otherUserTyping = useOtherUserTyping(sessionId)

    // Combined suggestions handler
    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('/')) {
            return getSlashSuggestions(query)
        }
        if (query.startsWith('@')) {
            return getFileSuggestions(query)
        }
        return []
    }, [getSlashSuggestions, getFileSuggestions])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    useEffect(() => {
        if (!notFound) return
        navigate({ to: '/sessions', replace: true })
    }, [navigate, notFound])

    if (!session) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    return (
        <SessionChat
            api={api}
            session={session}
            viewers={viewers}
            messages={messages}
            hasMoreMessages={messagesHasMore}
            isLoadingMessages={messagesLoading}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onSend={sendMessage}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
            otherUserTyping={otherUserTyping}
        />
    )
}

function NewSessionPage() {
    const { api, currentOrgId } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true, currentOrgId)

    const handleCancel = useCallback(() => {
        navigate({ to: '/sessions' })
    }, [navigate])

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({ to: '/sessions', replace: true })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
            })
        })
    }, [navigate, queryClient])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                    {!isTelegramApp() && (
                        <button
                            type="button"
                            onClick={goBack}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <BackIcon />
                        </button>
                    )}
                    <div className="flex-1 font-medium text-sm">Create Session</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {machinesError ? (
                        <div className="p-3 text-sm text-red-600">
                            {machinesError}
                        </div>
                    ) : null}

                    <NewSession
                        api={api}
                        machines={machines}
                        isLoading={machinesLoading}
                        onCancel={handleCancel}
                        onSuccess={handleSuccess}
                    />
                </div>
            </div>
        </div>
    )
}

const rootRoute = createRootRoute({
    component: App,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
    component: SessionPage,
})

const newSessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/new',
    component: NewSessionPage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
})

const orgDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/orgs/$orgId',
    component: OrgDetailPage,
})

// Auth routes (public - no authentication required)
const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: LoginPage,
})

const authCallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/auth/callback',
    component: AuthCallbackPage,
})

const acceptInvitationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/invitations/accept/$invitationId',
    component: AcceptInvitationPage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    loginRoute,
    authCallbackRoute,
    sessionsRoute,
    sessionRoute,
    newSessionRoute,
    settingsRoute,
    orgDetailRoute,
    acceptInvitationRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
