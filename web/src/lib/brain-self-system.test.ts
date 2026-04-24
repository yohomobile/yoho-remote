import { describe, expect, test } from 'bun:test'
import {
    applySelfSystemConfigPatch,
    canEnableSelfSystem,
    extractSelfSystemConfig,
    isValidSelfSystemConfig,
    type BrainSelfSystemConfig,
} from './brain-self-system'

describe('brain self system helpers', () => {
    test('extractSelfSystemConfig falls back to disabled defaults', () => {
        expect(extractSelfSystemConfig(null)).toEqual({
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory',
        })
    })

    test('extractSelfSystemConfig normalizes empty profile ids', () => {
        expect(extractSelfSystemConfig({
            selfSystem: {
                enabled: true,
                defaultProfileId: '   ',
                memoryProvider: 'none',
            },
        })).toEqual({
            enabled: true,
            defaultProfileId: null,
            memoryProvider: 'none',
        })
    })

    test('canEnableSelfSystem requires a default profile', () => {
        expect(canEnableSelfSystem({
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory',
        })).toBe(false)

        expect(canEnableSelfSystem({
            enabled: false,
            defaultProfileId: 'profile-1',
            memoryProvider: 'yoho-memory',
        })).toBe(true)
    })

    test('isValidSelfSystemConfig rejects enabled configs without a default profile', () => {
        expect(isValidSelfSystemConfig({
            enabled: true,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory',
        })).toBe(false)

        expect(isValidSelfSystemConfig({
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory',
        })).toBe(true)
    })

    test('applySelfSystemConfigPatch merges partial updates', () => {
        const current: BrainSelfSystemConfig = {
            enabled: false,
            defaultProfileId: 'profile-1',
            memoryProvider: 'yoho-memory',
        }

        expect(applySelfSystemConfigPatch(current, {
            enabled: true,
        })).toEqual({
            enabled: true,
            defaultProfileId: 'profile-1',
            memoryProvider: 'yoho-memory',
        })
    })
})
