import { describe, expect, test } from 'bun:test'
import {
    getBrainChildMainSessionId,
    getSessionMetadataInvariantError,
    getSessionMetadataPersistenceError,
    getUnsupportedSessionSourceError,
    getSessionSourceFromMetadata,
    isSupportedSessionSource,
    normalizeSessionMetadataInvariants,
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
        expect(getSessionSourceFromMetadata({ source: ' BRAIN-CHILD ' })).toBe('brain-child')
        expect(getSessionSourceFromMetadata({ source: 1 })).toBe(null)
        expect(getSessionSourceFromMetadata(null)).toBe(null)
    })

    test('formats a readable error message', () => {
        expect(getUnsupportedSessionSourceError('legacy-source')).toContain('legacy-source')
    })

    test('rejects brain-child metadata without mainSessionId', () => {
        expect(getSessionMetadataInvariantError({
            source: 'brain-child',
            caller: 'feishu',
        })).toBe('brain-child sessions require mainSessionId')
    })

    test('rejects brain-linked metadata when source is missing', () => {
        expect(getSessionMetadataInvariantError({
            mainSessionId: 'brain-1',
        })).toBe('brain-linked metadata requires source=brain or source=brain-child')
        expect(getSessionMetadataInvariantError({
            brainPreferences: {
                childModels: {},
            },
        })).toBe('brain-linked metadata requires source=brain or source=brain-child')
    })

    test('normalizes stray brain linkage fields off non-brain sessions', () => {
        expect(normalizeSessionMetadataInvariants({
            source: 'MANUAL',
            mainSessionId: 'brain-1',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
            caller: 'webapp',
        })).toEqual({
            source: 'manual',
            caller: 'webapp',
        })
    })

    test('normalizes brain metadata by clearing mainSessionId from brain main sessions only', () => {
        expect(normalizeSessionMetadataInvariants({
            source: 'BRAIN',
            mainSessionId: 'stale-child-link',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })).toEqual({
            source: 'brain',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })
    })

    test('only exposes mainSessionId for brain-child metadata on read paths', () => {
        expect(getBrainChildMainSessionId({
            source: 'brain-child',
            mainSessionId: 'brain-1',
        })).toBe('brain-1')
        expect(getBrainChildMainSessionId({
            source: 'manual',
            mainSessionId: 'brain-1',
        })).toBeUndefined()
    })

    test('rejects invalid brainPreferences at write time for brain-linked sessions', () => {
        expect(getSessionMetadataPersistenceError({
            source: 'BRAIN-CHILD',
            mainSessionId: 'brain-1',
            brainPreferences: {
                machineSelection: { mode: 'manual' },
            },
        })).toBe('Invalid brainPreferences in session metadata')
    })
})
