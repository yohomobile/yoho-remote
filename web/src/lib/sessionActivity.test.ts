import { describe, expect, test } from 'bun:test'
import type { SessionSummary } from '@/types/api'
import { isIdleBrainChildSession } from './sessionActivity'

function createSession(
    overrides: Partial<Pick<SessionSummary, 'active' | 'pendingRequestsCount' | 'metadata'>> = {}
): Pick<SessionSummary, 'active' | 'pendingRequestsCount' | 'metadata'> {
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
})
