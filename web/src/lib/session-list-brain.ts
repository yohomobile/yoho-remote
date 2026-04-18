import type { SessionSummary } from '@/types/api'

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

function isBrainSession(session: SessionSummary): boolean {
    return session.metadata?.source === 'brain'
}

function isBrainChildSession(session: SessionSummary): boolean {
    return session.metadata?.source === 'brain-child'
}

function getSessionTimestamp(session: SessionSummary): number {
    return session.lastMessageAt ?? session.updatedAt
}

function getSessionRank(session: SessionSummary): number {
    if (!session.active) return 2
    return session.pendingRequestsCount > 0 ? 0 : 1
}

function compareSessions(left: SessionSummary, right: SessionSummary): number {
    const rankDiff = getSessionRank(left) - getSessionRank(right)
    if (rankDiff !== 0) return rankDiff
    return getSessionTimestamp(right) - getSessionTimestamp(left)
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
        ? (left.statusSummary.active ? (left.statusSummary.pendingRequestsCount > 0 ? 0 : 1) : 2)
        : getSessionRank(left.session)
    const rightRank = right.kind === 'brain-group'
        ? (right.statusSummary.active ? (right.statusSummary.pendingRequestsCount > 0 ? 0 : 1) : 2)
        : getSessionRank(right.session)
    if (leftRank !== rightRank) return leftRank - rightRank

    const leftTimestamp = left.kind === 'brain-group' ? left.statusSummary.timestamp : getSessionTimestamp(left.session)
    const rightTimestamp = right.kind === 'brain-group' ? right.statusSummary.timestamp : getSessionTimestamp(right.session)
    return rightTimestamp - leftTimestamp
}

export function buildSessionListEntries(sessions: SessionSummary[]): SessionListEntry[] {
    if (!Array.isArray(sessions) || sessions.length === 0) return []

    const visibleBrainParents = new Map<string, SessionSummary>()
    sessions.forEach(session => {
        if (isBrainSession(session)) {
            visibleBrainParents.set(session.id, session)
        }
    })

    const childrenByParent = new Map<string, SessionSummary[]>()
    sessions.forEach(session => {
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
    sessions.forEach(session => {
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

        const children = [...(childrenByParent.get(session.id) ?? [])].sort(compareSessions)
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

    return entries.sort(compareEntries)
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
