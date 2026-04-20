import { describe, expect, it } from 'vitest'

import { buildBrainChildScopeQuery, getBrainChildScopeParamsFromMetadata } from './brainChildScope'

describe('buildBrainChildScopeQuery', () => {
    it('serializes mainSessionId into query string', () => {
        expect(buildBrainChildScopeQuery({ mainSessionId: 'brain-main' })).toBe('?mainSessionId=brain-main')
    })

    it('returns empty string when mainSessionId is absent', () => {
        expect(buildBrainChildScopeQuery()).toBe('')
        expect(buildBrainChildScopeQuery({ mainSessionId: '   ' })).toBe('')
    })
})

describe('getBrainChildScopeParamsFromMetadata', () => {
    it('extracts scope from brain-child metadata', () => {
        expect(getBrainChildScopeParamsFromMetadata({
            source: 'brain-child',
            mainSessionId: 'brain-main',
        } as any)).toEqual({ mainSessionId: 'brain-main' })
    })

    it('ignores non brain-child sessions', () => {
        expect(getBrainChildScopeParamsFromMetadata({
            source: 'brain',
            mainSessionId: 'brain-main',
        } as any)).toBeUndefined()
    })

    it('ignores malformed brain-child metadata without mainSessionId', () => {
        expect(getBrainChildScopeParamsFromMetadata({
            source: 'brain-child',
        } as any)).toBeUndefined()
    })
})
