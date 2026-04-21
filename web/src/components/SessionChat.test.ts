import { describe, expect, test } from 'bun:test'

import { MODEL_MODE_VALUES, coerceModelMode, getSessionChatConnectionNotices, getSessionConnectionState } from './SessionChat'

describe('SessionChat model mode coercion', () => {
    test('includes opus-4-7 in the allowed model values', () => {
        expect(MODEL_MODE_VALUES.has('opus-4-7')).toBe(true)
    })

    test('preserves opus-4-7 during coercion', () => {
        expect(coerceModelMode('opus-4-7')).toBe('opus-4-7')
        expect(coerceModelMode('claude-opus-4-7')).toBe('opus-4-7')
    })

    test('does not collapse opus-4-7 to opus or default', () => {
        expect(coerceModelMode('opus-4-7')).not.toBe('opus')
        expect(coerceModelMode('opus-4-7')).not.toBe('default')
    })
})

describe('SessionChat reconnecting semantics', () => {
    test('treats reconnecting as a distinct state from inactive', () => {
        expect(getSessionConnectionState({
            active: false,
            reconnecting: true,
        })).toBe('reconnecting')

        expect(getSessionConnectionState({
            active: false,
            reconnecting: false,
        })).toBe('inactive')
    })

    test('renders reconnecting notices instead of inactive copy', () => {
        const notices = getSessionChatConnectionNotices({
            connectionState: 'reconnecting',
            showComposer: true,
            isResuming: false,
            resumeError: null,
            messageCount: 1,
            brainChildInactiveHint: null,
            canQueueWhileInactive: false,
            terminationReason: null,
        })

        expect(notices.reconnectingText).toContain('reconnecting')
        expect(notices.inactiveText).toBeNull()
        expect(notices.licenseTerminationText).toBeNull()
    })
})
