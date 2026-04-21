import { describe, expect, test } from 'bun:test'
import type { SessionSummary } from '@/types/api'
import {
    canQueueMessagesWhenInactive,
    isArchivedSession,
    isIdleBrainChildSession,
    isSessionReconnecting,
    isSessionVisibleInActiveList,
    matchesArchiveFilter,
    shouldShowSessionComposer,
} from './sessionActivity'

function createSession(
    overrides: Partial<Pick<SessionSummary, 'active' | 'reconnecting' | 'pendingRequestsCount' | 'metadata'>> = {}
): Pick<SessionSummary, 'active' | 'reconnecting' | 'pendingRequestsCount' | 'metadata'> {
    return {
        active: true,
        pendingRequestsCount: 0,
        metadata: {
            path: '/tmp/session',
        },
        ...overrides,
    }
}

describe('sessionActivity', () => {
    test('shows composer for regular sessions', () => {
        expect(shouldShowSessionComposer(createSession({
            metadata: {
                path: '/tmp/session',
            },
        }))).toBe(true)
    })

    test('shows composer for main brain sessions', () => {
        expect(shouldShowSessionComposer(createSession({
            metadata: {
                path: '/tmp/brain',
                source: 'brain',
            },
        }))).toBe(true)
    })

    test('allows inactive queueing for main brain sessions', () => {
        expect(canQueueMessagesWhenInactive(createSession({
            metadata: {
                path: '/tmp/brain',
                source: 'brain',
            },
        }))).toBe(true)
    })

    test('hides composer for brain-child sessions', () => {
        expect(shouldShowSessionComposer(createSession({
            metadata: {
                path: '/tmp/child',
                source: 'brain-child',
            },
        }))).toBe(false)
    })

    test('does not allow inactive queueing for brain-child sessions', () => {
        expect(canQueueMessagesWhenInactive(createSession({
            metadata: {
                path: '/tmp/child',
                source: 'brain-child',
            },
        }))).toBe(false)
    })

    test('marks active brain-child sessions without pending work as idle', () => {
        expect(isIdleBrainChildSession(createSession({
            metadata: {
                path: '/tmp/child',
                source: 'brain-child',
            },
        }), false)).toBe(true)
    })

    test('does not mark brain-child sessions with pending requests as idle', () => {
        expect(isIdleBrainChildSession(createSession({
            pendingRequestsCount: 1,
            metadata: {
                path: '/tmp/child',
                source: 'brain-child',
            },
        }), false)).toBe(false)
    })

    test('does not mark brain-child sessions that are still thinking as idle', () => {
        expect(isIdleBrainChildSession(createSession({
            metadata: {
                path: '/tmp/child',
                source: 'brain-child',
            },
        }), true)).toBe(false)
    })

    test('does not mark non brain-child sessions as idle', () => {
        expect(isIdleBrainChildSession(createSession({
            metadata: {
                path: '/tmp/session',
                source: 'brain',
            },
        }), false)).toBe(false)
    })

    test('treats lifecycleState=archived as archived even if the summary still says active', () => {
        const archived = createSession({
            active: true,
            metadata: {
                path: '/tmp/archived-child',
                source: 'brain-child',
                lifecycleState: 'archived',
            },
        })

        expect(isArchivedSession(archived)).toBe(true)
        expect(matchesArchiveFilter(archived, 'active')).toBe(false)
        expect(matchesArchiveFilter(archived, 'archive')).toBe(true)
    })

    test('keeps regular inactive sessions visible in archive view', () => {
        const inactive = createSession({
            active: false,
            metadata: {
                path: '/tmp/inactive-session',
            },
        })

        expect(matchesArchiveFilter(inactive, 'archive')).toBe(true)
    })

    test('treats reconnecting sessions as visible in active view without marking them online', () => {
        const reconnecting = createSession({
            active: false,
            reconnecting: true,
            metadata: {
                path: '/tmp/reconnecting-session',
            },
        })

        expect(isSessionReconnecting(reconnecting)).toBe(true)
        expect(isSessionVisibleInActiveList(reconnecting)).toBe(true)
        expect(matchesArchiveFilter(reconnecting, 'active')).toBe(true)
        expect(matchesArchiveFilter(reconnecting, 'archive')).toBe(false)
    })
})
