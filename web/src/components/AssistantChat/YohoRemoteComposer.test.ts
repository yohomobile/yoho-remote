import { describe, expect, test } from 'bun:test'

import { CODEX_MODELS, isCodexModel } from './YohoRemoteComposer'

describe('YohoRemoteComposer codex model options', () => {
    test('keeps the expected baseline Codex models visible', () => {
        const modelIds = CODEX_MODELS.map((model) => model.id)

        expect(modelIds).toContain('gpt-5.4')
        expect(modelIds).toContain('gpt-5.4-mini')
        expect(modelIds).toContain('gpt-5.3-codex-spark')
    })

    test('recognizes valid Codex model ids', () => {
        expect(isCodexModel('gpt-5.4')).toBe(true)
        expect(isCodexModel('gpt-5.4-mini')).toBe(true)
        expect(isCodexModel('gpt-5.3-codex-spark')).toBe(true)
    })

    test('rejects non-Codex model ids', () => {
        expect(isCodexModel('sonnet')).toBe(false)
        expect(isCodexModel(undefined)).toBe(false)
    })
})
