import { describe, expect, test } from 'bun:test'
import { normalizeOwnerFilter } from './session-filters'

describe('normalizeOwnerFilter', () => {
    test('falls back to mine when others filter is unavailable', () => {
        expect(normalizeOwnerFilter('others', {
            viewOthersSessions: false,
            hasBrainSessions: true,
        })).toBe('mine')
    })

    test('falls back to mine when brain filter has no matching sessions', () => {
        expect(normalizeOwnerFilter('brain', {
            viewOthersSessions: true,
            hasBrainSessions: false,
        })).toBe('mine')
    })

    test('keeps supported filters unchanged', () => {
        expect(normalizeOwnerFilter('mine', {
            viewOthersSessions: false,
            hasBrainSessions: false,
        })).toBe('mine')

        expect(normalizeOwnerFilter('others', {
            viewOthersSessions: true,
            hasBrainSessions: false,
        })).toBe('others')
    })
})
