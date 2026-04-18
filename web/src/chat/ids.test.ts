import { describe, expect, test } from 'bun:test'
import { deriveStableMessageId, parseLocalIdPrefix } from './ids'

describe('chat id helpers', () => {
    test('parses colon-rich local id prefixes without truncating semantic colons', () => {
        expect(parseLocalIdPrefix('turn:foo:0')).toBe('turn:foo')
        expect(parseLocalIdPrefix('turn:foo:result-text:0')).toBe('turn:foo:result-text')
    })

    test('derives a stable message id from localId or seq plus hash', () => {
        expect(deriveStableMessageId({
            id: 'turn:foo:0',
            localId: 'local-1',
            seq: 9
        })).toBe('local-1')

        const first = deriveStableMessageId({
            id: 'turn:foo:0',
            localId: null,
            seq: 9
        })
        const second = deriveStableMessageId({
            id: 'turn:foo:0',
            localId: null,
            seq: 9
        })

        expect(first).toBe(second)
        expect(first.startsWith('seq:9:')).toBe(true)
    })
})
