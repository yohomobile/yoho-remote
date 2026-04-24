import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { buildBrainSessionPreferences } from '../../brain/brainSessionPreferences'
import type { StoredSession } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { buildResumeContextMessage, createSessionsRoutes } from './sessions'

const TEST_ORGS = [{
    id: 'org-a',
    name: 'Org A',
    role: 'owner' as const,
}]

function createStoredSession(overrides: Partial<StoredSession>): StoredSession {
    return {
        id: 'session-default',
        tag: null,
        namespace: 'ns-test',
        machineId: 'machine-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        createdBy: null,
        orgId: 'org-a',
        metadata: {
            path: '/tmp/default',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        todos: null,
        todosUpdatedAt: null,
        active: false,
        activeAt: null,
        thinking: false,
        thinkingAt: null,
        seq: 0,
        advisorTaskId: null,
        creatorChatId: null,
        advisorMode: false,
        advisorPromptInjected: false,
        rolePromptSent: false,
        permissionMode: null,
        modelMode: null,
        modelReasoningEffort: null,
        fastMode: null,
        terminationReason: null,
        lastMessageAt: null,
        activeMonitors: null,
        ...overrides,
    }
}

function createBrainPreferences(machineId = 'machine-1') {
    return buildBrainSessionPreferences({
        machineSelectionMode: 'manual',
        machineId,
    })
}

function withRouteDiagnostics<T extends Record<string, unknown>>(engine: T): T & {
    markSessionResumeReady: (sessionId: string, source: string) => void
    noteResumeClientEvent: (sessionId: string, event: string, details?: Record<string, unknown>) => void
} {
    return {
        markSessionResumeReady() {},
        noteResumeClientEvent() {},
        ...engine,
    }
}

describe('createSessionsRoutes', () => {
    it('rejects creating a session when the selected machine belongs to another org', async () => {
        let spawnCalled = false
        const fakeEngine = {
            getMachine: () => ({
                id: 'machine-1',
                namespace: 'default',
                active: true,
                activeAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_100,
                orgId: 'org-b',
                metadata: {
                    host: 'test-host',
                    platform: 'linux',
                    yohoRemoteCliVersion: 'v1.0.0',
                },
                metadataVersion: 1,
                daemonState: { status: 'running' },
                daemonStateVersion: 1,
                supportedAgents: null,
            }),
            spawnSession: async () => {
                spawnCalled = true
                return { type: 'success', sessionId: 'session-new' }
            },
        }

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('orgs', [
                { id: 'org-a', name: 'Org A', role: 'owner' as const },
                { id: 'org-b', name: 'Org B', role: 'owner' as const },
            ])
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, {} as any))

        const response = await app.request('/api/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/project',
                agent: 'claude',
            }),
        })

        expect(response.status).toBe(403)
        expect(spawnCalled).toBe(false)
    })

    it('archives sessions by default and still requests runtime shutdown for inactive sessions', async () => {
        const archiveCalls: Array<{ sessionId: string; options: Record<string, unknown> }> = []
        let hardDeleteCalls = 0
        const session = {
            id: 'session-archive',
            namespace: 'ns-test',
            orgId: 'org-a',
            active: false,
            activeAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_100,
            lastMessageAt: null,
            createdBy: null,
            metadata: {
                path: '/tmp/archive-me',
                machineId: 'machine-1',
                flavor: 'codex',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            todos: undefined,
            activeMonitors: [],
            permissionMode: null,
            modelMode: null,
            modelReasoningEffort: null,
            fastMode: null,
            terminationReason: null,
        }

        const fakeEngine = {
            getOrRefreshSession: async () => session,
            archiveSession: async (sessionId: string, options: Record<string, unknown>) => {
                archiveCalls.push({ sessionId, options })
                return true
            },
            deleteSession: async () => {
                hardDeleteCalls += 1
                return true
            },
        }

        const fakeStore = {
            isSessionSharedWith: async () => false,
            getShareAllSessions: async () => false,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions/session-archive', { method: 'DELETE' })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(archiveCalls).toEqual([{
            sessionId: 'session-archive',
            options: {
                terminateSession: true,
                force: false,
                archivedBy: 'user',
                archiveReason: 'User archived session',
            },
        }])
        expect(hardDeleteCalls).toBe(0)
    })

    it('sorts sessions by lastMessageAt before falling back to updatedAt', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'session-stale-message',
                updatedAt: 1_700_000_000_500,
                lastMessageAt: 1_700_000_000_100,
                metadata: { path: '/tmp/stale' },
            }),
            createStoredSession({
                id: 'session-new-message',
                updatedAt: 1_700_000_000_200,
                lastMessageAt: 1_700_000_000_400,
                metadata: { path: '/tmp/new' },
            }),
            createStoredSession({
                id: 'session-no-message',
                updatedAt: 1_700_000_000_300,
                lastMessageAt: null,
                metadata: { path: '/tmp/fallback' },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [],
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a')
        expect(response.status).toBe(200)

        const payload = await response.json() as { sessions: Array<{ id: string; createdAt: number; lastMessageAt: number | null }> }
        expect(payload.sessions.map((session) => session.id)).toEqual([
            'session-new-message',
            'session-no-message',
            'session-stale-message',
        ])
        expect(payload.sessions[0]?.lastMessageAt).toBe(1_700_000_000_400)
        expect(payload.sessions[1]?.lastMessageAt).toBeNull()
        expect(payload.sessions[0]?.createdAt).toBe(1_700_000_000_000)
    })

    it('prefers recent activity over pending requests within active sessions', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'session-stale-pending',
                active: true,
                lastMessageAt: 1_700_000_000_100,
                updatedAt: 1_700_000_000_100,
                metadata: { path: '/tmp/stale-pending' },
            }),
            createStoredSession({
                id: 'session-fresh',
                active: true,
                lastMessageAt: 1_700_000_000_400,
                updatedAt: 1_700_000_000_400,
                metadata: { path: '/tmp/fresh' },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [{
                id: 'session-stale-pending',
                active: true,
                activeAt: 1_700_000_000_100,
                updatedAt: 1_700_000_000_100,
                lastMessageAt: 1_700_000_000_100,
                thinking: false,
                metadata: { path: '/tmp/stale-pending' },
                agentState: {
                    requests: {
                        req1: { tool: 'AskUserQuestion', arguments: {} },
                        req2: { tool: 'AskUserQuestion', arguments: {} },
                    }
                },
                activeMonitors: [],
                modelMode: null,
                modelReasoningEffort: null,
                fastMode: null,
                terminationReason: null,
            }],
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a')
        expect(response.status).toBe(200)

        const payload = await response.json() as { sessions: Array<{ id: string; pendingRequestsCount: number }> }
        expect(payload.sessions.map((session) => session.id)).toEqual([
            'session-fresh',
            'session-stale-pending',
        ])
        expect(payload.sessions[1]?.pendingRequestsCount).toBe(2)
    })

    it('preserves mainSessionId for brain-child session summaries', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'brain-child-session',
                metadata: {
                    path: '/tmp/brain-child',
                    source: 'brain-child',
                    mainSessionId: 'brain-session',
                },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [],
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a')
        expect(response.status).toBe(200)

        const payload = await response.json() as {
            sessions: Array<{
                id: string
                metadata: { source?: string; mainSessionId?: string } | null
            }>
        }
        expect(payload.sessions[0]).toMatchObject({
            id: 'brain-child-session',
            metadata: {
                source: 'brain-child',
                mainSessionId: 'brain-session',
            },
        })
    })

    it('does not expose stale mainSessionId for non-brain-child session summaries', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'manual-session',
                metadata: {
                    path: '/tmp/manual',
                    source: 'manual',
                    mainSessionId: 'brain-session',
                },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [],
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a')
        expect(response.status).toBe(200)

        const payload = await response.json() as {
            sessions: Array<{
                id: string
                metadata: { source?: string; mainSessionId?: string } | null
            }>
        }
        expect(payload.sessions[0]).toMatchObject({
            id: 'manual-session',
            metadata: {
                source: 'manual',
            },
        })
        expect(payload.sessions[0]?.metadata).not.toHaveProperty('mainSessionId')
    })

    it('marks startup-recovering sessions as reconnecting instead of dropping them into archive semantics', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'session-reconnecting',
                active: true,
                activeAt: 1_700_000_000_200,
                metadata: {
                    path: '/tmp/reconnecting',
                    machineId: 'machine-1',
                },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [{
                id: 'session-reconnecting',
                active: false,
                activeAt: 1_700_000_000_200,
                updatedAt: 1_700_000_000_300,
                lastMessageAt: null,
                thinking: false,
                metadata: {
                    path: '/tmp/reconnecting',
                    machineId: 'machine-1',
                },
                agentState: null,
                activeMonitors: [],
                modelMode: null,
                modelReasoningEffort: null,
                fastMode: null,
                terminationReason: null,
            }],
            isSessionStartupRecovering: (sessionId: string) => sessionId === 'session-reconnecting',
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a')
        expect(response.status).toBe(200)

        const payload = await response.json() as {
            sessions: Array<{
                id: string
                active: boolean
                reconnecting?: boolean
            }>
        }
        expect(payload.sessions[0]).toMatchObject({
            id: 'session-reconnecting',
            active: false,
            reconnecting: true,
        })
    })

    it('includes self system troubleshooting metadata in brain session summaries', async () => {
        const storedSessions = [
            createStoredSession({
                id: 'brain-session-self-summary',
                metadata: {
                    path: '/tmp/brain',
                    source: 'brain',
                    selfSystemEnabled: true,
                    selfProfileId: 'profile-1',
                    selfProfileName: 'K1',
                    selfProfileResolved: true,
                    selfMemoryProvider: 'yoho-memory',
                    selfMemoryAttached: true,
                    selfMemoryStatus: 'attached',
                },
            }),
        ]

        const fakeEngine = {
            getSessionsByNamespace: () => [],
        }

        const fakeStore = {
            getSessionsByNamespace: async () => storedSessions,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'ns-test')
            c.set('role', 'developer')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a')
        expect(response.status).toBe(200)

        const payload = await response.json() as {
            sessions: Array<{
                metadata: {
                    selfSystemEnabled?: boolean
                    selfProfileName?: string
                    selfMemoryAttached?: boolean
                    selfMemoryStatus?: string
                } | null
            }>
        }
        expect(payload.sessions[0]?.metadata).toMatchObject({
            selfSystemEnabled: true,
            selfProfileName: 'K1',
            selfMemoryAttached: true,
            selfMemoryStatus: 'attached',
        })
    })

    it('includes Claude result.result text in resume context', () => {
        const contextMessage = buildResumeContextMessage({
            metadata: {
                summary: {
                    text: 'Existing summary',
                    updatedAt: 1_700_000_000_000,
                }
            }
        } as any, [{
            id: 'msg-result',
            seq: 1,
            localId: null,
            createdAt: 1_700_000_000_123,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'result',
                        result: 'Claude only returned final text in result'
                    }
                }
            }
        }])

        expect(contextMessage).toContain('摘要：Existing summary')
        expect(contextMessage).toContain('助手：Claude only returned final text in result')
    })

    it('includes Claude user content arrays in resume context', () => {
        const contextMessage = buildResumeContextMessage({
            metadata: {
                summary: {
                    text: 'Existing summary',
                    updatedAt: 1_700_000_000_000,
                }
            }
        } as any, [{
            id: 'msg-user-array',
            seq: 1,
            localId: null,
            createdAt: 1_700_000_000_456,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [
                                { type: 'text', text: 'say lol' }
                            ]
                        }
                    }
                }
            }
        }])

        expect(contextMessage).toContain('摘要：Existing summary')
        expect(contextMessage).toContain('用户：say lol')
    })

    it('deduplicates immediate Claude user echoes in resume context', () => {
        const contextMessage = buildResumeContextMessage({
            metadata: null,
        } as any, [
            {
                id: 'msg-user-webapp',
                seq: 1,
                localId: null,
                createdAt: 1_700_000_000_100,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '继续'
                    },
                    meta: {
                        sentFrom: 'webapp'
                    }
                }
            },
            {
                id: 'msg-user-cli-echo',
                seq: 2,
                localId: null,
                createdAt: 1_700_000_000_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            message: {
                                role: 'user',
                                content: [{ type: 'text', text: '继续' }]
                            }
                        }
                    },
                    meta: {
                        sentFrom: 'cli'
                    }
                }
            }
        ])

        expect(contextMessage?.match(/用户：继续/g)?.length ?? 0).toBe(1)
    })

    it('keeps only the most complete adjacent Claude assistant text in resume context', () => {
        const contextMessage = buildResumeContextMessage({
            metadata: null,
        } as any, [
            {
                id: 'msg-assistant-partial',
                seq: 1,
                localId: null,
                createdAt: 1_700_000_000_100,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [{ type: 'text', text: '今天上午 Medusa' }]
                            }
                        }
                    }
                }
            },
            {
                id: 'msg-assistant-result',
                seq: 2,
                localId: null,
                createdAt: 1_700_000_000_200,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'result',
                            result: '今天上午 Medusa 总订单 254 单'
                        }
                    }
                }
            }
        ])

        expect(contextMessage).not.toContain('助手：今天上午 Medusa\n助手：今天上午 Medusa 总订单 254 单')
        expect(contextMessage?.match(/助手：/g)?.length ?? 0).toBe(1)
        expect(contextMessage).toContain('助手：今天上午 Medusa 总订单 254 单')
    })

    it('includes Claude plan file attachments in resume context fallback', () => {
        const contextMessage = buildResumeContextMessage({
            metadata: null,
        } as any, [{
            id: 'msg-plan-file',
            seq: 1,
            localId: null,
            createdAt: 1_700_000_000_300,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'attachment',
                        attachment: {
                            type: 'plan_file_reference',
                            planFilePath: '/tmp/demo-plan.md',
                            planContent: '# Demo Plan\n\n- step 1'
                        }
                    }
                }
            }
        }])

        expect(contextMessage).toContain('当前计划文件（/tmp/demo-plan.md）')
        expect(contextMessage).toContain('# Demo Plan')
    })

    it('preserves brain metadata when resuming an existing session', async () => {
        const session = {
            id: 'brain-session',
            namespace: 'default',
            orgId: 'org-a',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            lastMessageAt: null,
            active: false,
            activeAt: 0,
            createdBy: null,
            metadata: {
                path: '/tmp/brain',
                machineId: 'machine-1',
                flavor: 'claude',
                source: 'brain',
                caller: 'feishu',
                brainPreferences: createBrainPreferences(),
                claudeSessionId: 'claude-session-1',
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
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
        }

        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        const unarchiveCalls: string[] = []
        const fakeEngine = withRouteDiagnostics({
            getSession: (id: string) => id === session.id ? session : null,
            getOrRefreshSession: async (id: string) => id === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }),
            checkPathsExist: async () => ({ '/tmp/brain': true }),
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
        })

        const fakeStore = {
            getSession: async () => createStoredSession({
                id: session.id,
                namespace: session.namespace,
                metadata: session.metadata,
                active: false,
            }),
            setSessionActive: async () => true,
            setSessionCreatedBy: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions/brain-session/resume', { method: 'POST' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'resumed', sessionId: 'brain-session' })
        expect(spawnCalls).toEqual([expect.objectContaining({
            sessionId: 'brain-session',
            resumeSessionId: 'claude-session-1',
            source: 'brain',
            caller: 'feishu',
            brainPreferences: createBrainPreferences(),
        })])
        expect(unarchiveCalls).toEqual(['brain-session'])
    })

    it('rejects web resume when brainPreferences metadata is invalid', async () => {
        let spawnCalled = false
        const session = {
            id: 'brain-child-invalid',
            namespace: 'default',
            orgId: 'org-a',
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
                brainPreferences: {
                    machineSelection: { mode: 'manual' },
                },
                codexSessionId: 'thread-invalid',
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

        const fakeEngine = withRouteDiagnostics({
            getSession: (id: string) => id === session.id ? session : null,
            getOrRefreshSession: async (id: string) => id === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }),
            checkPathsExist: async () => ({ '/tmp/brain-child': true }),
            spawnSession: async () => {
                spawnCalled = true
                return { type: 'success', sessionId: session.id }
            },
            subscribe: () => () => {},
        })

        const fakeStore = {
            getSession: async () => createStoredSession({
                id: session.id,
                namespace: session.namespace,
                metadata: session.metadata,
                active: false,
            }),
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request(`/api/sessions/${session.id}/resume`, { method: 'POST' })
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session has invalid brainPreferences metadata; repair it before resuming',
        })
        expect(spawnCalled).toBe(false)
    })

    it('passes selected brain creation options into spawnSession and brainPreferences', async () => {
        const spawnCalls: Array<{
            machineId: string
            directory: string
            agent: string
            yolo: boolean | undefined
            options: Record<string, unknown> | undefined
        }> = []
        let createdSession: any = null

        const fakeEngine = {
            getSession: (id: string) => id === 'brain-session-new' ? createdSession : null,
            getMachine: (id: string) => id === 'machine-1'
                ? { id: 'machine-1', active: true, metadata: { homeDir: '/home/dev' }, namespace: 'default', orgId: 'org-a' }
                : null,
            spawnSession: async (machineId: string, directory: string, agent: string, yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push({ machineId, directory, agent, yolo, options })
                createdSession = {
                    id: 'brain-session-new',
                    namespace: 'default',
                    orgId: 'org-a',
                    active: true,
                    metadata: {
                        path: directory,
                        source: 'brain',
                        machineId,
                        brainPreferences: options?.brainPreferences,
                    },
                }
                return { type: 'success', sessionId: 'brain-session-new' }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
        }

        const fakeStore = {
            getBrainConfig: async () => ({
                agent: 'claude',
                claudeModelMode: 'sonnet',
                codexModel: 'gpt-5.4',
                extra: null,
            }),
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/brain/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                agent: 'claude',
                claudeModel: 'opus-4-7',
                childClaudeModels: ['opus-4-7'],
                childCodexModels: ['gpt-5.4-mini'],
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'brain-session-new' })
        expect(spawnCalls).toEqual([{
            machineId: 'machine-1',
            directory: '/home/dev/.yoho-remote/brain-workspace',
            agent: 'claude',
            yolo: true,
            options: expect.objectContaining({
                source: 'brain',
                permissionMode: 'bypassPermissions',
                modelMode: 'opus-4-7',
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                    childModels: {
                        claude: { allowed: ['opus-4-7'], defaultModel: 'opus-4-7' },
                        codex: { allowed: ['gpt-5.4-mini'], defaultModel: 'gpt-5.4-mini' },
                    },
                },
            }),
        }])
    })

    it('sanitizes unavailable Brain child agents from brainPreferences before spawn', async () => {
        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        let createdSession: any = null

        const fakeEngine = {
            getSession: (id: string) => id === 'brain-session-sanitized' ? createdSession : null,
            getMachine: (id: string) => id === 'machine-1'
                ? {
                    id: 'machine-1',
                    active: true,
                    metadata: { homeDir: '/home/dev' },
                    namespace: 'default',
                    orgId: 'org-a',
                    supportedAgents: ['claude', 'codex'],
                }
                : null,
            spawnSession: async (_machineId: string, directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                createdSession = {
                    id: 'brain-session-sanitized',
                    namespace: 'default',
                    orgId: 'org-a',
                    active: true,
                    metadata: {
                        path: directory,
                        source: 'brain',
                        machineId: 'machine-1',
                        brainPreferences: options?.brainPreferences,
                    },
                }
                return { type: 'success', sessionId: 'brain-session-sanitized' }
            },
            patchSessionMetadata: async () => ({ ok: true }),
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
            getOnlineMachinesByNamespace: () => [],
        }

        const fakeStore = {
            getBrainConfig: async () => ({
                agent: 'claude',
                claudeModelMode: 'sonnet',
                codexModel: 'gpt-5.4',
                extra: null,
            }),
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
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
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/brain/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                agent: 'claude',
                claudeTokenSourceId: 'ts-claude',
                childClaudeModels: ['sonnet'],
                childCodexModels: ['gpt-5.4'],
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'brain-session-sanitized' })
        expect(spawnCalls).toEqual([expect.objectContaining({
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
                childModels: {
                    claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                    codex: { allowed: [], defaultModel: 'gpt-5.4' },
                },
            },
        })])
    })

    it('preserves cross-machine child agents when current Brain machine cannot run them locally', async () => {
        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        let createdSession: any = null

        const fakeEngine = {
            getSession: (id: string) => id === 'brain-session-cross-machine' ? createdSession : null,
            getMachine: (id: string) => id === 'machine-1'
                ? {
                    id: 'machine-1',
                    active: true,
                    metadata: { homeDir: '/home/dev' },
                    namespace: 'default',
                    orgId: 'org-a',
                    supportedAgents: ['claude'],
                }
                : null,
            spawnSession: async (_machineId: string, directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                createdSession = {
                    id: 'brain-session-cross-machine',
                    namespace: 'default',
                    orgId: 'org-a',
                    active: true,
                    metadata: {
                        path: directory,
                        source: 'brain',
                        machineId: 'machine-1',
                        brainPreferences: options?.brainPreferences,
                    },
                }
                return { type: 'success', sessionId: 'brain-session-cross-machine' }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
            getOnlineMachinesByNamespace: () => [],
        }

        const fakeStore = {
            getBrainConfig: async () => ({
                agent: 'claude',
                claudeModelMode: 'sonnet',
                codexModel: 'gpt-5.4',
                extra: null,
            }),
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/brain/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                agent: 'claude',
                claudeModel: 'sonnet',
                childClaudeModels: ['sonnet'],
                childCodexModels: ['gpt-5.4'],
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'brain-session-cross-machine' })
        expect(spawnCalls).toEqual([expect.objectContaining({
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
                childModels: {
                    claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                    codex: { allowed: ['gpt-5.4'], defaultModel: 'gpt-5.4' },
                },
            },
        })])
    })

    it('preserves disabled Claude child models when creating a Codex brain session', async () => {
        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        let createdSession: any = null

        const fakeEngine = {
            getSession: (id: string) => id === 'brain-session-new' ? createdSession : null,
            getMachine: (id: string) => id === 'machine-1'
                ? { id: 'machine-1', active: true, metadata: { homeDir: '/home/dev' }, namespace: 'default', orgId: 'org-a', supportedAgents: ['codex'] }
                : null,
            spawnSession: async (_machineId: string, directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                createdSession = {
                    id: 'brain-session-new',
                    namespace: 'default',
                    orgId: 'org-a',
                    active: true,
                    metadata: {
                        path: directory,
                        source: 'brain',
                        machineId: 'machine-1',
                        brainPreferences: options?.brainPreferences,
                    },
                }
                return { type: 'success', sessionId: 'brain-session-new' }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
            getOnlineMachinesByNamespace: () => [],
        }

        const fakeStore = {
            getBrainConfig: async () => ({
                agent: 'codex',
                claudeModelMode: 'opus',
                codexModel: 'gpt-5.4',
                extra: null,
            }),
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/brain/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                agent: 'codex',
                codexModel: 'gpt-5.4-mini',
                childClaudeModels: [],
                childCodexModels: ['gpt-5.4-mini'],
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'brain-session-new' })
        expect(spawnCalls).toEqual([expect.objectContaining({
            permissionMode: 'yolo',
            modelMode: 'gpt-5.4-mini',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
                childModels: {
                    claude: { allowed: [], defaultModel: 'sonnet' },
                    codex: { allowed: ['gpt-5.4-mini'], defaultModel: 'gpt-5.4-mini' },
                },
            },
        })])
    })

    it('rejects POST /sessions without tokenSourceId when Local is disabled at org level', async () => {
        let spawnCalled = false
        const fakeEngine = {
            getMachine: (id: string) => id === 'machine-1'
                ? { id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }
                : null,
            spawnSession: async () => {
                spawnCalled = true
                return { type: 'success', sessionId: 'session-new' }
            },
            subscribe: () => () => {},
        }

        const fakeStore = {
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: { localTokenSourceEnabled: false },
            }),
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/project',
                agent: 'claude',
            }),
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error?: string }
        expect(body.error).toContain('Local Token Source is disabled')
        expect(spawnCalled).toBe(false)
    })

    it('allows POST /sessions without tokenSourceId when Local stays enabled by default', async () => {
        let spawnCalled = false
        const activeSession = {
            id: 'session-new',
            orgId: 'org-a',
            active: true,
            metadata: { path: '/tmp/project' },
        }
        const fakeEngine = {
            getMachine: (id: string) => id === 'machine-1'
                ? { id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }
                : null,
            getSession: () => activeSession,
            spawnSession: async () => {
                spawnCalled = true
                return { type: 'success', sessionId: 'session-new' }
            },
            waitForSocketInRoom: async () => true,
            sendMessage: async () => true,
            subscribe: () => () => {},
        }

        const fakeStore = {
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {},
            }),
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
                directory: '/tmp/project',
                agent: 'claude',
            }),
        })

        expect(response.status).toBe(200)
        expect(spawnCalled).toBe(true)
    })

    it('patches resolved identity context after POST /sessions spawn', async () => {
        let resolvePatch!: (call: { sessionId: string; patch: Record<string, unknown> }) => void
        const patchPromise = new Promise<{ sessionId: string; patch: Record<string, unknown> }>((resolve) => {
            resolvePatch = resolve
        })
        const activeSession = {
            id: 'session-new',
            namespace: 'default',
            orgId: 'org-a',
            active: true,
            metadata: { path: '/tmp/project' },
        }
        const fakeEngine = {
            getMachine: (id: string) => id === 'machine-1'
                ? { id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }
                : null,
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
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {},
            }),
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
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
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: 'machine-1',
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

    it('preserves brain-child metadata when resume falls back to a new session', async () => {
        const session = {
            id: 'brain-child-old',
            namespace: 'default',
            orgId: 'org-a',
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
                brainPreferences: createBrainPreferences(),
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
        const createdSession = {
            ...session,
            id: 'brain-child-new',
            active: true,
            metadata: {
                ...session.metadata,
                codexSessionId: 'thread-brain-child-new',
            },
        }

        const spawnCalls: Array<Record<string, unknown> | undefined> = []
        let spawnCount = 0
        const fakeEngine = withRouteDiagnostics({
            getSession: (id: string) => {
                if (id === session.id) return session
                if (id === createdSession.id) return createdSession
                return null
            },
            getOrRefreshSession: async (id: string) => id === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }),
            checkPathsExist: async () => ({ '/tmp/brain-child': true }),
            spawnSession: async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                spawnCount += 1
                if (spawnCount === 1) {
                    return { type: 'error', message: 'resume failed' }
                }
                return { type: 'success', sessionId: createdSession.id }
            },
            terminateSessionProcess: async () => true,
            subscribe: () => () => {},
            sendMessage: async () => true,
            getMessagesPage: async () => ({ messages: [] }),
        })

        const fakeStore = {
            getSession: async (id: string) => createStoredSession({
                id,
                namespace: session.namespace,
                metadata: id === createdSession.id ? createdSession.metadata : session.metadata,
                active: false,
            }),
            setSessionActive: async () => true,
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions/brain-child-old/resume', { method: 'POST' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'created',
            sessionId: 'brain-child-new',
            resumedFrom: 'brain-child-old',
            usedResume: true,
        })
        expect(spawnCalls).toEqual([
            expect.objectContaining({
                sessionId: 'brain-child-old',
                resumeSessionId: 'thread-brain-child',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                brainPreferences: createBrainPreferences(),
            }),
            expect.objectContaining({
                resumeSessionId: 'thread-brain-child',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                brainPreferences: createBrainPreferences(),
            }),
        ])
    })

    it('rebinds brain-child sessions when a brain resume falls back to a new session id', async () => {
        const session = {
            id: 'brain-main-old',
            namespace: 'default',
            orgId: 'org-a',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            lastMessageAt: null,
            active: false,
            activeAt: 0,
            createdBy: null,
            metadata: {
                path: '/tmp/brain-main',
                machineId: 'machine-1',
                flavor: 'claude',
                source: 'BRAIN',
                caller: 'feishu',
                brainPreferences: createBrainPreferences(),
                claudeSessionId: 'claude-brain-main',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            activeMonitors: [],
            thinking: false,
            thinkingAt: 0,
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
        }
        const createdSession = {
            ...session,
            id: 'brain-main-new',
            active: true,
            metadata: {
                ...session.metadata,
                claudeSessionId: 'claude-brain-main-new',
            },
        }
        const childSession = {
            id: 'brain-child-1',
            namespace: 'default',
            orgId: 'org-a',
            metadata: {
                path: '/tmp/brain-child',
                source: 'BRAIN-CHILD',
                mainSessionId: session.id,
            },
        }

        const rebindCalls: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
        let spawnCount = 0
        const fakeEngine = withRouteDiagnostics({
            getSession: (id: string) => {
                if (id === session.id) return session
                if (id === createdSession.id) return createdSession
                if (id === childSession.id) return childSession
                return null
            },
            getOrRefreshSession: async (id: string) => id === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default', orgId: 'org-a' }),
            getSessionsByNamespace: () => [session, childSession],
            checkPathsExist: async () => ({ '/tmp/brain-main': true }),
            spawnSession: async () => {
                spawnCount += 1
                if (spawnCount === 1) {
                    return { type: 'error', message: 'resume failed' }
                }
                return { type: 'success', sessionId: createdSession.id }
            },
            patchSessionMetadata: async (sessionId: string, patch: Record<string, unknown>) => {
                rebindCalls.push({ sessionId, patch })
                return { ok: true }
            },
            terminateSessionProcess: async () => true,
            subscribe: () => () => {},
            sendMessage: async () => true,
            getMessagesPage: async () => ({ messages: [] }),
        })

        const fakeStore = {
            getSession: async (id: string) => createStoredSession({
                id,
                namespace: session.namespace,
                metadata: id === createdSession.id ? createdSession.metadata : session.metadata,
                active: false,
                orgId: 'org-a',
            }),
            setSessionActive: async () => true,
            setSessionCreatedBy: async () => true,
            setSessionOrgId: async () => true,
        } as any

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            c.set('role', 'developer')
            c.set('email', 'dev@example.com')
            c.set('name', 'Dev')
            c.set('orgs', TEST_ORGS)
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions/brain-main-old/resume', { method: 'POST' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'created',
            sessionId: 'brain-main-new',
            resumedFrom: 'brain-main-old',
            usedResume: true,
        })
        expect(rebindCalls).toEqual([
            {
                sessionId: 'brain-child-1',
                patch: {
                    mainSessionId: 'brain-main-new',
                },
            },
            {
                sessionId: 'brain-main-new',
                patch: {
                    selfSystemEnabled: false,
                    selfProfileId: null,
                    selfProfileName: null,
                    selfProfileResolved: false,
                    selfMemoryProvider: 'yoho-memory',
                    selfMemoryAttached: false,
                    selfMemoryStatus: 'disabled',
                },
            },
            {
                sessionId: 'brain-main-new',
                patch: {
                    communicationPlanAttached: false,
                    communicationPlanId: null,
                    communicationPlanPersonId: null,
                    communicationPlanStatus: 'disabled-no-person',
                    communicationPlanVersion: null,
                },
            },
        ])
    })

    it('injects self system prompt and metadata when creating a Brain session', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => new Response(JSON.stringify({
            result: {
                content: 'K1 长期倾向：先收敛问题边界，再做分派。',
                sources: ['memories/self/preferences.md'],
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch

        try {
            const patchCalls: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
            const sendCalls: Array<{ sessionId: string; text: string }> = []
            let createdSession: any = null

            const fakeEngine = {
                getSession: (id: string) => id === 'brain-session-self' ? createdSession : null,
                getMachine: (id: string) => id === 'machine-1'
                    ? { id: 'machine-1', active: true, metadata: { homeDir: '/home/dev' }, namespace: 'default', orgId: 'org-a' }
                    : null,
                spawnSession: async (machineId: string, directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                    createdSession = {
                        id: 'brain-session-self',
                        namespace: 'default',
                        orgId: 'org-a',
                        active: true,
                        metadata: {
                            path: directory,
                            source: 'brain',
                            machineId,
                            brainPreferences: options?.brainPreferences,
                        },
                    }
                    return { type: 'success', sessionId: 'brain-session-self' }
                },
                patchSessionMetadata: async (sessionId: string, patch: Record<string, unknown>) => {
                    patchCalls.push({ sessionId, patch })
                    return { ok: true }
                },
                waitForSocketInRoom: async () => true,
                sendMessage: async (sessionId: string, payload: { text: string }) => {
                    sendCalls.push({ sessionId, text: payload.text })
                    return true
                },
                subscribe: () => () => {},
                getOnlineMachinesByNamespace: () => [],
            }

            const fakeStore = {
                getBrainConfigByOrg: async () => ({
                    agent: 'claude',
                    claudeModelMode: 'sonnet',
                    codexModel: 'gpt-5.4',
                    extra: {
                        selfSystem: {
                            enabled: true,
                            defaultProfileId: 'profile-1',
                            memoryProvider: 'yoho-memory',
                        },
                    },
                }),
                getAIProfile: async () => ({
                    id: 'profile-1',
                    namespace: 'default',
                    orgId: 'org-a',
                    name: 'K1',
                    role: 'architect',
                    specialties: ['TypeScript'],
                    personality: '结构化',
                    greetingTemplate: '先把问题拆开。',
                    preferredProjects: ['yoho-remote'],
                    workStyle: '先澄清再执行',
                    behaviorAnchors: [],
                    avatarEmoji: '🤖',
                    status: 'idle',
                    stats: {
                        tasksCompleted: 0,
                        activeMinutes: 0,
                        lastActiveAt: null,
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }),
                setSessionCreatedBy: async () => true,
                setSessionOrgId: async () => true,
            } as any

            const app = new Hono<WebAppEnv>()
            app.use('*', async (c, next) => {
                c.set('namespace', 'default')
                c.set('role', 'developer')
                c.set('email', 'dev@example.com')
                c.set('name', 'Dev')
                c.set('orgs', TEST_ORGS)
                await next()
            })
            app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

            const response = await app.request('/api/brain/sessions?orgId=org-a', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    machineId: 'machine-1',
                    agent: 'claude',
                    childClaudeModels: ['sonnet'],
                    childCodexModels: ['gpt-5.4'],
                }),
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ type: 'success', sessionId: 'brain-session-self' })
            await Bun.sleep(20)

            expect(patchCalls).toContainEqual({
                sessionId: 'brain-session-self',
                patch: {
                    selfSystemEnabled: true,
                    selfProfileId: 'profile-1',
                    selfProfileName: 'K1',
                    selfProfileResolved: true,
                    selfMemoryProvider: 'yoho-memory',
                    selfMemoryAttached: true,
                    selfMemoryStatus: 'attached',
                },
            })
            expect(sendCalls[0]?.sessionId).toBe('brain-session-self')
            expect(sendCalls[0]?.text).toContain('## K1 自我系统')
            expect(sendCalls[0]?.text).toContain('K1 长期倾向')
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
