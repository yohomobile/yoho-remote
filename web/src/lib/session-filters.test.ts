import { describe, expect, test } from 'bun:test'
import { normalizeOwnerFilter, validateNewSessionSearch } from './session-filters'

describe('normalizeOwnerFilter', () => {
    test('accepts orchestrator as a new session kind', () => {
        expect(validateNewSessionSearch({ kind: 'orchestrator' })).toEqual({
            archive: undefined,
            owner: undefined,
            kind: 'orchestrator',
        })
    })

    test('falls back to mine when others filter is unavailable', () => {
        expect(normalizeOwnerFilter('others', {
            viewOthersSessions: false,
            hasBrainSessions: true,
            hasOrchestratorSessions: true,
        })).toBe('mine')
    })

    test('falls back to mine when brain filter has no matching sessions', () => {
        expect(normalizeOwnerFilter('brain', {
            viewOthersSessions: true,
            hasBrainSessions: false,
            hasOrchestratorSessions: true,
        })).toBe('mine')
    })

    test('falls back to mine when orchestrator filter has no matching sessions', () => {
        expect(normalizeOwnerFilter('orchestrator', {
            viewOthersSessions: true,
            hasBrainSessions: true,
            hasOrchestratorSessions: false,
        })).toBe('mine')
    })

    test('keeps supported filters unchanged', () => {
        expect(normalizeOwnerFilter('mine', {
            viewOthersSessions: false,
            hasBrainSessions: false,
            hasOrchestratorSessions: false,
        })).toBe('mine')

        expect(normalizeOwnerFilter('orchestrator', {
            viewOthersSessions: true,
            hasBrainSessions: false,
            hasOrchestratorSessions: true,
        })).toBe('orchestrator')

        expect(normalizeOwnerFilter('others', {
            viewOthersSessions: true,
            hasBrainSessions: false,
            hasOrchestratorSessions: false,
        })).toBe('others')
    })
})
