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
})
