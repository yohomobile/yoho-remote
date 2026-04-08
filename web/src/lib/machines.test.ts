import { describe, expect, test } from 'bun:test'
import { getMobileSessionAgentSummary } from './machines'

describe('getMobileSessionAgentSummary', () => {
    test('includes machine name before project name in mobile session header summary', () => {
        expect(getMobileSessionAgentSummary({
            agentLabel: 'Codex',
            machineName: 'ncu',
            projectName: 'YohoRemote'
        })).toBe('Codex · ncu · YohoRemote')
    })

    test('skips empty machine and project values', () => {
        expect(getMobileSessionAgentSummary({
            agentLabel: 'Claude',
            machineName: '   ',
            projectName: null
        })).toBe('Claude')
    })
})
