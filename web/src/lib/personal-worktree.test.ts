import { describe, expect, it } from 'bun:test'
import { getPersonalWorktreeOwner } from './personal-worktree'

describe('getPersonalWorktreeOwner', () => {
    it('matches the server-side underscore normalization rule preserving domain', () => {
        expect(getPersonalWorktreeOwner('guang.yang@yohomobile.com')).toBe('guang_yang_yohomobile_com')
        expect(getPersonalWorktreeOwner('Guang+Yang@yohomobile.com')).toBe('guang_yang_yohomobile_com')
    })
})
