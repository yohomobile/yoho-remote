import { describe, expect, test } from 'bun:test'
import type { SessionSummary } from '@/types/api'
import {
    buildSessionListEntries,
    buildVisibleSessionRows,
    getCollapsedBrainChildCount
} from './session-list-brain'

function createSession(
    id: string,
    overrides: Partial<SessionSummary> = {}
): SessionSummary {
    const metadata = {
        path: `/tmp/${id}`,
        ...overrides.metadata,
    }

    return {
        id,
        createdAt: 1,
        active: true,
        activeAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        thinking: false,
        ...overrides,
        metadata,
    }
}

describe('session-list-brain', () => {
    test('keeps brain children collapsed by default and expands them on demand', () => {
        const brain = createSession('brain-1', {
            updatedAt: 100,
            metadata: {
                path: '/tmp/brain-1',
                source: 'brain',
            },
        })
        const child = createSession('child-1', {
            updatedAt: 300,
            pendingRequestsCount: 1,
            metadata: {
                path: '/tmp/child-1',
                source: 'brain-child',
                mainSessionId: 'brain-1',
            },
        })
        const regular = createSession('session-1', {
            updatedAt: 200,
        })

        const entries = buildSessionListEntries([regular, child, brain])
        expect(entries).toHaveLength(2)
        expect(entries[0]).toMatchObject({
            kind: 'brain-group',
            session: { id: 'brain-1' },
            children: [{ id: 'child-1' }],
            statusSummary: {
                active: true,
                reconnecting: false,
                pendingRequestsCount: 1,
                timestamp: 300,
            },
        })

        const collapsedRows = buildVisibleSessionRows(entries, [])
        expect(collapsedRows.map(row => row.session.id)).toEqual(['brain-1', 'session-1'])
        expect(getCollapsedBrainChildCount(entries, [])).toBe(1)

        const expandedRows = buildVisibleSessionRows(entries, ['brain-1'])
        expect(expandedRows.map(row => row.session.id)).toEqual(['brain-1', 'child-1', 'session-1'])
        expect(expandedRows[1]).toMatchObject({
            kind: 'session',
            session: { id: 'child-1' },
            nested: true,
        })
        expect(getCollapsedBrainChildCount(entries, ['brain-1'])).toBe(0)
    })

    test('keeps orphan brain-child sessions visible as top-level rows', () => {
        const orphanChild = createSession('child-orphan', {
            updatedAt: 400,
            metadata: {
                path: '/tmp/child-orphan',
                source: 'brain-child',
                mainSessionId: 'missing-brain',
            },
        })
        const regular = createSession('session-1', {
            updatedAt: 200,
        })

        const entries = buildSessionListEntries([regular, orphanChild])

        expect(entries).toHaveLength(2)
        expect(entries[0]).toMatchObject({
            kind: 'session',
            session: { id: 'child-orphan' },
        })
        expect(entries[1]).toMatchObject({
            kind: 'session',
            session: { id: 'session-1' },
        })
    })

    test('keeps orchestrator sessions as regular top-level rows', () => {
        const orchestrator = createSession('orch-1', {
            updatedAt: 100,
            metadata: {
                path: '/tmp/orch-1',
                source: 'orchestrator',
            },
        })
        const child = createSession('orch-child-1', {
            updatedAt: 200,
            metadata: {
                path: '/tmp/orch-child-1',
                source: 'orchestrator-child',
                mainSessionId: 'orch-1',
            },
        })

        const entries = buildSessionListEntries([child, orchestrator])

        expect(entries).toHaveLength(2)
        expect(entries[0]).toMatchObject({
            kind: 'session',
            session: { id: 'orch-child-1' },
        })
        expect(entries[1]).toMatchObject({
            kind: 'session',
            session: { id: 'orch-1' },
        })
    })

    test('does not group mismatched orchestration child sources under the wrong parent profile', () => {
        const orchestrator = createSession('orch-1', {
            updatedAt: 100,
            metadata: {
                path: '/tmp/orch-1',
                source: 'orchestrator',
            },
        })
        const wrongChild = createSession('brain-child-1', {
            updatedAt: 200,
            metadata: {
                path: '/tmp/brain-child-1',
                source: 'brain-child',
                mainSessionId: 'orch-1',
            },
        })

        const entries = buildSessionListEntries([wrongChild, orchestrator])

        expect(entries).toHaveLength(2)
        expect(entries[0]).toMatchObject({
            kind: 'session',
            session: { id: 'brain-child-1' },
        })
        expect(entries[1]).toMatchObject({
            kind: 'session',
            session: { id: 'orch-1' },
        })
    })

    test('prefers recent activity over pending count for top-level active entries', () => {
        const stalePending = createSession('session-stale-pending', {
            updatedAt: 100,
            lastMessageAt: 100,
            pendingRequestsCount: 3,
        })
        const fresh = createSession('session-fresh', {
            updatedAt: 300,
            lastMessageAt: 300,
            pendingRequestsCount: 0,
        })

        const entries = buildSessionListEntries([stalePending, fresh])

        expect(entries.map((entry) => entry.session.id)).toEqual([
            'session-fresh',
            'session-stale-pending',
        ])
    })

    test('treats reconnecting sessions as active-looking for list ordering and brain group status', () => {
        const reconnectingBrain = createSession('brain-reconnecting', {
            active: false,
            reconnecting: true,
            updatedAt: 200,
            metadata: {
                path: '/tmp/brain-reconnecting',
                source: 'brain',
            },
        })
        const reconnectingChild = createSession('child-reconnecting', {
            active: false,
            reconnecting: true,
            updatedAt: 220,
            metadata: {
                path: '/tmp/child-reconnecting',
                source: 'brain-child',
                mainSessionId: 'brain-reconnecting',
            },
        })
        const offline = createSession('session-offline', {
            active: false,
            updatedAt: 999,
        })

        const entries = buildSessionListEntries([offline, reconnectingChild, reconnectingBrain])

        expect(entries[0]).toMatchObject({
            kind: 'brain-group',
            session: { id: 'brain-reconnecting' },
            statusSummary: {
                active: true,
                reconnecting: true,
            },
        })
        expect(entries[1]).toMatchObject({
            kind: 'session',
            session: { id: 'session-offline' },
        })
    })

    test('prefers recent activity over pending count for brain children within a group', () => {
        const brain = createSession('brain-1', {
            createdAt: 10,
            updatedAt: 50,
            metadata: {
                path: '/tmp/brain-1',
                source: 'brain',
            },
        })
        const stalePendingChild = createSession('child-old', {
            createdAt: 20,
            updatedAt: 100,
            lastMessageAt: 100,
            pendingRequestsCount: 2,
            metadata: {
                path: '/tmp/child-old',
                source: 'brain-child',
                mainSessionId: 'brain-1',
            },
        })
        const freshChild = createSession('child-new', {
            createdAt: 30,
            updatedAt: 300,
            lastMessageAt: 300,
            pendingRequestsCount: 0,
            metadata: {
                path: '/tmp/child-new',
                source: 'brain-child',
                mainSessionId: 'brain-1',
            },
        })

        const entries = buildSessionListEntries([stalePendingChild, freshChild, brain])
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'brain-group',
            children: [
                { id: 'child-new' },
                { id: 'child-old' },
            ],
            statusSummary: {
                timestamp: 300,
                pendingRequestsCount: 2,
            },
        })
    })

    test('sorts top-level brain entries by createdAt desc in brain list mode', () => {
        const staleNewer = createSession('brain-newer', {
            createdAt: 300,
            active: false,
            updatedAt: 100,
            metadata: {
                path: '/tmp/brain-newer',
                source: 'brain',
            },
        })
        const activeOlder = createSession('brain-older', {
            createdAt: 100,
            active: true,
            updatedAt: 999,
            lastMessageAt: 999,
            metadata: {
                path: '/tmp/brain-older',
                source: 'brain',
            },
        })
        const orphanChild = createSession('child-middle', {
            createdAt: 200,
            active: true,
            updatedAt: 500,
            lastMessageAt: 500,
            metadata: {
                path: '/tmp/child-middle',
                source: 'brain-child',
                mainSessionId: 'missing-brain',
            },
        })

        const entries = buildSessionListEntries([activeOlder, staleNewer, orphanChild], {
            sortMode: 'createdAtDesc',
        })

        expect(entries.map((entry) => entry.session.id)).toEqual([
            'brain-newer',
            'child-middle',
            'brain-older',
        ])
    })

    test('sorts grouped brain children by createdAt desc in brain list mode', () => {
        const brain = createSession('brain-1', {
            createdAt: 100,
            updatedAt: 100,
            metadata: {
                path: '/tmp/brain-1',
                source: 'brain',
            },
        })
        const newerChild = createSession('child-newer', {
            createdAt: 300,
            updatedAt: 50,
            metadata: {
                path: '/tmp/child-newer',
                source: 'brain-child',
                mainSessionId: 'brain-1',
            },
        })
        const olderChild = createSession('child-older', {
            createdAt: 200,
            updatedAt: 999,
            lastMessageAt: 999,
            pendingRequestsCount: 2,
            metadata: {
                path: '/tmp/child-older',
                source: 'brain-child',
                mainSessionId: 'brain-1',
            },
        })

        const entries = buildSessionListEntries([olderChild, newerChild, brain], {
            sortMode: 'createdAtDesc',
        })

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'brain-group',
            children: [
                { id: 'child-newer' },
                { id: 'child-older' },
            ],
        })
    })

    test('uses session id as a stable tie-breaker when createdAt matches in brain list mode', () => {
        const alpha = createSession('alpha-session', {
            createdAt: 100,
            metadata: {
                path: '/tmp/alpha-session',
                source: 'brain',
            },
        })
        const beta = createSession('beta-session', {
            createdAt: 100,
            metadata: {
                path: '/tmp/beta-session',
                source: 'brain',
            },
        })

        const entries = buildSessionListEntries([beta, alpha], {
            sortMode: 'createdAtDesc',
        })

        expect(entries.map((entry) => entry.session.id)).toEqual([
            'alpha-session',
            'beta-session',
        ])
    })

    test('drops archived brain children from default grouped entries', () => {
        const brain = createSession('brain-1', {
            updatedAt: 100,
            metadata: {
                path: '/tmp/brain-1',
                source: 'brain',
            },
        })
        const archivedChild = createSession('child-archived', {
            active: true,
            updatedAt: 200,
            metadata: {
                path: '/tmp/child-archived',
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'archived',
            },
        })
        const liveChild = createSession('child-live', {
            updatedAt: 300,
            metadata: {
                path: '/tmp/child-live',
                source: 'brain-child',
                mainSessionId: 'brain-1',
            },
        })

        const entries = buildSessionListEntries([brain, archivedChild, liveChild])

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'brain-group',
            session: { id: 'brain-1' },
            children: [{ id: 'child-live' }],
        })
    })

    test('keeps archived brain children only when explicitly requested', () => {
        const brain = createSession('brain-1', {
            metadata: {
                path: '/tmp/brain-1',
                source: 'brain',
            },
        })
        const archivedChild = createSession('child-archived', {
            active: true,
            metadata: {
                path: '/tmp/child-archived',
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'archived',
            },
        })

        const entries = buildSessionListEntries([brain, archivedChild], {
            includeArchived: true,
        })

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'brain-group',
            children: [{ id: 'child-archived' }],
        })
    })
})
