import { describe, expect, test } from 'bun:test'
import { buildBrainSessionPreferences } from './brain/brainSessionPreferences'
import {
    extractResumeSpawnMetadata,
    getInvalidResumeMetadataReason,
    hasInvalidResumeBrainPreferences,
} from './resumeSpawnMetadata'

function createBrainPreferences(machineId = 'machine-1') {
    return buildBrainSessionPreferences({
        machineSelectionMode: 'manual',
        machineId,
    })
}

describe('extractResumeSpawnMetadata', () => {
    test('keeps brain metadata needed for resume', () => {
        expect(extractResumeSpawnMetadata({
            source: 'BRAIN-CHILD',
            caller: 'feishu',
            mainSessionId: 'brain-session-1',
            brainPreferences: createBrainPreferences(),
            ignored: true,
        })).toEqual({
            source: 'brain-child',
            caller: 'feishu',
            mainSessionId: 'brain-session-1',
            brainPreferences: createBrainPreferences(),
        })
    })

    test('drops empty or invalid resume metadata fields', () => {
        expect(extractResumeSpawnMetadata({
            source: '   ',
            caller: '   ',
            mainSessionId: null,
            brainPreferences: ['invalid'],
        })).toEqual({})
    })

    test('reports invalid brainPreferences separately so resume paths can fail closed', () => {
        expect(hasInvalidResumeBrainPreferences({
            source: 'brain',
            brainPreferences: {
                machineSelection: { mode: 'manual' },
            } as unknown,
        })).toBe(true)
        expect(hasInvalidResumeBrainPreferences({
            source: 'brain',
            brainPreferences: {
                ...createBrainPreferences(),
            },
        })).toBe(false)
    })

    test('drops stray mainSessionId and brainPreferences when resuming a non-brain session', () => {
        expect(extractResumeSpawnMetadata({
            source: 'manual',
            caller: 'webapp',
            mainSessionId: 'brain-session-1',
            brainPreferences: createBrainPreferences(),
        })).toEqual({
            source: 'manual',
            caller: 'webapp',
        })
    })

    test('reports invalid source/mainSessionId invariants separately so resume paths can fail closed', () => {
        expect(getInvalidResumeMetadataReason({
            source: 'brain-child',
            caller: 'feishu',
        })).toBe('brain-child sessions require mainSessionId')
        expect(getInvalidResumeMetadataReason({
            brainPreferences: createBrainPreferences(),
        })).toBe('brain-linked metadata requires source=brain or source=brain-child')
    })
})
