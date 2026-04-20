import { describe, expect, it } from 'bun:test'
import {
    filterBrainChildModelsByRuntimeAvailability,
    machineSupportsBrainChildAgent,
    resolveBrainChildRuntimeAvailability,
} from './brainChildRuntimeSupport'

describe('brainChildRuntimeSupport', () => {
    it('treats null machine restrictions as supporting both agents', () => {
        expect(machineSupportsBrainChildAgent(null, 'claude')).toBe(true)
        expect(machineSupportsBrainChildAgent(null, 'codex')).toBe(true)
    })

    it('intersects machine support with local/token-source availability', () => {
        const availability = resolveBrainChildRuntimeAvailability({
            machineSupportedAgents: ['claude'],
            localTokenSourceEnabled: false,
            tokenSourceIds: {
                claude: 'ts-claude',
                codex: 'ts-codex',
            },
        })

        expect(availability).toEqual({
            claude: true,
            codex: false,
        })
    })

    it('drops child model families that are not actually runnable', () => {
        const filtered = filterBrainChildModelsByRuntimeAvailability({
            availability: {
                claude: false,
                codex: true,
            },
            childClaudeModels: ['sonnet', 'opus'],
            childCodexModels: ['gpt-5.4', 'gpt-5.4-mini'],
        })

        expect(filtered).toEqual({
            childClaudeModels: [],
            childCodexModels: ['gpt-5.4', 'gpt-5.4-mini'],
        })
    })
})
