import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Machine, Project, SessionSummary } from '@/types/api'
import { SessionList } from './SessionList'

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        createdAt: 1,
        active: true,
        activeAt: 1,
        updatedAt: 1,
        lastMessageAt: 1,
        metadata: {
            path: '/tmp/session-1',
            source: 'codex',
        },
        todoProgress: null,
        pendingRequestsCount: 0,
        thinking: false,
        ...overrides,
    }
}

describe('SessionList', () => {
    test('renders todo progress in the session row when tasks are incomplete', () => {
        const html = renderToStaticMarkup(
            <SessionList
                sessions={[
                    createSession({
                        id: 'session-progress',
                        todoProgress: {
                            completed: 1,
                            total: 3,
                        },
                    }),
                ]}
                projects={[] as Project[]}
                currentUserEmail={null}
                archiveFilter="active"
                ownerFilter="mine"
                onArchiveFilterChange={() => {}}
                onOwnerFilterChange={() => {}}
                onSelect={() => {}}
                onNewSession={() => {}}
                onRefresh={() => {}}
                isLoading={false}
                machines={[] as Machine[]}
                renderHeader={false}
            />
        )

        expect(html).toContain('1/3')
    })

    test('renders reconnecting sessions with reconnecting semantics instead of offline copy', () => {
        const html = renderToStaticMarkup(
            <SessionList
                sessions={[
                    createSession({
                        id: 'session-reconnecting',
                        active: false,
                        reconnecting: true,
                        metadata: {
                            path: '/tmp/session-reconnecting',
                            source: 'codex',
                        },
                    }),
                ]}
                projects={[] as Project[]}
                currentUserEmail={null}
                archiveFilter="active"
                ownerFilter="mine"
                onArchiveFilterChange={() => {}}
                onOwnerFilterChange={() => {}}
                onSelect={() => {}}
                onNewSession={() => {}}
                onRefresh={() => {}}
                isLoading={false}
                machines={[] as Machine[]}
                renderHeader={false}
            />
        )

        expect(html).toContain('reconnecting')
        expect(html).not.toContain('offline')
    })
})
