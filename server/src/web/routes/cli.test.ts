import { beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { configuration, createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'

function authHeaders() {
    return {
        authorization: `Bearer ${configuration.cliApiToken}`,
        'content-type': 'application/json',
    }
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
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                },
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
                        brainPreferences: {
                            machineSelection: { mode: 'manual', machineId: 'machine-1' },
                        },
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
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
            permissionMode: 'bypassPermissions',
        }))

        await new Promise(resolve => setTimeout(resolve, 0))

        expect(spawnSessionCalled).toBe(1)
        expect(patchSessionMetadataCalled).toBe(0)
        expect(sendMessageCalled).toBe(1)
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

    it('returns a machine-readable busy verdict for session_send without enqueuing', async () => {
        let sendCalled = 0
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            thinking: true,
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
            status: 'busy',
            sessionId: 'child-session',
            retryable: true,
        })
        expect(sendCalled).toBe(0)
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
        const session = {
            id: 'child-session',
            namespace: 'default',
            active: true,
            thinking: false,
            metadata: {
                path: '/tmp/child-session',
                source: 'brain-child',
            },
        }
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
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

    it('resumes an offline child session through the CLI route', async () => {
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
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                },
                codexSessionId: 'thread-brain-child',
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
        const engine = {
            getSessionByNamespace: (sessionId: string, namespace: string) =>
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default' }),
            checkPathsExist: async () => ({ '/tmp/brain-child': true }),
            spawnSession: async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                session.active = true
                return { type: 'success', sessionId: session.id }
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

        const response = await app.request('/cli/sessions/brain-child-old/resume', {
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
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })])
    })

    it('returns orchestration-focused diagnostics from the inspect route', async () => {
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
                sessionId === session.id && namespace === session.namespace ? session : null,
            getSession: (sessionId: string) => sessionId === session.id ? session : null,
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

        const response = await app.request('/cli/sessions/child-session/inspect', {
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
            }),
            contextWindow: expect.objectContaining({
                usedTokens: 12_345,
            }),
        }))
    })

    it('returns recent real tail fragments instead of weak counters', async () => {
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

        const response = await app.request('/cli/sessions/child-session/tail?limit=3', {
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
            namespace: 'default',
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
