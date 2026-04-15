import { describe, expect, test } from 'bun:test'
import { formatSessionModelLabel } from '../src/lib/sessionModelLabel'

describe('formatSessionModelLabel', () => {
    test('prefers configured modelMode over runtimeModel', () => {
        expect(formatSessionModelLabel({
            modelMode: 'gpt-5.4',
            runtimeModel: 'gpt-5.3-codex'
        })).toBe('gpt-5.4')
    })

    test('falls back to runtimeModel when modelMode is default', () => {
        expect(formatSessionModelLabel({
            modelMode: 'default',
            runtimeModel: 'gpt-5.3-codex',
            runtimeModelReasoningEffort: 'high'
        })).toBe('gpt-5.3-codex (high)')
    })

    test('uses configured reasoning effort when available', () => {
        expect(formatSessionModelLabel({
            modelMode: 'gpt-5.4-mini',
            modelReasoningEffort: 'medium',
            runtimeModel: 'gpt-5.3-codex',
            runtimeModelReasoningEffort: 'high'
        })).toBe('gpt-5.4-mini (medium)')
    })

    test('shows fast-mode fallback when no model is available', () => {
        expect(formatSessionModelLabel({
            fastMode: true
        })).toBe('\u21af Fast')
    })
})
