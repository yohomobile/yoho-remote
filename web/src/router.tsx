import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    createRootRoute,
    createRoute,
    createRouter,
    useSearch,
    useNavigate,
    useParams,
} from '@tanstack/react-router'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { NewBrainSession } from '@/components/NewBrainSession'
import { NewSession } from '@/components/NewSession'
import { LoadingState } from '@/components/LoadingState'
import { OnlineUsersBadge } from '@/components/OnlineUsersBadge'
import { useAppContext } from '@/lib/app-context'
import { useMyOrgs, useOrg } from '@/hooks/queries/useOrgs'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isFlutterApp, callNativeHandler } from '@/hooks/useFlutterApp'
import { pushSessionsHeader, getOnlineUsersForBadge } from '@/hooks/useFlutterBridge'
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
import { deriveEffectiveLicenseState } from '@/lib/license'
import {
    DEFAULT_SESSION_LIST_SEARCH,
    type ArchiveFilter,
    type NewSessionSearch,
    type OwnerFilter,
    validateNewSessionSearch,
    validateSessionListSearch,
} from '@/lib/session-filters'
import { isSessionVisibleInActiveList } from '@/lib/sessionActivity'
import SettingsPage from '@/routes/settings'
import SelfSystemPage from '@/routes/self-system'
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

function OrchestratorIcon(props: { className?: string }) {
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
            <circle cx="12" cy="5" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="18" r="2.5" />
            <path d="M12 7.5v4.5" />
            <path d="M12 12H6" />
            <path d="M12 12h6" />
        </svg>
    )
}

function SelfSystemIcon(props: { className?: string }) {
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
            <path d="M12 14a4 4 0 1 0-4-4" />
            <path d="M6 20a6 6 0 0 1 12 0" />
            <path d="m18 3 .8 1.7L20.5 5l-1.7.8L18 7.5l-.8-1.7L15.5 5l1.7-.8z" />
        </svg>
    )
}

function SessionsPage() {
    const { api, userEmail, currentOrgId, setCurrentOrgId } = useAppContext()
    const navigate = useNavigate()
    const search = useSearch({ from: '/sessions' })
    const queryClient = useQueryClient()
    const archiveFilter: ArchiveFilter = search.archive === 'archive'
        ? 'archive'
        : DEFAULT_SESSION_LIST_SEARCH.archive
    const ownerFilter: OwnerFilter = search.owner === 'brain'
        || search.owner === 'orchestrator'
        || search.owner === 'others'
        ? search.owner
        : DEFAULT_SESSION_LIST_SEARCH.owner
    const { sessions, isLoading, error, refetch } = useSessions(api, currentOrgId)
    const { machines, error: machinesError } = useMachines(api, true, currentOrgId)
    const { users: onlineUsers } = useOnlineUsers(api, currentOrgId)
    const { orgs } = useMyOrgs(api)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const currentOrg = orgs.find(o => o.id === currentOrgId) ?? orgs[0] ?? null

    const { data: projectsData } = useQuery({
        queryKey: ['projects', currentOrgId],
        queryFn: async () => api.getProjects(currentOrgId)
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

    const handleDeleteSession = useCallback(async (sessionId: string) => {
        try {
            await api.deleteSession(sessionId)
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        } catch (err) {
            console.error('Failed to delete session:', err)
        }
    }, [api, queryClient])

    const projectCount = new Set(sessions.map(s => s.metadata?.path ?? 'Other')).size
    const gitCommitHash = typeof __GIT_COMMIT_HASH__ !== 'undefined' ? __GIT_COMMIT_HASH__ : 'dev'
    const gitCommitMessage = typeof __GIT_COMMIT_MESSAGE__ !== 'undefined' ? __GIT_COMMIT_MESSAGE__ : ''

    useEffect(() => {
        if (!isFlutterApp()) return
        pushSessionsHeader({
            orgName: currentOrg?.name,
            onlineUsers: getOnlineUsersForBadge(onlineUsers),
            activeCount: sessions.filter((session) => isSessionVisibleInActiveList(session)).length,
            gitHash: gitCommitHash,
        })
    }, [onlineUsers, sessions, gitCommitHash, currentOrg])

    return (
        <div className="flex h-full flex-col">
            {!isFlutterApp() && (
                <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center justify-between gap-2 sm:py-1.5">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <div className="flex h-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 shadow-sm text-white text-xs font-bold px-2">
                                    {currentOrg?.name ?? 'Yoho'}
                            </div>
                            <div className="flex flex-col items-start justify-center min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-sm font-bold leading-tight yoho-brand-text">
                                        Remote
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleForceRefresh}
                                    disabled={isRefreshing}
                                    className="mt-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                                    title={`${gitCommitMessage}\n\nClick to force refresh`}
                                >
                                    {isRefreshing ? '...' : gitCommitHash}
                                </button>
                            </div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <OnlineUsersBadge users={onlineUsers} />
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                            <span className="sm:hidden">{sessions.filter((session) => isSessionVisibleInActiveList(session)).length}</span>
                            <span className="hidden sm:inline">{sessions.filter((session) => isSessionVisibleInActiveList(session)).length} sessions</span>
                        </span>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/self-system' })}
                            className="flex items-center justify-center h-7 w-7 rounded-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                            title="Self System"
                        >
                            <SelfSystemIcon />
                        </button>
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
                            onClick={() => navigate({
                                to: '/sessions/new',
                                search: { ...search, kind: 'brain' },
                            })}
                            className="flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm hover:shadow-md transition-all hover:scale-105 disabled:opacity-50"
                            title="New Brain Session"
                        >
                            <BrainIcon className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({
                                to: '/sessions/new',
                                search: { ...search, kind: 'orchestrator' },
                            })}
                            className="flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-to-br from-sky-500 to-cyan-600 text-white shadow-sm hover:shadow-md transition-all hover:scale-105"
                            title="New Orchestrator Session"
                        >
                            <OrchestratorIcon className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions/new', search })}
                            className="session-list-new-button flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-sm hover:shadow-md transition-all hover:scale-105"
                            title="New Session"
                        >
                            <PlusIcon className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
            )}
            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                {error ? (
                    <div className="mx-auto w-full max-w-content px-3 py-2">
                        <div className="text-sm text-red-600">{error}</div>
                    </div>
                ) : null}
                {machinesError ? (
                    <div className="mx-auto w-full max-w-content px-3 py-2">
                        <div className="text-sm text-red-600">{machinesError}</div>
                    </div>
                ) : null}
                <SessionList
                    sessions={sessions}
                    projects={projects}
                    currentUserEmail={userEmail}
                    viewOthersSessions={userPreferences?.viewOthersSessions}
                    archiveFilter={archiveFilter}
                    ownerFilter={ownerFilter}
                    onArchiveFilterChange={(archive) => navigate({
                        to: '/sessions',
                        search: (prev) => ({ ...prev, archive }),
                        replace: true,
                    })}
                    onOwnerFilterChange={(owner) => navigate({
                        to: '/sessions',
                        search: (prev) => ({ ...prev, owner }),
                        replace: true,
                    })}
                    onSelect={(sessionId) => {
                        if (isFlutterApp()) {
                            void callNativeHandler('openDetail', { path: `/sessions/${sessionId}` })
                        } else {
                            navigate({
                                to: '/sessions/$sessionId',
                                params: { sessionId },
                                search,
                            })
                        }
                    }}
                    onDelete={handleDeleteSession}
                    onNewSession={() => {
                        if (isFlutterApp()) {
                            void callNativeHandler('openDetail', { path: '/sessions/new' })
                        } else {
                            navigate({ to: '/sessions/new', search })
                        }
                    }}
                    onRefresh={handleRefresh}
                    isLoading={isLoading}
                    machines={machines}
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
    const viewers = useSessionViewers(api, currentOrgId, sessionId)
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
    const search = useSearch({ from: '/sessions/new' })
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true, currentOrgId)
    const { license, licenseExempt } = useOrg(api, currentOrgId)
    const licenseState = license ? deriveEffectiveLicenseState(license, { licenseExempt }) : null
    const licenseBlocked = licenseState?.isBlocked === true
    const sessionListSearch = {
        archive: search.archive ?? DEFAULT_SESSION_LIST_SEARCH.archive,
        owner: search.owner ?? DEFAULT_SESSION_LIST_SEARCH.owner,
    } satisfies NewSessionSearch
    const isBrainCreation = search.kind === 'brain'
    const isOrchestratorCreation = search.kind === 'orchestrator'

    const handleCancel = useCallback(() => {
        goBack()
    }, [goBack])

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        if (isFlutterApp()) {
            void callNativeHandler('refreshSessions')
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
                replace: true,
            })
        } else {
            navigate({ to: '/sessions', search: sessionListSearch, replace: true })
            requestAnimationFrame(() => {
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId },
                    search: sessionListSearch,
                })
            })
        }
    }, [navigate, queryClient, sessionListSearch])

    return (
        <div className="flex h-full flex-col">
            {!isFlutterApp() && (
                <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                        <button
                            type="button"
                            onClick={goBack}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <BackIcon />
                        </button>
                        <div className="flex-1 font-medium text-sm">
                            {isBrainCreation
                                ? 'Create Brain Session'
                                : isOrchestratorCreation
                                    ? 'Create Orchestrator Session'
                                    : 'Create Session'}
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {machinesError ? (
                        <div className="p-3 text-sm text-red-600">
                            {machinesError}
                        </div>
                    ) : null}

                    {licenseBlocked ? (
                        <div className="mx-auto w-full max-w-content p-4 flex flex-col gap-3 items-center text-center">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
                                <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                </svg>
                            </div>
                            <div>
                                <div className="text-sm font-semibold text-[var(--app-fg)]">
                                    {licenseState?.isSuspended
                                        ? 'License suspended'
                                        : licenseState?.isNotStarted
                                            ? 'License not active yet'
                                            : 'License expired'}
                                </div>
                                <div className="text-[12px] text-[var(--app-hint)] mt-1 leading-relaxed">
                                    {licenseState?.isNotStarted
                                        ? 'Sessions are currently blocked until the license start date.'
                                        : 'Sessions are currently blocked.'}
                                    <br/>Contact your administrator to review the license.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/settings' })}
                                className="mt-1 px-4 py-2 text-sm font-medium rounded-lg bg-[var(--app-subtle-bg)] border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                            >
                                View License in Settings
                            </button>
                        </div>
                    ) : (
                        isBrainCreation ? (
                            <NewBrainSession
                                api={api}
                                machines={machines}
                                isLoading={machinesLoading}
                                onCancel={handleCancel}
                                onSuccess={handleSuccess}
                            />
                        ) : isOrchestratorCreation ? (
                            <NewSession
                                api={api}
                                machines={machines}
                                isLoading={machinesLoading}
                                onCancel={handleCancel}
                                onSuccess={handleSuccess}
                                source="orchestrator"
                                introTitle="Create an Orchestrator Session"
                                introDescription="Orchestrator sessions use a regular project workspace and can coordinate child sessions without Brain self-system or the managed Brain workspace."
                            />
                        ) : (
                            <NewSession
                                api={api}
                                machines={machines}
                                isLoading={machinesLoading}
                                onCancel={handleCancel}
                                onSuccess={handleSuccess}
                            />
                        )
                    )}
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
    validateSearch: validateSessionListSearch,
    component: SessionsPage,
})

const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
    validateSearch: validateSessionListSearch,
    component: SessionPage,
})

const newSessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/new',
    validateSearch: validateNewSessionSearch,
    component: NewSessionPage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
})

const selfSystemRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/self-system',
    component: SelfSystemPage,
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
    selfSystemRoute,
    settingsRoute,
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
