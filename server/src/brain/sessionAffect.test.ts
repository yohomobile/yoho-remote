import { describe, expect, it } from 'bun:test'
import {
    appendSessionAffectPrompt,
    buildSessionAffect,
    resolveSessionAffectContext,
    type SessionAffect,
} from './sessionAffect'

function makeAffect(overrides: Partial<SessionAffect> = {}): SessionAffect {
    return {
        mode: 'concise',
        source: 'user_explicit',
        setAt: 1_000,
        expiresAt: null,
        note: null,
        ...overrides,
    }
}

describe('resolveSessionAffectContext', () => {
    it('returns none status when no affect stored', () => {
        const ctx = resolveSessionAffectContext({ affect: null })
        expect(ctx.prompt).toBeNull()
        expect(ctx.metadataPatch.sessionAffectStatus).toBe('none')
        expect(ctx.metadataPatch.sessionAffectAttached).toBe(false)
    })

    it('skips injection for mode=default but still reports metadata', () => {
        const affect = makeAffect({ mode: 'default' })
        const ctx = resolveSessionAffectContext({ affect })
        expect(ctx.prompt).toBeNull()
        expect(ctx.metadataPatch.sessionAffectStatus).toBe('default')
        expect(ctx.metadataPatch.sessionAffectMode).toBe('default')
    })

    it('builds concise prompt with explicit guardrails', () => {
        const affect = makeAffect({ mode: 'concise', note: '在赶 ddl' })
        const ctx = resolveSessionAffectContext({ affect, now: 500 })
        expect(ctx.prompt).not.toBeNull()
        const text = ctx.prompt!
        expect(text).toContain('本会话表达节奏')
        expect(text).toContain('偏好简洁')
        expect(text).toContain('用户在本会话明确表达')
        expect(text).toContain('在赶 ddl')
        expect(text).toContain('仅影响回复节奏')
        expect(text).toContain('不影响工具调用')
    })

    it('marks expired when expiresAt <= now', () => {
        const affect = makeAffect({ mode: 'detailed', expiresAt: 2_000 })
        const ctx = resolveSessionAffectContext({ affect, now: 3_000 })
        expect(ctx.prompt).toBeNull()
        expect(ctx.metadataPatch.sessionAffectStatus).toBe('expired')
        expect(ctx.metadataPatch.sessionAffectAttached).toBe(false)
        expect(ctx.metadataPatch.sessionAffectExpiresAt).toBe(2_000)
    })

    it('attaches when expiresAt is in the future', () => {
        const affect = makeAffect({ mode: 'detailed', expiresAt: 10_000 })
        const ctx = resolveSessionAffectContext({ affect, now: 5_000 })
        expect(ctx.prompt).toContain('偏好详细')
        expect(ctx.metadataPatch.sessionAffectStatus).toBe('attached')
        expect(ctx.metadataPatch.sessionAffectMode).toBe('detailed')
    })
})

describe('appendSessionAffectPrompt', () => {
    it('is a no-op when affect prompt empty', () => {
        expect(appendSessionAffectPrompt('base', null)).toBe('base')
        expect(appendSessionAffectPrompt('base', '   ')).toBe('base')
    })

    it('returns affect prompt when base empty', () => {
        expect(appendSessionAffectPrompt('', 'affect')).toBe('affect')
    })

    it('joins with blank line between', () => {
        expect(appendSessionAffectPrompt('base', 'affect')).toBe('base\n\naffect')
    })
})

describe('buildSessionAffect', () => {
    it('sets setAt and expiresAt based on now+ttl', () => {
        const affect = buildSessionAffect({
            mode: 'concise',
            source: 'user_toggle',
            ttlMs: 60_000,
            now: 1_000,
        })
        expect(affect.setAt).toBe(1_000)
        expect(affect.expiresAt).toBe(61_000)
        expect(affect.mode).toBe('concise')
        expect(affect.source).toBe('user_toggle')
    })

    it('preserves null expiry when ttl not provided', () => {
        const affect = buildSessionAffect({
            mode: 'default',
            source: 'system_signal',
            now: 1_000,
        })
        expect(affect.expiresAt).toBeNull()
    })

    it('trims note and rejects overly long notes', () => {
        const affect = buildSessionAffect({
            mode: 'concise',
            source: 'user_explicit',
            note: '  在赶 ddl  ',
            now: 1_000,
        })
        expect(affect.note).toBe('在赶 ddl')

        expect(() => buildSessionAffect({
            mode: 'concise',
            source: 'user_explicit',
            note: 'x'.repeat(600),
            now: 1_000,
        })).toThrow(/note length/)
    })
})
