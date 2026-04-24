import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Machine, Project, SessionSummary } from '@/types/api'
import { SessionList } from './SessionList'

function createSession(
    overrides: Partial<SessionSummary> = {}
): SessionSummary {
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

    test('renders Brain self system memory status in the session row', () => {
        const html = renderToStaticMarkup(
            <SessionList
                sessions={[
                    createSession({
                        id: 'brain-session-self',
                        metadata: {
                            path: '/home/dev/.yoho-remote/brain-workspace',
                            source: 'brain',
                            selfSystemEnabled: true,
                            selfProfileId: 'profile-k1',
                            selfProfileName: 'K1',
                            selfProfileResolved: true,
                            selfMemoryProvider: 'yoho-memory',
                            selfMemoryAttached: true,
                            selfMemoryStatus: 'attached',
                        },
                    }),
                ]}
                projects={[] as Project[]}
                currentUserEmail={null}
                archiveFilter="active"
                ownerFilter="brain"
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

        expect(html).toContain('Self: K1 + memory')
    })

    test('renders orchestrator sessions through the regular session list', () => {
        const html = renderToStaticMarkup(
            <SessionList
                sessions={[
                    createSession({
                        id: 'session-orchestrator-active',
                        active: true,
                        metadata: {
                            path: '/tmp/orchestrator-active',
                            source: 'orchestrator',
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

        expect(html).toContain('orchestrator-active')
        expect(html).not.toContain('Orchestrator')
    })
})
