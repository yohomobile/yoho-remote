import { useMemo } from 'react'
import type { Machine, Project, SessionSummary } from '@/types/api'
import { ViewersBadge } from './ViewersBadge'
import { LoadingState } from './LoadingState'
import { useVibingMessage } from '@/hooks/useVibingMessage'
import { getMachineTitle } from '@/lib/machines'
import type { ArchiveFilter, OwnerFilter } from '@/lib/session-filters'

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
        // Archive filter
        if (archiveFilter === 'archive' && session.active) return false
        if (archiveFilter === 'active' && !session.active) return false

        // Owner filter
        const isOpenClawSession = session.metadata?.source === 'openclaw'
        const isBrainSession = session.metadata?.source === 'brain' || session.metadata?.source === 'brain-child'
        if (ownerFilter === 'mine') {
            if (session.ownerEmail) return false
            if (isOpenClawSession) return false
            if (isBrainSession) return false
        } else if (ownerFilter === 'openclaw') {
            if (!isOpenClawSession) return false
        } else if (ownerFilter === 'brain') {
            if (!isBrainSession) return false
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

function getSessionModelLabel(session: SessionSummary): string | null {
    const runtimeModel = session.metadata?.runtimeModel?.trim()
    if (!runtimeModel) return null
    const effort = session.metadata?.runtimeModelReasoningEffort
    return effort ? `${runtimeModel} (${effort})` : runtimeModel
}

function getSessionMachineLabel(session: SessionSummary, machineMap: Map<string, Machine>): string | null {
    const machineId = session.metadata?.machineId
    if (!machineId) return null
    const machine = machineMap.get(machineId)
    if (machine) {
        return getMachineTitle(machine)
    }
    return machineId.slice(0, 8)
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

function TrashIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
    )
}

function SessionItem(props: {
    session: SessionSummary
    project: Project | null
    currentUserEmail: string | null
    onSelect: (sessionId: string) => void
    onDelete?: (sessionId: string) => void
    modelLabel?: string | null
    machineName?: string | null
}) {
    const { session: s, project, currentUserEmail, onSelect, onDelete, modelLabel, machineName } = props
    const isBrainSession = s.metadata?.source === 'brain'

    // Check if session was created by current user
    const isMySession = currentUserEmail && s.createdBy
        ? s.createdBy.toLowerCase() === currentUserEmail.toLowerCase()
        : false
    const progress = getTodoProgress(s)
    const hasPending = s.pendingRequestsCount > 0
    const isThinking = s.thinking && !hasPending  // thinking but not waiting for permission
    const vibingMessage = useVibingMessage(Boolean(isThinking))
    const runtimeAgent = s.metadata?.runtimeAgent?.trim()
    const sourceTag = getSourceTag(s)

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
                        ${!s.active ? 'bg-[#999]' : hasPending ? 'bg-[#FF9500] animate-pulse' : isThinking ? 'bg-[#007AFF] animate-pulse' : 'bg-[#34C759]'}
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
                    {hasPending && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600">
                            {s.pendingRequestsCount} pending
                        </span>
                    )}
                    {s.terminationReason?.startsWith('LICENSE_') && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-500">
                            {s.terminationReason === 'LICENSE_SUSPENDED' ? 'License suspended' : 'License expired'}
                        </span>
                    )}
                    {s.viewers && s.viewers.length > 0 && (
                        <ViewersBadge viewers={s.viewers} />
                    )}
                </div>
                <div className="flex items-center gap-1 mt-0.5 text-[11px] text-[var(--app-hint)] flex-wrap">
                    <span className="shrink-0">{getAgentLabel(s)}</span>
                    {modelLabel && (
                        <>
                            <span className="opacity-50">·</span>
                            <span
                                className="shrink-0 text-[11px] text-[var(--app-hint)] whitespace-nowrap overflow-hidden truncate max-w-[160px]"
                                title={modelLabel}
                            >
                                {modelLabel}
                            </span>
                        </>
                    )}
                    {machineName && (
                        <>
                            <span className="opacity-50">·</span>
                            <span
                                className="shrink-0 text-[11px] text-[var(--app-hint)] whitespace-nowrap overflow-hidden truncate max-w-[160px]"
                                title={machineName}
                            >
                                {machineName}
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
            </div>

            {/* Status and Time */}
            <div className="shrink-0 flex items-center gap-1.5">
                {!s.active ? (
                    <span className="text-[10px] font-medium text-[#999]">
                        offline
                    </span>
                ) : hasPending ? (
                    <span className="text-[10px] font-medium text-[#FF9500]">
                        permission required
                    </span>
                ) : isThinking ? (
                    <span className="text-[10px] font-medium text-[#007AFF]">
                        {vibingMessage}
                    </span>
                ) : (
                    <span className="text-[10px] font-medium text-[#34C759]">
                        online
                    </span>
                )}
                <span className="text-[11px] text-[var(--app-hint)]">
                    {formatRelativeTime(s.updatedAt)}
                </span>
                {isBrainSession && onDelete && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDelete(s.id) }}
                        className="opacity-0 group-hover:opacity-100 flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-all hover:bg-red-500/10 hover:text-red-500"
                        title="Delete brain session"
                    >
                        <TrashIcon />
                    </button>
                )}
            </div>
        </button>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    projects: Project[]
    currentUserEmail: string | null
    viewOthersSessions?: boolean
    archiveFilter: ArchiveFilter
    ownerFilter: OwnerFilter
    onArchiveFilterChange: (value: ArchiveFilter) => void
    onOwnerFilterChange: (value: OwnerFilter) => void
    onSelect: (sessionId: string) => void
    onDelete?: (sessionId: string) => void
    onNewSession: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    machines: Machine[]
}) {
    const { renderHeader = true, viewOthersSessions = false, machines } = props

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

    const machineMap = useMemo(() => {
        const map = new Map<string, Machine>()
        machines.forEach((machine) => {
            map.set(machine.id, machine)
        })
        return map
    }, [machines])

    // Filter and sort sessions (flat display)
    const filteredSessions = useMemo(() => {
        const filtered = filterSessions(props.sessions, props.archiveFilter, props.ownerFilter)
        return sortSessions(filtered)
    }, [props.sessions, props.archiveFilter, props.ownerFilter])

    // Check if there are any openclaw sessions
    const hasOpenClawSessions = useMemo(() =>
        props.sessions.some(s => s.metadata?.source === 'openclaw'),
        [props.sessions]
    )

    // Check if there are any brain or brain-child sessions
    const hasBrainSessions = useMemo(() =>
        props.sessions.some(s => s.metadata?.source === 'brain' || s.metadata?.source === 'brain-child'),
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
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => props.onArchiveFilterChange('active')}
                            className={`
                                px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                ${props.archiveFilter === 'active'
                                    ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm'
                                    : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                }
                            `}
                        >
                            Active
                        </button>
                        <button
                            type="button"
                            onClick={() => props.onArchiveFilterChange('archive')}
                            className={`
                                px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                ${props.archiveFilter === 'archive'
                                    ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm'
                                    : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                }
                            `}
                        >
                            Archive
                        </button>
                    </div>
                </div>
                {(viewOthersSessions || hasOpenClawSessions || hasBrainSessions) && (
                    <div className="flex items-center gap-1.5 min-w-0">
                        <div className="flex items-center gap-1">
                            {(viewOthersSessions || hasOpenClawSessions || hasBrainSessions) && (
                                <button
                                    type="button"
                                    onClick={() => props.onOwnerFilterChange('mine')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${props.ownerFilter === 'mine'
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
                                    onClick={() => props.onOwnerFilterChange('openclaw')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${props.ownerFilter === 'openclaw'
                                            ? 'bg-gradient-to-r from-teal-500 to-emerald-600 text-white shadow-sm'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                        }
                                    `}
                                >
                                    OpenClaw
                                </button>
                            )}
                            {hasBrainSessions && (
                                <button
                                    type="button"
                                    onClick={() => props.onOwnerFilterChange('brain')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${props.ownerFilter === 'brain'
                                            ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-sm'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                        }
                                    `}
                                >
                                    🧠 Brain
                                </button>
                            )}
                            {viewOthersSessions && (
                                <button
                                    type="button"
                                    onClick={() => props.onOwnerFilterChange('others')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${props.ownerFilter === 'others'
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
                    filteredSessions.map((session) => {
                        const modelLabel = getSessionModelLabel(session)
                        const machineName = getSessionMachineLabel(session, machineMap)
                        return (
                            <SessionItem
                                key={session.id}
                                session={session}
                                project={sessionProjectMap.get(session.id) ?? null}
                                currentUserEmail={props.currentUserEmail}
                                onSelect={props.onSelect}
                                onDelete={props.onDelete}
                                modelLabel={modelLabel}
                                machineName={machineName}
                            />
                        )
                    })
                )}
            </div>
        </div>
    )
}
