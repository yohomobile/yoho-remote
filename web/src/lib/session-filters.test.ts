import { describe, expect, test } from 'bun:test'
import { normalizeOwnerFilter } from './session-filters'

describe('normalizeOwnerFilter', () => {
    test('falls back to mine when others filter is unavailable', () => {
        expect(normalizeOwnerFilter('others', {
            viewOthersSessions: false,
            hasOpenClawSessions: true,
            hasBrainSessions: true,
        })).toBe('mine')
    })

    test('falls back to mine when openclaw or brain filters have no matching sessions', () => {
        expect(normalizeOwnerFilter('openclaw', {
            viewOthersSessions: true,
            hasOpenClawSessions: false,
            hasBrainSessions: true,
        })).toBe('mine')

        expect(normalizeOwnerFilter('brain', {
            viewOthersSessions: true,
            hasOpenClawSessions: true,
            hasBrainSessions: false,
        })).toBe('mine')
    })

    test('keeps supported filters unchanged', () => {
        expect(normalizeOwnerFilter('mine', {
            viewOthersSessions: false,
            hasOpenClawSessions: false,
            hasBrainSessions: false,
        })).toBe('mine')

        expect(normalizeOwnerFilter('others', {
            viewOthersSessions: true,
            hasOpenClawSessions: false,
            hasBrainSessions: false,
        })).toBe('others')
    })
})
