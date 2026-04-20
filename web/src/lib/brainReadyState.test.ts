import { describe, expect, test } from 'bun:test'
import {
    deriveBrainCreationReadyPhase,
    extractDecryptedMessageRole,
    extractDecryptedMessageText,
    hasBrainReadyFollowUpActivity,
    isInitPromptText,
    type BrainReadyMarker,
} from './brainReadyState'

const marker: BrainReadyMarker = { createdAt: 123 }

describe('deriveBrainCreationReadyPhase', () => {
    test('returns null for non-brain sessions', () => {
        expect(deriveBrainCreationReadyPhase({
            source: 'brain-child',
            active: false,
            thinking: false,
            marker,
        })).toBeNull()
    })

    test('returns created before runtime comes online', () => {
        expect(deriveBrainCreationReadyPhase({
            source: 'brain',
            active: false,
            thinking: false,
            marker,
        })).toBe('created')
    })

    test('returns initializing while brain is still thinking during startup', () => {
        expect(deriveBrainCreationReadyPhase({
            source: 'brain',
            active: true,
            thinking: true,
            marker,
        })).toBe('initializing')
    })

    test('returns ready once brain is online and idle', () => {
        expect(deriveBrainCreationReadyPhase({
            source: 'brain',
            active: true,
            thinking: false,
            marker,
        })).toBe('ready')
    })
})

describe('brain ready follow-up activity detection', () => {
    test('recognizes init prompt text', () => {
        expect(isInitPromptText('#InitPrompt-Brain')).toBe(true)
        expect(isInitPromptText('real user message')).toBe(false)
    })

    test('extracts text from common decrypted message shapes', () => {
        expect(extractDecryptedMessageText({
            content: '#InitPrompt-Brain',
        } as any)).toBe('#InitPrompt-Brain')
        expect(extractDecryptedMessageText({
            content: { role: 'user', content: '继续排查' },
        } as any)).toBe('继续排查')
        expect(extractDecryptedMessageText({
            content: { type: 'text', text: 'assistant ready' },
        } as any)).toBe('assistant ready')
    })

    test('extracts role from role-wrapped decrypted messages', () => {
        expect(extractDecryptedMessageRole({
            content: { role: 'assistant', content: 'Brain ready' },
        } as any)).toBe('assistant')
        expect(extractDecryptedMessageRole({
            content: 'plain string',
        } as any)).toBeNull()
    })

    test('ignores pure init prompts and keeps tracking active', () => {
        expect(hasBrainReadyFollowUpActivity([
            { content: '#InitPrompt-Brain编排中枢' } as any,
        ])).toBe(false)
    })

    test('ignores startup assistant replies when deciding whether ready banner should clear', () => {
        expect(hasBrainReadyFollowUpActivity([
            { content: '#InitPrompt-Brain编排中枢' } as any,
            { content: { role: 'assistant', content: 'Brain 编排中枢已就绪。' } } as any,
        ])).toBe(false)
    })

    test('detects real follow-up activity after creation', () => {
        expect(hasBrainReadyFollowUpActivity([
            { content: '#InitPrompt-Brain编排中枢' } as any,
            { content: { role: 'user', content: '请开始拆任务' } } as any,
        ])).toBe(true)
    })
})
