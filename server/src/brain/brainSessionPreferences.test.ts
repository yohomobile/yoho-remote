import { describe, expect, it } from 'bun:test'

import {
    buildBrainSessionPreferences,
    extractBrainChildModelDefaults,
    getAllowedBrainChildAgents,
    parseBrainSessionPreferences,
} from './brainSessionPreferences'

describe('brainSessionPreferences', () => {
    it('normalizes machine and child model allowlists', () => {
        const preferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childClaudeModels: ['opus'],
            childCodexModels: ['openai/gpt-5.4-mini', 'gpt-5.3-codex'],
        })

        expect(preferences.machineSelection).toEqual({
            mode: 'manual',
            machineId: 'machine-1',
        })
        expect(preferences.childModels.claude.allowed).toEqual(['opus'])
        expect(preferences.childModels.claude.defaultModel).toBe('opus')
        expect(preferences.childModels.codex.allowed).toEqual(['gpt-5.4-mini', 'gpt-5.3-codex'])
        expect(preferences.childModels.codex.defaultModel).toBe('gpt-5.4-mini')
    })

    it('parses saved preferences and derives enabled child agents', () => {
        const preferences = parseBrainSessionPreferences({
            machineSelection: { mode: 'auto', machineId: 'machine-2' },
            childModels: {
                claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                codex: { allowed: [], defaultModel: 'gpt-5.4' },
            },
        })

        expect(preferences?.childModels.claude.allowed).toEqual(['sonnet'])
        expect(getAllowedBrainChildAgents(preferences)).toEqual(['claude'])
    })

    it('reads child model defaults from brainConfig.extra', () => {
        const defaults = extractBrainChildModelDefaults({
            childClaudeModels: ['sonnet'],
            childCodexModels: ['openai/gpt-5.4', 'gpt-5.3-codex'],
        })

        expect(defaults.childClaudeModels).toEqual(['sonnet'])
        expect(defaults.childCodexModels).toEqual(['gpt-5.4', 'gpt-5.3-codex'])
    })
})
