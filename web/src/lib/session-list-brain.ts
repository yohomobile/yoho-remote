import type { SessionSummary } from '@/types/api'
import { isArchivedSession } from '@/lib/sessionActivity'

export type BrainGroupStatusSummary = {
    active: boolean
    thinking: boolean
    pendingRequestsCount: number
    timestamp: number
}

export type BrainSessionListEntry = {
    kind: 'brain-group'
    session: SessionSummary
    children: SessionSummary[]
    statusSummary: BrainGroupStatusSummary
}

export type SessionListEntry = {
    kind: 'session'
    session: SessionSummary
} | BrainSessionListEntry

export type SessionListVisibleRow = {
    kind: 'session'
    session: SessionSummary
    nested: boolean
} | {
    kind: 'brain-group'
    session: SessionSummary
    children: SessionSummary[]
    statusSummary: BrainGroupStatusSummary
    isExpanded: boolean
}

type SessionListSortMode = 'activity' | 'createdAtDesc'

function isBrainSession(session: SessionSummary): boolean {
    return session.metadata?.source === 'brain'
}

function isBrainChildSession(session: SessionSummary): boolean {
    return session.metadata?.source === 'brain-child'
}

function getSessionTimestamp(session: SessionSummary): number {
    return session.lastMessageAt ?? session.updatedAt
}

function compareCreatedAtDescWithStableId(left: SessionSummary, right: SessionSummary): number {
    const createdAtDiff = right.createdAt - left.createdAt
    if (createdAtDiff !== 0) return createdAtDiff
    return left.id.localeCompare(right.id)
}

function getEntryRank(active: boolean): number {
    return active ? 0 : 1
}

function compareActivityAndPending(
    left: { pendingRequestsCount: number; timestamp: number },
    right: { pendingRequestsCount: number; timestamp: number }
): number {
    const timestampDiff = right.timestamp - left.timestamp
    if (timestampDiff !== 0) return timestampDiff
    return right.pendingRequestsCount - left.pendingRequestsCount
}

function compareSessions(left: SessionSummary, right: SessionSummary): number {
    const rankDiff = getEntryRank(left.active) - getEntryRank(right.active)
    if (rankDiff !== 0) return rankDiff
    return compareActivityAndPending(
        {
            pendingRequestsCount: left.pendingRequestsCount,
            timestamp: getSessionTimestamp(left),
        },
        {
            pendingRequestsCount: right.pendingRequestsCount,
            timestamp: getSessionTimestamp(right),
        }
    )
}

function compareSessionsByCreatedAt(left: SessionSummary, right: SessionSummary): number {
    return compareCreatedAtDescWithStableId(left, right)
}

function buildBrainGroupStatusSummary(
    session: SessionSummary,
    children: SessionSummary[]
): BrainGroupStatusSummary {
    const allSessions = [session, ...children]
    const pendingRequestsCount = allSessions.reduce((total, item) => total + item.pendingRequestsCount, 0)
    return {
        active: allSessions.some(item => item.active),
        thinking: pendingRequestsCount === 0 && allSessions.some(item => item.thinking),
        pendingRequestsCount,
        timestamp: allSessions.reduce((max, item) => Math.max(max, getSessionTimestamp(item)), 0)
    }
}

function compareEntries(left: SessionListEntry, right: SessionListEntry): number {
    const leftRank = left.kind === 'brain-group'
        ? getEntryRank(left.statusSummary.active)
        : getEntryRank(left.session.active)
    const rightRank = right.kind === 'brain-group'
        ? getEntryRank(right.statusSummary.active)
        : getEntryRank(right.session.active)
    if (leftRank !== rightRank) return leftRank - rightRank

    return compareActivityAndPending(
        left.kind === 'brain-group'
            ? left.statusSummary
            : {
                pendingRequestsCount: left.session.pendingRequestsCount,
                timestamp: getSessionTimestamp(left.session),
            },
        right.kind === 'brain-group'
            ? right.statusSummary
            : {
                pendingRequestsCount: right.session.pendingRequestsCount,
                timestamp: getSessionTimestamp(right.session),
            }
    )
}

function compareEntriesByCreatedAt(left: SessionListEntry, right: SessionListEntry): number {
    return compareCreatedAtDescWithStableId(left.session, right.session)
}

export function buildSessionListEntries(
    sessions: SessionSummary[],
    options: { sortMode?: SessionListSortMode; includeArchived?: boolean } = {}
): SessionListEntry[] {
    if (!Array.isArray(sessions) || sessions.length === 0) return []
    const sortMode = options.sortMode ?? 'activity'
    const includeArchived = options.includeArchived === true
    const compareSessionRows = sortMode === 'createdAtDesc' ? compareSessionsByCreatedAt : compareSessions
    const compareTopLevelEntries = sortMode === 'createdAtDesc' ? compareEntriesByCreatedAt : compareEntries
    const visibleSessions = includeArchived
        ? sessions
        : sessions.filter((session) => !isArchivedSession(session))

    const visibleBrainParents = new Map<string, SessionSummary>()
    visibleSessions.forEach(session => {
        if (isBrainSession(session)) {
            visibleBrainParents.set(session.id, session)
        }
    })

    const childrenByParent = new Map<string, SessionSummary[]>()
    visibleSessions.forEach(session => {
        if (!isBrainChildSession(session)) return
        const parentId = session.metadata?.mainSessionId
        if (!parentId || !visibleBrainParents.has(parentId)) return
        const bucket = childrenByParent.get(parentId)
        if (bucket) {
            bucket.push(session)
            return
        }
        childrenByParent.set(parentId, [session])
    })

    const entries: SessionListEntry[] = []
    visibleSessions.forEach(session => {
        if (isBrainChildSession(session)) {
            const parentId = session.metadata?.mainSessionId
            if (parentId && visibleBrainParents.has(parentId)) {
                return
            }
        }

        if (!isBrainSession(session)) {
            entries.push({ kind: 'session', session })
            return
        }

        const children = [...(childrenByParent.get(session.id) ?? [])].sort(compareSessionRows)
        if (children.length === 0) {
            entries.push({ kind: 'session', session })
            return
        }

        entries.push({
            kind: 'brain-group',
            session,
            children,
            statusSummary: buildBrainGroupStatusSummary(session, children)
        })
    })

    return entries.sort(compareTopLevelEntries)
}

export function buildVisibleSessionRows(
    entries: SessionListEntry[],
    expandedBrainSessionIds: Iterable<string>
): SessionListVisibleRow[] {
    const expandedIds = new Set(expandedBrainSessionIds)
    const rows: SessionListVisibleRow[] = []

    entries.forEach(entry => {
        if (entry.kind === 'session') {
            rows.push({
                kind: 'session',
                session: entry.session,
                nested: false
            })
            return
        }

        const isExpanded = expandedIds.has(entry.session.id)
        rows.push({
            kind: 'brain-group',
            session: entry.session,
            children: entry.children,
            statusSummary: entry.statusSummary,
            isExpanded
        })

        if (!isExpanded) return

        entry.children.forEach(child => {
            rows.push({
                kind: 'session',
                session: child,
                nested: true
            })
        })
    })

    return rows
}

export function getCollapsedBrainChildCount(
    entries: SessionListEntry[],
    expandedBrainSessionIds: Iterable<string>
): number {
    const expandedIds = new Set(expandedBrainSessionIds)
    return entries.reduce((total, entry) => {
        if (entry.kind !== 'brain-group') return total
        if (expandedIds.has(entry.session.id)) return total
        return total + entry.children.length
    }, 0)
}
