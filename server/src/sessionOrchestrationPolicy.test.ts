import { describe, expect, test } from 'bun:test'

import {
    getAllSessionOrchestrationChildSources,
    getAllSessionOrchestrationParentSources,
    getAllSessionOrchestrationReservedMetadataKeys,
    getAllSessionOrchestrationSources,
    getReservedSessionMetadataKeysForSource,
    getSessionOrchestrationChildSourceForParentSource,
    getSessionOrchestrationParentSourceForChildSource,
    getSessionOrchestrationParentSessionId,
    getSessionOrchestrationProfileBySource,
    hasSessionOrchestrationMetadata,
    isSessionOrchestrationChildForParent,
    isSessionOrchestrationChildForParentMetadata,
    isSessionOrchestrationChildMetadata,
    isSessionOrchestrationChildSource,
    isSessionOrchestrationParentMetadata,
    isSessionOrchestrationParentChildSourcePair,
    isSessionOrchestrationParentSource,
} from './sessionOrchestrationPolicy'

describe('sessionOrchestrationPolicy', () => {
    test('exposes the registered orchestration sources', () => {
        expect(getAllSessionOrchestrationSources()).toEqual(['brain', 'brain-child', 'orchestrator', 'orchestrator-child'])
        expect(getAllSessionOrchestrationParentSources()).toEqual(['brain', 'orchestrator'])
        expect(getAllSessionOrchestrationChildSources()).toEqual(['brain-child', 'orchestrator-child'])
    })

    test('recognizes parent and child sources independently', () => {
        expect(isSessionOrchestrationParentSource('brain')).toBe(true)
        expect(isSessionOrchestrationParentSource('orchestrator')).toBe(true)
        expect(isSessionOrchestrationParentSource('brain-child')).toBe(false)
        expect(isSessionOrchestrationChildSource('brain-child')).toBe(true)
        expect(isSessionOrchestrationChildSource('orchestrator-child')).toBe(true)
        expect(isSessionOrchestrationChildSource('brain')).toBe(false)
        expect(isSessionOrchestrationParentSource('brain', 'brain')).toBe(true)
        expect(isSessionOrchestrationChildSource('brain-child', 'brain-child')).toBe(true)
    })

    test('maps matching parent and child sources within the same profile', () => {
        expect(getSessionOrchestrationProfileBySource('brain')?.key).toBe('brain')
        expect(getSessionOrchestrationProfileBySource('orchestrator-child')?.key).toBe('orchestrator')
        expect(getSessionOrchestrationChildSourceForParentSource('brain')).toBe('brain-child')
        expect(getSessionOrchestrationChildSourceForParentSource('orchestrator')).toBe('orchestrator-child')
        expect(getSessionOrchestrationParentSourceForChildSource('brain-child')).toBe('brain')
        expect(getSessionOrchestrationParentSourceForChildSource('orchestrator-child')).toBe('orchestrator')
        expect(isSessionOrchestrationParentChildSourcePair('brain', 'brain-child')).toBe(true)
        expect(isSessionOrchestrationParentChildSourcePair('brain', 'orchestrator-child')).toBe(false)
    })

    test('recognizes parent and child session metadata', () => {
        expect(isSessionOrchestrationParentMetadata({ source: 'brain' }, 'brain')).toBe(true)
        expect(isSessionOrchestrationParentMetadata({ source: 'manual' }, 'brain')).toBe(false)
        expect(isSessionOrchestrationChildMetadata({ source: 'brain-child', mainSessionId: 'brain-1' }, 'brain-child')).toBe(true)
        expect(isSessionOrchestrationChildMetadata({ source: 'manual', mainSessionId: 'brain-1' }, 'brain-child')).toBe(false)
    })

    test('extracts parent session id only for configured child sources', () => {
        expect(getSessionOrchestrationParentSessionId({
            source: 'brain-child',
            mainSessionId: 'brain-1',
        }, 'brain-child')).toBe('brain-1')
        expect(getSessionOrchestrationParentSessionId({
            source: 'manual',
            mainSessionId: 'brain-1',
        }, 'brain-child')).toBeUndefined()
    })

    test('matches children to the expected parent session', () => {
        expect(isSessionOrchestrationChildForParent({
            source: 'brain-child',
            mainSessionId: 'brain-1',
        }, 'brain-1', 'brain-child')).toBe(true)
        expect(isSessionOrchestrationChildForParent({
            source: 'brain-child',
            mainSessionId: 'brain-2',
        }, 'brain-1', 'brain-child')).toBe(false)
    })

    test('matches children against parent metadata using the registered profile pair', () => {
        expect(isSessionOrchestrationChildForParentMetadata({
            source: 'orchestrator-child',
            mainSessionId: 'parent-1',
        }, {
            source: 'orchestrator',
        }, 'parent-1')).toBe(true)
        expect(isSessionOrchestrationChildForParentMetadata({
            source: 'orchestrator-child',
            mainSessionId: 'parent-1',
        }, {
            source: 'brain',
        }, 'parent-1')).toBe(false)
    })

    test('tracks orchestration-reserved metadata keys', () => {
        expect(getReservedSessionMetadataKeysForSource('brain')).toEqual(['brainPreferences'])
        expect(getReservedSessionMetadataKeysForSource('brain-child')).toEqual(['brainPreferences'])
        expect(getReservedSessionMetadataKeysForSource('orchestrator')).toEqual([])
        expect(getReservedSessionMetadataKeysForSource('orchestrator-child')).toEqual([])
        expect(getReservedSessionMetadataKeysForSource('manual')).toEqual([])
        expect(getAllSessionOrchestrationReservedMetadataKeys()).toEqual(['brainPreferences'])
    })

    test('detects orchestration-linked metadata even before source normalization', () => {
        expect(hasSessionOrchestrationMetadata({
            mainSessionId: 'brain-1',
        })).toBe(true)
        expect(hasSessionOrchestrationMetadata({
            brainPreferences: {
                childModels: {},
            },
        })).toBe(true)
        expect(hasSessionOrchestrationMetadata({
            source: 'manual',
        })).toBe(false)
    })
})
