import { describe, expect, it } from 'bun:test'
import { getPersonalWorktreeOwner } from './personal-worktree'

describe('getPersonalWorktreeOwner', () => {
    it('matches the server-side underscore normalization rule', () => {
        expect(getPersonalWorktreeOwner('guang.yang@yohomobile.com')).toBe('guang_yang')
        expect(getPersonalWorktreeOwner('Guang+Yang@yohomobile.com')).toBe('guang_yang')
    })
})
