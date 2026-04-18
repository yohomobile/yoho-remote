import { describe, expect, test } from 'bun:test'
import type { Metadata } from '@/api/types'
import { mergeResumeMetadata } from './mergeResumeMetadata'

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp/project',
        host: 'host-a',
        homeDir: '/home/tester',
        yohoRemoteHomeDir: '/home/tester/.yoho-remote',
        yohoRemoteLibDir: '/opt/yoho-remote/lib',
        yohoRemoteToolsDir: '/opt/yoho-remote/tools',
        ...overrides,
    }
}

describe('mergeResumeMetadata', () => {
    test('preserves existing brain metadata when resumed process omits those fields', () => {
        const current = createMetadata({
            source: 'brain-child',
            mainSessionId: 'brain-session-1',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
            summary: {
                text: 'existing summary',
                updatedAt: 123,
            },
            claudeSessionId: 'claude-session-1',
        })

        const incoming = createMetadata({
            host: 'host-b',
            source: undefined,
            mainSessionId: undefined,
            brainPreferences: undefined,
            summary: {
                text: 'new summary should not replace existing one',
                updatedAt: 456,
            },
            claudeSessionId: undefined,
        })

        expect(mergeResumeMetadata(current, incoming)).toMatchObject({
            host: 'host-b',
            source: 'brain-child',
            mainSessionId: 'brain-session-1',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
            summary: {
                text: 'existing summary',
                updatedAt: 123,
            },
            claudeSessionId: 'claude-session-1',
        })
    })
})
