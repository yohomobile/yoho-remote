import { describe, expect, it, vi } from 'vitest'

import {
    BRAIN_SESSION_ABORT_DESCRIPTION,
    BRAIN_SESSION_INSPECT_DESCRIPTION,
    BRAIN_SESSION_LIST_DESCRIPTION,
    BRAIN_SESSION_RESUME_DESCRIPTION,
    BRAIN_SESSION_SEND_DESCRIPTION,
    BRAIN_SESSION_SET_CONFIG_DESCRIPTION,
    BRAIN_SESSION_STOP_DESCRIPTION,
    BRAIN_SESSION_STATUS_DESCRIPTION,
    BRAIN_SESSION_TAIL_DESCRIPTION,
    BRAIN_SESSION_UPDATE_DESCRIPTION,
    buildBrainCreateDescription,
    buildBrainFindOrCreateDescription,
    registerBrainTools,
} from './brainTools'

describe('brainTools descriptions', () => {
    it('emphasizes reuse-first behavior for child sessions', () => {
        const guide = 'MODEL GUIDE'
        expect(buildBrainCreateDescription(guide)).toContain('仅在确实需要真正并行或上下文隔离时使用')
        expect(buildBrainCreateDescription(guide)).toContain('第二路或更多独立调研/验证')
        expect(buildBrainFindOrCreateDescription(guide)).toContain('这是默认入口')
        expect(buildBrainFindOrCreateDescription(guide)).toContain('只有需要真正并行或上下文隔离时')
        expect(buildBrainFindOrCreateDescription(guide)).toContain('默认至少组织两路独立调研/验证')
    })

    it('discourages polling and requires reusable summaries', () => {
        expect(BRAIN_SESSION_SEND_DESCRIPTION).toContain('发送后默认结束当前轮')
        expect(BRAIN_SESSION_SEND_DESCRIPTION).toContain('监督分工进度')
        expect(BRAIN_SESSION_LIST_DESCRIPTION).toContain('当前 Brain 下面的子 session')
        expect(BRAIN_SESSION_ABORT_DESCRIPTION).toContain('用户明确要求停掉旧任务/切换方向')
        expect(BRAIN_SESSION_ABORT_DESCRIPTION).toContain('不要因为普通补充信息')
        expect(BRAIN_SESSION_STOP_DESCRIPTION).toContain('不要用 session_close 代替 stop')
        expect(BRAIN_SESSION_STOP_DESCRIPTION).toContain('正常并行任务默认继续跑')
        expect(BRAIN_SESSION_RESUME_DESCRIPTION).toContain('新的 sessionId')
        expect(BRAIN_SESSION_STATUS_DESCRIPTION).toContain('监督子 session 是否跑偏')
        expect(BRAIN_SESSION_INSPECT_DESCRIPTION).toContain('activeMonitors')
        expect(BRAIN_SESSION_TAIL_DESCRIPTION).toContain('真实输出/事件片段')
        expect(BRAIN_SESSION_SET_CONFIG_DESCRIPTION).toContain('统一调整子 session 的运行时 steering')
        expect(BRAIN_SESSION_UPDATE_DESCRIPTION).toContain('必须写入一行 brainSummary')
    })

    it('registers stop/resume/config/inspect/tail brain MCP tools', () => {
        const toolNames: string[] = []
        const registrations: Array<{ name: string; title?: string; description?: string }> = []
        const fakeMcp = {
            registerTool: (name: string, meta: { title?: string; description?: string }) => {
                registrations.push({ name, title: meta.title, description: meta.description })
            },
        }

        registerBrainTools(fakeMcp as any, toolNames, {
            apiClient: {} as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        expect(toolNames).toContain('session_stop')
        expect(toolNames).toContain('session_resume')
        expect(toolNames).toContain('session_set_config')
        expect(toolNames).toContain('session_inspect')
        expect(toolNames).toContain('session_tail')
        expect(toolNames).toContain('ask_user_question')
        expect(registrations.find((item) => item.name === 'session_stop')?.description).toContain('正常并行任务默认继续跑')
        expect(registrations.find((item) => item.name === 'session_resume')?.description).toContain('新的 sessionId')
        expect(registrations.find((item) => item.name === 'session_set_config')?.description).toContain('运行时 steering')
        expect(registrations.find((item) => item.name === 'session_inspect')?.description).toContain('lastMessageAt')
        expect(registrations.find((item) => item.name === 'session_tail')?.description).toContain('真实输出/事件片段')
        expect(registrations.find((item) => item.name === 'session_list')?.title).toBe('List Child Sessions')
        expect(registrations.find((item) => item.name === 'session_status')?.title).toBe('Child Session Status')
    })

    it('returns structured delivery data from session_send while keeping natural-language text', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            getSession: vi.fn(async () => ({
                id: 'child-session',
                active: true,
                thinking: false,
                metadata: {
                    source: 'brain-child',
                    mainSessionId: 'brain-session',
                },
            })),
            patchSessionMetadata: vi.fn(async () => undefined),
            sendMessageToSession: vi.fn(async () => ({
                ok: false,
                status: 'busy',
                sessionId: 'child-session',
                retryable: true,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_send')
        expect(handler).toBeTypeOf('function')

        const result = await handler?.({
            sessionId: 'child-session',
            message: '修复问题',
        })

        expect(apiClient.sendMessageToSession).toHaveBeenCalledWith('child-session', '修复问题', 'brain')
        expect(result?.isError).toBeUndefined()
        expect(result).toMatchObject({
            structuredContent: {
                delivery: {
                    status: 'busy',
                    sessionId: 'child-session',
                    retryable: true,
                },
            },
            content: [{
                type: 'text',
                text: expect.stringContaining('当前消息未投递'),
            }],
        })
    })

    it('renders brain-session queueing as a non-error queued delivery for session_send', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            getSession: vi.fn(async () => ({
                id: 'brain-session',
                active: true,
                thinking: true,
                metadata: {
                    source: 'brain',
                },
            })),
            patchSessionMetadata: vi.fn(async () => undefined),
            sendMessageToSession: vi.fn(async () => ({
                ok: true,
                status: 'queued',
                sessionId: 'brain-session',
                queue: 'brain-session-inbox',
                queueDepth: 2,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_send')
        const result = await handler?.({
            sessionId: 'brain-session',
            message: '继续处理',
        })

        expect(result?.isError).toBeUndefined()
        expect(result).toMatchObject({
            structuredContent: {
                delivery: {
                    status: 'queued',
                    queue: 'brain-session-inbox',
                    queueDepth: 2,
                },
            },
            content: [{
                type: 'text',
                text: expect.stringContaining('消费队列'),
            }],
        })
    })

    it('defaults omitted child agent to a machine-supported agent instead of always forcing claude', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            listMachines: vi.fn(async () => ([
                {
                    id: 'machine-1',
                    active: true,
                    supportedAgents: ['codex'],
                    metadata: {
                        displayName: 'Codex Box',
                    },
                },
            ])),
            brainSpawnSession: vi.fn(async () => ({
                type: 'success',
                sessionId: 'codex-child',
            })),
            getSessionStatus: vi.fn(async () => ({
                active: true,
                initDone: true,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_create')
        expect(handler).toBeTypeOf('function')

        const result = await handler?.({
            directory: '/tmp/task',
        })

        expect(apiClient.brainSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            directory: '/tmp/task',
            agent: 'codex',
            codexModel: 'gpt-5.4',
        }))
        expect(result).toMatchObject({
            content: [{
                type: 'text',
                text: expect.stringContaining('Session 创建成功'),
            }],
        })
    })

    it('returns after child session becomes active instead of waiting for initDone', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            listMachines: vi.fn(async () => ([
                {
                    id: 'machine-1',
                    active: true,
                    supportedAgents: ['claude'],
                    metadata: {
                        displayName: 'Claude Box',
                    },
                },
            ])),
            brainSpawnSession: vi.fn(async () => ({
                type: 'success',
                sessionId: 'claude-child',
            })),
            getSessionStatus: vi.fn()
                .mockResolvedValueOnce({
                    active: true,
                    thinking: true,
                    initDone: false,
                    messageCount: 1,
                    lastUsage: null,
                    metadata: null,
                }),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_create')
        const result = await handler?.({
            directory: '/tmp/task',
        })

        expect(apiClient.getSessionStatus).toHaveBeenCalledTimes(1)
        expect(apiClient.getSessionStatus).toHaveBeenCalledWith('claude-child', { mainSessionId: 'brain-session' })
        expect(result).toMatchObject({
            content: [{
                type: 'text',
                text: expect.stringContaining('首条任务会自动排队'),
            }],
        })
    })

    it('scopes session_status/session_inspect/session_tail to the current brain session', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            getSessionStatus: vi.fn(async () => ({
                active: true,
                thinking: false,
                initDone: true,
                messageCount: 2,
                lastUsage: null,
                metadata: null,
            })),
            getSessionInspect: vi.fn(async () => ({
                sessionId: 'child-session',
                status: 'idle',
                active: true,
                thinking: false,
                initDone: true,
                activeAt: 1,
                updatedAt: 1,
                thinkingAt: null,
                lastMessageAt: 1,
                messageCount: 2,
                pendingRequestsCount: 0,
                pendingRequests: [],
                runtimeAgent: null,
                runtimeModel: null,
                runtimeModelReasoningEffort: null,
                fastMode: null,
                todoProgress: null,
                todos: null,
                activeMonitors: [],
                terminationReason: null,
                lastUsage: null,
                contextWindow: null,
                metadata: {
                    path: null,
                    summary: null,
                    brainSummary: null,
                    source: 'brain-child',
                    caller: null,
                    machineId: null,
                    flavor: null,
                    mainSessionId: 'brain-session',
                    selfSystemEnabled: null,
                    selfProfileId: null,
                    selfProfileName: null,
                    selfProfileResolved: null,
                    selfMemoryProvider: null,
                    selfMemoryAttached: null,
                    selfMemoryStatus: null,
                },
            })),
            getSessionTail: vi.fn(async () => ({
                sessionId: 'child-session',
                items: [],
                returned: 0,
                inspectedMessages: 0,
                newestSeq: null,
                oldestSeq: null,
                hasMoreHistory: false,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        await handlers.get('session_status')?.({ sessionId: 'child-session' })
        await handlers.get('session_inspect')?.({ sessionId: 'child-session' })
        await handlers.get('session_tail')?.({ sessionId: 'child-session', limit: 3 })

        expect(apiClient.getSessionStatus).toHaveBeenCalledWith('child-session', { mainSessionId: 'brain-session' })
        expect(apiClient.getSessionInspect).toHaveBeenCalledWith('child-session', { mainSessionId: 'brain-session' })
        expect(apiClient.getSessionTail).toHaveBeenCalledWith('child-session', { limit: 3, mainSessionId: 'brain-session' })
    })

    it('limits session_list to current brain child sessions', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            listSessions: vi.fn(async () => ({
                sessions: [{
                    id: 'child-1',
                    active: true,
                    activeAt: 10,
                    thinking: false,
                    modelMode: 'gpt-5.4',
                    pendingRequestsCount: 0,
                    metadata: {
                        path: '/tmp/current-child',
                        source: 'brain-child',
                        mainSessionId: 'brain-session',
                        flavor: 'codex',
                        brainSummary: '当前 brain 子任务',
                    },
                }],
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const result = await handlers.get('session_list')?.({ includeOffline: true })

        expect(apiClient.listSessions).toHaveBeenCalledWith({ includeOffline: true, mainSessionId: 'brain-session' })
        expect(result?.content?.[0]?.type).toBe('text')
        const text = result?.content?.[0]?.text
        expect(typeof text).toBe('string')
        expect(text).toContain('child-1')
        expect(text).toContain('当前 brain 子任务')
    })

    it('keeps an explicit child agent instead of overriding it with a machine-supported fallback', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            listMachines: vi.fn(async () => ([
                {
                    id: 'machine-1',
                    active: true,
                    supportedAgents: ['codex'],
                    metadata: {
                        displayName: 'Codex Box',
                    },
                },
            ])),
            brainSpawnSession: vi.fn(),
            getSessionStatus: vi.fn(),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_create')
        expect(handler).toBeTypeOf('function')

        const result = await handler?.({
            directory: '/tmp/task',
            agent: 'claude',
        })

        expect(apiClient.brainSpawnSession).not.toHaveBeenCalled()
        expect(result).toMatchObject({
            isError: true,
            content: [{
                type: 'text',
                text: expect.stringContaining('不支持 agent "claude"'),
            }],
        })
    })

    it('creates a new child on consecutive find_or_create calls when the previous child has not finished init', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }

        const listedSessions: Array<{
            id: string
            active: boolean
            activeAt: number
            thinking: boolean
            initDone: boolean
            modelMode: string
            pendingRequestsCount: number
            metadata: {
                path: string
                source: string
                machineId: string
                flavor: string
                summary: { text: string }
                mainSessionId: string
            }
        }> = []

        const apiClient = {
            listMachines: vi.fn(async () => ([
                {
                    id: 'machine-1',
                    active: true,
                    supportedAgents: ['claude'],
                    metadata: {
                        displayName: 'Claude Box',
                    },
                },
            ])),
            listSessions: vi.fn(async () => ({
                sessions: [...listedSessions],
            })),
            brainSpawnSession: vi.fn(async () => {
                const index = listedSessions.length + 1
                const sessionId = `child-${index}`
                listedSessions.push({
                    id: sessionId,
                    active: true,
                    activeAt: 1_700_000_000_000 + index,
                    thinking: false,
                    initDone: false,
                    modelMode: 'sonnet',
                    pendingRequestsCount: 0,
                    metadata: {
                        path: '/tmp/task',
                        source: 'brain-child',
                        machineId: 'machine-1',
                        flavor: 'claude',
                        summary: { text: `Child ${index}` },
                        mainSessionId: 'brain-session',
                    },
                })
                return {
                    type: 'success' as const,
                    sessionId,
                }
            }),
            getSessionStatus: vi.fn(async () => ({
                active: true,
                thinking: false,
                initDone: false,
                messageCount: 0,
                lastUsage: null,
                metadata: null,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_find_or_create')
        expect(handler).toBeTypeOf('function')

        const first = await handler?.({
            directory: '/tmp/task',
            hint: 'first task',
        })
        const second = await handler?.({
            directory: '/tmp/task',
            hint: 'second task',
        })

        expect(apiClient.brainSpawnSession).toHaveBeenCalledTimes(2)
        expect(first).toMatchObject({
            content: [{
                type: 'text',
                text: expect.stringContaining('sessionId: child-1'),
            }],
        })
        expect(second).toMatchObject({
            content: [{
                type: 'text',
                text: expect.stringContaining('sessionId: child-2'),
            }],
        })
    })

    it('resumes a historical child when hint matches an existing brain summary', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            listMachines: vi.fn(async () => ([
                {
                    id: 'machine-1',
                    active: true,
                    supportedAgents: ['claude'],
                    metadata: {
                        displayName: 'Claude Box',
                    },
                },
            ])),
            listSessions: vi.fn(async () => ({
                sessions: [],
            })),
            searchSessions: vi.fn(async () => ({
                query: 'brain summary 复用',
                returned: 1,
                results: [{
                    sessionId: 'child-old',
                    score: 70,
                    active: false,
                    thinking: false,
                    activeAt: 1_700_000_000_000,
                    updatedAt: 1_700_000_000_100,
                    lastMessageAt: 1_700_000_000_200,
                    pendingRequestsCount: 0,
                    permissionMode: 'read-only',
                    modelMode: 'sonnet',
                    modelReasoningEffort: null,
                    fastMode: null,
                    metadata: {
                        path: '/tmp/task',
                        summary: { text: '排查 session reuse', updatedAt: 1_700_000_000_111 },
                        brainSummary: '已经定位过 brain summary 复用链路并写完结论',
                        source: 'brain-child',
                        caller: null,
                        machineId: 'machine-1',
                        flavor: 'claude',
                        mainSessionId: 'brain-session',
                    },
                    match: {
                        source: 'brain-summary',
                        text: '已经定位过 brain summary 复用链路并写完结论',
                        createdAt: null,
                        seqStart: null,
                        seqEnd: null,
                    },
                }],
            })),
            resumeSession: vi.fn(async () => ({
                type: 'resumed' as const,
                sessionId: 'child-old',
            })),
            brainSpawnSession: vi.fn(),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_find_or_create')
        expect(handler).toBeTypeOf('function')

        const result = await handler?.({
            directory: '/tmp/task',
            hint: 'brain summary 复用',
        })
        const responseText = String((result as any)?.content?.[0]?.text ?? '')

        expect(apiClient.searchSessions).toHaveBeenCalledWith({
            query: 'brain summary 复用',
            limit: 8,
            includeOffline: true,
            mainSessionId: 'brain-session',
            directory: '/tmp/task',
            flavor: 'claude',
            source: 'brain-child',
        })
        expect(apiClient.resumeSession).toHaveBeenCalledWith('child-old')
        expect(apiClient.brainSpawnSession).not.toHaveBeenCalled()
        expect(result).toMatchObject({
            content: [{
                type: 'text',
                text: expect.stringContaining('sessionId: child-old'),
            }],
        })
        expect(responseText).toContain('历史brain-summary')
    })

    it('does not reuse a matched historical session when that session is still busy', async () => {
        const handlers = new Map<string, (args: any) => Promise<any>>()
        const fakeMcp = {
            registerTool: (name: string, _meta: { description?: string }, handler: (args: any) => Promise<any>) => {
                handlers.set(name, handler)
            },
        }
        const apiClient = {
            listMachines: vi.fn(async () => ([
                {
                    id: 'machine-1',
                    active: true,
                    supportedAgents: ['claude'],
                    metadata: {
                        displayName: 'Claude Box',
                    },
                },
            ])),
            listSessions: vi.fn(async () => ({
                sessions: [{
                    id: 'child-busy',
                    active: true,
                    activeAt: 1_700_000_000_010,
                    thinking: true,
                    initDone: true,
                    modelMode: 'sonnet',
                    pendingRequestsCount: 1,
                    metadata: {
                        path: '/tmp/task',
                        source: 'brain-child',
                        machineId: 'machine-1',
                        flavor: 'claude',
                        summary: { text: '排查 session reuse' },
                        brainSummary: '已经定位过 brain summary 复用链路并写完结论',
                        mainSessionId: 'brain-session',
                    },
                }],
            })),
            searchSessions: vi.fn(async () => ({
                query: 'brain summary 复用',
                returned: 1,
                results: [{
                    sessionId: 'child-busy',
                    score: 70,
                    active: true,
                    thinking: true,
                    activeAt: 1_700_000_000_010,
                    updatedAt: 1_700_000_000_100,
                    lastMessageAt: 1_700_000_000_200,
                    pendingRequestsCount: 1,
                    permissionMode: 'read-only',
                    modelMode: 'sonnet',
                    modelReasoningEffort: null,
                    fastMode: null,
                    metadata: {
                        path: '/tmp/task',
                        summary: { text: '排查 session reuse', updatedAt: 1_700_000_000_111 },
                        brainSummary: '已经定位过 brain summary 复用链路并写完结论',
                        source: 'brain-child',
                        caller: null,
                        machineId: 'machine-1',
                        flavor: 'claude',
                        mainSessionId: 'brain-session',
                    },
                    match: {
                        source: 'brain-summary',
                        text: '已经定位过 brain summary 复用链路并写完结论',
                        createdAt: null,
                        seqStart: null,
                        seqEnd: null,
                    },
                }],
            })),
            resumeSession: vi.fn(),
            brainSpawnSession: vi.fn(async () => ({
                type: 'success' as const,
                sessionId: 'child-new',
            })),
            getSessionStatus: vi.fn(async () => ({
                active: true,
                thinking: false,
                initDone: true,
                messageCount: 0,
                lastUsage: null,
                metadata: null,
            })),
        }

        registerBrainTools(fakeMcp as any, [], {
            apiClient: apiClient as any,
            machineId: 'machine-1',
            brainSessionId: 'brain-session',
            sessionCaller: 'webapp',
            brainPreferences: null,
        })

        const handler = handlers.get('session_find_or_create')
        expect(handler).toBeTypeOf('function')

        const result = await handler?.({
            directory: '/tmp/task',
            hint: 'brain summary 复用',
        })

        expect(apiClient.resumeSession).not.toHaveBeenCalled()
        expect(apiClient.brainSpawnSession).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({
            content: [{
                type: 'text',
                text: expect.stringContaining('sessionId: child-new'),
            }],
        })
    })
})
