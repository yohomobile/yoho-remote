import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Machine } from '../../sync/syncEngine'
import { createMachinesRoutes } from './machines'

function createMachine(overrides: Partial<Machine>): Machine {
    return {
        id: 'machine-default',
        namespace: 'default',
        seq: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_010_000,
        active: false,
        activeAt: 1_700_000_005_000,
        metadata: {
            host: 'test-host',
            platform: 'linux',
            yohoRemoteCliVersion: 'v1.0.0',
        },
        metadataVersion: 1,
        daemonState: {
            status: 'offline',
        },
        daemonStateVersion: 1,
        orgId: null,
        ...overrides,
    }
}

describe('createMachinesRoutes', () => {
    it('returns offline machines with full payload and online-first ordering', async () => {
        const onlineMachine = createMachine({
            id: 'machine-online',
            active: true,
            activeAt: 1_700_000_020_000,
            metadata: {
                host: 'online-host',
                platform: 'linux',
                yohoRemoteCliVersion: 'v2.0.0',
                publicIp: '1.2.3.4',
            },
            daemonState: {
                status: 'running',
                pid: 1234,
                httpPort: 3006,
            },
        })

        const offlineMachine = createMachine({
            id: 'machine-offline',
            active: false,
            activeAt: 1_700_000_015_000,
            metadata: {
                host: 'offline-host',
                platform: 'darwin',
                yohoRemoteCliVersion: 'v1.5.0',
                arch: 'arm64',
            },
            daemonState: {
                status: 'offline',
            },
        })

        const fakeEngine = {
            getMachinesByNamespace: () => [offlineMachine, onlineMachine],
        }

        const app = new Hono<{ Variables: { namespace: string } }>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => fakeEngine as any, {} as any))

        const response = await app.request('/api/machines')
        expect(response.status).toBe(200)

        const payload = await response.json() as { machines: Array<Record<string, any>> }
        expect(payload.machines).toHaveLength(2)
        expect(payload.machines.map((machine) => machine.id)).toEqual(['machine-online', 'machine-offline'])
        expect(payload.machines[0]?.daemonState).toEqual({
            status: 'running',
            pid: 1234,
            httpPort: 3006,
        })
        expect(payload.machines[1]?.metadata).toMatchObject({
            host: 'offline-host',
            platform: 'darwin',
            arch: 'arm64',
        })
    })
})
