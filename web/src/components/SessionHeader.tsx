import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Project, Session, SessionViewer, ModelMode, ModelReasoningEffort } from '@/types/api'
import { isTelegramApp, getTelegramWebApp } from '@/hooks/useTelegram'
import { getClientId } from '@/lib/client-identity'
import { ViewersBadge } from './ViewersBadge'
import { ShareDialog } from './ShareDialog'
import { useAppContext } from '@/lib/app-context'
import { getMachineTitle, getMobileSessionAgentSummary } from '@/lib/machines'
import { queryKeys } from '@/lib/query-keys'
import { useMachines } from '@/hooks/queries/useMachines'

function getSessionPath(session: Session): string | null {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? null
}

function matchSessionToProject(session: Session, projects: Project[]): Project | null {
    const sessionPath = getSessionPath(session)
    if (!sessionPath) return null
    if (!Array.isArray(projects)) return null

    // Exact match first
    for (const project of projects) {
        if (project.path === sessionPath) {
            return project
        }
    }

    // Check if session path starts with project path (for worktrees)
    for (const project of projects) {
        if (sessionPath.startsWith(project.path + '/') || sessionPath.startsWith(project.path + '-')) {
            return project
        }
    }

    return null
}

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
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

function TrashIcon(props: { className?: string }) {
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
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
    )
}


function XIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

function MoreIcon(props: { className?: string }) {
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
            <circle cx="12" cy="12" r="1" />
            <circle cx="12" cy="5" r="1" />
            <circle cx="12" cy="19" r="1" />
        </svg>
    )
}

function RefreshAccountIcon(props: { className?: string }) {
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
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
        </svg>
    )
}

function ShareIcon(props: { className?: string }) {
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
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
    )
}

function LockIcon(props: { className?: string }) {
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
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    )
}

function UnlockIcon(props: { className?: string }) {
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
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        </svg>
    )
}

function getAgentLabel(session: Session): string {
    const flavor = session.metadata?.flavor?.trim()
    if (flavor === 'claude') return 'Claude'
    if (flavor === 'codex') return 'Codex'
    if (flavor === 'gemini') return 'Gemini'
    if (flavor) return flavor
    return 'Agent'
}

function formatRuntimeModel(session: Session, modelMode?: ModelMode, modelReasoningEffort?: ModelReasoningEffort): string | null {
    // 优先使用用户设置的 modelMode 和 modelReasoningEffort
    const displayModel = modelMode && modelMode !== 'default' ? modelMode : session.metadata?.runtimeModel?.trim()
    if (!displayModel) {
        return session.fastMode ? '\u21af Fast' : null
    }
    const parts: string[] = [displayModel]
    const displayEffort = modelReasoningEffort ?? session.metadata?.runtimeModelReasoningEffort
    if (displayEffort) {
        parts.push(`(${displayEffort})`)
    }
    if (session.fastMode) {
        parts.push('\u21af')
    }
    return parts.join(' ')
}

export function SessionHeader(props: {
    session: Session
    viewers?: SessionViewer[]
    onBack: () => void
    onDelete?: () => void
    onRefreshAccount?: () => void
    deleteDisabled?: boolean
    refreshAccountDisabled?: boolean
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
}) {
    const { api, userEmail, currentOrgId } = useAppContext()
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const { machines } = useMachines(api, true, currentOrgId)
    const title = useMemo(() => getSessionTitle(props.session), [props.session])
    const worktreeBranch = props.session.metadata?.worktree?.branch
    const agentLabel = useMemo(() => getAgentLabel(props.session), [props.session])
    const runtimeAgent = props.session.metadata?.runtimeAgent?.trim() || null
    const runtimeModel = useMemo(
        () => formatRuntimeModel(props.session, props.modelMode, props.modelReasoningEffort),
        [props.session, props.modelMode, props.modelReasoningEffort]
    )
    const machineName = useMemo(() => {
        const machineId = props.session.metadata?.machineId
        if (!machineId) return null
        const machine = machines.find((m) => m.id === machineId) ?? null
        if (machine) {
            return getMachineTitle(machine)
        }
        return machineId.slice(0, 8)
    }, [machines, props.session.metadata?.machineId])

    // Check if current user is the creator of this session (must be defined before queries that use it)
    const isCreator = useMemo(() => {
        if (!userEmail) return false
        return props.session.createdBy === userEmail
    }, [userEmail, props.session.createdBy])

    // 分享对话框状态
    const [showShareDialog, setShowShareDialog] = useState(false)

    // 获取用户偏好设置
    const { data: userPreferences } = useQuery({
        queryKey: queryKeys.userPreferences,
        queryFn: async () => api.getUserPreferences()
    })

    // 获取 session 隐私模式
    const { data: privacyModeData } = useQuery({
        queryKey: ['session-privacy-mode', props.session.id],
        queryFn: async () => api.getSessionPrivacyMode(props.session.id),
        enabled: isCreator && userPreferences?.shareAllSessions === true
    })
    const privacyMode = privacyModeData?.privacyMode ?? false

    // 设置隐私模式的 mutation
    const setPrivacyModeMutation = useMutation({
        mutationFn: async (enabled: boolean) => {
            return await api.setSessionPrivacyMode(props.session.id, enabled)
        },
        onSuccess: (result) => {
            queryClient.setQueryData(['session-privacy-mode', props.session.id], {
                privacyMode: result.privacyMode
            })
            // 刷新 session 列表以更新显示
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
    })

    // 查询项目列表
    const { data: projectsData } = useQuery({
        queryKey: ['projects', currentOrgId],
        queryFn: async () => api.getProjects(currentOrgId)
    })
    const projects = Array.isArray(projectsData?.projects) ? projectsData.projects : []
    const project = useMemo(() => matchSessionToProject(props.session, projects), [props.session, projects])

    const agentMeta = useMemo(
        () => {
            const parts = [agentLabel]
            if (runtimeModel) {
                parts.push(runtimeModel)
            }
            if (runtimeAgent) {
                parts.push(runtimeAgent)
            }
            if (machineName) {
                parts.push(machineName)
            }
            if (project) {
                parts.push(project.name)
            }
            if (worktreeBranch) {
                parts.push(worktreeBranch)
            }
            return parts.join(' · ')
        },
        [agentLabel, runtimeAgent, runtimeModel, project, worktreeBranch, machineName]
    )
    const mobileAgentSummary = useMemo(
        () => getMobileSessionAgentSummary({
            agentLabel,
            machineName,
            projectName: project?.name
        }),
        [agentLabel, machineName, project?.name]
    )

    // Subscription state - supports both Telegram chatId and Web clientId
    const tg = getTelegramWebApp()
    const currentChatId = tg?.initDataUnsafe?.user?.id?.toString() ?? null
    const currentClientId = getClientId()

    // 过滤掉自己，只显示其他在线用户
    const otherViewers = useMemo(() => {
        if (!props.viewers) return []
        return props.viewers.filter(v => v.clientId !== currentClientId)
    }, [props.viewers, currentClientId])

    // 移动端更多菜单状态
    const [showMoreMenu, setShowMoreMenu] = useState(false)
    const moreMenuRef = useRef<HTMLDivElement>(null)

    // 移动端 agent 详情弹出框状态
    const [showAgentDetails, setShowAgentDetails] = useState(false)
    const agentDetailsRef = useRef<HTMLDivElement>(null)

    // 点击外部关闭菜单
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
                setShowMoreMenu(false)
            }
            if (agentDetailsRef.current && !agentDetailsRef.current.contains(event.target as Node)) {
                setShowAgentDetails(false)
            }
        }
        if (showMoreMenu || showAgentDetails) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [showMoreMenu, showAgentDetails])

    useEffect(() => {
        setShowMoreMenu(false)
        setShowAgentDetails(false)
    }, [props.session.id])

    // In Telegram, don't render header (Telegram provides its own)
    if (isTelegramApp()) {
        return null
    }

    return (
        <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
            <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center justify-between gap-2 sm:py-1.5">
                {/* Left side: Back button + Title + Agent */}
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button
                        type="button"
                        onClick={props.onBack}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1 relative" ref={agentDetailsRef}>
                        {/* 移动端：标题和agentMeta，两行挨着 */}
                        <div className="sm:hidden -space-y-1">
                            <div className="truncate font-medium text-sm leading-none">
                                {title}
                            </div>
                                <button
                                    type="button"
                                    onClick={() => setShowAgentDetails(!showAgentDetails)}
                                    className="text-[10px] text-[var(--app-hint)] truncate text-left leading-none"
                                >
                                    {mobileAgentSummary}
                                </button>
                        </div>
                        {/* PC端：标题 */}
                        <div className="hidden sm:block max-w-[180px] truncate font-medium text-sm sm:max-w-none">
                            {title}
                        </div>
                        {/* PC端：显示完整 agentMeta */}
                        <div className="hidden sm:block text-[10px] text-[var(--app-hint)] truncate">
                            {agentMeta}
                        </div>
                        {/* 移动端详情弹出框 */}
                        {showAgentDetails && (
                            <div className="sm:hidden absolute left-0 top-full z-30 mt-1 min-w-[200px] max-w-[280px] rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] py-2 px-3 shadow-lg">
                                <div className="text-xs text-[var(--app-fg)] space-y-1">
                                    <div className="text-[var(--app-hint)] truncate">{agentMeta}</div>
                                    {project && <div><span className="text-[var(--app-hint)]">Project:</span> {project.name}</div>}
                                    {worktreeBranch && <div><span className="text-[var(--app-hint)]">Branch:</span> {worktreeBranch}</div>}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Right side: Viewers + Action buttons */}
                <div className="flex shrink-0 items-center gap-1.5">
                    {/* PC端：在线用户（排除自己） */}
                    {otherViewers.length > 0 && (
                        <div className="hidden sm:block">
                            <ViewersBadge viewers={otherViewers} compact buttonClassName="h-7 leading-none" />
                        </div>
                    )}
                    {/* PC端：独立按钮 */}
                    <div className="hidden sm:flex items-center gap-1.5">
                        {/* Privacy Mode icon - 当全局开启 Share My Sessions 时显示 (仅图标) */}
                        {isCreator && userPreferences?.shareAllSessions === true && (
                            <button
                                type="button"
                                onClick={() => setPrivacyModeMutation.mutate(!privacyMode)}
                                disabled={setPrivacyModeMutation.isPending}
                                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                                    privacyMode
                                        ? 'bg-red-500/10 text-red-600 hover:bg-red-500/20'
                                        : 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
                                } ${setPrivacyModeMutation.isPending ? 'opacity-50' : ''}`}
                                title={privacyMode ? 'Private Mode' : 'Public Mode'}
                            >
                                {privacyMode ? <LockIcon /> : <UnlockIcon />}
                            </button>
                        )}
                        {/* Share button - 只有创建者可以分享 (未开启 Share My Sessions 时显示) */}
                        {isCreator && userPreferences?.shareAllSessions !== true && (
                            <button
                                type="button"
                                onClick={() => setShowShareDialog(true)}
                                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)] transition-colors hover:bg-purple-500/10 hover:text-purple-600"
                                title="Share session"
                            >
                                <ShareIcon />
                            </button>
                        )}
                        {props.onRefreshAccount ? (
                            <button
                                type="button"
                                onClick={props.onRefreshAccount}
                                disabled={props.refreshAccountDisabled}
                                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)] transition-colors hover:bg-green-500/10 hover:text-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Refresh session (keep context)"
                            >
                                <RefreshAccountIcon />
                            </button>
                        ) : null}

                        {/* Delete button - 只有创建者可见 */}
                        {isCreator && props.onDelete ? (
                            <button
                                type="button"
                                onClick={props.onDelete}
                                disabled={props.deleteDisabled}
                                className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)] transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Delete session"
                            >
                                <TrashIcon />
                            </button>
                        ) : null}
                    </div>
                    {/* 移动端：更多菜单 */}
                    <div className="sm:hidden relative" ref={moreMenuRef}>
                        <button
                            type="button"
                            onClick={() => setShowMoreMenu(!showMoreMenu)}
                            className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            title="More"
                        >
                            <MoreIcon />
                        </button>
                        {showMoreMenu && (
                            <div className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] py-1 shadow-lg">
                                {/* 在线用户列表（排除自己） */}
                                {otherViewers.length > 0 && (
                                    <>
                                        <div className="px-3 py-1.5 text-[10px] font-medium text-[var(--app-hint)] uppercase tracking-wider">
                                            Online ({otherViewers.length})
                                        </div>
                                        {otherViewers.map((viewer) => (
                                            <div key={viewer.clientId} className="flex items-center gap-2 px-3 py-1.5">
                                                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                                                <span className="text-xs text-[var(--app-fg)] truncate">
                                                    {viewer.email.split('@')[0]}
                                                </span>
                                            </div>
                                        ))}
                                        <div className="my-1 border-t border-[var(--app-divider)]" />
                                    </>
                                )}
                                {/* 分享会话 - 只有创建者可以分享 */}
                                {isCreator && userPreferences?.shareAllSessions === true ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMoreMenu(false)
                                            setPrivacyModeMutation.mutate(!privacyMode)
                                        }}
                                        disabled={setPrivacyModeMutation.isPending}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            privacyMode
                                                ? 'text-red-600 bg-red-500/10'
                                                : 'text-green-600 bg-green-500/10'
                                        } ${setPrivacyModeMutation.isPending ? 'opacity-50' : ''}`}
                                    >
                                        {privacyMode ? <LockIcon className="shrink-0" /> : <UnlockIcon className="shrink-0" />}
                                        <span>{privacyMode ? 'Private Mode' : 'Public Mode'}</span>
                                    </button>
                                ) : isCreator && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMoreMenu(false)
                                            setShowShareDialog(true)
                                        }}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                                    >
                                        <ShareIcon className="shrink-0" />
                                        <span>Share Session</span>
                                    </button>
                                )}
                                {/* 刷新账号 */}
                                {props.onRefreshAccount ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMoreMenu(false)
                                            props.onRefreshAccount?.()
                                        }}
                                        disabled={props.refreshAccountDisabled}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <RefreshAccountIcon className="shrink-0" />
                                        <span className="whitespace-nowrap">Refresh Session</span>
                                    </button>
                                ) : null}

                                {/* 删除会话 - 只有创建者可见 */}
                                {isCreator && props.onDelete ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMoreMenu(false)
                                            props.onDelete?.()
                                        }}
                                        disabled={props.deleteDisabled}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <TrashIcon className="shrink-0" />
                                        <span className="whitespace-nowrap">Delete Session</span>
                                    </button>
                                ) : null}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {/* Share Dialog */}
            {showShareDialog && (
                <ShareDialog
                    sessionId={props.session.id}
                    onClose={() => setShowShareDialog(false)}
                />
            )}
        </div>
    )
}
