import { describe, expect, test } from 'bun:test'
import { hashStableValueSync, stableStringify } from './hash'

describe('hash helpers', () => {
    test('stringifies objects with sorted keys', () => {
        expect(stableStringify({
            z: 3,
            a: {
                d: 4,
                b: 2
            }
        })).toBe('{"a":{"b":2,"d":4},"z":3}')
    })

    test('hashes semantically equal objects to the same value', () => {
        expect(hashStableValueSync({
            z: 3,
            a: [2, 1]
        })).toBe(hashStableValueSync({
            a: [2, 1],
            z: 3
        }))
    })
})
