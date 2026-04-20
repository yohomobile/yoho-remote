import { describe, expect, test } from 'bun:test'

import {
    getCompatibleTokenSources,
    LOCAL_TOKEN_SOURCE,
    machineSupportsTokenSourceAgent,
} from './tokenSources'

describe('tokenSources', () => {
    test('treats Local as machine-dependent instead of universally supporting both agents', () => {
        expect(machineSupportsTokenSourceAgent(['codex'], 'claude')).toBe(false)
        expect(machineSupportsTokenSourceAgent(['codex'], 'codex')).toBe(true)
    })

    test('filters Local out of incompatible agent lists on a machine', () => {
        const compatibleClaude = getCompatibleTokenSources([LOCAL_TOKEN_SOURCE], 'claude', {
            machineSupportedAgents: ['codex'],
        })
        const compatibleCodex = getCompatibleTokenSources([LOCAL_TOKEN_SOURCE], 'codex', {
            machineSupportedAgents: ['codex'],
        })

        expect(compatibleClaude).toEqual([])
        expect(compatibleCodex).toEqual([LOCAL_TOKEN_SOURCE])
    })

    test('keeps Local compatible when no machine-specific restriction is applied', () => {
        expect(getCompatibleTokenSources([LOCAL_TOKEN_SOURCE], 'claude')).toEqual([LOCAL_TOKEN_SOURCE])
        expect(getCompatibleTokenSources([LOCAL_TOKEN_SOURCE], 'codex')).toEqual([LOCAL_TOKEN_SOURCE])
    })
})
