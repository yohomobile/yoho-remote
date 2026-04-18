import { describe, expect, test } from 'bun:test'
import { extractResumeSpawnMetadata } from './resumeSpawnMetadata'

describe('extractResumeSpawnMetadata', () => {
    test('keeps brain metadata needed for resume', () => {
        expect(extractResumeSpawnMetadata({
            source: 'brain-child',
            mainSessionId: 'brain-session-1',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
            ignored: true,
        })).toEqual({
            source: 'brain-child',
            mainSessionId: 'brain-session-1',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })
    })

    test('drops empty or invalid resume metadata fields', () => {
        expect(extractResumeSpawnMetadata({
            source: '   ',
            mainSessionId: null,
            brainPreferences: ['invalid'],
        })).toEqual({})
    })
})
