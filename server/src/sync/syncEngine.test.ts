import { describe, expect, test } from 'bun:test'
import { SyncEngine, type Machine, type Session } from './syncEngine'

function createSession(id: string, metadata: Record<string, unknown>): Session {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        lastMessageAt: null,
        active: true,
        activeAt: 0,
        metadata: metadata as Session['metadata'],
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        activeMonitors: [],
        thinking: false,
        thinkingAt: 0,
        modelMode: 'default',
    }
}

function createMachine(id: string, metadata: Record<string, unknown>): Machine {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: metadata as Machine['metadata'],
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        orgId: null,
        supportedAgents: null,
    }
}

function createAgentAssistantMessage(seq: number, text: string) {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [{ type: 'text', text }],
                        usage: {
                            input_tokens: 123,
                            output_tokens: 45,
                        },
                    },
                },
            },
        },
    }
}

function createAgentResultMessage(seq: number, text: string) {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'result',
                    result: text,
                    usage: {
                        input_tokens: 123,
                        output_tokens: 45,
                    },
                },
            },
        },
    }
}

function createAgentEventMessage() {
    return {
        role: 'agent',
        content: {
            type: 'event',
            event: 'noop',
        },
    }
}

function createUserTextMessage(seq: number, text: string, sentFrom: string = 'webapp') {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
            meta: {
                sentFrom,
            },
        },
    }
}

function createMonitorToolCallMessage(seq: number, opts: {
    id?: string
    description?: string
    command?: string
    persistent?: boolean
    timeoutMs?: number | null
} = {}) {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [{
                            type: 'tool_use',
                            id: opts.id ?? 'monitor-tool',
                            name: 'Monitor',
                            input: {
                                description: opts.description ?? 'watch logs',
                                command: opts.command ?? 'tail -f app.log',
                                persistent: opts.persistent === true,
                                ...(opts.timeoutMs !== undefined && opts.timeoutMs !== null ? { timeout_ms: opts.timeoutMs } : {})
                            }
                        }]
                    }
                }
            }
        }
    }
}

function createMonitorTaskStartedMessage(seq: number, toolUseId: string, taskId: string = 'task-1') {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'task_started',
                    tool_use_id: toolUseId,
                    task_id: taskId,
                }
            }
        }
    }
}

function createMonitorTaskNotificationMessage(seq: number, toolUseId: string, status: string = 'completed') {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'task_notification',
                    tool_use_id: toolUseId,
                    task_id: 'task-1',
                    status,
                }
            }
        }
    }
}

function createMonitorToolResultMessage(seq: number, toolUseId: string, opts: {
    isError?: boolean
    permissions?: { result?: string; decision?: string }
} = {}) {
    return {
        id: `m-${seq}`,
        seq,
        localId: null,
        createdAt: 1_000 + seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolUseId,
                            content: 'monitor started',
                            is_error: opts.isError === true,
                            ...(opts.permissions ? { permissions: opts.permissions } : {}),
                        }]
                    }
                }
            }
        }
    }
}

describe('SyncEngine', () => {
    test('waits for late tail messages before sending brain callback', async () => {
        let childMessages: ReturnType<typeof createAgentAssistantMessage>[] = []
        const sent: Array<{ sessionId: string; payload: { text: string } }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', { source: 'brain', summary: { text: 'Main', updatedAt: 0 } })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sendMessage = async (sessionId: string, payload: { text: string }) => {
            sent.push({ sessionId, payload })
        }

        setTimeout(() => {
            childMessages = [createAgentAssistantMessage(1, '子任务最终结果')]
            ;(engine as any).handleRealtimeEvent({
                type: 'message-received',
                sessionId: childSession.id,
                message: childMessages[0],
            })
        }, 80)

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(1)
        expect(sent[0]?.sessionId).toBe(mainSession.id)
        expect(sent[0]?.payload.text).toContain('子任务最终结果')
    })

    test('prefers result text over assistant narration in brain callback and attaches a structured envelope', async () => {
        const sent: Array<{ sessionId: string; payload: { text: string; meta?: Record<string, unknown> } }> = []
        const childMessages = [
            createAgentAssistantMessage(1, '现在时间正确了。让我汇总关键数据并生成执行报告：'),
            createAgentResultMessage(2, '## 查询结果汇总\n总订单数：254'),
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', { source: 'brain', summary: { text: 'Main', updatedAt: 0 } })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).sendMessage = async (sessionId: string, payload: { text: string; meta?: Record<string, unknown> }) => {
            sent.push({ sessionId, payload })
            return { status: 'delivered' }
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(1)
        expect(sent[0]?.payload.text).toContain('总订单数：254')
        expect(sent[0]?.payload.text).not.toContain('让我汇总关键数据并生成执行报告')
        expect(sent[0]?.payload.meta).toMatchObject({
            brainChildCallback: {
                type: 'brain-child-callback',
                version: 1,
                sessionId: 'child-session',
                mainSessionId: 'main-session',
                title: 'Child',
                result: {
                    text: '## 查询结果汇总\n总订单数：254',
                    source: 'result',
                    seq: 2,
                },
                stats: {
                    messageCount: 2,
                },
            },
        })
    })

    test('forwards full brain-child result back to the main brain session without truncation', async () => {
        const sent: Array<{ sessionId: string; payload: { text: string } }> = []
        const fullResult = `开始\n${'A'.repeat(4_500)}\n结束标记`
        const childMessages = [
            createAgentResultMessage(1, fullResult),
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', { source: 'brain', summary: { text: 'Main', updatedAt: 0 } })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).sendMessage = async (sessionId: string, payload: { text: string }) => {
            sent.push({ sessionId, payload })
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(1)
        expect(sent[0]?.payload.text).toContain(fullResult)
        expect(sent[0]?.payload.text).toContain('结束标记')
        expect(sent[0]?.payload.text).not.toContain('...(truncated)')
    })

    test('skips init prompt completion before forwarding real brain-child task results', async () => {
        const sent: Array<{ sessionId: string; payload: { text: string } }> = []
        const childMessages = [
            createUserTextMessage(1, '#InitPrompt-Yoho开发规范（最高优先级）'),
            createAgentAssistantMessage(2, '初始化完成，等待后续任务。'),
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', { source: 'brain', summary: { text: 'Main', updatedAt: 0 } })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sendMessage = async (sessionId: string, payload: { text: string }) => {
            sent.push({ sessionId, payload })
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(0)
        expect(engine.isBrainChildInitDone(childSession.id)).toBe(true)
    })

    test('recovers init completion from persisted history before sending a buffered brain message', async () => {
        const childMessages = [
            createUserTextMessage(1, '#InitPrompt-Yoho开发规范（最高优先级）'),
            createAgentAssistantMessage(2, '初始化完成，等待后续任务。'),
        ]
        const added: Array<{ sessionId: string; content: unknown }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            addMessage: async (sessionId: string, content: unknown, localId?: string) => {
                added.push({ sessionId, content })
                return {
                    id: 'stored-message',
                    sessionId,
                    seq: 3,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_003,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const childSession = createSession('child-session', {
            source: 'brain-child',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(childSession.id, childSession)

        await engine.sendMessage(childSession.id, { text: '请继续处理这个任务', sentFrom: 'brain' })

        expect(engine.isBrainChildInitDone(childSession.id)).toBe(true)
        expect(added).toHaveLength(1)
        expect(added[0]?.sessionId).toBe(childSession.id)
        expect((added[0]?.content as any)?.meta?.sentFrom).toBe('brain')
        expect((engine as any).brainChildPendingMessages.get(childSession.id)).toBeUndefined()
    })

    test('marks disconnected sessions inactive in memory and allows heartbeat reactivation', async () => {
        const setSessionActiveCalls: Array<{ id: string; active: boolean; activeAt: number; namespace: string }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => ({ active: true }),
            setSessionActive: async (id: string, active: boolean, activeAt: number, namespace: string) => {
                setSessionActiveCalls.push({ id, active, activeAt, namespace })
            },
            setSessionThinking: async () => {},
            setSessionModelConfig: async () => {},
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-1', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'thread-1',
        })
        session.active = true
        session.activeAt = Date.now() - 5_000
        session.thinking = true

        ;(engine as any).sessions.set(session.id, session)

        engine.handleSessionDisconnect({ sid: session.id, time: Date.now() })

        expect(session.active).toBe(false)
        expect(session.thinking).toBe(false)
        expect(setSessionActiveCalls).toHaveLength(0)

        await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        expect(session.active).toBe(true)
        expect(setSessionActiveCalls).toHaveLength(1)
        expect(setSessionActiveCalls[0]).toEqual({
            id: session.id,
            active: true,
            activeAt: session.activeAt,
            namespace: session.namespace,
        })
    })

    test('suppresses startup-replayed completion and clears stale termination on first reconnect', async () => {
        const storedSession = createSession('session-startup-reconnect', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'thread-1',
        })
        storedSession.active = true
        storedSession.activeAt = 1_700_000_000_100
        storedSession.thinking = true
        storedSession.thinkingAt = 1_700_000_000_050
        storedSession.terminationReason = 'license-expired'

        const setSessionActiveCalls: Array<{ id: string; active: boolean; activeAt: number; namespace: string; terminationReason?: string | null }> = []
        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            setSessionActive: async (id: string, active: boolean, activeAt: number, namespace: string, terminationReason?: string | null) => {
                setSessionActiveCalls.push({ id, active, activeAt, namespace, terminationReason })
                return true
            },
            setSessionThinking: async () => {},
            setSessionModelConfig: async () => {},
            getSessionNotificationRecipients: async () => [],
            getSessionNotificationRecipientClientIds: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))
        ;(engine as any).serverStartedAt = Date.now() - 60_000

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now(),
            thinking: false,
        })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(setSessionActiveCalls).toHaveLength(1)
        const reactivatedActiveAt = engine.getSession(storedSession.id)?.activeAt
        expect(reactivatedActiveAt).toBeDefined()
        expect(setSessionActiveCalls[0]?.id).toBe(storedSession.id)
        expect(setSessionActiveCalls[0]?.active).toBe(true)
        expect(setSessionActiveCalls[0]?.activeAt).toBe(reactivatedActiveAt as number)
        expect(setSessionActiveCalls[0]?.namespace).toBe(storedSession.namespace)
        expect(setSessionActiveCalls[0]?.terminationReason).toBeNull()
        expect(engine.getSession(storedSession.id)?.terminationReason).toBeUndefined()
        expect(sessionUpdatedEvents).toHaveLength(1)
        expect(sessionUpdatedEvents[0]?.sessionId).toBe(storedSession.id)
        expect(sessionUpdatedEvents[0]?.data?.wasThinking).toBe(false)
        expect(sessionUpdatedEvents[0]?.data?.terminationReason).toBeUndefined()

        unsubscribe()
    })

    test('does not replay startup termination reason in refreshed session payloads', async () => {
        const storedSession = createSession('session-startup-terminated', {
            machineId: 'machine-1',
            path: '/tmp/project',
        })
        storedSession.active = false
        storedSession.thinking = false
        storedSession.terminationReason = 'license-expired'

        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await (engine as any).refreshSession(storedSession.id)

        expect(sessionUpdatedEvents).toHaveLength(1)
        expect(sessionUpdatedEvents[0]?.sessionId).toBe(storedSession.id)
        expect(sessionUpdatedEvents[0]?.data?.terminationReason).toBeUndefined()

        unsubscribe()
    })

    test('emits task-complete after restarted session proves the task is still running', async () => {
        const storedSession = createSession('session-startup-thinking', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'thread-1',
        })
        storedSession.active = true
        storedSession.activeAt = 1_700_000_000_100
        storedSession.thinking = true
        storedSession.thinkingAt = 1_700_000_000_050

        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionThinking: async () => {},
            setSessionModelConfig: async () => {},
            getSessionNotificationRecipients: async () => [],
            getSessionNotificationRecipientClientIds: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))
        ;(engine as any).serverStartedAt = Date.now() - 60_000

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now(),
            thinking: true,
        })
        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now() + 1_000,
            thinking: false,
        })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(sessionUpdatedEvents.some(event => event.data?.wasThinking === true && event.data?.thinking === false)).toBe(true)

        unsubscribe()
    })

    test('sendMessage neutralizes startup stale thinking before reconnect heartbeats', async () => {
        let seq = 0
        const storedSession = createSession('session-send-message-alive', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'thread-1',
        })
        storedSession.active = true
        storedSession.activeAt = 1_700_000_000_100
        storedSession.thinking = true
        storedSession.thinkingAt = 1_700_000_000_050

        const setSessionThinkingCalls: Array<{ id: string; thinking: boolean; namespace: string }> = []
        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            addMessage: async (sessionId: string, content: unknown) => {
                seq += 1
                return {
                    id: `m-${seq}`,
                    sessionId,
                    content,
                    createdAt: 1_700_000_000_000 + seq,
                    seq,
                    localId: null,
                }
            },
            setSessionThinking: async (id: string, thinking: boolean, namespace: string) => {
                setSessionThinkingCalls.push({ id, thinking, namespace })
                storedSession.thinking = thinking
            },
            setSessionActive: async () => true,
            setSessionModelConfig: async () => {},
            getSessionNotificationRecipients: async () => [],
            getSessionNotificationRecipientClientIds: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))
        ;(engine as any).serverStartedAt = Date.now() - 60_000

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.sendMessage(storedSession.id, { text: 'retry after restart' })
        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now(),
            thinking: false,
        })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(setSessionThinkingCalls).toContainEqual({
            id: storedSession.id,
            thinking: false,
            namespace: storedSession.namespace,
        })
        expect(engine.getSession(storedSession.id)?.thinking).toBe(false)
        expect(sessionUpdatedEvents.some(event => event.data?.wasThinking === true)).toBe(false)

        unsubscribe()
    })

    test('sendMessage neutralizes startup stale thinking before old session-end arrives', async () => {
        let seq = 0
        const storedSession = createSession('session-send-message-end', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'thread-1',
        })
        storedSession.active = true
        storedSession.activeAt = 1_700_000_000_100
        storedSession.thinking = true
        storedSession.thinkingAt = 1_700_000_000_050

        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            addMessage: async (sessionId: string, content: unknown) => {
                seq += 1
                return {
                    id: `m-${seq}`,
                    sessionId,
                    content,
                    createdAt: 1_700_000_000_000 + seq,
                    seq,
                    localId: null,
                }
            },
            setSessionThinking: async (_id: string, thinking: boolean) => {
                storedSession.thinking = thinking
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))
        ;(engine as any).serverStartedAt = Date.now() - 60_000

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.sendMessage(storedSession.id, { text: 'retry after restart' })
        await engine.handleSessionEnd({
            sid: storedSession.id,
            time: Date.now(),
        })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(sessionUpdatedEvents).toHaveLength(1)
        expect(sessionUpdatedEvents[0]?.sessionId).toBe(storedSession.id)
        expect(sessionUpdatedEvents[0]?.data?.wasThinking).toBeUndefined()
        expect(engine.getSession(storedSession.id)?.thinking).toBe(false)

        unsubscribe()
    })

    test('sendMessage clears stale termination in DB before refreshSession', async () => {
        let seq = 0
        const storedSession = createSession('session-send-message-refresh', {
            machineId: 'machine-1',
            path: '/tmp/project',
        })
        storedSession.active = false
        storedSession.thinking = false
        storedSession.terminationReason = 'license-expired'

        const setSessionActiveCalls: Array<{ id: string; active: boolean; activeAt: number; namespace: string; terminationReason?: string | null }> = []
        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            addMessage: async (sessionId: string, content: unknown) => {
                seq += 1
                return {
                    id: `m-${seq}`,
                    sessionId,
                    content,
                    createdAt: 1_700_000_000_000 + seq,
                    seq,
                    localId: null,
                }
            },
            setSessionThinking: async () => {},
            setSessionActive: async (id: string, active: boolean, activeAt: number, namespace: string, terminationReason?: string | null) => {
                setSessionActiveCalls.push({ id, active, activeAt, namespace, terminationReason })
                storedSession.active = active
                storedSession.activeAt = activeAt
                storedSession.terminationReason = terminationReason ?? undefined
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.sendMessage(storedSession.id, { text: 'retry after restart' })
        await (engine as any).refreshSession(storedSession.id)

        expect(setSessionActiveCalls).toHaveLength(1)
        expect(setSessionActiveCalls[0]?.terminationReason).toBeNull()
        expect(engine.getSession(storedSession.id)?.terminationReason).toBeUndefined()
        expect(sessionUpdatedEvents.some(event => event.data?.terminationReason !== undefined)).toBe(false)

        unsubscribe()
    })

    test('advances lastMessageAt only for real activity messages', async () => {
        let seq = 0
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            addMessage: async (sessionId: string, content: unknown) => {
                seq += 1
                return {
                    id: `m-${seq}`,
                    sessionId,
                    content,
                    createdAt: 1_700_000_000_000 + seq,
                    seq,
                    localId: null,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-1', {
            machineId: 'machine-1',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        const sessionUpdatedEvents: Array<{ sessionId?: string }> = []
        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event)
            }
        })

        await engine.addMessage(session.id, {
            role: 'system',
            content: {
                type: 'status',
                text: 'still thinking',
            },
        })

        expect(session.lastMessageAt).toBeNull()
        expect(sessionUpdatedEvents).toHaveLength(0)

        await engine.addMessage(session.id, {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'done',
            },
        })

        expect(session.lastMessageAt).toBe(1_700_000_000_002)
        expect(sessionUpdatedEvents).toHaveLength(1)
        expect(sessionUpdatedEvents[0]?.sessionId).toBe(session.id)

        unsubscribe()
    })

    test('backfills todos by paginating from the start of history', async () => {
        const pageCalls: Array<{ afterSeq: number; limit: number }> = []
        const setSessionTodosCalls: Array<{ id: string; todos: unknown; todosUpdatedAt: number; namespace: string }> = []

        const storedSession: any = createSession('session-1', {
            path: '/tmp/project',
            summary: { text: 'Session summary', updatedAt: 0 },
        })
        storedSession.todos = null

        const firstPage = Array.from({ length: 200 }, (_, index) => ({
            id: `msg-${index + 1}`,
            sessionId: 'session-1',
            seq: index + 1,
            createdAt: 1_700_000_000_000 + index,
            localId: null,
            content: createAgentEventMessage(),
        }))
        const todoPage = [
            {
                id: 'msg-201',
                sessionId: 'session-1',
                seq: 201,
                createdAt: 1_700_000_000_200,
                localId: null,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'attachment',
                            attachment: {
                                type: 'todo_reminder',
                                itemCount: 1,
                                content: [
                                    {
                                        content: 'Finish the patch',
                                        status: 'pending'
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedSession,
            getMessagesAfter: async (sessionId: string, afterSeq: number, limit: number) => {
                pageCalls.push({ afterSeq, limit })
                expect(sessionId).toBe('session-1')
                if (afterSeq === 0) {
                    return firstPage
                }
                if (afterSeq === 200) {
                    return todoPage as any
                }
                return []
            },
            setSessionTodos: async (id: string, todos: unknown, todosUpdatedAt: number, namespace: string) => {
                setSessionTodosCalls.push({ id, todos, todosUpdatedAt, namespace })
                storedSession.todos = todos as Session['todos']
                storedSession.todosUpdatedAt = todosUpdatedAt
                return true
            }
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = await engine.getOrRefreshSession('session-1')

        expect(session?.todos).toEqual([
            {
                id: 'claude-plan-1',
                content: 'Finish the patch',
                status: 'pending',
                priority: 'medium'
            }
        ])
        expect(pageCalls).toEqual([
            { afterSeq: 0, limit: 200 },
            { afterSeq: 200, limit: 200 }
        ])
        expect(setSessionTodosCalls).toHaveLength(1)
        expect(setSessionTodosCalls[0]?.todosUpdatedAt).toBe(1_700_000_000_200)
    })

    test('broadcasts session:clear-messages updates to the CLI room', async () => {
        const cliEmits: Array<{ room: string; event: string; payload: unknown }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            clearMessages: async (_sessionId: string, _keepCount: number) => ({
                deleted: 3,
                remaining: 2
            })
        } as any

        const io = {
            of: (namespace: string) => ({
                to: (room: string) => ({
                    emit: (event: string, payload: unknown) => {
                        cliEmits.push({ room: `${namespace}:${room}`, event, payload })
                    }
                }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        await expect(engine.clearSessionMessages('session-1', 10)).resolves.toEqual({
            deleted: 3,
            remaining: 2
        })

        expect(cliEmits).toHaveLength(1)
        expect(cliEmits[0]?.room).toBe('/cli:session:session-1')
        expect(cliEmits[0]?.event).toBe('update')
        expect(cliEmits[0]?.payload).toEqual(expect.objectContaining({
            body: expect.objectContaining({
                t: 'session:clear-messages',
                sid: 'session-1',
                keepCount: 10,
                deleted: 3,
                remaining: 2
            })
        }))
    })

    test('machine disconnect creates an offline-to-online edge for auto-resume', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const machine = createMachine('machine-1', {
            host: 'guang-instance',
            platform: 'linux',
            yohoRemoteCliVersion: 'test',
        })
        machine.active = true
        machine.activeAt = Date.now() - 5_000
        ;(engine as any).machines.set(machine.id, machine)

        const autoResumeCalls: Array<{ machineId: string; namespace: string }> = []
        ;(engine as any).autoResumeSessions = async (machineId: string, namespace: string) => {
            autoResumeCalls.push({ machineId, namespace })
        }

        engine.handleMachineDisconnect({ machineId: machine.id, time: Date.now() })
        expect(machine.active).toBe(false)

        await engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        expect(machine.active).toBe(true)
        expect(autoResumeCalls).toEqual([{ machineId: machine.id, namespace: machine.namespace }])
    })

    test('tracks monitor lifecycle from realtime messages', async () => {
        const persisted: unknown[] = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActiveMonitors: async (_id: string, activeMonitors: unknown) => {
                persisted.push(activeMonitors)
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorToolCallMessage(1, { id: 'mon-1', description: 'watch logs', timeoutMs: 30_000 }),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskStartedMessage(2, 'mon-1', 'task-1'),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([{
            id: 'mon-1',
            description: 'watch logs',
            command: 'tail -f app.log',
            persistent: false,
            timeoutMs: 30_000,
            startedAt: 1002,
            taskId: 'task-1',
            state: 'running',
        }])

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskNotificationMessage(3, 'mon-1', 'completed'),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])
        expect(persisted).toHaveLength(2)
    })

    test('does not expose a monitor before task_started arrives', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionThinking: async () => {},
            setSessionActiveMonitors: async () => true,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorToolCallMessage(1, { id: 'mon-2' }),
        })
        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorToolResultMessage(2, 'mon-2'),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])
    })

    test('ignores task_started events without a preceding monitor tool call', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActiveMonitors: async () => true,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskStartedMessage(1, 'not-a-monitor', 'task-ghost'),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])
    })

    test('marks active monitors unknown on session disconnect', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActiveMonitors: async () => true,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        session.activeMonitors = [{
            id: 'mon-3',
            description: 'watch logs',
            command: 'tail -f app.log',
            persistent: false,
            timeoutMs: null,
            startedAt: 1001,
            taskId: 'task-1',
            state: 'running',
        }]
        ;(engine as any).sessions.set(session.id, session)

        engine.handleSessionDisconnect({ sid: session.id, time: Date.now() })

        await new Promise(resolve => setTimeout(resolve, 0))
        expect(engine.getSession(session.id)?.activeMonitors).toEqual([{
            id: 'mon-3',
            description: 'watch logs',
            command: 'tail -f app.log',
            persistent: false,
            timeoutMs: null,
            startedAt: 1001,
            taskId: 'task-1',
            state: 'unknown',
        }])
    })

    test('drops pending monitor metadata when tool result is denied', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActiveMonitors: async () => true,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorToolCallMessage(1, { id: 'mon-denied' }),
        })
        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorToolResultMessage(2, 'mon-denied', {
                permissions: { result: 'denied', decision: 'denied' }
            }),
        })
        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskStartedMessage(3, 'mon-denied', 'task-denied'),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])
    })
})
