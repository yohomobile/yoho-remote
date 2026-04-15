import { describe, expect, test } from 'bun:test'
import {
    getUnsupportedSessionSourceError,
    getSessionSourceFromMetadata,
    isSupportedSessionSource,
} from './sessionSourcePolicy'

describe('sessionSourcePolicy', () => {
    test('accepts supported sources only', () => {
        expect(isSupportedSessionSource('brain')).toBe(true)
        expect(isSupportedSessionSource('brain-child')).toBe(true)
        expect(isSupportedSessionSource('external-api')).toBe(true)
        expect(isSupportedSessionSource('automation:repair')).toBe(true)
        expect(isSupportedSessionSource('legacy-source')).toBe(false)
        expect(isSupportedSessionSource(undefined)).toBe(true)
    })

    test('extracts source from metadata objects only', () => {
        expect(getSessionSourceFromMetadata({ source: 'brain' })).toBe('brain')
        expect(getSessionSourceFromMetadata({ source: 1 })).toBe(null)
        expect(getSessionSourceFromMetadata(null)).toBe(null)
    })

    test('formats a readable error message', () => {
        expect(getUnsupportedSessionSourceError('legacy-source')).toContain('legacy-source')
    })
})
