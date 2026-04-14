import { describe, expect, test } from 'bun:test'
import { shouldBypassOrgGate } from './org-gate'

describe('shouldBypassOrgGate', () => {
    test('allows invitation accept routes to bypass org setup gating', () => {
        expect(shouldBypassOrgGate('/invitations/accept/invite-123')).toBe(true)
    })

    test('keeps normal application routes gated', () => {
        expect(shouldBypassOrgGate('/sessions')).toBe(false)
        expect(shouldBypassOrgGate('/settings')).toBe(false)
    })
})
