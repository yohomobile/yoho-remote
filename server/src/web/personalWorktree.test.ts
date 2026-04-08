import { describe, expect, it } from 'bun:test'
import { getPersonalWorktreeOwner } from './personalWorktree'

describe('getPersonalWorktreeOwner', () => {
    it('normalizes email prefixes to underscore-separated owners', () => {
        expect(getPersonalWorktreeOwner('guang.yang@yohomobile.com')).toBe('guang_yang')
        expect(getPersonalWorktreeOwner('Guang+Yang@yohomobile.com')).toBe('guang_yang')
    })

    it('trims empty normalized owners to null', () => {
        expect(getPersonalWorktreeOwner('___@yohomobile.com')).toBeNull()
    })
})
