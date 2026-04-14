import { describe, expect, it } from 'bun:test'

import {
    compareClaudeCodeVersions,
    parseClaudeCodeVersion,
    pickPreferredClaudePath,
} from './utils'

describe('parseClaudeCodeVersion', () => {
    it('extracts semantic version from Claude version output', () => {
        expect(parseClaudeCodeVersion('2.1.107 (Claude Code)')).toBe('2.1.107')
        expect(parseClaudeCodeVersion('Claude Code 2.1.91')).toBe('2.1.91')
        expect(parseClaudeCodeVersion('not a version')).toBeNull()
    })
})

describe('compareClaudeCodeVersions', () => {
    it('orders newer versions after older ones', () => {
        expect(compareClaudeCodeVersions('2.1.107', '2.1.91')).toBeGreaterThan(0)
        expect(compareClaudeCodeVersions('2.1.91', '2.1.107')).toBeLessThan(0)
        expect(compareClaudeCodeVersions('2.1.107', '2.1.107')).toBe(0)
    })
})

describe('pickPreferredClaudePath', () => {
    it('prefers the highest parsed Claude version', () => {
        expect(pickPreferredClaudePath([
            { path: '/old/claude', version: '2.1.91' },
            { path: '/new/claude', version: '2.1.107' },
            { path: '/unknown/claude', version: null },
        ])).toBe('/new/claude')
    })

    it('falls back to the first deterministic path when no versions are known', () => {
        expect(pickPreferredClaudePath([
            { path: '/b/claude', version: null },
            { path: '/a/claude', version: null },
        ])).toBe('/a/claude')
    })
})
