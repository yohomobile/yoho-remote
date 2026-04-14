import { describe, expect, it } from 'vitest'

import { getAllowedBrainChildAgents, getBrainSessionPreferencesFromMetadata, parseBrainSessionPreferences } from './brainSessionPreferences'

describe('brainSessionPreferences', () => {
    it('parses saved preferences from metadata', () => {
        const preferences = getBrainSessionPreferencesFromMetadata({
            path: '/tmp',
            host: 'ncu',
            homeDir: '/home/guang',
            yohoRemoteHomeDir: '/home/guang/.yoho-remote',
            yohoRemoteLibDir: '/home/workspaces/repos/yoho-remote/cli',
            yohoRemoteToolsDir: '/home/workspaces/repos/yoho-remote/cli/tools/unpacked',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
                childModels: {
                    claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                    codex: { allowed: ['gpt-5.4-mini'], defaultModel: 'gpt-5.4-mini' },
                },
            },
        })

        expect(preferences?.machineSelection.machineId).toBe('machine-1')
        expect(preferences?.childModels.codex.allowed).toEqual(['gpt-5.4-mini'])
    })

    it('derives enabled child agents from allowed model lists', () => {
        const preferences = parseBrainSessionPreferences({
            machineSelection: { mode: 'auto', machineId: 'machine-2' },
            childModels: {
                claude: { allowed: [], defaultModel: 'sonnet' },
                codex: { allowed: ['gpt-5.4'], defaultModel: 'gpt-5.4' },
            },
        })

        expect(getAllowedBrainChildAgents(preferences)).toEqual(['codex'])
    })
})
