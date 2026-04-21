import { useMemo, useState, type KeyboardEvent } from 'react'
import type { Machine, Project, SessionSummary } from '@/types/api'
import { ViewersBadge } from './ViewersBadge'
import { LoadingState } from './LoadingState'
import { useVibingMessage } from '@/hooks/useVibingMessage'
import { useDebouncedThinking } from '@/hooks/useDebouncedThinking'
import { getMachineTitle } from '@/lib/machines'
import { formatSessionModelLabel } from '@/lib/sessionModelLabel'
import { matchSessionToProject } from '@/lib/projectMatching'
import {
    isArchivedSession,
    isIdleBrainChildSession,
    isSessionReconnecting,
    isSessionVisibleInActiveList,
    matchesArchiveFilter,
} from '@/lib/sessionActivity'
import {
    buildSessionListEntries,
    getCollapsedBrainChildCount,
    type BrainGroupStatusSummary
} from '@/lib/session-list-brain'
import { normalizeOwnerFilter, type ArchiveFilter, type OwnerFilter } from '@/lib/session-filters'
import { isLicenseTermination, getLicenseTerminationLabel } from '@/lib/license'

const EXPANDED_BRAIN_SESSION_IDS_STORAGE_KEY = 'yr:expandedBrainSessionIds'

function loadExpandedBrainSessionIds(): string[] {
    try {
        const stored = localStorage.getItem(EXPANDED_BRAIN_SESSION_IDS_STORAGE_KEY)
        if (!stored) return []
        const parsed = JSON.parse(stored)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((item): item is string => typeof item === 'string')
    } catch {
        return []
    }
}

function saveExpandedBrainSessionIds(ids: string[]): void {
    try {
        localStorage.setItem(EXPANDED_BRAIN_SESSION_IDS_STORAGE_KEY, JSON.stringify(ids))
    } catch {
        // Ignore storage errors
    }
}

// Filter sessions
function filterSessions(
    sessions: SessionSummary[],
    archiveFilter: ArchiveFilter,
    ownerFilter: OwnerFilter
): SessionSummary[] {
    return sessions.filter(session => {
        // Archive filter
        if (!matchesArchiveFilter(session, archiveFilter)) return false

        // Owner filter
        const isBrainSession = session.metadata?.source === 'brain' || session.metadata?.source === 'brain-child'
        if (ownerFilter === 'mine') {
            if (session.ownerEmail) return false
            if (isBrainSession) return false
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
    if (source === 'external-api') {
        return { label: '🔌 API', color: 'bg-blue-500/15 text-blue-600' }
    }
    if (source.startsWith('automation:') || source.startsWith('bot:') || source.startsWith('script:')) {
        return { label: '⚙️ Automation', color: 'bg-orange-500/15 text-orange-600' }
    }
    return null
}

function getSessionModelLabel(session: SessionSummary): string | null {
    return formatSessionModelLabel({
        modelMode: session.modelMode,
        modelReasoningEffort: session.modelReasoningEffort,
        fastMode: session.fastMode,
        runtimeModel: session.metadata?.runtimeModel,
        runtimeModelReasoningEffort: session.metadata?.runtimeModelReasoningEffort
    })
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

function getBrainSelfLabel(session: SessionSummary): string | null {
    if (session.metadata?.source !== 'brain') {
        return null
    }
    if (session.metadata.selfSystemEnabled !== true) {
        return 'Self: off'
    }
    if (session.metadata.selfProfileResolved === true) {
        const suffix = session.metadata.selfMemoryStatus === 'attached'
            ? ' + memory'
            : session.metadata.selfMemoryStatus === 'error'
                ? ' · memory error'
                : session.metadata.selfMemoryStatus === 'empty'
                    ? ' · memory empty'
                    : session.metadata.selfMemoryStatus === 'skipped'
                        ? ' · memory skipped'
                        : ''
        return `Self: ${session.metadata.selfProfileName ?? session.metadata.selfProfileId ?? 'configured'}${suffix}`
    }
    if (session.metadata.selfProfileId) {
        return session.metadata.selfMemoryStatus === 'skipped'
            ? `Self: unresolved (${session.metadata.selfProfileId.slice(0, 8)}) · memory skipped`
            : `Self: unresolved (${session.metadata.selfProfileId.slice(0, 8)})`
    }
    return 'Self: unresolved'
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

function ChevronIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="9 18 15 12 9 6" />
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
    nested?: boolean
    childCount?: number
    isExpanded?: boolean
    onToggleExpand?: () => void
    statusSummary?: BrainGroupStatusSummary
}) {
    const {
        session: s,
        project,
        currentUserEmail,
        onSelect,
        onDelete,
        modelLabel,
        machineName,
        nested = false,
        childCount = 0,
        isExpanded = false,
        onToggleExpand,
        statusSummary
    } = props
    const isBrainSession = s.metadata?.source === 'brain'

    // Check if session was created by current user
    const isMySession = currentUserEmail && s.createdBy
        ? s.createdBy.toLowerCase() === currentUserEmail.toLowerCase()
        : false
    const progress = getTodoProgress(s)
    const reconnecting = statusSummary?.reconnecting ?? isSessionReconnecting(s)
    const online = statusSummary
        ? (statusSummary.active && !statusSummary.reconnecting)
        : s.active
    const active = statusSummary?.active ?? isSessionVisibleInActiveList(s)
    const pendingRequestsCount = statusSummary?.pendingRequestsCount ?? s.pendingRequestsCount
    const hasPending = pendingRequestsCount > 0
    const debouncedThinking = useDebouncedThinking(Boolean(statusSummary?.thinking ?? s.thinking))
    const isThinking = debouncedThinking && !hasPending
    const isIdleBrainChild = isIdleBrainChildSession(
        {
            active: online,
            pendingRequestsCount,
            metadata: s.metadata,
        },
        isThinking
    )
    const vibingMessage = useVibingMessage(Boolean(isThinking))
    const runtimeAgent = s.metadata?.runtimeAgent?.trim()
    const sourceTag = getSourceTag(s)
    const timestamp = statusSummary?.timestamp ?? (s.lastMessageAt ?? s.updatedAt)
    const brainSelfLabel = getBrainSelfLabel(s)

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect(s.id)
    }

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onSelect(s.id)}
            onKeyDown={handleKeyDown}
            className={`
                group flex w-full items-center gap-3 text-left
                transition-all duration-150
                hover:bg-[var(--app-secondary-bg)]
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]
                ${nested ? 'px-2 py-2' : 'px-3 py-2.5'}
                ${!active ? 'opacity-40' : reconnecting ? 'opacity-80' : ''}
            `}
        >
            {/* Status indicator */}
            <div className="shrink-0">
                <span
                    className={`
                        block h-2 w-2 rounded-full
                        ${!active ? 'bg-[#999]' : reconnecting ? 'bg-[#FFB020] animate-pulse' : hasPending ? 'bg-[#FF9500] animate-pulse' : isThinking ? 'bg-[#007AFF] animate-pulse' : isIdleBrainChild ? 'bg-[#8E8E93]' : 'bg-[#34C759]'}
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
                    {isIdleBrainChild && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-500/15 text-slate-600">
                            空闲
                        </span>
                    )}
                    {reconnecting && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700">
                            重连中
                        </span>
                    )}
                    {childCount > 0 && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                            {childCount} 子任务
                        </span>
                    )}
                    {progress && (
                        <span
                            className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-600"
                            title={`Todo progress ${progress.completed}/${progress.total}`}
                        >
                            {progress.completed}/{progress.total}
                        </span>
                    )}
                    {hasPending && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600">
                            {pendingRequestsCount} pending
                        </span>
                    )}
                    {isLicenseTermination(s.terminationReason) && (
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-500">
                            {getLicenseTerminationLabel(s.terminationReason!)}
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
                {brainSelfLabel && (
                    <div className="mt-0.5 text-[11px] text-[var(--app-hint)] truncate" title={brainSelfLabel}>
                        {brainSelfLabel}
                    </div>
                )}
            </div>

            {/* Status and Time */}
            <div className="shrink-0 flex items-center gap-1.5">
                {onToggleExpand && (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation()
                            onToggleExpand()
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        aria-label={isExpanded ? '收起 brain 子任务' : '展开 brain 子任务'}
                        aria-expanded={isExpanded}
                        title={isExpanded ? 'Collapse brain subtasks' : 'Expand brain subtasks'}
                    >
                        <ChevronIcon className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    </button>
                )}
                {!active ? (
                    <span className="text-[10px] font-medium text-[#999]">
                        offline
                    </span>
                ) : reconnecting ? (
                    <span className="text-[10px] font-medium text-[#FFB020]">
                        reconnecting
                    </span>
                ) : hasPending ? (
                    <span className="text-[10px] font-medium text-[#FF9500]">
                        permission required
                    </span>
                ) : isThinking ? (
                    <span className="text-[10px] font-medium text-[#007AFF]">
                        {vibingMessage}
                    </span>
                ) : isIdleBrainChild ? (
                    <span className="text-[10px] font-medium text-slate-500">
                        idle
                    </span>
                ) : (
                    <span className="text-[10px] font-medium text-[#34C759]">
                        online
                    </span>
                )}
                <span className="text-[11px] text-[var(--app-hint)]">
                    {formatRelativeTime(timestamp)}
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
        </div>
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
    const [expandedBrainSessionIds, setExpandedBrainSessionIds] = useState<string[]>(loadExpandedBrainSessionIds)

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

    // Check if there are any brain or brain-child sessions
    const hasBrainSessions = useMemo(() =>
        props.sessions.some(s => s.metadata?.source === 'brain' || s.metadata?.source === 'brain-child'),
        [props.sessions]
    )

    const effectiveOwnerFilter = useMemo(() => normalizeOwnerFilter(props.ownerFilter, {
        viewOthersSessions,
        hasBrainSessions,
    }), [hasBrainSessions, props.ownerFilter, viewOthersSessions])

    // Filter sessions first, then build grouped/expandable list entries.
    const filteredSessions = useMemo(() => {
        return filterSessions(props.sessions, props.archiveFilter, effectiveOwnerFilter)
    }, [effectiveOwnerFilter, props.sessions, props.archiveFilter])

    const listEntries = useMemo(
        () => buildSessionListEntries(filteredSessions, {
            sortMode: effectiveOwnerFilter === 'brain' ? 'createdAtDesc' : 'activity',
            includeArchived: props.archiveFilter === 'archive',
        }),
        [effectiveOwnerFilter, filteredSessions, props.archiveFilter]
    )
    const expandedBrainSessionIdSet = useMemo(
        () => new Set(expandedBrainSessionIds),
        [expandedBrainSessionIds]
    )
    const collapsedBrainChildCount = useMemo(
        () => getCollapsedBrainChildCount(listEntries, expandedBrainSessionIdSet),
        [expandedBrainSessionIdSet, listEntries]
    )

    // Statistics
    const visibleActiveCount = filteredSessions.filter((session) => isSessionVisibleInActiveList(session) && !isArchivedSession(session)).length
    const reconnectingCount = filteredSessions.filter((session) => isSessionReconnecting(session) && !isArchivedSession(session)).length
    const archiveFilterLabel = props.archiveFilter === 'active' ? 'Active' : 'Archive'
    const nextArchiveFilter = props.archiveFilter === 'active' ? 'archive' : 'active'
    const nextArchiveFilterLabel = nextArchiveFilter === 'active' ? 'Active' : 'Archive'
    const toggleBrainSession = (sessionId: string) => {
        setExpandedBrainSessionIds(previous => {
            const next = previous.includes(sessionId)
                ? previous.filter(id => id !== sessionId)
                : [...previous, sessionId]
            saveExpandedBrainSessionIds(next)
            return next
        })
    }

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {filteredSessions.length} sessions
                        {visibleActiveCount > 0 && ` (${visibleActiveCount} visible)`}
                        {reconnectingCount > 0 && ` · ${reconnectingCount} reconnecting`}
                        {collapsedBrainChildCount > 0 && ` · ${collapsedBrainChildCount} collapsed`}
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
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--app-divider)]">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-[var(--app-hint)] shrink-0">Filter</span>
                    <button
                        type="button"
                        onClick={() => props.onArchiveFilterChange(nextArchiveFilter)}
                        title={`Showing ${archiveFilterLabel}. Click to view ${nextArchiveFilterLabel}.`}
                        aria-label={`Showing ${archiveFilterLabel}. Click to view ${nextArchiveFilterLabel}.`}
                        className={`
                            px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap text-white shadow-sm
                            ${props.archiveFilter === 'active'
                                ? 'bg-gradient-to-r from-indigo-500 to-purple-600'
                                : 'bg-gradient-to-r from-slate-500 to-slate-600'
                            }
                        `}
                    >
                        {archiveFilterLabel}
                    </button>
                </div>
                {(viewOthersSessions || hasBrainSessions) && (
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-1">
                            {(viewOthersSessions || hasBrainSessions) && (
                                <button
                                    type="button"
                                    onClick={() => props.onOwnerFilterChange('mine')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${effectiveOwnerFilter === 'mine'
                                            ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
                                        }
                                    `}
                                >
                                    Mine
                                </button>
                            )}
                            {hasBrainSessions && (
                                <button
                                    type="button"
                                    onClick={() => props.onOwnerFilterChange('brain')}
                                    className={`
                                        px-2 py-1 text-xs rounded-md transition-colors whitespace-nowrap
                                        ${effectiveOwnerFilter === 'brain'
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
                                        ${effectiveOwnerFilter === 'others'
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
                    listEntries.map((entry) => {
                        if (entry.kind === 'session') {
                            const modelLabel = getSessionModelLabel(entry.session)
                            const machineName = getSessionMachineLabel(entry.session, machineMap)
                            return (
                                <SessionItem
                                    key={entry.session.id}
                                    session={entry.session}
                                    project={sessionProjectMap.get(entry.session.id) ?? null}
                                    currentUserEmail={props.currentUserEmail}
                                    onSelect={props.onSelect}
                                    onDelete={props.onDelete}
                                    modelLabel={modelLabel}
                                    machineName={machineName}
                                />
                            )
                        }

                        const isExpanded = expandedBrainSessionIdSet.has(entry.session.id)
                        const modelLabel = getSessionModelLabel(entry.session)
                        const machineName = getSessionMachineLabel(entry.session, machineMap)

                        return (
                            <div key={entry.session.id} className="flex flex-col">
                                <SessionItem
                                    session={entry.session}
                                    project={sessionProjectMap.get(entry.session.id) ?? null}
                                    currentUserEmail={props.currentUserEmail}
                                    onSelect={props.onSelect}
                                    onDelete={props.onDelete}
                                    modelLabel={modelLabel}
                                    machineName={machineName}
                                    childCount={entry.children.length}
                                    isExpanded={isExpanded}
                                    onToggleExpand={() => toggleBrainSession(entry.session.id)}
                                    statusSummary={entry.statusSummary}
                                />
                                {isExpanded && (
                                    <div className="border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]">
                                        <div className="ml-6 border-l border-[var(--app-divider)]">
                                            {entry.children.map((child, index) => {
                                                const childModelLabel = getSessionModelLabel(child)
                                                const childMachineName = getSessionMachineLabel(child, machineMap)
                                                return (
                                                    <div
                                                        key={child.id}
                                                        className={index > 0 ? 'border-t border-[var(--app-divider)]' : undefined}
                                                    >
                                                        <SessionItem
                                                            session={child}
                                                            project={sessionProjectMap.get(child.id) ?? null}
                                                            currentUserEmail={props.currentUserEmail}
                                                            onSelect={props.onSelect}
                                                            onDelete={props.onDelete}
                                                            modelLabel={childModelLabel}
                                                            machineName={childMachineName}
                                                            nested
                                                        />
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })
                )}
            </div>
        </div>
    )
}
