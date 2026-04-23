import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Machine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
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

    it('patches resolved identity context after machine spawn', async () => {
        let resolvePatch!: (call: { sessionId: string; patch: Record<string, unknown> }) => void
        const patchPromise = new Promise<{ sessionId: string; patch: Record<string, unknown> }>((resolve) => {
            resolvePatch = resolve
        })
        const machine = createMachine({
            id: 'machine-1',
            active: true,
            metadata: {
                host: 'test-host',
                platform: 'linux',
                yohoRemoteCliVersion: 'v1.0.0',
                homeDir: '/home/dev',
            },
        })
        const activeSession = {
            id: 'session-new',
            namespace: 'default',
            active: true,
            metadata: { path: '/tmp/project' },
        }
        const fakeEngine = {
            getMachine: (id: string) => id === 'machine-1' ? machine : null,
            getSession: () => activeSession,
            spawnSession: async () => ({ type: 'success', sessionId: 'session-new' }),
            patchSessionMetadata: async (sessionId: string, patch: Record<string, unknown>) => {
                resolvePatch({ sessionId, patch })
                return { ok: true }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
        }

        const fakeStore = {
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', [])
            c.set('identityActor', {
                identityId: 'identity-1',
                personId: 'person-1',
                channel: 'keycloak',
                resolution: 'auto_verified',
                displayName: 'Dev User',
                email: 'dev@example.com',
                externalId: 'keycloak-user-1',
                accountType: 'human',
            })
            await next()
        })
        app.route('/api', createMachinesRoutes(() => fakeEngine as any, fakeStore))

        const response = await app.request('/api/machines/machine-1/spawn', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'claude',
            }),
        })

        expect(response.status).toBe(200)
        const patchCall = await Promise.race([
            patchPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for identity context patch')), 100)),
        ])
        expect(patchCall).toEqual({
            sessionId: 'session-new',
            patch: {
                identityContext: {
                    version: 1,
                    mode: 'single-actor',
                    defaultActor: {
                        identityId: 'identity-1',
                        personId: 'person-1',
                        channel: 'keycloak',
                        resolution: 'auto_verified',
                        displayName: 'Dev User',
                        email: 'dev@example.com',
                        externalId: 'keycloak-user-1',
                        accountType: 'human',
                    },
                },
            },
        })
    })

})
