import { describe, expect, test } from 'bun:test'
import { buildBrainSessionPreferences } from './brain/brainSessionPreferences'
import { extractResumeSpawnMetadata, hasInvalidResumeBrainPreferences } from './resumeSpawnMetadata'

function createBrainPreferences(machineId = 'machine-1') {
    return buildBrainSessionPreferences({
        machineSelectionMode: 'manual',
        machineId,
    })
}

describe('extractResumeSpawnMetadata', () => {
    test('keeps brain metadata needed for resume', () => {
        expect(extractResumeSpawnMetadata({
            source: 'brain-child',
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
            brainPreferences: {
                machineSelection: { mode: 'manual' },
            } as unknown,
        })).toBe(true)
        expect(hasInvalidResumeBrainPreferences({
            brainPreferences: {
                ...createBrainPreferences(),
            },
        })).toBe(false)
    })
})
