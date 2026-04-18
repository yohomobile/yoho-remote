import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { StoredSession } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { buildResumeContextMessage, createSessionsRoutes } from './sessions'

function createStoredSession(overrides: Partial<StoredSession>): StoredSession {
    return {
        id: 'session-default',
        tag: null,
        namespace: 'ns-test',
        machineId: 'machine-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        createdBy: null,
        orgId: null,
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

describe('createSessionsRoutes', () => {
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
            c.set('orgs', [])
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions')
        expect(response.status).toBe(200)

        const payload = await response.json() as { sessions: Array<{ id: string; lastMessageAt: number | null }> }
        expect(payload.sessions.map((session) => session.id)).toEqual([
            'session-new-message',
            'session-no-message',
            'session-stale-message',
        ])
        expect(payload.sessions[0]?.lastMessageAt).toBe(1_700_000_000_400)
        expect(payload.sessions[1]?.lastMessageAt).toBeNull()
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
            c.set('orgs', [])
            await next()
        })
        app.route('/api', createSessionsRoutes(() => fakeEngine as any, () => null, fakeStore))

        const response = await app.request('/api/sessions')
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
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                },
                claudeSessionId: 'claude-session-1',
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
        const fakeEngine = {
            getSession: (id: string) => id === session.id ? session : null,
            getOrRefreshSession: async (id: string) => id === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default' }),
            checkPathsExist: async () => ({ '/tmp/brain': true }),
            spawnSession: async (_machineId: string, _directory: string, _agent: string, _yolo: boolean | undefined, options?: Record<string, unknown>) => {
                spawnCalls.push(options)
                session.active = true
                return { type: 'success', sessionId: session.id }
            },
            subscribe: () => () => {},
        }

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
            c.set('orgs', [])
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
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })])
    })

    it('preserves brain-child metadata when resume falls back to a new session', async () => {
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
        const fakeEngine = {
            getSession: (id: string) => {
                if (id === session.id) return session
                if (id === createdSession.id) return createdSession
                return null
            },
            getOrRefreshSession: async (id: string) => id === session.id ? session : null,
            getMachineByNamespace: () => ({ id: 'machine-1', active: true, metadata: {}, namespace: 'default' }),
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
        }

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
            c.set('orgs', [])
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
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                },
            }),
            expect.objectContaining({
                resumeSessionId: 'thread-brain-child',
                source: 'brain-child',
                mainSessionId: 'brain-main',
                brainPreferences: {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                },
            }),
        ])
    })
})
