import { describe, expect, test } from 'bun:test'
import type { Machine } from '../types/api'
import { sortMachinesForStableDisplay } from './machines'

function createMachine(input: {
    id: string
    active: boolean
    activeAt: number
    title?: string
    host?: string
}): Machine {
    return {
        id: input.id,
        active: input.active,
        activeAt: input.activeAt,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        metadata: {
            host: input.host ?? `${input.id}.local`,
            displayName: input.title,
            platform: 'linux',
            yohoRemoteCliVersion: 'v1.0.0',
        },
        daemonState: {
            status: input.active ? 'running' : 'offline',
        },
        supportedAgents: null,
    }
}

describe('sortMachinesForStableDisplay', () => {
    test('keeps online machines first without reordering them by heartbeat timestamps', () => {
        const machines = [
            createMachine({ id: 'zulu', active: true, activeAt: 3_000, title: 'Zulu' }),
            createMachine({ id: 'alpha', active: true, activeAt: 1_000, title: 'Alpha' }),
            createMachine({ id: 'offline', active: false, activeAt: 9_000, title: 'Offline' }),
        ]

        expect(sortMachinesForStableDisplay(machines).map((machine) => machine.id)).toEqual([
            'alpha',
            'zulu',
            'offline',
        ])
    })

    test('falls back to host and id when titles are the same', () => {
        const machines = [
            createMachine({ id: 'machine-b', active: true, activeAt: 2_000, title: 'Worker', host: 'b-host' }),
            createMachine({ id: 'machine-a', active: true, activeAt: 1_000, title: 'Worker', host: 'a-host' }),
        ]

        expect(sortMachinesForStableDisplay(machines).map((machine) => machine.id)).toEqual([
            'machine-a',
            'machine-b',
        ])
    })
})
