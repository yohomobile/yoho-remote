import { describe, expect, it } from 'bun:test'
import { getPersonalWorktreeOwner } from './personalWorktree'

describe('getPersonalWorktreeOwner', () => {
    it('normalizes full email to underscore-separated owners preserving domain', () => {
        expect(getPersonalWorktreeOwner('guang.yang@yohomobile.com')).toBe('guang_yang_yohomobile_com')
        expect(getPersonalWorktreeOwner('Guang+Yang@yohomobile.com')).toBe('guang_yang_yohomobile_com')
    })

    it('trims empty normalized owners to null', () => {
        expect(getPersonalWorktreeOwner('___@___.___')).toBeNull()
    })
})
