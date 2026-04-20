import { describe, expect, test } from 'bun:test'

import { CODEX_MODELS, getCodexModelsForSessionSource } from './YohoRemoteComposer'

describe('YohoRemoteComposer codex model options', () => {
    test('restricts brain-scoped sessions to the current Brain Codex whitelist', () => {
        expect(getCodexModelsForSessionSource('brain').map((model) => model.id)).toEqual([
            'gpt-5.3-codex-spark',
            'gpt-5.4-mini',
            'gpt-5.4',
        ])
        expect(getCodexModelsForSessionSource('BRAIN-CHILD').map((model) => model.id)).toEqual([
            'gpt-5.3-codex-spark',
            'gpt-5.4-mini',
            'gpt-5.4',
        ])
    })

    test('keeps the broader Codex model list for non-brain sessions', () => {
        expect(getCodexModelsForSessionSource('manual').map((model) => model.id)).toEqual(
            CODEX_MODELS.map((model) => model.id),
        )
        expect(getCodexModelsForSessionSource(undefined).map((model) => model.id)).toEqual(
            CODEX_MODELS.map((model) => model.id),
        )
    })

    test('keeps gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark visible for non-brain sessions', () => {
        expect(getCodexModelsForSessionSource('manual').map((model) => model.id)).toEqual(
            expect.arrayContaining(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']),
        )
    })
})
