import { useMemo, useState } from 'react'
import type { Project, SessionSummary } from '@/types/api'
import { ViewersBadge } from './ViewersBadge'
import { LoadingState } from './LoadingState'

// Filter types
type ArchiveFilter = boolean  // true = show archived (offline) sessions only
type OwnerFilter = 'mine' | 'openclaw' | 'others'

function getSessionPath(session: SessionSummary): string | null {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? null
}

function matchSessionToProject(session: SessionSummary, projects: Project[]): Project | null {
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

// Get agent type (used for OpenCode display logic)
function getAgentType(session: SessionSummary): 'claude' | 'codex' | 'opencode' | 'other' {
    const flavor = session.metadata?.flavor?.trim()?.toLowerCase()
    if (flavor === 'claude') return 'claude'
    if (flavor === 'codex') return 'codex'
    if (flavor === 'opencode') return 'opencode'
    return 'other'
}

// Sort sessions flat
function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
    if (!Array.isArray(sessions)) return []
    return [...sessions].sort((a, b) => {
        const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
        const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
        if (rankA !== rankB) return rankA - rankB
        return b.updatedAt - a.updatedAt
    })
}

// Filter sessions
function filterSessions(
    sessions: SessionSummary[],
    archiveFilter: ArchiveFilter,
    ownerFilter: OwnerFilter
): SessionSummary[] {
    return sessions.filter(session => {
        // Archive filter: if true, show only offline sessions; if false, show only active sessions
        if (archiveFilter && session.active) return false
        if (!archiveFilter && !session.active) return false

        // Owner filter
        const isOpenClawSession = session.metadata?.source === 'openclaw'
        if (ownerFilter === 'mine') {
            if (session.ownerEmail) return false
            if (isOpenClawSession) return false
        } else if (ownerFilter === 'openclaw') {
            if (!isOpenClawSession) return false
        } else if (ownerFilter === 'others') {
            if (!session.ownerEmail) return false
        }

        return true
    })
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

function getSessionTitle(session: SessionSummary): string {
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

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor?.trim()
    if (flavor === 'claude') return 'Claude'
    if (flavor === 'codex') return 'Codex'
    if (flavor === 'opencode') return 'OpenCode'
    if (flavor === 'gemini') return 'Gemini'
    if (flavor) return flavor
    return 'Agent'
}

function getSourceTag(session: SessionSummary): { label: string; color: string } | null {
    const source = session.metadata?.source?.trim()
    if (!source) return null
    // Machine/automation session tags
    if (source.includes('_repair')) {
        return { label: '🤖 Auto Repair', color: 'bg-purple-500/15 text-purple-600' }
    }
    if (source === 'brain') {
        return { label: '🧠 Brain', color: 'bg-amber-500/15 text-amber-600' }
    }
    if (source === 'brain-child') {
        return { label: '🧠 子任务', color: 'bg-amber-500/15 text-amber-500' }
    }
    if (source === 'openclaw') {
        return { label: '🦀 OpenClaw', color: 'bg-teal-500/15 text-teal-600' }
    }
    if (source === 'external-api') {
        return { label: '🔌 API', color: 'bg-blue-500/15 text-blue-600' }
    }
    if (source.startsWith('automation:') || source.startsWith('bot:') || source.startsWith('script:')) {
        return { label: '⚙️ Automation', color: 'bg-orange-500/15 text-orange-600' }
    }
    // Other custom sources
    if (source.length > 0 && source !== 'manual' && source !== 'webapp') {
        return { label: source.slice(0, 20), color: 'bg-gray-500/15 text-gray-600' }
    }
    return null
}

// OpenCode 特有状态和配置显示
function getOpenCodeStatus(session: SessionSummary): { label: string; color: string; icon?: string } | null {
    if (getAgentType(session) !== 'opencode') return null
    
    const status = session.metadata?.opencodeStatus
    if (!status) return null
    
    if (!status.initialized) {
        return { label: '初始化中', color: 'bg-amber-500/15 text-amber-600', icon: '⏳' }
    }
    
    if (!status.sessionActive) {
        return { label: '未激活', color: 'bg-gray-500/15 text-gray-600', icon: '💤' }
    }
    
    if (status.errorCount && status.errorCount > 0) {
        return { label: `${status.errorCount} 错误`, color: 'bg-red-500/15 text-red-600', icon: '⚠️' }
    }
    
    return { label: '运行中', color: 'bg-emerald-500/15 text-emerald-600', icon: '✅' }
}

function getOpenCodeModelDisplay(session: SessionSummary): string | null {
    if (getAgentType(session) !== 'opencode') return null
    
    const model = session.metadata?.runtimeModel
    const effort = session.metadata?.runtimeModelReasoningEffort
    
    if (!model) return null
    
    const modelName = model.includes('/') ? model.split('/')[1] : model
    let display = modelName
    
    if (effort) {
        const effortMap: Record<string, string> = {
            'low': '🟢 低',
            'medium': '🟡 中', 
            'high': '🟠 高',
            'xhigh': '🔴 极高'
        }
        display += ` ${effortMap[effort] || effort}`
    }
    
    return display
}

function getOpenCodeCapabilities(session: SessionSummary): string[] | null {
    if (getAgentType(session) !== 'opencode') return null
    
    const caps = session.metadata?.opencodeCapabilities
    if (!caps) return null
    
    const capabilities: string[] = []
    if (caps.fs) capabilities.push('📁 文件')
    if (caps.terminal) capabilities.push('💻 终端')
    if (caps.mcp) capabilities.push('🔌 MCP')
    if (caps.tools && caps.tools.length > 0) {
        capabilities.push(`🛠️ ${caps.tools.length} 工具`)
    }
    
    return capabilities.length > 0 ? capabilities : null
}

function formatRelativeTime(value: number): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return 'now'
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    return new Date(ms).toLocaleDateString()
}

// Get display name from email (first part before @, or full email if short)
function getCreatorDisplayName(email: string | undefined | null): string | null {
    if (!email) return null
    const atIndex = email.indexOf('@')
    if (atIndex === -1) return email
    const name = email.slice(0, atIndex)
    return name.length > 0 ? name : email
}

function SessionItem(props: {
    session: SessionSummary
    project: Project | null
    currentUserEmail: string | null
    onSelect: (sessionId: string) => void
}) {
    const { session: s, project, currentUserEmail, onSelect } = props

    // Check if session was created by current user
    const isMySession = currentUserEmail && s.createdBy
        ? s.createdBy.toLowerCase() === currentUserEmail.toLowerCase()
        : false
    const progress = getTodoProgress(s)
    const hasPending = s.pendingRequestsCount > 0
    const runtimeAgent = s.metadata?.runtimeAgent?.trim()
    const sourceTag = getSourceTag(s)
    
    // OpenCode 特有信息
    const openCodeStatus = getOpenCodeStatus(s)
    const openCodeModelDisplay = getOpenCodeModelDisplay(s)
    const openCodeCapabilities = getOpenCodeCapabilities(s)

    return (
        <button
            type="button"
            onClick={() => onSelect(s.id)}
            className={`
                group flex w-full items-center gap-3 px-3 py-2.5 text-left
                transition-all duration-150
                hover:bg-[var(--app-secondary-bg)]
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]
                ${!s.active ? 'opacity-40' : ''}
            `}
        >
            {/* Status indicator */}
            <div className="shrink-0">
                <span
                    className={`
                        block h-2 w-2 rounded-full
                        ${hasPending ? 'bg-amber-500 animate-pulse' : s.active ? 'bg-emerald-500' : 'bg-gray-400'}
                    `}
                />
            </div>

            {/* Main content */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="truncate text-sm font-medium text-[var(--app-fg)]">
                        {getSessionTitle(s)}
                    </span>
                    {sourceTag && (
                        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${sourceTag.color}`}>
                            {sourceTag.label}
                        </span>
                    )}
                    {openCodeStatus && (
                        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${openCodeStatus.color}`}>
                            {openCodeStatus.icon} {openCodeStatus.label}
                        </span>
                    )}
                    {hasPending && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600">
                            {s.pendingRequestsCount} pending
                        </span>
                    )}
                    {s.viewers && s.viewers.length > 0 && (
                        <ViewersBadge viewers={s.viewers} />
                    )}
                </div>
                <div className="flex items-center gap-1 mt-0.5 text-[11px] text-[var(--app-hint)] flex-wrap">
                    <span className="shrink-0">{getAgentLabel(s)}</span>
                    {openCodeModelDisplay && (
                        <>
                            <span className="opacity-50">·</span>
                            <span className="shrink-0 font-medium" title={s.metadata?.runtimeModel}>
                                {openCodeModelDisplay}
                            </span>
                        </>
                    )}
                    {project && (
                        <>
                            <span className="opacity-50">·</span>
                            <span className="truncate" title={project.path}>{project.name}</span>
                        </>
                    )}
                    {s.ownerEmail && (
                        <>
                            <span className="opacity-50">·</span>
                            <span className="shrink-0 text-blue-500" title={s.ownerEmail}>@ {getCreatorDisplayName(s.ownerEmail)}</span>
                        </>
                    )}
                    {!isMySession && s.createdBy && !s.ownerEmail && (
                        <>
                            <span className="opacity-50">·</span>
                            <span className="shrink-0" title={s.createdBy}>share by {getCreatorDisplayName(s.createdBy)}</span>
                        </>
                    )}
                </div>
                {/* OpenCode 能力显示 */}
                {openCodeCapabilities && openCodeCapabilities.length > 0 && (
                    <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--app-hint)]">
                        {openCodeCapabilities.map((cap, index) => (
                            <span key={index} className="shrink-0 px-1 py-0.5 bg-[var(--app-subtle-bg)] rounded">
                                {cap}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {/* Time */}
            <div className="shrink-0 text-[11px] text-[var(--app-hint)]">
                {formatRelativeTime(s.updatedAt)}
            </div>
        </button>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    projects: Project[]
    currentUserEmail: string | null
    viewOthersSessions?: boolean
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
}) {
    const { renderHeader = true, viewOthersSessions = false } = props

    // Filter state - defaults: not archived, show mine by default
    const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>(false)
    const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('mine')

    // Build session to project mapping (still used for display)
    const sessionProjectMap = useMemo(() => {
        const map = new Map<string, Project | null>()
        if (Array.isArray(props.sessions) && Array.isArray(props.projects)) {
            props.sessions.forEach(session => {
                map.set(session.id, matchSessionToProject(session, props.projects))
            })
        }
        return map
    }, [props.sessions, props.projects])

    // Filter and sort sessions (flat display)
    const filteredSessions = useMemo(() => {
        const filtered = filterSessions(props.sessions, archiveFilter, ownerFilter)
        return sortSessions(filtered)
    }, [props.sessions, archiveFilter, ownerFilter])

    // Check if there are any openclaw sessions
    const hasOpenClawSessions = useMemo(() =>
        props.sessions.some(s => s.metadata?.source === 'openclaw'),
        [props.sessions]
    )

    // Statistics
    const activeCount = filteredSessions.filter(s => s.active).length

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {filteredSessions.length} sessions
                        {activeCount > 0 && ` (${activeCount} active)`}
                    </div>
                    <button
                        type="button"
                        onClick={props.onNewSession}
                        className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                        title="New Session"
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            {/* Filters */}
            <div className="flex items-center gap-4 px-3 py-2 border-b border-[var(--app-divider)]">
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs text-[var(--app-hint)] shrink-0">Filter:</span>
                    <button
                        type="button"
                        onClick={() => setArchiveFilter(!archiveFilter)}
                        className={`
                            px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                            ${archiveFilter
                                ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm'
                                : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                            }
                        `}
                    >
                        {archiveFilter ? 'Archive' : 'Active'}
                    </button>
                </div>
                {(viewOthersSessions || hasOpenClawSessions) && (
                    <div className="flex items-center gap-1.5 min-w-0">
                        <div className="flex items-center gap-1">
                            {(viewOthersSessions || hasOpenClawSessions) && (
                                <button
                                    type="button"
                                    onClick={() => setOwnerFilter('mine')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${ownerFilter === 'mine'
                                            ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                        }
                                    `}
                                >
                                    Mine
                                </button>
                            )}
                            {hasOpenClawSessions && (
                                <button
                                    type="button"
                                    onClick={() => setOwnerFilter('openclaw')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${ownerFilter === 'openclaw'
                                            ? 'bg-gradient-to-r from-teal-500 to-emerald-600 text-white shadow-sm'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                        }
                                    `}
                                >
                                    OpenClaw
                                </button>
                            )}
                            {viewOthersSessions && (
                                <button
                                    type="button"
                                    onClick={() => setOwnerFilter('others')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${ownerFilter === 'others'
                                            ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                        }
                                    `}
                                >
                                    Others
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Sessions list */}
            <div className="flex flex-col divide-y divide-[var(--app-divider)]">
                {props.isLoading && filteredSessions.length === 0 ? (
                    <div className="px-3 py-8 flex justify-center">
                        <LoadingState label="Loading..." spinnerSize="sm" />
                    </div>
                ) : filteredSessions.length === 0 ? (
                    <div className="px-3 py-8 text-center text-sm text-[var(--app-hint)]">
                        No matching sessions
                    </div>
                ) : (
                    filteredSessions.map((session) => (
                        <SessionItem
                            key={session.id}
                            session={session}
                            project={sessionProjectMap.get(session.id) ?? null}
                            currentUserEmail={props.currentUserEmail}
                            onSelect={props.onSelect}
                        />
                    ))
                )}
            </div>
        </div>
    )
}
