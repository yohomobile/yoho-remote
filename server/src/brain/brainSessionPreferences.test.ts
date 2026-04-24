import { describe, expect, it } from 'bun:test'

import {
    buildBrainSessionPreferences,
    extractBrainChildModelDefaults,
    getAllowedBrainChildAgents,
    parseBrainSessionPreferences,
    repairBrainSessionPreferencesFromMetadata,
    repairLegacyBrainSessionPreferences,
} from './brainSessionPreferences'

describe('brainSessionPreferences', () => {
    it('normalizes machine and child model allowlists', () => {
        const preferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childClaudeModels: ['opus'],
            childCodexModels: ['openai/gpt-5.5', 'openai/gpt-5.4-mini'],
        })

        expect(preferences.machineSelection).toEqual({
            mode: 'manual',
            machineId: 'machine-1',
        })
        expect(preferences.childModels.claude.allowed).toEqual(['opus'])
        expect(preferences.childModels.claude.defaultModel).toBe('opus')
        expect(preferences.childModels.codex.allowed).toEqual(['gpt-5.5', 'gpt-5.4-mini'])
        expect(preferences.childModels.codex.defaultModel).toBe('gpt-5.5')
    })

    it('preserves explicit empty child model allowlists', () => {
        const preferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childClaudeModels: [],
            childCodexModels: ['gpt-5.4-mini'],
        })

        expect(preferences.childModels.claude.allowed).toEqual([])
        expect(preferences.childModels.claude.defaultModel).toBe('sonnet')
        expect(preferences.childModels.codex.allowed).toEqual(['gpt-5.4-mini'])
        expect(getAllowedBrainChildAgents(preferences)).toEqual(['codex'])
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

    it('keeps empty child model defaults from brainConfig.extra', () => {
        const defaults = extractBrainChildModelDefaults({
            childClaudeModels: [],
            childCodexModels: ['openai/gpt-5.4-mini'],
        })

        expect(defaults.childClaudeModels).toEqual([])
        expect(defaults.childCodexModels).toEqual(['gpt-5.4-mini'])
    })

    it('repairs legacy request-shaped brainPreferences into canonical schema', () => {
        const repaired = repairLegacyBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: ' machine-1 ',
            childClaudeModels: [],
            childCodexModels: ['openai/gpt-5.4-mini', ' gpt-5.3-codex ', 'gpt-5.4-mini'],
        })

        expect(repaired).toEqual({
            status: 'migrated',
            preferences: {
                machineSelection: {
                    mode: 'manual',
                    machineId: 'machine-1',
                },
                childModels: {
                    claude: {
                        allowed: [],
                        defaultModel: 'sonnet',
                    },
                    codex: {
                        allowed: ['gpt-5.4-mini', 'gpt-5.3-codex'],
                        defaultModel: 'gpt-5.4-mini',
                    },
                },
            },
            rules: [
                'rewrite_request_shape',
                'normalize_codex_allowed_models',
                'derive_claude_default_model',
                'derive_codex_default_model',
            ],
        })
    })

    it('repairs canonical-ish payloads by backfilling machineId and re-deriving defaults', () => {
        const repaired = repairLegacyBrainSessionPreferences({
            machineSelection: { mode: 'manual' },
            childModels: {
                claude: {
                    allowed: ['sonnet', 'sonnet'],
                    defaultModel: 'opus',
                },
                codex: {
                    allowed: ['openai/gpt-5.4-mini'],
                    defaultModel: 'gpt-5.4',
                },
            },
        }, {
            fallbackMachineId: 'machine-2',
        })

        expect(repaired).toEqual({
            status: 'migrated',
            preferences: {
                machineSelection: {
                    mode: 'manual',
                    machineId: 'machine-2',
                },
                childModels: {
                    claude: {
                        allowed: ['sonnet'],
                        defaultModel: 'sonnet',
                    },
                    codex: {
                        allowed: ['gpt-5.4-mini'],
                        defaultModel: 'gpt-5.4-mini',
                    },
                },
            },
            rules: [
                'backfill_machine_id_from_metadata',
                'normalize_claude_allowed_models',
                'normalize_codex_allowed_models',
                'derive_claude_default_model',
                'derive_codex_default_model',
            ],
        })
    })

    it('repairs invalid metadata payloads with outer machineId fallback', () => {
        const repaired = repairBrainSessionPreferencesFromMetadata({
            machineId: 'machine-3',
            brainPreferences: {
                machineSelection: { mode: 'auto' },
                childModels: {
                    claude: { allowed: ['opus-4-7'], defaultModel: 'opus' },
                    codex: { allowed: [], defaultModel: 'gpt-5.4' },
                },
            },
        })

        expect(repaired).toEqual({
            status: 'migrated',
            preferences: {
                machineSelection: {
                    mode: 'auto',
                    machineId: 'machine-3',
                },
                childModels: {
                    claude: { allowed: ['opus-4-7'], defaultModel: 'opus-4-7' },
                    codex: { allowed: [], defaultModel: 'gpt-5.4' },
                },
            },
            rules: [
                'backfill_machine_id_from_metadata',
                'derive_claude_default_model',
                'derive_codex_default_model',
            ],
        })
    })

    it('marks partial canonical payloads as requiring manual repair', () => {
        expect(repairLegacyBrainSessionPreferences({
            machineSelection: { mode: 'manual', machineId: 'machine-1' },
            childModels: {
                codex: { allowed: ['gpt-5.4'], defaultModel: 'gpt-5.4' },
            },
        })).toEqual({
            status: 'manual',
            reasons: ['缺少 childModels.claude 配置'],
        })
    })

    it('marks unsupported legacy model values as requiring manual repair', () => {
        expect(repairLegacyBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childCodexModels: ['gpt-6'],
        })).toEqual({
            status: 'manual',
            reasons: ['childCodexModels allowed 数组包含无法安全迁移的模型: gpt-6'],
        })
    })

    it('keeps already-canonical payloads untouched instead of guessing past user intent', () => {
        const preferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-9',
            childClaudeModels: ['sonnet', 'opus'],
            childCodexModels: ['gpt-5.4'],
        })

        expect(repairLegacyBrainSessionPreferences(preferences)).toEqual({
            status: 'valid',
            preferences,
            rules: [],
        })
    })
})
