import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { buildBrainSessionPreferences } from '../../brain/brainSessionPreferences'
import { configuration, createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'

function authHeaders() {
    return {
        authorization: `Bearer ${configuration.cliApiToken}`,
        'content-type': 'application/json',
        'x-org-id': 'default',
    }
}

function createBrainPreferences(machineId = 'machine-1') {
    return buildBrainSessionPreferences({
        machineSelectionMode: 'manual',
        machineId,
    })
}

describe('createCliRoutes projects', () => {
    beforeAll(async () => {
        await createConfiguration()
    })

    it('rejects project listing and creation for sessions without machineId', async () => {
        let getProjectsCalled = false
        let addProjectCalled = false
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: null,
                orgId: 'org-a',
            }),
            getProjects: async () => {
                getProjectsCalled = true
                return []
            },
            addProject: async () => {
                addProjectCalled = true
                return null
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const listResponse = await app.request('/cli/projects?sessionId=session-1', {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(listResponse.status).toBe(400)
        expect(await listResponse.json()).toEqual({
            error: 'Project operations require a machine-bound session',
        })

        const createResponse = await app.request('/cli/projects?sessionId=session-1', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
            }),
        })
        expect(createResponse.status).toBe(400)
        expect(await createResponse.json()).toEqual({
            error: 'Project operations require a machine-bound session',
        })

        expect(getProjectsCalled).toBe(false)
        expect(addProjectCalled).toBe(false)
    })

    it('rejects updates and deletes for projects on another machine', async () => {
        let updateProjectCalled = false
        let removeProjectCalled = false
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: 'machine-a',
                orgId: 'org-a',
            }),
            getProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: 'machine-b',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            updateProject: async () => {
                updateProjectCalled = true
                return null
            },
            removeProject: async () => {
                removeProjectCalled = true
                return true
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const updateResponse = await app.request('/cli/projects/project-1?sessionId=session-1', {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({
                name: 'YohoRemote',
            }),
        })
        expect(updateResponse.status).toBe(404)

        const deleteResponse = await app.request('/cli/projects/project-1?sessionId=session-1', {
            method: 'DELETE',
            headers: authHeaders(),
        })
        expect(deleteResponse.status).toBe(404)

        expect(updateProjectCalled).toBe(false)
        expect(removeProjectCalled).toBe(false)
    })

    it('includes brain-child initDone in the CLI session list payload', async () => {
        const childSession = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            activeAt: 1_700_000_000_100,
            thinking: false,
            modelMode: 'sonnet',
            agentState: null,
            metadata: {
                path: '/tmp/task',
                source: 'brain-child',
                machineId: 'machine-1',
                flavor: 'claude',
                summary: {
                    text: 'Child summary',
                    updatedAt: 1_700_000_000_000,
                },
                mainSessionId: 'brain-main',
                brainSummary: 'previous work',
            },
        }

        const engine = {
            getSessionsByNamespace: () => [childSession],
            isBrainChildInitDone: (sessionId: string) => sessionId === childSession.id ? false : true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [{
                id: 'child-session',
                active: true,
                activeAt: 1_700_000_000_100,
                thinking: false,
                initDone: false,
                modelMode: 'sonnet',
                pendingRequestsCount: 0,
                metadata: {
                    path: '/tmp/task',
                    source: 'brain-child',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    summary: {
                        text: 'Child summary',
                        updatedAt: 1_700_000_000_000,
                    },
                    mainSessionId: 'brain-main',
                    brainSummary: 'previous work',
                },
            }],
        })
    })

    it('normalizes stray brain linkage fields when creating a non-brain session through the CLI route', async () => {
        let capturedMetadata: unknown = null
        const engine = {
            getOrCreateSession: async (_tag: string, metadata: unknown) => {
                capturedMetadata = metadata
                return {
                    id: 'session-1',
                    metadata,
                }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                tag: 'session-1',
                metadata: {
                    path: '/tmp/task',
                    host: 'localhost',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yoho-remote',
                    yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
                    yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
                    source: 'MANUAL',
                    mainSessionId: 'brain-main',
                    brainPreferences: createBrainPreferences(),
                },
            }),
        })

        expect(response.status).toBe(200)
        expect(capturedMetadata).toEqual({
            path: '/tmp/task',
            host: 'localhost',
            homeDir: '/tmp',
            yohoRemoteHomeDir: '/tmp/.yoho-remote',
            yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
            yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
            source: 'manual',
        })
    })

    it('canonicalizes mixed-case brain-child source before persisting session metadata', async () => {
        let capturedMetadata: unknown = null
        const engine = {
            getOrCreateSession: async (_tag: string, metadata: unknown) => {
                capturedMetadata = metadata
                return {
                    id: 'brain-child-1',
                    metadata,
                }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                tag: 'brain-child-1',
                metadata: {
                    path: '/tmp/task',
                    host: 'localhost',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yoho-remote',
                    yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
                    yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
                    source: 'BRAIN-CHILD',
                    mainSessionId: 'brain-main',
                    caller: 'feishu',
                    brainPreferences: createBrainPreferences(),
                },
            }),
        })

        expect(response.status).toBe(200)
        expect(capturedMetadata).toEqual({
            path: '/tmp/task',
            host: 'localhost',
            homeDir: '/tmp',
            yohoRemoteHomeDir: '/tmp/.yoho-remote',
            yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
            yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
            source: 'brain-child',
            mainSessionId: 'brain-main',
            caller: 'feishu',
            brainPreferences: createBrainPreferences(),
        })
    })

    it('rejects brain-child session create/load when mainSessionId is missing', async () => {
        let createCalled = false
        const engine = {
            getOrCreateSession: async () => {
                createCalled = true
                return { id: 'session-1' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                tag: 'session-1',
                metadata: {
                    path: '/tmp/task',
                    host: 'localhost',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yoho-remote',
                    yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
                    yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
                    source: 'brain-child',
                },
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'brain-child sessions require mainSessionId',
        })
        expect(createCalled).toBe(false)
    })

    it('rejects invalid brainPreferences when creating brain-linked sessions through the CLI route', async () => {
        let createCalled = false
        const engine = {
            getOrCreateSession: async () => {
                createCalled = true
                return { id: 'session-1' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                tag: 'session-1',
                metadata: {
                    path: '/tmp/task',
                    host: 'localhost',
                    homeDir: '/tmp',
                    yohoRemoteHomeDir: '/tmp/.yoho-remote',
                    yohoRemoteLibDir: '/tmp/.yoho-remote/lib',
                    yohoRemoteToolsDir: '/tmp/.yoho-remote/tools',
                    source: 'brain',
                    brainPreferences: {
                        machineSelection: { mode: 'manual' },
                    },
                },
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Invalid brainPreferences in session metadata',
        })
        expect(createCalled).toBe(false)
    })

    it('archives brain sessions by default and still requests runtime shutdown for inactive sessions', async () => {
        const archiveCalls: Array<{ sessionId: string; options: Record<string, unknown> }> = []
        let hardDeleteCalls = 0
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: false,
            metadata: {
                path: '/tmp/task',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                machineId: 'machine-1',
                flavor: 'claude',
            },
        }

        const engine = {
            getSessionByNamespace: (sessionId: string) => {
                if (sessionId === session.id) return session
                if (sessionId === mainSession.id) return mainSession
                return null
            },
            getSession: (sessionId: string) => {
                if (sessionId === session.id) return session
                if (sessionId === mainSession.id) return mainSession
                return null
            },
            archiveSession: async (sessionId: string, options: Record<string, unknown>) => {
                archiveCalls.push({ sessionId, options })
                return true
            },
            deleteSession: async () => {
                hardDeleteCalls += 1
                return true
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session?mainSessionId=brain-main', {
            method: 'DELETE',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(archiveCalls).toEqual([{
            sessionId: 'child-session',
            options: {
                terminateSession: true,
                force: true,
                archivedBy: 'brain',
                archiveReason: 'Brain closed session',
            },
        }])
        expect(hardDeleteCalls).toBe(0)
    })

    it('passes brain metadata during child spawn without relying on a post-online metadata patch', async () => {
        let spawnedOptions: Record<string, unknown> | undefined
        let patchSessionMetadataCalled = 0
        let sendMessageCalled = 0
        let spawnSessionCalled = 0

        const session = {
            id: 'child-session',
            active: true,
            metadata: {
                path: '/tmp/child-session',
            },
        }
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
                caller: 'feishu',
                brainPreferences: createBrainPreferences(),
            },
        }

        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
            }),
            spawnSession: async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _yolo: boolean,
                options?: Record<string, unknown>
            ) => {
                spawnSessionCalled += 1
                spawnedOptions = options
                return { type: 'success', sessionId: session.id }
            },
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === mainBrainSession.id && namespace === mainBrainSession.namespace
                    ? mainBrainSession
                    : null,
            getSession: (sessionId: string) => {
                if (sessionId === session.id) return session
                if (sessionId === mainBrainSession.id) return mainBrainSession
                return null
            },
            subscribe: () => () => {},
            waitForSocketInRoom: async () => true,
            sendMessage: async () => {
                sendMessageCalled += 1
            },
            patchSessionMetadata: async () => {
                patchSessionMetadataCalled += 1
                return { ok: true }
            },
        }

        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === 'brain-main'
                ? {
                    id: 'brain-main',
                    orgId: 'org-1',
                    metadata: {
                        caller: 'feishu',
                        brainPreferences: createBrainPreferences(),
                    },
                }
                : null,
            setSessionOrgId: async () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'claude',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'child-session' })
        expect(spawnedOptions).toEqual(expect.objectContaining({
            source: 'brain-child',
            mainSessionId: 'brain-main',
            caller: 'feishu',
            brainPreferences: createBrainPreferences(),
            permissionMode: 'bypassPermissions',
        }))

        await new Promise(resolve => setTimeout(resolve, 0))

        expect(spawnSessionCalled).toBe(1)
        expect(patchSessionMetadataCalled).toBe(0)
        expect(sendMessageCalled).toBe(1)
    })

    it('uses Codex-compatible permission mode when spawning a brain child', async () => {
        let spawnedOptions: Record<string, unknown> | undefined

        const session = {
            id: 'child-session',
            active: true,
            metadata: {
                path: '/tmp/child-session',
            },
        }
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
                caller: 'feishu',
                brainPreferences: createBrainPreferences(),
            },
        }

        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                supportedAgents: ['codex'],
            }),
            getSessionByNamespace: (sessionId: string) => {
                if (sessionId === 'brain-main') return mainBrainSession
                if (sessionId === 'child-session') return session
                return null
            },
            getSession: (sessionId: string) => {
                if (sessionId === 'brain-main') return mainBrainSession
                if (sessionId === 'child-session') return session
                return null
            },
            spawnSession: async (_machineId: string, _directory: string, _agent: string, _yolo: boolean, options?: Record<string, unknown>) => {
                spawnedOptions = options
                return { type: 'success', sessionId: 'child-session' }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
        }

        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === 'brain-main'
                ? {
                    id: 'brain-main',
                    orgId: 'org-1',
                    metadata: mainBrainSession.metadata,
                }
                : null,
            setSessionOrgId: async () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                codexModel: 'gpt-5.4-mini',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'child-session' })
        expect(spawnedOptions).toEqual(expect.objectContaining({
            source: 'brain-child',
            mainSessionId: 'brain-main',
            permissionMode: 'yolo',
            modelMode: 'gpt-5.4-mini',
        }))
    })

    it('rejects child spawn when inherited brainPreferences metadata is invalid', async () => {
        let spawnCalled = false
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
                caller: 'feishu',
                brainPreferences: {
                    machineSelection: { mode: 'manual' },
                },
            },
        }

        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                supportedAgents: ['codex'],
            }),
            getSessionByNamespace: (sessionId: string) => sessionId === 'brain-main' ? mainBrainSession : null,
            getSession: (sessionId: string) => sessionId === 'brain-main' ? mainBrainSession : null,
            spawnSession: async () => {
                spawnCalled = true
                return { type: 'success', sessionId: 'child-session' }
            },
        }

        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === 'brain-main'
                ? {
                    id: 'brain-main',
                    orgId: 'org-1',
                    metadata: mainBrainSession.metadata,
                }
                : null,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            }),
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Parent brain session has invalid brainPreferences metadata; repair it before spawning children',
        })
        expect(spawnCalled).toBe(false)
    })

    it('rejects brain-child spawn requests without mainSessionId', async () => {
        let spawnSessionCalled = 0
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
            }),
            spawnSession: async () => {
                spawnSessionCalled += 1
                return { type: 'success', sessionId: 'child-session' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'claude',
                source: 'brain-child',
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual(expect.objectContaining({
            error: 'Invalid body',
        }))
        expect(spawnSessionCalled).toBe(0)
    })

    it('rejects brain-child spawn requests when mainSessionId does not point to a brain session', async () => {
        let spawnSessionCalled = 0
        const nonBrainSession = {
            id: 'not-a-brain',
            namespace: 'default',
            metadata: {
                source: 'webapp',
            },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
            }),
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === nonBrainSession.id && namespace === nonBrainSession.namespace
                    ? nonBrainSession
                    : null,
            getSession: (sessionId: string) => sessionId === nonBrainSession.id ? nonBrainSession : null,
            spawnSession: async () => {
                spawnSessionCalled += 1
                return { type: 'success', sessionId: 'child-session' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'claude',
                source: 'brain-child',
                mainSessionId: 'not-a-brain',
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'mainSessionId must reference a brain session',
        })
        expect(spawnSessionCalled).toBe(0)
    })

    it('spawns orchestrator-child sessions when mainSessionId points to an orchestrator session', async () => {
        let spawnedOptions: Record<string, unknown> | undefined
        let sendMessageCalled = 0
        const session = {
            id: 'orchestrator-child-session',
            namespace: 'default',
            active: true,
            metadata: {
                path: '/tmp/orchestrator-child-session',
            },
        }
        const mainSession = {
            id: 'orchestrator-main',
            namespace: 'default',
            metadata: {
                source: 'orchestrator',
                caller: 'webapp',
            },
        }

        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
            }),
            getSessionByNamespace: (sessionId: string) => {
                if (sessionId === mainSession.id) return mainSession
                if (sessionId === session.id) return session
                return null
            },
            getSession: (sessionId: string) => {
                if (sessionId === mainSession.id) return mainSession
                if (sessionId === session.id) return session
                return null
            },
            spawnSession: async (_machineId: string, _directory: string, _agent: string, _yolo: boolean, options?: Record<string, unknown>) => {
                spawnedOptions = options
                return { type: 'success', sessionId: session.id }
            },
            subscribe: () => () => {},
            waitForSocketInRoom: async () => true,
            sendMessage: async () => {
                sendMessageCalled += 1
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'claude',
                source: 'orchestrator-child',
                mainSessionId: 'orchestrator-main',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: session.id })
        expect(spawnedOptions).toEqual(expect.objectContaining({
            source: 'orchestrator-child',
            mainSessionId: 'orchestrator-main',
            caller: 'webapp',
        }))

        await new Promise(resolve => setTimeout(resolve, 0))

        expect(sendMessageCalled).toBe(1)
    })

    it('brain-child inherits Token Source from parent brainTokenSourceIds per child agent', async () => {
        let spawnedOptions: Record<string, unknown> | undefined
        const childSession = {
            id: 'codex-child',
            namespace: 'default',
            active: true,
            metadata: { path: '/tmp/task' },
        }
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
                brainTokenSourceIds: { claude: 'ts-claude', codex: 'ts-codex' },
            },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                orgId: 'org-1',
                supportedAgents: ['claude', 'codex'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: (sessionId: string) => sessionId === childSession.id ? childSession : null,
            spawnSession: async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _yolo: boolean,
                options?: Record<string, unknown>,
            ) => {
                spawnedOptions = options
                return { type: 'success', sessionId: childSession.id }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => undefined,
            subscribe: () => () => {},
        }
        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === 'brain-main'
                ? {
                    id: 'brain-main',
                    orgId: 'org-1',
                    metadata: {
                        brainTokenSourceIds: { claude: 'ts-claude', codex: 'ts-codex' },
                    },
                }
                : null,
            getOrganization: async () => ({
                id: 'org-1',
                name: 'Org 1',
                slug: 'org-1',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {
                    tokenSources: [
                        {
                            id: 'ts-claude',
                            name: 'Claude Source',
                            baseUrl: 'https://claude.example.com',
                            apiKey: 'claude-secret',
                            supportedAgents: ['claude'],
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'ts-codex',
                            name: 'Codex Source',
                            baseUrl: 'https://codex.example.com',
                            apiKey: 'codex-secret',
                            supportedAgents: ['codex'],
                            createdAt: 2,
                            updatedAt: 2,
                        },
                    ],
                },
            }),
            setSessionOrgId: async () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            }),
        })

        expect(response.status).toBe(200)
        expect(spawnedOptions).toEqual(expect.objectContaining({
            tokenSourceId: 'ts-codex',
            tokenSourceName: 'Codex Source',
            tokenSourceType: 'codex',
            tokenSourceBaseUrl: 'https://codex.example.com',
            tokenSourceApiKey: 'codex-secret',
        }))
    })

    it('brain-child legacy parent (no brainTokenSourceIds) with Local disabled still spawns (grandfathered)', async () => {
        let spawnedOptions: Record<string, unknown> | undefined
        const childSession = {
            id: 'legacy-child',
            namespace: 'default',
            active: true,
            metadata: { path: '/tmp/task' },
        }
        const mainBrainSession = {
            id: 'brain-legacy',
            namespace: 'default',
            metadata: { source: 'brain' },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                orgId: 'org-1',
                supportedAgents: ['claude', 'codex'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: (sessionId: string) => sessionId === childSession.id ? childSession : null,
            spawnSession: async (
                _machineId: string,
                _directory: string,
                _agent: string,
                _yolo: boolean,
                options?: Record<string, unknown>,
            ) => {
                spawnedOptions = options
                return { type: 'success', sessionId: childSession.id }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => undefined,
            subscribe: () => () => {},
        }
        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === 'brain-legacy'
                ? { id: 'brain-legacy', orgId: 'org-1', metadata: {} }
                : null,
            getOrganization: async () => ({
                id: 'org-1',
                name: 'Org 1',
                slug: 'org-1',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: { localTokenSourceEnabled: false },
            }),
            setSessionOrgId: async () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-legacy',
            }),
        })

        expect(response.status).toBe(200)
        expect(spawnedOptions?.tokenSourceId).toBeUndefined()
    })

    it('brain-child new-flow parent missing codex source + Local disabled → 400', async () => {
        let spawnSessionCalled = 0
        const mainBrainSession = {
            id: 'brain-strict',
            namespace: 'default',
            metadata: {
                source: 'brain',
                brainTokenSourceIds: { claude: 'ts-claude' },
            },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                orgId: 'org-1',
                supportedAgents: ['claude', 'codex'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: () => null,
            spawnSession: async () => {
                spawnSessionCalled += 1
                return { type: 'success', sessionId: 'should-not-spawn' }
            },
        }
        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === 'brain-strict'
                ? {
                    id: 'brain-strict',
                    orgId: 'org-1',
                    metadata: { brainTokenSourceIds: { claude: 'ts-claude' } },
                }
                : null,
            getOrganization: async () => ({
                id: 'org-1',
                name: 'Org 1',
                slug: 'org-1',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {
                    localTokenSourceEnabled: false,
                    tokenSources: [
                        {
                            id: 'ts-claude',
                            name: 'Claude Source',
                            baseUrl: 'https://claude.example.com',
                            apiKey: 'claude-secret',
                            supportedAgents: ['claude'],
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
            }),
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-strict',
            }),
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error?: string }
        expect(body.error).toContain('Local is disabled')
        expect(spawnSessionCalled).toBe(0)
    })

    it('brain-child rejects spawn when brainPreferences disallow the child agent', async () => {
        let spawnSessionCalled = 0
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                    childModels: {
                        claude: { allowed: [], defaultModel: 'sonnet' },
                        codex: { allowed: ['gpt-5.4'], defaultModel: 'gpt-5.4' },
                    },
                },
            },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                orgId: 'org-1',
                supportedAgents: ['claude', 'codex'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: () => null,
            spawnSession: async () => {
                spawnSessionCalled += 1
                return { type: 'success', sessionId: 'should-not-spawn' }
            },
        }
        const store = {
            getSessionByNamespace: async () => ({ id: 'brain-main', orgId: 'org-1', metadata: mainBrainSession.metadata }),
            getOrganization: async () => ({
                id: 'org-1',
                name: 'Org 1',
                slug: 'org-1',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {},
            }),
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'claude',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            }),
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error?: string }
        expect(body.error).toContain('does not allow child agent "claude"')
        expect(spawnSessionCalled).toBe(0)
    })

    it('brain-child rejects spawn when machine does not support child agent', async () => {
        let spawnSessionCalled = 0
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: { source: 'brain' },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                orgId: 'org-1',
                supportedAgents: ['claude'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: () => null,
            spawnSession: async () => {
                spawnSessionCalled += 1
                return { type: 'success', sessionId: 'should-not-spawn' }
            },
        }
        const store = {
            getSessionByNamespace: async () => ({ id: 'brain-main', orgId: 'org-1', metadata: {} }),
            getOrganization: async () => ({
                id: 'org-1',
                name: 'Org 1',
                slug: 'org-1',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {},
            }),
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/brain/spawn', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/task',
                agent: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            }),
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error?: string }
        expect(body.error).toContain('does not support agent "codex"')
        expect(spawnSessionCalled).toBe(0)
    })

    it('logs webhook timing in brain spawn perf summary when spawn fails after webhook wait starts', async () => {
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                supportedAgents: ['claude'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: () => null,
            spawnSession: async () => ({
                type: 'error',
                message: 'Session webhook timeout for PID 42',
                logs: [
                    { timestamp: 1_000, step: 'init', message: 'Starting session spawn', status: 'running' },
                    { timestamp: 1_100, step: 'spawn', message: 'Spawning CLI process: yoho-remote claude', status: 'running' },
                    { timestamp: 1_300, step: 'spawn', message: 'Process spawned with PID: 42', status: 'success' },
                    { timestamp: 1_350, step: 'webhook', message: 'Waiting for session to report back (PID: 42)...', status: 'running' },
                    { timestamp: 2_550, step: 'webhook', message: 'Session webhook timeout for PID 42', status: 'error' },
                    { timestamp: 2_560, step: 'error', message: 'Failed to spawn session: Session webhook timeout for PID 42', status: 'error' },
                ],
            }),
        }
        const warn = mock(() => {})
        const originalWarn = console.warn
        console.warn = warn as typeof console.warn

        try {
            const app = new Hono()
            app.route('/cli', createCliRoutes(() => engine as any))

            const response = await app.request('/cli/brain/spawn', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    machineId: 'machine-1',
                    directory: '/tmp/task',
                    agent: 'claude',
                    source: 'brain-child',
                    mainSessionId: 'brain-main',
                }),
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                type: 'error',
                message: 'Session webhook timeout for PID 42',
            })
            expect(warn).toHaveBeenCalledTimes(1)
            const loggedMessage = String((warn as any).mock.calls[0]?.[0] ?? '')
            expect(loggedMessage).toContain('daemon_cli_spawn=200ms')
            expect(loggedMessage).toContain('daemon_webhook=1200ms')
        } finally {
            console.warn = originalWarn
        }
    })

    it('logs spawn timing in brain spawn perf summary when daemon fails before webhook wait starts', async () => {
        const mainBrainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const engine = {
            getMachineByNamespace: () => ({
                id: 'machine-1',
                active: true,
                metadata: {},
                namespace: 'default',
                supportedAgents: ['claude'],
            }),
            getSessionByNamespace: (sessionId: string) =>
                sessionId === mainBrainSession.id ? mainBrainSession : null,
            getSession: () => null,
            spawnSession: async () => ({
                type: 'error',
                message: 'Failed to spawn YR process - no PID returned',
                logs: [
                    { timestamp: 2_000, step: 'init', message: 'Starting session spawn', status: 'running' },
                    { timestamp: 2_120, step: 'spawn', message: 'Spawning CLI process: yoho-remote claude', status: 'running' },
                    { timestamp: 2_620, step: 'spawn', message: 'Failed to spawn process - no PID returned', status: 'error' },
                    { timestamp: 2_630, step: 'error', message: 'Failed to spawn session: no pid', status: 'error' },
                ],
            }),
        }
        const warn = mock(() => {})
        const originalWarn = console.warn
        console.warn = warn as typeof console.warn

        try {
            const app = new Hono()
            app.route('/cli', createCliRoutes(() => engine as any))

            const response = await app.request('/cli/brain/spawn', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    machineId: 'machine-1',
                    directory: '/tmp/task',
                    agent: 'claude',
                    source: 'brain-child',
                    mainSessionId: 'brain-main',
                }),
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                type: 'error',
                message: 'Failed to spawn YR process - no PID returned',
            })
            expect(warn).toHaveBeenCalledTimes(1)
            const loggedMessage = String((warn as any).mock.calls[0]?.[0] ?? '')
            expect(loggedMessage).toContain('daemon_prep=120ms')
            expect(loggedMessage).toContain('daemon_cli_spawn=500ms')
            expect(loggedMessage).toContain('daemon_webhook=n/a')
        } finally {
            console.warn = originalWarn
        }
    })

    it('aborts a namespaced session through the CLI route', async () => {
        let abortedSessionId: string | null = null
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            metadata: {
                path: '/tmp/child-session',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            abortSession: async (sessionId: string) => {
                abortedSessionId = sessionId
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/abort', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(String(abortedSessionId)).toBe('child-session')
    })

    it('returns a machine-readable busy verdict for non-brain session_send without enqueuing', async () => {
        let sendCalled = 0
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            thinking: true,
            metadata: {
                path: '/tmp/child-session',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            sendMessage: async () => {
                sendCalled += 1
                return { status: 'delivered' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/messages?mainSessionId=brain-main', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                text: 'run task',
                sentFrom: 'brain',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: false,
            status: 'busy',
            sessionId: 'child-session',
            retryable: true,
        })
        expect(sendCalled).toBe(0)
    })

    it('returns the previous success verdict for duplicate idempotent retries on busy non-brain sessions', async () => {
        let sendCalled = 0
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            thinking: true,
            metadata: {
                path: '/tmp/child-session',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getSendOutcomeForCachedLocalId: (sessionId: string, localId: string) => (
                sessionId === session.id && localId === 'msg-123'
                    ? { status: 'delivered' as const }
                    : null
            ),
            sendMessage: async () => {
                sendCalled += 1
                return { status: 'delivered' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/messages?mainSessionId=brain-main', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'idempotency-key': 'msg-123',
            },
            body: JSON.stringify({
                text: 'run task',
                sentFrom: 'brain',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            status: 'delivered',
            sessionId: 'child-session',
        })
        expect(sendCalled).toBe(0)
    })

    it('queues busy brain session messages instead of rejecting them and forwards idempotency-key as localId', async () => {
        let sendPayload: Record<string, unknown> | null = null
        const session = {
            id: 'brain-session',
            namespace: 'default',
            active: true,
            thinking: true,
            metadata: {
                path: '/tmp/brain-session',
                source: 'brain',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            sendMessage: async (_sessionId: string, payload: Record<string, unknown>) => {
                sendPayload = payload
                return {
                    status: 'queued',
                    queue: 'brain-session-inbox',
                    queueDepth: 1,
                }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/brain-session/messages', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'idempotency-key': 'msg-123',
            },
            body: JSON.stringify({
                text: '继续处理',
                sentFrom: 'webapp',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            status: 'queued',
            sessionId: 'brain-session',
            queue: 'brain-session-inbox',
            queueDepth: 1,
        })
        expect(sendPayload).not.toBeNull()
        expect(sendPayload!).toEqual({
            text: '继续处理',
            localId: 'msg-123',
            sentFrom: 'webapp',
        })
    })

    it('returns a machine-readable offline verdict for session_send without delivering', async () => {
        let sendCalled = 0
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: false,
            thinking: false,
            metadata: {
                path: '/tmp/child-session',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            sendMessage: async () => {
                sendCalled += 1
                return { status: 'delivered' }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/messages', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                text: 'run task',
                sentFrom: 'brain',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: false,
            status: 'offline',
            sessionId: 'child-session',
            retryable: true,
            resumeRequired: true,
        })
        expect(sendCalled).toBe(0)
    })

    it('returns a machine-readable queued verdict for init-buffered session_send', async () => {
        let sendCalled = 0
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            thinking: false,
            metadata: {
                path: '/tmp/child-session',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            sendMessage: async () => {
                sendCalled += 1
                return {
                    status: 'queued',
                    queue: 'brain-child-init',
                    queueDepth: 1,
                }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/messages?mainSessionId=brain-main', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                text: 'run task',
                sentFrom: 'brain',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            status: 'queued',
            sessionId: 'child-session',
            queue: 'brain-child-init',
            queueDepth: 1,
        })
        expect(sendCalled).toBe(1)
    })

    it('applies shared runtime config through the CLI config route', async () => {
        let appliedConfig: Record<string, unknown> | null = null
        const session = {
            id: 'codex-session',
            namespace: 'default',
            active: true,
            metadata: {
                path: '/tmp/codex-session',
                flavor: 'codex',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            applySessionConfig: async (_sessionId: string, config: Record<string, unknown>) => {
                appliedConfig = config
                return {
                    permissionMode: config.permissionMode,
                    modelMode: config.modelMode,
                    modelReasoningEffort: config.modelReasoningEffort,
                    fastMode: config.fastMode,
                }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/codex-session/config', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                model: 'gpt-5.4-mini',
                reasoningEffort: 'high',
                permissionMode: 'safe-yolo',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            applied: {
                model: 'gpt-5.4-mini',
                reasoningEffort: 'high',
                permissionMode: 'safe-yolo',
            },
        })
        expect(appliedConfig ?? {}).toEqual({
            modelMode: 'gpt-5.4-mini',
            modelReasoningEffort: 'high',
            permissionMode: 'safe-yolo',
        })
    })

    it('accepts Codex default permissionMode through the CLI config route', async () => {
        let appliedConfig: Record<string, unknown> | null = null
        const session = {
            id: 'codex-session',
            namespace: 'default',
            active: true,
            metadata: {
                path: '/tmp/codex-session',
                flavor: 'codex',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            applySessionConfig: async (_sessionId: string, config: Record<string, unknown>) => {
                appliedConfig = config
                return {
                    permissionMode: config.permissionMode,
                }
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/codex-session/config', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                permissionMode: 'default',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            applied: {
                permissionMode: 'default',
            },
        })
        expect(appliedConfig ?? {}).toEqual({
            permissionMode: 'default',
        })
    })

    it('rejects bypassPermissions for Codex through the CLI config route', async () => {
        let applyCalled = false
        const session = {
            id: 'codex-session',
            namespace: 'default',
            active: true,
            metadata: {
                path: '/tmp/codex-session',
                flavor: 'codex',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            applySessionConfig: async () => {
                applyCalled = true
                return {}
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/codex-session/config', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                permissionMode: 'bypassPermissions',
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Codex sessions do not support permissionMode=bypassPermissions',
        })
        expect(applyCalled).toBe(false)
    })

    it('resumes an offline child session through the CLI route', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'brain-child-old',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            lastMessageAt: null,
            active: false,
            activeAt: 0,
            createdBy: null,
            metadata: {
                path: '/tmp/brain-child',
                machineId: 'machine-1',
                flavor: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                caller: 'feishu',
                brainPreferences: createBrainPreferences(),
                codexSessionId: 'thread-brain-child',
                lifecycleState: 'archived',
                archivedBy: 'user',
                archiveReason: 'User archived session',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            activeMonitors: [],
            thinking: false,
            thinkingAt: 0,
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5.4',
            modelReasoningEffort: 'high',
        }

        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        const unarchiveCalls: string[] = []
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default' }),
            checkPathsExist: async () => ({ '/tmp/brain-child': true }),
            spawnSession: async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                session.active = true
                return { type: 'success', sessionId: session.id }
            },
            unarchiveSession: async (sessionId: string) => {
                unarchiveCalls.push(sessionId)
                return { ok: true }
            },
            subscribe: () => () => {},
        }

        const store = {
            getSessionByNamespace: async (sessionId: string) => sessionId === session.id
                ? {
                    id: session.id,
                    namespace: session.namespace,
                    orgId: null,
                    metadata: session.metadata,
                    active: false,
                }
                : null,
            setSessionActive: async () => true,
            setSessionOrgId: async () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/sessions/brain-child-old/resume?mainSessionId=brain-main', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'resumed', sessionId: 'brain-child-old' })
        expect(spawnCalls).toEqual([expect.objectContaining({
            sessionId: 'brain-child-old',
            resumeSessionId: 'thread-brain-child',
            source: 'brain-child',
            mainSessionId: 'brain-main',
            caller: 'feishu',
            brainPreferences: createBrainPreferences(),
        })])
        expect(unarchiveCalls).toEqual(['brain-child-old'])
    })

    it('rejects CLI resume when brainPreferences metadata is invalid', async () => {
        let spawnCalled = false
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'brain-child-bad',
            namespace: 'default',
            active: false,
            activeAt: 0,
            createdAt: 0,
            updatedAt: 0,
            lastMessageAt: null,
            createdBy: null,
            metadata: {
                path: '/tmp/brain-child',
                machineId: 'machine-1',
                flavor: 'codex',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                brainPreferences: {
                    childModels: {
                        codex: { allowed: ['gpt-5.4'], defaultModel: 'gpt-5.4' },
                    },
                },
                codexSessionId: 'thread-bad',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            activeMonitors: [],
            thinking: false,
            thinkingAt: 0,
            permissionMode: 'yolo',
            modelMode: 'gpt-5.4',
        }

        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default' }),
            checkPathsExist: async () => ({ '/tmp/brain-child': true }),
            spawnSession: async () => {
                spawnCalled = true
                return { type: 'success', sessionId: session.id }
            },
            subscribe: () => () => {},
        }

        const store = {
            getSessionByNamespace: async () => ({
                id: session.id,
                namespace: session.namespace,
                orgId: null,
                metadata: session.metadata,
                active: false,
            }),
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request(`/cli/sessions/${session.id}/resume?mainSessionId=brain-main`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session has invalid brainPreferences metadata; repair it before resuming',
        })
        expect(spawnCalled).toBe(false)
    })

    it('returns orchestration-focused diagnostics from the inspect route', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            seq: 0,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_900,
            lastMessageAt: 1_700_000_000_800,
            active: true,
            activeAt: 1_700_000_000_100,
            createdBy: 'brain@example.com',
            metadata: {
                path: '/tmp/child-session',
                source: 'brain-child',
                caller: 'webapp',
                machineId: 'machine-1',
                flavor: 'codex',
                runtimeAgent: 'codex',
                runtimeModel: 'gpt-5.4',
                runtimeModelReasoningEffort: 'high',
                summary: {
                    text: 'child summary',
                    updatedAt: 1_700_000_000_700,
                },
                mainSessionId: 'brain-main',
                brainSummary: 'previous work',
                selfSystemEnabled: true,
                selfProfileId: 'profile-1',
                selfProfileName: 'K1',
                selfProfileResolved: true,
                selfMemoryProvider: 'yoho-memory',
                selfMemoryAttached: false,
                selfMemoryStatus: 'error',
            },
            metadataVersion: 1,
            agentState: {
                requests: {
                    'req-1': {
                        tool: 'Read',
                        createdAt: 1_700_000_000_750,
                    },
                },
            },
            agentStateVersion: 1,
            activeMonitors: [{
                id: 'mon-1',
                description: 'tail logs',
                command: 'tail -f app.log',
                persistent: true,
                timeoutMs: null,
                startedAt: 1_700_000_000_600,
                taskId: 'task-1',
                state: 'running',
            }],
            thinking: true,
            thinkingAt: 1_700_000_000_500,
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5.4',
            modelReasoningEffort: 'high',
            fastMode: true,
            todos: [{
                id: 'todo-1',
                content: 'Inspect sync logs',
                status: 'completed',
                priority: 'high',
            }, {
                id: 'todo-2',
                content: 'Patch retry loop',
                status: 'in_progress',
                priority: 'medium',
            }],
            terminationReason: 'license-expired',
        }

        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace
                    ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace
                        ? mainSession
                        : null,
            getSession: (sessionId: string) =>
                sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getMessageCount: async () => 42,
            getLastUsageForSession: async () => ({
                input_tokens: 1200,
                output_tokens: 300,
                contextSize: 12_345,
            }),
            isBrainChildInitDone: () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/inspect?mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(expect.objectContaining({
            sessionId: 'child-session',
            status: 'running',
            lastMessageAt: 1_700_000_000_800,
            pendingRequestsCount: 1,
            todoProgress: { completed: 1, total: 2 },
            terminationReason: 'license-expired',
            runtimeModel: 'gpt-5.4',
            fastMode: true,
            activeMonitors: [expect.objectContaining({
                id: 'mon-1',
                command: 'tail -f app.log',
            })],
            metadata: expect.objectContaining({
                path: '/tmp/child-session',
                mainSessionId: 'brain-main',
                brainSummary: 'previous work',
                selfProfileName: 'K1',
                selfMemoryStatus: 'error',
            }),
            contextWindow: expect.objectContaining({
                usedTokens: 12_345,
            }),
        }))
    })

    it('returns recent real tail fragments instead of weak counters', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            metadata: {
                path: '/tmp/child-session',
                source: 'brain-child',
                mainSessionId: 'brain-main',
            },
        }

        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace
                    ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace
                        ? mainSession
                        : null,
            getSession: (sessionId: string) =>
                sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getMessagesPage: async () => ({
                messages: [{
                    id: 'm-1',
                    seq: 1,
                    localId: null,
                    createdAt: 1_700_000_000_100,
                    content: {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'Investigate the failing sync job',
                        },
                        meta: { sentFrom: 'brain' },
                    },
                }, {
                    id: 'm-2',
                    seq: 2,
                    localId: null,
                    createdAt: 1_700_000_000_200,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'assistant',
                                message: {
                                    content: [{ type: 'text', text: 'Running focused verification now' }],
                                },
                            },
                        },
                    },
                }, {
                    id: 'm-3',
                    seq: 3,
                    localId: null,
                    createdAt: 1_700_000_000_300,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'attachment',
                                attachment: {
                                    type: 'todo_reminder',
                                    content: [{
                                        content: 'Inspect sync logs',
                                        status: 'in_progress',
                                    }],
                                },
                            },
                        },
                    },
                }, {
                    id: 'm-4',
                    seq: 4,
                    localId: null,
                    createdAt: 1_700_000_000_400,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'result',
                                result: 'Found the root cause and prepared a patch',
                            },
                        },
                    },
                }],
                page: {
                    limit: 24,
                    beforeSeq: null,
                    nextBeforeSeq: 1,
                    hasMore: false,
                },
            }),
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-session/tail?mainSessionId=brain-main&limit=3', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessionId: 'child-session',
            items: [{
                seq: 2,
                createdAt: 1_700_000_000_200,
                role: 'agent',
                kind: 'assistant',
                subtype: 'assistant',
                sentFrom: null,
                snippet: 'Running focused verification now',
            }, {
                seq: 3,
                createdAt: 1_700_000_000_300,
                role: 'agent',
                kind: 'todo',
                subtype: 'todo_reminder',
                sentFrom: null,
                snippet: '当前待办：\n- [in_progress] Inspect sync logs',
            }, {
                seq: 4,
                createdAt: 1_700_000_000_400,
                role: 'agent',
                kind: 'result',
                subtype: 'result',
                sentFrom: null,
                snippet: 'Found the root cause and prepared a patch',
            }],
            returned: 3,
            inspectedMessages: 4,
            newestSeq: 4,
            oldestSeq: 1,
            hasMoreHistory: false,
        })
    })

    it('filters the session list to children of the requested main brain session', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            active: true,
            activeAt: 10,
            thinking: false,
            metadata: {
                source: 'brain',
            },
        }
        const matchingChild = {
            id: 'child-match',
            namespace: 'default',
            active: true,
            activeAt: 20,
            thinking: false,
            modelMode: 'gpt-5.4',
            agentState: { requests: {} },
            metadata: {
                path: '/tmp/match',
                source: 'brain-child',
                flavor: 'codex',
                mainSessionId: 'brain-main',
            },
        }
        const otherChild = {
            id: 'child-other',
            namespace: 'default',
            active: true,
            activeAt: 30,
            thinking: false,
            modelMode: 'sonnet',
            agentState: { requests: {} },
            metadata: {
                path: '/tmp/other',
                source: 'brain-child',
                flavor: 'claude',
                mainSessionId: 'brain-other',
            },
        }
        const plainSession = {
            id: 'plain-session',
            namespace: 'default',
            active: true,
            activeAt: 40,
            thinking: false,
            modelMode: 'default',
            agentState: { requests: {} },
            metadata: {
                path: '/tmp/plain',
                source: 'manual',
            },
        }

        const engine = {
            getSessionsByNamespace: () => [mainSession, matchingChild, otherChild, plainSession],
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                namespace === 'default' && sessionId === mainSession.id ? mainSession : null,
            getSession: (sessionId: string) => sessionId === mainSession.id ? mainSession : null,
            isBrainChildInitDone: () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions?includeOffline=true&mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [expect.objectContaining({
                id: 'child-match',
                active: true,
                activeAt: 20,
                thinking: false,
                modelMode: 'gpt-5.4',
                pendingRequestsCount: 0,
                metadata: expect.objectContaining({
                    path: '/tmp/match',
                    source: 'brain-child',
                    flavor: 'codex',
                    mainSessionId: 'brain-main',
                }),
            })],
        })
    })

    it('does not expose stale mainSessionId in CLI session summaries for non-brain-child sessions', async () => {
        const dirtySession = {
            id: 'manual-dirty',
            namespace: 'default',
            active: true,
            activeAt: 40,
            thinking: false,
            modelMode: 'default',
            agentState: { requests: {} },
            metadata: {
                path: '/tmp/plain',
                source: 'manual',
                mainSessionId: 'brain-main',
            },
        }

        const engine = {
            getSessionsByNamespace: () => [dirtySession],
            getSessionByNamespace: () => null,
            getSession: () => null,
            isBrainChildInitDone: () => true,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions?includeOffline=true', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        const payload = await response.json() as {
            sessions: Array<{
                id: string
                metadata: Record<string, unknown> | null
            }>
        }
        expect(payload.sessions[0]).toMatchObject({
            id: 'manual-dirty',
            metadata: {
                path: '/tmp/plain',
                source: 'manual',
            },
        })
        expect(payload.sessions[0]?.metadata).not.toHaveProperty('mainSessionId')
    })

    it('rejects status lookups outside the requested brain child scope', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const unrelatedChild = {
            id: 'child-other',
            namespace: 'default',
            active: true,
            metadata: {
                source: 'brain-child',
                mainSessionId: 'brain-other',
            },
        }

        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                namespace === 'default' && sessionId === unrelatedChild.id
                    ? unrelatedChild
                    : namespace === 'default' && sessionId === mainSession.id
                        ? mainSession
                        : null,
            getSession: (sessionId: string) =>
                sessionId === unrelatedChild.id ? unrelatedChild : sessionId === mainSession.id ? mainSession : null,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const response = await app.request('/cli/sessions/child-other/status?mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
            error: 'Session access denied',
        })
    })

    it('requires mainSessionId for brain child inspect/status/tail routes', async () => {
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => ({
            getSessionByNamespace: () => null,
            getSession: () => null,
        }) as any))

        const inspectResponse = await app.request('/cli/sessions/child-session/inspect', {
            method: 'GET',
            headers: authHeaders(),
        })
        const statusResponse = await app.request('/cli/sessions/child-session/status', {
            method: 'GET',
            headers: authHeaders(),
        })
        const tailResponse = await app.request('/cli/sessions/child-session/tail?limit=3', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(inspectResponse.status).toBe(400)
        expect(statusResponse.status).toBe(400)
        expect(tailResponse.status).toBe(400)
    })

    it('requires mainSessionId for brain child session read routes', async () => {
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            metadata: {
                source: 'brain-child',
                mainSessionId: 'brain-main',
                path: '/tmp/child-session',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const sessionResponse = await app.request('/cli/sessions/child-session', {
            method: 'GET',
            headers: authHeaders(),
        })
        const messagesResponse = await app.request('/cli/sessions/child-session/messages?limit=3', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(sessionResponse.status).toBe(400)
        expect(await sessionResponse.json()).toEqual({
            error: 'brain-child sessions require mainSessionId',
        })
        expect(messagesResponse.status).toBe(400)
        expect(await messagesResponse.json()).toEqual({
            error: 'brain-child sessions require mainSessionId',
        })
    })

    it('scopes orchestrator child session read routes to the requested mainSessionId', async () => {
        const mainSession = {
            id: 'orchestrator-main',
            namespace: 'default',
            metadata: {
                source: 'orchestrator',
            },
        }
        const session = {
            id: 'orchestrator-child-session',
            namespace: 'default',
            active: true,
            metadata: {
                source: 'orchestrator-child',
                mainSessionId: 'orchestrator-main',
                path: '/tmp/orchestrator-child-session',
            },
        }
        const messages = [{
            id: 'm-1',
            seq: 1,
            localId: null,
            createdAt: 1_700_000_000_100,
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'hello orchestrator',
                },
            },
        }]
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getMessagesAfter: async (_sessionId: string, _opts: { afterSeq: number; limit: number }) => messages,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const missingMainResponse = await app.request('/cli/sessions/orchestrator-child-session', {
            method: 'GET',
            headers: authHeaders(),
        })
        const sessionResponse = await app.request('/cli/sessions/orchestrator-child-session?mainSessionId=orchestrator-main', {
            method: 'GET',
            headers: authHeaders(),
        })
        const messagesResponse = await app.request('/cli/sessions/orchestrator-child-session/messages?mainSessionId=orchestrator-main&limit=3', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(missingMainResponse.status).toBe(400)
        expect(await missingMainResponse.json()).toEqual({
            error: 'orchestrator-child sessions require mainSessionId',
        })
        expect(sessionResponse.status).toBe(200)
        expect(await sessionResponse.json()).toEqual({ session })
        expect(messagesResponse.status).toBe(200)
        expect(await messagesResponse.json()).toEqual({ messages })
    })

    it('scopes brain child session read routes to the requested mainSessionId', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            metadata: {
                source: 'brain-child',
                mainSessionId: 'brain-main',
                path: '/tmp/child-session',
            },
        }
        const messages = [{
            id: 'm-1',
            seq: 1,
            localId: null,
            createdAt: 1_700_000_000_100,
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'hello',
                },
            },
        }]
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session
                    : sessionId === mainSession.id && namespace === mainSession.namespace ? mainSession
                        : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : sessionId === mainSession.id ? mainSession : null,
            getMessagesAfter: async (_sessionId: string, _opts: { afterSeq: number; limit: number }) => messages,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const sessionResponse = await app.request('/cli/sessions/child-session?mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })
        const messagesResponse = await app.request('/cli/sessions/child-session/messages?mainSessionId=brain-main&limit=3', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(sessionResponse.status).toBe(200)
        expect(await sessionResponse.json()).toEqual({ session })
        expect(messagesResponse.status).toBe(200)
        expect(await messagesResponse.json()).toEqual({ messages })
    })

    it('supports read routes after mainSessionId is repaired to valid brain session', async () => {
        const mainSession = {
            id: 'brain-main',
            namespace: 'default',
            metadata: {
                source: 'brain',
            },
        }
        const childSession = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            metadata: {
                source: 'brain-child',
                path: '/tmp/child-session',
            } as Record<string, unknown>,
        }

        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === childSession.id && namespace === childSession.namespace
                    ? childSession
                    : sessionId === mainSession.id && namespace === mainSession.namespace
                        ? mainSession
                        : null,
            getSession: (sessionId: string) =>
                sessionId === childSession.id ? childSession : sessionId === mainSession.id ? mainSession : null,
            getMessagesAfter: async (_sessionId: string, _opts: { afterSeq: number; limit: number }) => [],
            getMessageCount: async () => 0,
            getLastUsageForSession: async () => null,
            isBrainChildInitDone: () => false,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any))

        const beforeFix = await app.request('/cli/sessions/child-session/messages?mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(beforeFix.status).toBe(403)
        expect(await beforeFix.json()).toEqual({
            error: 'Session access denied',
        })

        childSession.metadata = {
            source: 'brain-child',
            mainSessionId: 'brain-main',
            path: '/tmp/child-session',
        } as Record<string, unknown>

        const afterFix = await app.request('/cli/sessions/child-session/messages?mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })
        const inspectResponse = await app.request('/cli/sessions/child-session/status?mainSessionId=brain-main', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(afterFix.status).toBe(200)
        expect(await afterFix.json()).toEqual({ messages: [] })
        expect(inspectResponse.status).toBe(200)
        expect(await inspectResponse.json()).toHaveProperty('active')
    })

    it('requires mainSessionId for brain child mutating routes', async () => {
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            metadata: {
                source: 'brain-child',
                mainSessionId: 'brain-main',
                path: '/tmp/child-session',
                flavor: 'codex',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
        }
        const store = {
            getSessionByNamespace: async () => null,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const routes = [{
            path: '/cli/sessions/child-session/messages',
            method: 'POST',
            body: { text: 'run task', sentFrom: 'brain' },
        }, {
            path: '/cli/sessions/child-session/abort',
            method: 'POST',
            body: {},
        }, {
            path: '/cli/sessions/child-session/resume',
            method: 'POST',
            body: {},
        }, {
            path: '/cli/sessions/child-session/config',
            method: 'POST',
            body: { model: 'gpt-5.4-mini' },
        }, {
            path: '/cli/sessions/child-session',
            method: 'DELETE',
            body: undefined,
        }, {
            path: '/cli/sessions/child-session/metadata',
            method: 'PATCH',
            body: { brainSummary: 'updated summary' },
        }, {
            path: '/cli/sessions/child-session/model-mode',
            method: 'PATCH',
            body: { modelMode: 'gpt-5.4-mini' },
        }] as const

        for (const route of routes) {
            const response = await app.request(route.path, {
                method: route.method,
                headers: authHeaders(),
                body: route.body === undefined ? undefined : JSON.stringify(route.body),
            })

            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({
                error: 'brain-child sessions require mainSessionId',
            })
        }
    })

    it('returns structured session history matches and overlays live session state', async () => {
        let searchArgs: Record<string, unknown> | undefined
        const store = {
            searchSessionHistory: async (args: Record<string, unknown>) => {
                searchArgs = args
                return [{
                    session: {
                        id: 'child-session',
                        active: false,
                        thinking: false,
                        activeAt: 1_700_000_000_000,
                        updatedAt: 1_700_000_000_100,
                        lastMessageAt: 1_700_000_000_200,
                        permissionMode: 'read-only',
                        modelMode: 'gpt-5.4',
                        modelReasoningEffort: 'medium',
                        fastMode: null,
                        metadata: {
                            path: '/tmp/project-a',
                            source: 'brain-child',
                            machineId: 'machine-1',
                            flavor: 'codex',
                            mainSessionId: 'brain-main',
                            brainSummary: '处理过 worker / publisher / summary 闭环',
                            summary: { text: 'Publisher smoke', updatedAt: 1_700_000_000_111 },
                        },
                    },
                    score: 99,
                    match: {
                        source: 'turn-summary',
                        text: '验证 worker / publisher / session_summaries 闭环',
                        createdAt: 1_700_000_000_300,
                        seqStart: 10,
                        seqEnd: 18,
                    },
                }]
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) => sessionId === 'child-session' && namespace === 'default'
                ? {
                    id: 'child-session',
                    active: true,
                    thinking: true,
                    activeAt: 1_700_000_000_500,
                    updatedAt: 1_700_000_000_600,
                    lastMessageAt: 1_700_000_000_700,
                    permissionMode: 'yolo',
                    modelMode: 'gpt-5.4-mini',
                    modelReasoningEffort: 'high',
                    fastMode: false,
                    metadata: {
                        path: '/tmp/project-a',
                        source: 'brain-child',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        mainSessionId: 'brain-main',
                        brainSummary: '处理过 worker / publisher / summary 闭环',
                        summary: { text: 'Publisher smoke', updatedAt: 1_700_000_000_111 },
                    },
                    agentState: {
                        requests: {
                            req1: { tool: 'write_file' },
                        },
                    },
                }
                : undefined,
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as any, undefined, store as any))

        const response = await app.request('/cli/sessions/search?query=publisher%20worker&limit=3&mainSessionId=brain-main&flavor=codex', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(searchArgs).toEqual({
            orgId: 'default',
            query: 'publisher worker',
            limit: 3,
            includeOffline: true,
            mainSessionId: 'brain-main',
            directory: undefined,
            flavor: 'codex',
            source: undefined,
        })
        expect(await response.json()).toEqual({
            query: 'publisher worker',
            returned: 1,
            results: [{
                sessionId: 'child-session',
                score: 99,
                active: true,
                thinking: true,
                activeAt: 1_700_000_000_500,
                updatedAt: 1_700_000_000_600,
                lastMessageAt: 1_700_000_000_700,
                pendingRequestsCount: 1,
                permissionMode: 'yolo',
                modelMode: 'gpt-5.4-mini',
                modelReasoningEffort: 'high',
                fastMode: false,
                metadata: {
                    path: '/tmp/project-a',
                    summary: { text: 'Publisher smoke', updatedAt: 1_700_000_000_111 },
                    brainSummary: '处理过 worker / publisher / summary 闭环',
                    source: 'brain-child',
                    caller: null,
                    machineId: 'machine-1',
                    flavor: 'codex',
                    mainSessionId: 'brain-main',
                    selfSystemEnabled: null,
                    selfProfileId: null,
                    selfProfileName: null,
                    selfProfileResolved: null,
                    selfMemoryProvider: null,
                    selfMemoryAttached: null,
                    selfMemoryStatus: null,
                },
                match: {
                    source: 'turn-summary',
                    text: '验证 worker / publisher / session_summaries 闭环',
                    createdAt: 1_700_000_000_300,
                    seqStart: 10,
                    seqEnd: 18,
                },
            }],
        })
    })

    it('rejects conflicting source filters when session search also scopes by mainSessionId', async () => {
        let searchCalled = false
        const store = {
            searchSessionHistory: async () => {
                searchCalled = true
                return []
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const response = await app.request('/cli/sessions/search?query=publisher&mainSessionId=brain-main&source=manual', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'mainSessionId filter requires an orchestration child source when source is provided',
        })
        expect(searchCalled).toBe(false)
    })

    it('hides invalid stored permissionMode values in search results when normalization fails', async () => {
        const store = {
            searchSessionHistory: async () => [{
                session: {
                    id: 'child-session',
                    active: false,
                    thinking: false,
                    activeAt: 1_700_000_000_000,
                    updatedAt: 1_700_000_000_100,
                    lastMessageAt: 1_700_000_000_200,
                    permissionMode: 'bypassPermissions',
                    modelMode: 'gpt-5.4',
                    modelReasoningEffort: 'medium',
                    fastMode: null,
                    metadata: {
                        path: '/tmp/project-a',
                        source: 'brain-child',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        mainSessionId: 'brain-main',
                        selfSystemEnabled: true,
                        selfProfileId: 'profile-1',
                        selfProfileName: 'K1',
                        selfProfileResolved: true,
                        selfMemoryProvider: 'yoho-memory',
                        selfMemoryAttached: false,
                        selfMemoryStatus: 'empty',
                    },
                },
                score: 99,
                match: {
                    source: 'path',
                    text: '/tmp/project-a',
                    createdAt: null,
                    seqStart: null,
                    seqEnd: null,
                },
            }],
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const response = await app.request('/cli/sessions/search?query=project-a', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            query: 'project-a',
            returned: 1,
            results: [{
                sessionId: 'child-session',
                score: 99,
                active: false,
                thinking: false,
                activeAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_100,
                lastMessageAt: 1_700_000_000_200,
                pendingRequestsCount: 0,
                permissionMode: null,
                modelMode: 'gpt-5.4',
                modelReasoningEffort: 'medium',
                fastMode: null,
                metadata: {
                    path: '/tmp/project-a',
                    summary: null,
                    brainSummary: null,
                    source: 'brain-child',
                    caller: null,
                    machineId: 'machine-1',
                    flavor: 'codex',
                    mainSessionId: 'brain-main',
                    selfSystemEnabled: true,
                    selfProfileId: 'profile-1',
                    selfProfileName: 'K1',
                    selfProfileResolved: true,
                    selfMemoryProvider: 'yoho-memory',
                    selfMemoryAttached: false,
                    selfMemoryStatus: 'empty',
                },
                match: {
                    source: 'path',
                    text: '/tmp/project-a',
                    createdAt: null,
                    seqStart: null,
                    seqEnd: null,
                },
            }],
        })
    })

    it('rejects invalid session search query', async () => {
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, {
            searchSessionHistory: async () => [],
        } as any))

        const response = await app.request('/cli/sessions/search?limit=2', {
            method: 'GET',
            headers: authHeaders(),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual(expect.objectContaining({
            error: 'Invalid query',
        }))
    })
})
