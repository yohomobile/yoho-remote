import { describe, expect, test } from 'bun:test'
import { extractTextFromResult } from './_results'

describe('extractTextFromResult', () => {
    test('reads Codex aggregated_output for terminal results', () => {
        expect(extractTextFromResult({
            command: 'printf hello',
            exit_code: 0,
            aggregated_output: 'hello from aggregated output'
        })).toBe('hello from aggregated output')
    })

    test('reads nested combined output payloads', () => {
        expect(extractTextFromResult({
            output: {
                combined_output: 'hello from nested combined output'
            }
        })).toBe('hello from nested combined output')
    })

    test('reads content text blocks from terminal results', () => {
        expect(extractTextFromResult({
            content: [
                { type: 'text', text: 'hello from content block' }
            ]
        })).toBe('hello from content block')
    })
})
