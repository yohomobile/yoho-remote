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
        supportedAgents: null,
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

    it('updates machine workspace group metadata', async () => {
        const machine = createMachine({
            id: 'machine-workspace',
            metadata: {
                host: 'workspace-host',
                platform: 'darwin',
                yohoRemoteCliVersion: 'v2.1.0',
                displayName: 'MacBook',
            },
            metadataVersion: 3,
        })

        const updateCalls: Array<{ id: string; metadata: Record<string, unknown>; version: number; namespace: string }> = []
        const fakeEngine = {
            getMachinesByNamespace: () => [machine],
            getMachine: (id: string) => id === machine.id ? machine : undefined,
            emit: () => {},
        }
        const store = {
            updateMachineMetadata: async (id: string, metadata: unknown, version: number, namespace: string) => {
                updateCalls.push({ id, metadata: metadata as Record<string, unknown>, version, namespace })
                return { result: 'success' as const, version: version + 1, value: metadata }
            },
            getMachineByNamespace: async () => null,
        }

        const app = new Hono<{ Variables: { namespace: string } }>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => fakeEngine as any, store as any))

        const response = await app.request('/api/machines/machine-workspace/workspace-group', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceGroupId: 'laptops' }),
        })
        expect(response.status).toBe(200)

        expect(updateCalls).toEqual([
            {
                id: 'machine-workspace',
                metadata: {
                    host: 'workspace-host',
                    platform: 'darwin',
                    yohoRemoteCliVersion: 'v2.1.0',
                    displayName: 'MacBook',
                    workspaceGroupId: 'laptops',
                },
                version: 3,
                namespace: 'default',
            },
        ])

        const payload = await response.json() as { ok: boolean; machine: { metadata: { workspaceGroupId: string | null } } }
        expect(payload.ok).toBe(true)
        expect(payload.machine.metadata.workspaceGroupId).toBe('laptops')
    })
})
