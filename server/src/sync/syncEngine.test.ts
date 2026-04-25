import { describe, expect, test } from 'bun:test'
import { SyncEngine, type Machine, type Session } from './syncEngine'

function createSession(id: string, metadata: Record<string, unknown>): Session {
    return {
        id,
        namespace: 'default',
        orgId: null,
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

function createUserTextMessage(
    seq: number,
    text: string,
    sentFrom: string = 'webapp'
) {
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

function createMonitorToolCallMessage(
    seq: number,
    opts: {
        id?: string
        description?: string
        command?: string
        persistent?: boolean
        timeoutMs?: number | null
    } = {}
) {
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
                        content: [
                            {
                                type: 'tool_use',
                                id: opts.id ?? 'monitor-tool',
                                name: 'Monitor',
                                input: {
                                    description:
                                        opts.description ?? 'watch logs',
                                    command: opts.command ?? 'tail -f app.log',
                                    persistent: opts.persistent === true,
                                    ...(opts.timeoutMs !== undefined &&
                                    opts.timeoutMs !== null
                                        ? { timeout_ms: opts.timeoutMs }
                                        : {}),
                                },
                            },
                        ],
                    },
                },
            },
        },
    }
}

function createMonitorTaskStartedMessage(
    seq: number,
    toolUseId: string,
    taskId: string = 'task-1'
) {
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
                },
            },
        },
    }
}

function createMonitorTaskNotificationMessage(
    seq: number,
    toolUseId: string,
    status: string = 'completed'
) {
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
                },
            },
        },
    }
}

function createMonitorToolResultMessage(
    seq: number,
    toolUseId: string,
    opts: {
        isError?: boolean
        permissions?: { result?: string; decision?: string }
    } = {}
) {
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
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: toolUseId,
                                content: 'monitor started',
                                is_error: opts.isError === true,
                                ...(opts.permissions
                                    ? { permissions: opts.permissions }
                                    : {}),
                            },
                        ],
                    },
                },
            },
        },
    }
}

describe('SyncEngine', () => {
    test('archiveSession soft-archives brain sessions and falls back to daemon stop-session when runtime RPC is unavailable', async () => {
        const setSessionActiveCalls: Array<{
            id: string
            active: boolean
            activeAt: number
            namespace: string
            terminationReason?: string | null
        }> = []
        const patchSessionMetadataCalls: Array<{
            id: string
            patch: Record<string, unknown>
            namespace: string
        }> = []
        let hardDeleteCalls = 0

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async (
                id: string,
                active: boolean,
                activeAt: number,
                namespace: string,
                terminationReason?: string | null
            ) => {
                setSessionActiveCalls.push({
                    id,
                    active,
                    activeAt,
                    namespace,
                    terminationReason,
                })
                return true
            },
            patchSessionMetadata: async (
                id: string,
                patch: Record<string, unknown>,
                namespace: string
            ) => {
                patchSessionMetadataCalls.push({ id, patch, namespace })
                return true
            },
            deleteSession: async () => {
                hardDeleteCalls += 1
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('brain-main', {
            source: 'brain',
            machineId: 'machine-1',
            path: '/tmp/brain-main',
        })
        mainSession.active = false
        const childSession = createSession('brain-child', {
            source: 'brain-child',
            mainSessionId: 'brain-main',
            machineId: 'machine-1',
            path: '/tmp/brain-child',
        })
        childSession.active = false
        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)

        const sessionRpcCalls: Array<{ sessionId: string; method: string }> = []
        const machineRpcCalls: Array<{
            machineId: string
            method: string
            payload: unknown
        }> = []
        ;(engine as any).sessionRpc = async (
            sessionId: string,
            method: string
        ) => {
            sessionRpcCalls.push({ sessionId, method })
            throw new Error('session rpc unavailable')
        }
        ;(engine as any).machineRpc = async (
            machineId: string,
            method: string,
            payload: unknown
        ) => {
            machineRpcCalls.push({ machineId, method, payload })
            return { message: 'Session stopped' }
        }

        const archived = await engine.archiveSession('brain-main', {
            terminateSession: true,
            archivedBy: 'brain',
            archiveReason: 'Brain closed session',
        })

        expect(archived).toBe(true)
        expect(hardDeleteCalls).toBe(0)
        expect(sessionRpcCalls).toEqual([
            { sessionId: 'brain-child', method: 'killSession' },
            { sessionId: 'brain-main', method: 'killSession' },
        ])
        expect(machineRpcCalls).toEqual([
            {
                machineId: 'machine-1',
                method: 'stop-session',
                payload: { sessionId: 'brain-child' },
            },
            {
                machineId: 'machine-1',
                method: 'stop-session',
                payload: { sessionId: 'brain-main' },
            },
        ])
        expect(setSessionActiveCalls).toHaveLength(2)
        expect(setSessionActiveCalls.map((call) => call.id)).toEqual([
            'brain-child',
            'brain-main',
        ])
        expect(
            setSessionActiveCalls.every(
                (call) =>
                    call.active === false &&
                    call.namespace === 'default' &&
                    call.terminationReason === null
            )
        ).toBe(true)
        expect(patchSessionMetadataCalls).toHaveLength(2)
        expect(patchSessionMetadataCalls.map((call) => call.id)).toEqual([
            'brain-child',
            'brain-main',
        ])
        expect(
            patchSessionMetadataCalls.every(
                (call) => call.patch.archivedBy === 'brain'
            )
        ).toBe(true)
        expect(
            (
                engine.getSession('brain-main')?.metadata as Record<
                    string,
                    unknown
                >
            )?.lifecycleState
        ).toBe('archived')
        expect(
            (
                engine.getSession('brain-child')?.metadata as Record<
                    string,
                    unknown
                >
            )?.archiveReason
        ).toBe('Brain closed session')
        expect(engine.getSession('brain-main')?.active).toBe(false)
        expect(engine.getSession('brain-child')?.active).toBe(false)
    })

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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sendMessage = async (
            sessionId: string,
            payload: { text: string }
        ) => {
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
        const sent: Array<{
            sessionId: string
            payload: { text: string; meta?: Record<string, unknown> }
        }> = []
        const childMessages = [
            createAgentAssistantMessage(
                1,
                '现在时间正确了。让我汇总关键数据并生成执行报告：'
            ),
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).sendMessage = async (
            sessionId: string,
            payload: { text: string; meta?: Record<string, unknown> }
        ) => {
            sent.push({ sessionId, payload })
            return { status: 'delivered' }
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(1)
        expect(sent[0]?.payload.text).toContain('总订单数：254')
        expect(sent[0]?.payload.text).not.toContain(
            '让我汇总关键数据并生成执行报告'
        )
        expect(sent[0]?.payload.meta).toMatchObject({
            brainChildCallback: {
                type: 'brain-child-callback',
                version: 1,
                sessionId: 'child-session',
                mainSessionId: 'main-session',
                parentSource: 'brain',
                childSource: 'brain-child',
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

    test('forwards orchestrator-child results back to the matching orchestrator parent session', async () => {
        const sent: Array<{
            sessionId: string
            payload: { text: string; meta?: Record<string, unknown> }
        }> = []
        const childMessages = [
            createAgentResultMessage(1, 'orchestrator child result'),
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'orchestrator',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'orchestrator-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).sendMessage = async (
            sessionId: string,
            payload: { text: string; meta?: Record<string, unknown> }
        ) => {
            sent.push({ sessionId, payload })
            return { status: 'delivered' }
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(1)
        expect(sent[0]?.sessionId).toBe(mainSession.id)
        expect(sent[0]?.payload.text).toContain('orchestrator child result')
        expect(sent[0]?.payload.meta).toMatchObject({
            brainChildCallback: {
                sessionId: 'child-session',
                mainSessionId: 'main-session',
                parentSource: 'orchestrator',
                childSource: 'orchestrator-child',
                result: {
                    text: 'orchestrator child result',
                    source: 'result',
                    seq: 1,
                },
            },
        })
    })

    test('forwards full brain-child result back to the main brain session without truncation', async () => {
        const sent: Array<{ sessionId: string; payload: { text: string } }> = []
        const fullResult = `开始\n${'A'.repeat(4_500)}\n结束标记`
        const childMessages = [createAgentResultMessage(1, fullResult)]

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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).sendMessage = async (
            sessionId: string,
            payload: { text: string }
        ) => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sendMessage = async (
            sessionId: string,
            payload: { text: string }
        ) => {
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
            getMessagesAfter: async (
                _sessionId: string,
                afterSeq: number,
                _limit?: number
            ) => {
                if (afterSeq !== 0) return []
                return childMessages
            },
            patchSessionMetadata: async () => true,
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const childSession = createSession('child-session', {
            source: 'brain-child',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(childSession.id, childSession)

        await engine.sendMessage(childSession.id, {
            text: '请继续处理这个任务',
            sentFrom: 'brain',
        })

        expect(engine.isBrainChildInitDone(childSession.id)).toBe(true)
        expect(added).toHaveLength(1)
        expect(added[0]?.sessionId).toBe(childSession.id)
        expect((added[0]?.content as any)?.meta?.sentFrom).toBe('brain')
        expect(
            (engine as any).brainChildPendingMessages.get(childSession.id)
        ).toBeUndefined()
    })

    test('keeps user follow-ups and child callback together while the main brain is still thinking', async () => {
        let seq = 0
        const added: Array<{
            sessionId: string
            content: unknown
            localId?: string | undefined
        }> = []
        const childMessages = [
            createAgentResultMessage(1, '子任务 burst 最终结果'),
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content, localId })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.thinking = true
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}

        await Promise.all([
            engine.sendMessage(mainSession.id, {
                text: '用户追问 1',
                sentFrom: 'webapp',
            }),
            (engine as any).sendBrainCallbackIfNeeded(childSession),
            engine.sendMessage(mainSession.id, {
                text: '用户追问 2',
                sentFrom: 'webapp',
            }),
        ])

        const mainMessages = added.filter(
            (item) => item.sessionId === mainSession.id
        )
        const sentFroms = mainMessages.map(
            (item) => (item.content as any)?.meta?.sentFrom
        )

        expect(mainMessages).toHaveLength(3)
        expect(sentFroms.filter((value) => value === 'webapp')).toHaveLength(2)
        expect(
            sentFroms.filter((value) => value === 'brain-callback')
        ).toHaveLength(1)
        expect(
            mainMessages.every((item) =>
                Boolean((item.content as any)?.meta?.brainSessionQueue)
            )
        ).toBe(true)
        expect(mainSession.thinking).toBe(true)
    })

    test('resets brain wake queue depth when the next consume round starts', async () => {
        let seq = 0
        const added: Array<{
            sessionId: string
            content: unknown
            localId?: string | undefined
        }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content, localId })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
            setSessionThinking: async () => {},
            setSessionActive: async () => {},
            setSessionModelConfig: async () => {},
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('brain-main', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.thinking = true
        ;(engine as any).sessions.set(mainSession.id, mainSession)

        const first = await engine.sendMessage(mainSession.id, {
            text: '用户追问 1',
            sentFrom: 'webapp',
            localId: 'u-1',
        })
        const second = await engine.sendMessage(mainSession.id, {
            text: '用户追问 2',
            sentFrom: 'feishu',
            localId: 'u-2',
        })

        expect(first).toEqual({
            status: 'queued',
            queue: 'brain-session-inbox',
            queueDepth: 1,
        })
        expect(second).toEqual({
            status: 'queued',
            queue: 'brain-session-inbox',
            queueDepth: 2,
        })
        expect(
            (added[0]?.content as any)?.meta?.brainSessionQueue
        ).toMatchObject({
            source: 'user',
            delivery: 'queued',
            wakeQueueDepth: 1,
            localId: 'u-1',
        })
        expect(
            (added[1]?.content as any)?.meta?.brainSessionQueue
        ).toMatchObject({
            source: 'channel',
            delivery: 'queued',
            wakeQueueDepth: 2,
            localId: 'u-2',
        })

        await engine.handleSessionAlive({
            sid: mainSession.id,
            time: Date.now(),
            thinking: false,
        })
        await engine.handleSessionAlive({
            sid: mainSession.id,
            time: Date.now() + 1,
            thinking: true,
        })

        const third = await engine.sendMessage(mainSession.id, {
            text: '下一轮消息',
            sentFrom: 'brain-callback',
            localId: 'cb-1',
        })
        expect(third).toEqual({
            status: 'queued',
            queue: 'brain-session-inbox',
            queueDepth: 1,
        })
        expect(
            (added[2]?.content as any)?.meta?.brainSessionQueue
        ).toMatchObject({
            source: 'brain-callback',
            delivery: 'queued',
            wakeQueueDepth: 1,
            localId: 'cb-1',
        })
    })

    test('does not send duplicate brain callbacks when the same child completion is replayed', async () => {
        let seq = 0
        const added: Array<{
            sessionId: string
            content: unknown
            localId?: string | undefined
        }> = []
        const childMessages = [createAgentResultMessage(1, '同一轮子任务结果')]
        let messageCount = childMessages.length

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => messageCount,
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content, localId })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}

        await (engine as any).sendBrainCallbackIfNeeded(childSession)
        messageCount = 99
        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        const callbackMessages = added.filter(
            (item) =>
                item.sessionId === mainSession.id &&
                (item.content as any)?.meta?.sentFrom === 'brain-callback'
        )

        expect(callbackMessages).toHaveLength(1)
        expect(callbackMessages[0]?.localId).toBe(
            'brain-callback:main-session:child-session:1'
        )
        expect(
            (callbackMessages[0]?.content as any)?.meta?.brainChildCallback
                ?.result?.text
        ).toBe('同一轮子任务结果')
    })

    test('does not collide callback localId across different children targeting the same brain session', async () => {
        let seq = 0
        const added: Array<{
            sessionId: string
            content: unknown
            localId?: string | undefined
        }> = []
        const childOneMessages = [createAgentResultMessage(1, 'child-1 result')]
        const childTwoMessages = [createAgentResultMessage(1, 'child-2 result')]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async (sessionId: string) =>
                sessionId === 'child-1' ? childOneMessages : childTwoMessages,
            getMessageCount: async () => 1,
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content, localId })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childOne = createSession('child-1', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child 1', updatedAt: 0 },
        })
        const childTwo = createSession('child-2', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child 2', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childOne.id, childOne)
        ;(engine as any).sessions.set(childTwo.id, childTwo)
        ;(engine as any).sessionMessages.set(childOne.id, childOneMessages)
        ;(engine as any).sessionMessages.set(childTwo.id, childTwoMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}

        await (engine as any).sendBrainCallbackIfNeeded(childOne)
        await (engine as any).sendBrainCallbackIfNeeded(childTwo)

        const callbackMessages = added.filter(
            (item) =>
                item.sessionId === mainSession.id &&
                (item.content as any)?.meta?.sentFrom === 'brain-callback'
        )

        expect(callbackMessages).toHaveLength(2)
        expect(callbackMessages.map((item) => item.localId)).toEqual([
            'brain-callback:main-session:child-1:1',
            'brain-callback:main-session:child-2:1',
        ])
    })

    test('retries brain callback for an inactive main session and delivers once it comes back online', async () => {
        const childMessages = [
            createAgentResultMessage(1, '离线主 session 恢复后的结果'),
        ]
        const sent: Array<{
            sessionId: string
            localId?: string
            meta?: unknown
        }> = []

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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.active = false
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}
        ;(engine as any).brainCallbackRetryDelaysMs = [1, 1, 1]
        // engine.stop() above only killed the inactivity timer; retries need
        // the stopped flag cleared so waitForBrainCallbackRetry doesn't bail.
        ;(engine as any).stopped = false
        ;(engine as any).sendMessage = async (
            sessionId: string,
            message: any
        ) => {
            sent.push({
                sessionId,
                localId: message.localId,
                meta: message.meta,
            })
            return { status: 'sent' }
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)
        expect(sent).toHaveLength(0)

        setTimeout(() => {
            mainSession.active = true
        }, 2)

        await new Promise((resolve) => setTimeout(resolve, 15))

        expect(sent).toHaveLength(1)
        expect(sent[0]?.sessionId).toBe(mainSession.id)
        expect(sent[0]?.localId).toBe(
            'brain-callback:main-session:child-session:1'
        )
        expect((sent[0]?.meta as any)?.brainChildCallback?.result?.text).toBe(
            '离线主 session 恢复后的结果'
        )
        expect(
            (engine as any).brainChildPendingRetryCallbackKeyBySessionId.get(
                childSession.id
            )
        ).toBeUndefined()
    })

    test('does not recursively re-enter callback sending while the main session stays inactive during retry backoff', async () => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.active = false
        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).brainCallbackRetryDelaysMs = [1, 1, 1]
        // engine.stop() above only killed the inactivity timer; retries need
        // the stopped flag cleared so retryBrainCallback doesn't bail.
        ;(engine as any).stopped = false
        ;(engine as any).brainChildPendingRetryCallbackKeyBySessionId.set(
            'child-session',
            'main-session:child-session:1'
        )

        let sendAttempts = 0
        ;(engine as any).sendBrainCallbackIfNeeded = async () => {
            sendAttempts += 1
        }

        await (engine as any).retryBrainCallback(
            'child-session',
            'main-session',
            'main-session:child-session:1',
            'brain session unavailable'
        )

        expect(sendAttempts).toBe(0)
        expect(
            (engine as any).brainChildPendingRetryCallbackKeyBySessionId.get(
                'child-session'
            )
        ).toBeUndefined()
    })

    test('persists a pending callback marker when the main brain session is offline', async () => {
        const childMessages = [createAgentResultMessage(1, '等待主 Brain 恢复')]
        const patchCalls: Array<Record<string, unknown>> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
            patchSessionMetadata: async (
                _sessionId: string,
                patch: Record<string, unknown>
            ) => {
                patchCalls.push(patch)
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('brain-main', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.active = false
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'brain-main',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}
        ;(engine as any).retryBrainCallback = async () => {}

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(patchCalls).toContainEqual({ brainCallbackPending: true })
        expect((childSession.metadata as any).brainCallbackPending).toBe(true)
    })

    test('reconciles persisted pending brain callbacks when the parent brain session comes back online', async () => {
        const childMessages = [
            createAgentResultMessage(1, '重启后待补发的结果'),
        ]
        const patchCalls: Array<Record<string, unknown>> = []
        const sent: Array<{
            sessionId: string
            localId?: string
            meta?: unknown
        }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => ({ active: true }),
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
            patchSessionMetadata: async (
                _sessionId: string,
                patch: Record<string, unknown>
            ) => {
                patchCalls.push(patch)
                return true
            },
            setSessionActive: async () => true,
            setSessionThinking: async () => undefined,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('brain-main', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.active = false
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'brain-main',
            brainCallbackPending: true,
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}
        ;(engine as any).sendMessage = async (
            sessionId: string,
            message: any
        ) => {
            sent.push({
                sessionId,
                localId: message.localId,
                meta: message.meta,
            })
            return { status: 'sent' }
        }

        await engine.handleSessionAlive({
            sid: mainSession.id,
            time: Date.now(),
            thinking: false,
        })
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(sent).toHaveLength(1)
        expect(sent[0]?.sessionId).toBe(mainSession.id)
        expect(sent[0]?.localId).toBe(
            'brain-callback:brain-main:child-session:1'
        )
        expect((sent[0]?.meta as any)?.brainChildCallback?.result?.text).toBe(
            '重启后待补发的结果'
        )
        expect(patchCalls).toContainEqual({ brainCallbackPending: false })
        expect((childSession.metadata as any).brainCallbackPending).toBe(false)
    })

    test('still forwards a later child completion after deduplicating the previous callback replay', async () => {
        let seq = 0
        const added: Array<{ sessionId: string; content: unknown }> = []
        let childMessages: Array<
            | ReturnType<typeof createAgentResultMessage>
            | ReturnType<typeof createUserTextMessage>
        > = [createAgentResultMessage(1, '第一次结果')]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}

        await (engine as any).sendBrainCallbackIfNeeded(childSession)
        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        childMessages = [
            ...childMessages,
            createUserTextMessage(2, '继续处理下一轮任务', 'brain'),
            createAgentResultMessage(3, '第二次结果'),
        ]
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        const callbackMessages = added.filter(
            (item) =>
                item.sessionId === mainSession.id &&
                (item.content as any)?.meta?.sentFrom === 'brain-callback'
        )
        const callbackResults = callbackMessages.map(
            (item) =>
                (item.content as any)?.meta?.brainChildCallback?.result?.text
        )

        expect(callbackResults).toEqual(['第一次结果', '第二次结果'])
    })

    test('prefers the latest terminal result over a later replayed assistant narration in brain callback', async () => {
        let seq = 0
        const added: Array<{ sessionId: string; content: unknown }> = []
        const childMessages = [
            createAgentAssistantMessage(1, '这是过程旁白'),
            createAgentResultMessage(2, '真正应该回灌的最终结果'),
            createAgentAssistantMessage(3, '较晚回放的旧旁白'),
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => childMessages,
            getMessageCount: async () => childMessages.length,
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('main-session', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'main-session',
            summary: { text: 'Child', updatedAt: 0 },
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).sessionMessages.set(childSession.id, childMessages)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        const callbackMessage = added.find(
            (item) =>
                item.sessionId === mainSession.id &&
                (item.content as any)?.meta?.sentFrom === 'brain-callback'
        )

        expect(
            (callbackMessage?.content as any)?.meta?.brainChildCallback?.result
        ).toMatchObject({
            text: '真正应该回灌的最终结果',
            source: 'result',
            seq: 2,
        })
    })

    test('keeps brain wake queue idempotent when the same localId is retried', async () => {
        let seq = 0
        const added: Array<{
            sessionId: string
            content: unknown
            localId?: string | undefined
        }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                seq += 1
                added.push({ sessionId, content, localId })
                return {
                    id: `stored-${seq}`,
                    sessionId,
                    seq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + seq,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('brain-main', {
            source: 'brain',
            summary: { text: 'Main', updatedAt: 0 },
        })
        mainSession.thinking = true
        ;(engine as any).sessions.set(mainSession.id, mainSession)

        const first = await engine.sendMessage(mainSession.id, {
            text: '第一次投递',
            sentFrom: 'webapp',
            localId: 'dup-1',
        })
        const second = await engine.sendMessage(mainSession.id, {
            text: '第一次投递',
            sentFrom: 'webapp',
            localId: 'dup-1',
        })

        expect(first).toEqual({
            status: 'queued',
            queue: 'brain-session-inbox',
            queueDepth: 1,
        })
        expect(second).toEqual({
            status: 'queued',
            queue: 'brain-session-inbox',
            queueDepth: 1,
        })
        expect(added).toHaveLength(1)
        expect(
            (added[0]?.content as any)?.meta?.brainSessionQueue
        ).toMatchObject({
            delivery: 'queued',
            wakeQueueDepth: 1,
            localId: 'dup-1',
        })
    })

    test('keeps brain-child init buffer idempotent when the same localId is retried', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const childSession = createSession('child-session', {
            source: 'brain-child',
            summary: { text: 'Child', updatedAt: 0 },
        })
        ;(engine as any).sessions.set(childSession.id, childSession)

        const first = await engine.sendMessage(childSession.id, {
            text: '请继续处理',
            sentFrom: 'brain',
            localId: 'brain-msg-1',
        })
        const second = await engine.sendMessage(childSession.id, {
            text: '请继续处理',
            sentFrom: 'brain',
            localId: 'brain-msg-1',
        })

        expect(first).toEqual({
            status: 'queued',
            queue: 'brain-child-init',
            queueDepth: 1,
        })
        expect(second).toEqual({
            status: 'queued',
            queue: 'brain-child-init',
            queueDepth: 1,
        })
        expect(
            (engine as any).brainChildPendingMessages.get(childSession.id)
        ).toEqual([
            {
                text: '请继续处理',
                localId: 'brain-msg-1',
            },
        ])
    })

    test('recovers brain-child init completion from earliest history when recent tail is empty of InitPrompt', async () => {
        // Simulates a long-lived brain-child after a server restart: the in-memory
        // brainChildInitCompleted Set has been wiped, the recent-message tail
        // no longer contains the original #InitPrompt- (scrolled out), but the
        // earliest messages do. A brain send must NOT be trapped in the init
        // buffer — it should deliver normally.
        const patchCalls: Array<{
            id: string
            patch: Record<string, unknown>
            namespace: string
        }> = []
        const deliveredAdds: Array<{
            sessionId: string
            content: unknown
            localId: string | undefined
        }> = []
        let addedSeq = 500
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => [
                // Simulate a tail-only view that has no InitPrompt anywhere —
                // this is what the old recovery path would see on a long-lived child.
                {
                    id: 'm-recent',
                    sessionId: 'child-session',
                    seq: 500,
                    createdAt: 0,
                    localId: null,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: '最新业务消息' },
                    },
                },
            ],
            getMessagesAfter: async (
                _sessionId: string,
                afterSeq: number,
                _limit?: number
            ) => {
                if (afterSeq !== 0) return []
                return [
                    {
                        id: 'm-1',
                        sessionId: 'child-session',
                        seq: 1,
                        createdAt: 0,
                        localId: null,
                        content: {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: '#InitPrompt-v1\nhello',
                            },
                        },
                    },
                    {
                        id: 'm-2',
                        sessionId: 'child-session',
                        seq: 2,
                        createdAt: 0,
                        localId: null,
                        content: {
                            role: 'agent',
                            content: { type: 'message' },
                        },
                    },
                ]
            },
            patchSessionMetadata: async (
                id: string,
                patch: Record<string, unknown>,
                namespace: string
            ) => {
                patchCalls.push({ id, patch, namespace })
                return true
            },
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => {
                deliveredAdds.push({ sessionId, content, localId })
                addedSeq += 1
                return {
                    id: `stored-${addedSeq}`,
                    sessionId,
                    seq: addedSeq,
                    localId: localId ?? null,
                    content,
                    createdAt: 1_000 + addedSeq,
                }
            },
            setSessionThinking: async () => {},
            setSessionActive: async () => true,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const childSession = createSession('child-session', {
            source: 'brain-child',
            summary: { text: 'Child', updatedAt: 0 },
        })
        // active=true & thinking=false mimics a post-restart resumed child
        childSession.active = true
        childSession.thinking = false
        ;(engine as any).sessions.set(childSession.id, childSession)

        const outcome = await engine.sendMessage(childSession.id, {
            text: '请继续处理',
            sentFrom: 'brain',
            localId: 'brain-msg-after-restart',
        })

        // Init flag should now be set, both in memory and persisted to metadata
        expect(
            (engine as any).brainChildInitCompleted.has(childSession.id)
        ).toBe(true)
        expect(patchCalls).toHaveLength(1)
        expect(patchCalls[0]?.patch).toEqual({ brainChildInitCompleted: true })

        // The message must NOT be stuck in the init buffer
        expect(
            (engine as any).brainChildPendingMessages.get(childSession.id)
        ).toBeUndefined()
        expect(outcome).not.toMatchObject({ queue: 'brain-child-init' })
    })

    test('hydrates brainChildInitCompleted Set from persisted metadata so restart-survived flag bypasses the init buffer', async () => {
        // A brain-child whose metadata already carries brainChildInitCompleted=true
        // (persisted before the restart) must bypass the init buffer on the very
        // first brain send after restart — without any history scan.
        const storedChild = {
            id: 'persisted-child',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            lastMessageAt: null,
            active: true,
            activeAt: 0,
            metadata: {
                path: '/tmp/project',
                host: 'local',
                source: 'brain-child',
                brainChildInitCompleted: true,
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            activeMonitors: [],
            thinking: false,
            thinkingAt: 0,
            modelMode: 'default',
            permissionMode: 'default',
            todos: null,
            terminationReason: null,
            fastMode: null,
        }

        const store = {
            getSessions: async () => [storedChild],
            getSession: async (id: string) =>
                id === storedChild.id ? storedChild : null,
            getMachines: async () => [],
            getMessages: async () => [],
            getMessagesAfter: async () => [],
            patchSessionMetadata: async () => true,
            setSessionModelConfig: async () => {},
            setSessionThinking: async () => {},
            setSessionActive: async () => true,
            getSessionNotificationRecipients: async () => [],
            getSessionNotificationRecipientClientIds: async () => [],
            addMessage: async (
                sessionId: string,
                content: unknown,
                localId?: string
            ) => ({
                id: 'stored-1',
                sessionId,
                seq: 1,
                localId: localId ?? null,
                content,
                createdAt: 1_000,
            }),
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        // Drive the reload-all path the way server startup does
        await (engine as any).refreshSession(storedChild.id, { silent: true })

        // The persisted flag must have repopulated the in-memory Set
        expect(
            (engine as any).brainChildInitCompleted.has(storedChild.id)
        ).toBe(true)

        // Now a brain send must NOT enter the init-buffer branch
        const outcome = await engine.sendMessage(storedChild.id, {
            text: '继续',
            sentFrom: 'brain',
            localId: 'post-restart-1',
        })
        expect(outcome).not.toMatchObject({ queue: 'brain-child-init' })
        expect(
            (engine as any).brainChildPendingMessages.get(storedChild.id)
        ).toBeUndefined()
    })

    test('marks disconnected sessions inactive in memory and allows heartbeat reactivation', async () => {
        const setSessionActiveCalls: Array<{
            id: string
            active: boolean
            activeAt: number
            namespace: string
        }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => ({ active: true }),
            setSessionActive: async (
                id: string,
                active: boolean,
                activeAt: number,
                namespace: string
            ) => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

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

        await engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
        })

        expect(session.active).toBe(true)
        expect(setSessionActiveCalls).toHaveLength(1)
        expect(setSessionActiveCalls[0]).toEqual({
            id: session.id,
            active: true,
            activeAt: session.activeAt,
            namespace: session.namespace,
        })
    })

    test('handleSessionAlive ignores heartbeat when session is legitimately archived (archivedBy set)', async () => {
        const setSessionActiveCalls: unknown[] = []
        const updateSessionMetadataCalls: unknown[] = []
        const storedRow = {
            id: 'session-archived',
            namespace: 'default',
            active: false,
            terminationReason: null,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/archived',
                flavor: 'claude',
                lifecycleState: 'archived',
                archivedBy: 'user',
                archiveReason: 'user clicked archive',
            },
        }
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedRow,
            setSessionActive: async (...args: unknown[]) => {
                setSessionActiveCalls.push(args)
                return true
            },
            updateSessionMetadata: async (...args: unknown[]) => {
                updateSessionMetadataCalls.push(args)
                return { result: 'success', version: 2 }
            },
            setSessionThinking: async () => {},
            setSessionModelConfig: async () => {},
        } as any
        const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise((r) => setTimeout(r, 0))

        const session = createSession('session-archived', storedRow.metadata)
        session.active = false
        session.activeAt = Date.now() - 60_000
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
        })

        // Legitimate archive — heartbeat ignored, no activation, no heal.
        expect(session.active).toBe(false)
        expect(setSessionActiveCalls).toEqual([])
        expect(updateSessionMetadataCalls).toEqual([])
    })

    test('handleSessionAlive heals pseudo-archive (lifecycleState=archived without archivedBy) on heartbeat', async () => {
        const setSessionActiveCalls: Array<{ id: string; active: boolean }> = []
        const updateSessionMetadataCalls: Array<{
            id: string
            metadata: Record<string, unknown>
        }> = []
        // Pseudo-archive: lifecycleState='archived' but archivedBy missing — the
        // exact fingerprint left by the old archiveStaleSession path. handle-
        // SessionAlive should detect this, allow the heartbeat through, and run
        // unarchiveSession to clean up the metadata.
        const storedMetadata: Record<string, unknown> = {
            host: 'test-host',
            machineId: 'machine-1',
            path: '/tmp/pseudo',
            flavor: 'claude',
            claudeSessionId: 'claude-x',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'archived',
            lifecycleStateSince: 1_700_000_000_000,
            // archivedBy intentionally absent
        }
        const storedRow = {
            id: 'session-pseudo',
            namespace: 'default',
            active: false,
            activeAt: 1_700_000_000_000,
            metadata: storedMetadata,
            metadataVersion: 5,
            terminationReason: null,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            seq: 10,
            todos: null,
            thinking: false,
            thinkingAt: null,
            modelMode: null,
            modelReasoningEffort: null,
            fastMode: null,
            permissionMode: null,
            activeMonitors: null,
        }
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedRow,
            setSessionActive: async (id: string, active: boolean) => {
                setSessionActiveCalls.push({ id, active })
                return true
            },
            updateSessionMetadata: async (
                id: string,
                metadata: Record<string, unknown>,
            ) => {
                updateSessionMetadataCalls.push({ id, metadata })
                return { result: 'success' as const, version: 6 }
            },
            setSessionThinking: async () => {},
            setSessionModelConfig: async () => {},
            getMessagesAfter: async () => [],
        } as any
        const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise((r) => setTimeout(r, 0))

        const session = createSession('session-pseudo', storedMetadata)
        session.active = false
        session.activeAt = Date.now() - 5_000
        session.metadataVersion = 5
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
        })

        // Heartbeat allowed → activation persists active=true.
        expect(setSessionActiveCalls.some((c) => c.active === true)).toBe(true)
        expect(session.active).toBe(true)

        // Let the fire-and-forget unarchive run.
        await new Promise((r) => setTimeout(r, 10))

        // Unarchive cleaned the metadata: archivedBy/archiveReason removed,
        // lifecycleState moved out of 'archived'.
        expect(updateSessionMetadataCalls.length).toBeGreaterThanOrEqual(1)
        const lastUpdate = updateSessionMetadataCalls[updateSessionMetadataCalls.length - 1]
        expect(lastUpdate.id).toBe('session-pseudo')
        expect(lastUpdate.metadata.lifecycleState).not.toBe('archived')
        expect(lastUpdate.metadata.archivedBy).toBeUndefined()
        expect(lastUpdate.metadata.archiveReason).toBeUndefined()
    })

    test('startup hydrate preserves sessions and machines that already reconnected during reload', async () => {
        const staleMachine = createMachine('machine-stale', {
            host: 'stale-host',
        })
        staleMachine.active = true
        staleMachine.activeAt = 1_000

        const liveMachine = createMachine('machine-live', { host: 'live-host' })
        liveMachine.active = true
        liveMachine.activeAt = 1_000

        const staleSession = createSession('session-stale', {
            machineId: staleMachine.id,
            path: '/tmp/stale-project',
            flavor: 'codex',
            codexSessionId: 'thread-stale',
        })
        staleSession.active = true
        staleSession.activeAt = 1_000

        const liveSession = createSession('session-live', {
            machineId: liveMachine.id,
            path: '/tmp/live-project',
            flavor: 'codex',
            codexSessionId: 'thread-live',
        })
        liveSession.active = true
        liveSession.activeAt = 1_000

        const store = {
            getSessions: async () => [],
            getSession: async () => null,
            getMachines: async () => [],
            getMachine: async () => null,
            setSessionThinking: async () => {},
            setSessionModelConfig: async () => {},
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        store.getSessions = async () => [staleSession, liveSession]
        store.getSession = async (id: string) => {
            if (id === staleSession.id) return staleSession
            if (id === liveSession.id) return liveSession
            return null
        }
        store.getMachines = async () => [staleMachine, liveMachine]
        store.getMachine = async (id: string) => {
            if (id === staleMachine.id) return staleMachine
            if (id === liveMachine.id) return liveMachine
            return null
        }

        const liveMachineInMemory = createMachine(liveMachine.id, {
            host: 'live-host',
        })
        liveMachineInMemory.active = true
        liveMachineInMemory.activeAt = 5_000
        const staleMachineInMemory = createMachine(staleMachine.id, {
            host: 'stale-host',
        })
        staleMachineInMemory.active = true
        staleMachineInMemory.activeAt = staleMachine.activeAt

        const liveSessionInMemory = createSession(liveSession.id, {
            machineId: liveMachine.id,
            path: '/tmp/live-project',
            flavor: 'codex',
            codexSessionId: 'thread-live',
        })
        liveSessionInMemory.active = true
        liveSessionInMemory.activeAt = 5_000
        const staleSessionInMemory = createSession(staleSession.id, {
            machineId: staleMachine.id,
            path: '/tmp/stale-project',
            flavor: 'codex',
            codexSessionId: 'thread-stale',
        })
        staleSessionInMemory.active = true
        staleSessionInMemory.activeAt = staleSession.activeAt
        ;(engine as any).machines.set(staleMachine.id, staleMachineInMemory)
        ;(engine as any).machines.set(liveMachine.id, liveMachineInMemory)
        ;(engine as any).sessions.set(staleSession.id, staleSessionInMemory)
        ;(engine as any).sessions.set(liveSession.id, liveSessionInMemory)

        await (engine as any).reloadAllAsync()

        expect((engine as any).machines.get(staleMachine.id)?.active).toBe(
            false
        )
        expect((engine as any).machines.get(liveMachine.id)?.active).toBe(true)
        expect(engine.getSession(staleSession.id)?.active).toBe(false)
        expect(engine.getSession(liveSession.id)?.active).toBe(true)
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

        const setSessionActiveCalls: Array<{
            id: string
            active: boolean
            activeAt: number
            namespace: string
            terminationReason?: string | null
        }> = []
        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> =
            []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            setSessionActive: async (
                id: string,
                active: boolean,
                activeAt: number,
                namespace: string,
                terminationReason?: string | null
            ) => {
                setSessionActiveCalls.push({
                    id,
                    active,
                    activeAt,
                    namespace,
                    terminationReason,
                })
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))
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
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(setSessionActiveCalls).toHaveLength(1)
        const reactivatedActiveAt = engine.getSession(
            storedSession.id
        )?.activeAt
        expect(reactivatedActiveAt).toBeDefined()
        expect(setSessionActiveCalls[0]?.id).toBe(storedSession.id)
        expect(setSessionActiveCalls[0]?.active).toBe(true)
        expect(setSessionActiveCalls[0]?.activeAt).toBe(
            reactivatedActiveAt as number
        )
        expect(setSessionActiveCalls[0]?.namespace).toBe(
            storedSession.namespace
        )
        expect(setSessionActiveCalls[0]?.terminationReason).toBeNull()
        expect(
            engine.getSession(storedSession.id)?.terminationReason
        ).toBeUndefined()
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

        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> =
            []
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

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

        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> =
            []
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))
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
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(
            sessionUpdatedEvents.some(
                (event) =>
                    event.data?.wasThinking === true &&
                    event.data?.thinking === false
            )
        ).toBe(true)

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

        const setSessionThinkingCalls: Array<{
            id: string
            thinking: boolean
            namespace: string
        }> = []
        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> =
            []
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
            setSessionThinking: async (
                id: string,
                thinking: boolean,
                namespace: string
            ) => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))
        ;(engine as any).serverStartedAt = Date.now() - 60_000

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.sendMessage(storedSession.id, {
            text: 'retry after restart',
        })
        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now(),
            thinking: false,
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(setSessionThinkingCalls).toContainEqual({
            id: storedSession.id,
            thinking: false,
            namespace: storedSession.namespace,
        })
        expect(engine.getSession(storedSession.id)?.thinking).toBe(false)
        expect(
            sessionUpdatedEvents.some(
                (event) => event.data?.wasThinking === true
            )
        ).toBe(false)

        unsubscribe()
    })

    test('normalizes legacy Codex bypassPermissions to yolo before persisting heartbeat config', async () => {
        const storedSession = createSession('session-codex-legacy-perm', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            yolo: true,
        })
        storedSession.permissionMode = 'bypassPermissions' as any

        const setSessionModelConfigCalls: Array<Record<string, unknown>> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionModelConfig: async (
                _sessionId: string,
                config: Record<string, unknown>
            ) => {
                setSessionModelConfigCalls.push(config)
            },
            getSessionNotificationRecipientClientIds: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now(),
            thinking: false,
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(engine.getSession(storedSession.id)?.permissionMode).toBe('yolo')
        expect(setSessionModelConfigCalls).toContainEqual(
            expect.objectContaining({
                permissionMode: 'yolo',
            })
        )
    })

    test('accepts Codex default permissionMode from heartbeat without treating it as dirty', async () => {
        const storedSession = createSession('session-codex-default-perm', {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
        })
        storedSession.permissionMode = undefined

        const setSessionModelConfigCalls: Array<Record<string, unknown>> = []
        const store = {
            getSessions: async () => [storedSession],
            getSession: async () => storedSession,
            getMachines: async () => [],
            setSessionActive: async () => true,
            setSessionModelConfig: async (
                _sessionId: string,
                config: Record<string, unknown>
            ) => {
                setSessionModelConfigCalls.push(config)
            },
            getSessionNotificationRecipientClientIds: async () => [],
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        await engine.handleSessionAlive({
            sid: storedSession.id,
            time: Date.now(),
            thinking: false,
            permissionMode: 'default',
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(engine.getSession(storedSession.id)?.permissionMode).toBe(
            'default'
        )
        expect(setSessionModelConfigCalls).toContainEqual(
            expect.objectContaining({
                permissionMode: 'default',
            })
        )
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

        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> =
            []
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))
        ;(engine as any).serverStartedAt = Date.now() - 60_000

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.sendMessage(storedSession.id, {
            text: 'retry after restart',
        })
        await engine.handleSessionEnd({
            sid: storedSession.id,
            time: Date.now(),
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

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

        const setSessionActiveCalls: Array<{
            id: string
            active: boolean
            activeAt: number
            namespace: string
            terminationReason?: string | null
        }> = []
        const sessionUpdatedEvents: Array<{ sessionId?: string; data?: any }> =
            []
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
            setSessionActive: async (
                id: string,
                active: boolean,
                activeAt: number,
                namespace: string,
                terminationReason?: string | null
            ) => {
                setSessionActiveCalls.push({
                    id,
                    active,
                    activeAt,
                    namespace,
                    terminationReason,
                })
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const unsubscribe = engine.subscribe((event) => {
            if (event.type === 'session-updated') {
                sessionUpdatedEvents.push(event as any)
            }
        })

        await engine.sendMessage(storedSession.id, {
            text: 'retry after restart',
        })
        await (engine as any).refreshSession(storedSession.id)

        expect(setSessionActiveCalls).toHaveLength(1)
        expect(setSessionActiveCalls[0]?.terminationReason).toBeNull()
        expect(
            engine.getSession(storedSession.id)?.terminationReason
        ).toBeUndefined()
        expect(
            sessionUpdatedEvents.some(
                (event) => event.data?.terminationReason !== undefined
            )
        ).toBe(false)

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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

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
        const setSessionTodosCalls: Array<{
            id: string
            todos: unknown
            todosUpdatedAt: number
            namespace: string
        }> = []

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
                                        status: 'pending',
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedSession,
            getMessagesAfter: async (
                sessionId: string,
                afterSeq: number,
                limit: number
            ) => {
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
            setSessionTodos: async (
                id: string,
                todos: unknown,
                todosUpdatedAt: number,
                namespace: string
            ) => {
                setSessionTodosCalls.push({
                    id,
                    todos,
                    todosUpdatedAt,
                    namespace,
                })
                storedSession.todos = todos as Session['todos']
                storedSession.todosUpdatedAt = todosUpdatedAt
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = await engine.getOrRefreshSession('session-1')

        expect(session?.todos).toEqual([
            {
                id: 'claude-plan-1',
                content: 'Finish the patch',
                status: 'pending',
                priority: 'medium',
            },
        ])
        expect(pageCalls).toEqual([
            { afterSeq: 0, limit: 200 },
            { afterSeq: 200, limit: 200 },
        ])
        expect(setSessionTodosCalls).toHaveLength(1)
        expect(setSessionTodosCalls[0]?.todosUpdatedAt).toBe(1_700_000_000_200)
    })

    test('does not restart todo backfill retries for unchanged history after giving up', async () => {
        const pageCalls: Array<{ afterSeq: number; limit: number }> = []
        const setSessionTodosCalls: Array<{
            id: string
            todos: unknown
            todosUpdatedAt: number
            namespace: string
        }> = []

        const storedSession: any = createSession('session-1', {
            path: '/tmp/project',
            summary: { text: 'Session summary', updatedAt: 0 },
        })
        storedSession.todos = null
        storedSession.seq = 5

        const todoPage = [
            {
                id: 'msg-6',
                sessionId: 'session-1',
                seq: 6,
                createdAt: 1_700_000_000_006,
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
                                        content:
                                            'Retry only after new history arrives',
                                        status: 'pending',
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        ]

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedSession,
            getMessagesAfter: async (
                _sessionId: string,
                afterSeq: number,
                limit: number
            ) => {
                pageCalls.push({ afterSeq, limit })
                return afterSeq === 0 ? (todoPage as any) : []
            },
            setSessionTodos: async (
                id: string,
                todos: unknown,
                todosUpdatedAt: number,
                namespace: string
            ) => {
                setSessionTodosCalls.push({
                    id,
                    todos,
                    todosUpdatedAt,
                    namespace,
                })
                storedSession.todos = todos
                storedSession.todosUpdatedAt = todosUpdatedAt
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))
        ;(engine as any).todoBackfillStateBySessionId.set('session-1', {
            attempts: 3,
            timer: null,
            nextRetryAt: Number.POSITIVE_INFINITY,
            seq: 5,
        })

        await engine.getOrRefreshSession('session-1')
        expect(pageCalls).toEqual([])
        expect(setSessionTodosCalls).toEqual([])

        storedSession.seq = 6
        const session = await engine.getOrRefreshSession('session-1')

        expect(pageCalls).toEqual([{ afterSeq: 0, limit: 200 }])
        expect(session?.todos).toEqual([
            {
                id: 'claude-plan-1',
                content: 'Retry only after new history arrives',
                status: 'pending',
                priority: 'medium',
            },
        ])
        expect(setSessionTodosCalls).toHaveLength(1)
    })

    test('refreshSession prefers stored inactive state on tie and heals active archived metadata', async () => {
        const updateMetadataCalls: Array<{
            id: string
            metadata: Record<string, unknown>
            expectedVersion: number
        }> = []
        const storedSession: any = createSession('session-1', {
            path: '/tmp/project',
            host: 'ncu',
            machineId: 'machine-1',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 150,
            archivedBy: 'user',
            archiveReason: 'User archived session',
        })
        storedSession.active = false
        storedSession.activeAt = 200
        storedSession.thinking = false
        storedSession.thinkingAt = 200
        storedSession.metadataVersion = 3

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedSession,
            updateSessionMetadata: async (
                id: string,
                metadata: Record<string, unknown>,
                expectedVersion: number
            ) => {
                updateMetadataCalls.push({ id, metadata, expectedVersion })
                storedSession.metadata = metadata
                storedSession.metadataVersion = expectedVersion + 1
                return {
                    result: 'success',
                    version: expectedVersion + 1,
                    value: metadata,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const staleMemorySession = createSession('session-1', {
            path: '/tmp/project',
            host: 'ncu',
            machineId: 'machine-1',
            flavor: 'codex',
            codexSessionId: 'thread-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 150,
            archivedBy: 'user',
            archiveReason: 'User archived session',
        })
        staleMemorySession.active = true
        staleMemorySession.activeAt = 200
        staleMemorySession.thinking = true
        staleMemorySession.thinkingAt = 200
        ;(engine as any).sessions.set(staleMemorySession.id, staleMemorySession)

        const refreshed = await engine.getOrRefreshSession('session-1')

        expect(refreshed?.active).toBe(false)
        expect(refreshed?.thinking).toBe(false)
        expect(updateMetadataCalls).toHaveLength(0)

        storedSession.active = true
        storedSession.activeAt = 260
        const healed = await engine.getOrRefreshSession('session-1')

        expect(healed?.active).toBe(true)
        expect(
            (healed?.metadata as Record<string, unknown>).lifecycleState
        ).toBe('active')
        expect(
            (healed?.metadata as Record<string, unknown>).archivedBy
        ).toBeUndefined()
        expect(updateMetadataCalls).toHaveLength(1)
        expect(updateMetadataCalls[0]).toEqual({
            id: 'session-1',
            metadata: expect.objectContaining({
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'codex',
                codexSessionId: 'thread-1',
                lifecycleState: 'active',
                lifecycleStateSince: 260,
            }),
            expectedVersion: 3,
        })
    })

    test('refreshSession heal also clears preArchiveActiveAt and autoResumeFailureAttempts', async () => {
        const updateMetadataCalls: Array<{
            id: string
            metadata: Record<string, unknown>
            expectedVersion: number
        }> = []
        const storedSession: any = createSession('session-heal-cleanup', {
            path: '/tmp/project',
            host: 'ncu',
            machineId: 'machine-1',
            flavor: 'codex',
            codexSessionId: 'thread-heal',
            lifecycleState: 'archived',
            lifecycleStateSince: 150,
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: alive-identity-mismatch',
            preArchiveActiveAt: 120,
            autoResumeFailureAttempts: 2,
        })
        storedSession.active = true
        storedSession.activeAt = 260
        storedSession.thinking = false
        storedSession.thinkingAt = 200
        storedSession.metadataVersion = 5

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => storedSession,
            updateSessionMetadata: async (
                id: string,
                metadata: Record<string, unknown>,
                expectedVersion: number,
            ) => {
                updateMetadataCalls.push({ id, metadata, expectedVersion })
                storedSession.metadata = metadata
                storedSession.metadataVersion = expectedVersion + 1
                return {
                    result: 'success',
                    version: expectedVersion + 1,
                    value: metadata,
                }
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any,
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const healed = await engine.getOrRefreshSession('session-heal-cleanup')

        expect(healed?.active).toBe(true)
        const healedMetadata = healed?.metadata as Record<string, unknown>
        expect(healedMetadata.lifecycleState).toBe('active')
        expect(healedMetadata.archivedBy).toBeUndefined()
        expect(healedMetadata.archiveReason).toBeUndefined()
        expect(healedMetadata.preArchiveActiveAt).toBeUndefined()
        expect(healedMetadata.autoResumeFailureAttempts).toBeUndefined()
        expect(updateMetadataCalls).toHaveLength(1)
        const persistedMetadata = updateMetadataCalls[0].metadata
        expect(persistedMetadata.preArchiveActiveAt).toBeUndefined()
        expect(persistedMetadata.autoResumeFailureAttempts).toBeUndefined()
        expect(persistedMetadata.archivedBy).toBeUndefined()
        expect(persistedMetadata.archiveReason).toBeUndefined()
    })

    test('broadcasts session:clear-messages updates to the CLI room', async () => {
        const cliEmits: Array<{
            room: string
            event: string
            payload: unknown
        }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            clearMessages: async (_sessionId: string, _keepCount: number) => ({
                deleted: 3,
                remaining: 2,
            }),
        } as any

        const io = {
            of: (namespace: string) => ({
                to: (room: string) => ({
                    emit: (event: string, payload: unknown) => {
                        cliEmits.push({
                            room: `${namespace}:${room}`,
                            event,
                            payload,
                        })
                    },
                }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        await expect(
            engine.clearSessionMessages('session-1', 10)
        ).resolves.toEqual({
            deleted: 3,
            remaining: 2,
        })

        expect(cliEmits).toHaveLength(1)
        expect(cliEmits[0]?.room).toBe('/cli:session:session-1')
        expect(cliEmits[0]?.event).toBe('update')
        expect(cliEmits[0]?.payload).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    t: 'session:clear-messages',
                    sid: 'session-1',
                    keepCount: 10,
                    deleted: 3,
                    remaining: 2,
                }),
            })
        )
    })

    test('clearSessionMessages clears pending brain callback retry state and cancels stale retry loops', async () => {
        const patchCalls: Array<{
            sessionId: string
            patch: Record<string, unknown>
            namespace: string
        }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            clearMessages: async (_sessionId: string, _keepCount: number) => ({
                deleted: 4,
                remaining: 1,
            }),
            patchSessionMetadata: async (
                sessionId: string,
                patch: Record<string, unknown>,
                namespace: string
            ) => {
                patchCalls.push({ sessionId, patch, namespace })
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const mainSession = createSession('brain-main', {
            source: 'brain',
        })
        mainSession.active = false
        const childSession = createSession('child-session', {
            source: 'brain-child',
            mainSessionId: 'brain-main',
            brainCallbackPending: true,
        })

        ;(engine as any).sessions.set(mainSession.id, mainSession)
        ;(engine as any).sessions.set(childSession.id, childSession)
        ;(engine as any).brainChildLastDeliveredCallbackKeyBySessionId.set(
            childSession.id,
            'brain-main:child-session:0'
        )
        ;(engine as any).brainChildInFlightCallbackKeyBySessionId.set(
            childSession.id,
            'brain-main:child-session:0'
        )
        ;(engine as any).brainChildPendingRetryCallbackKeyBySessionId.set(
            childSession.id,
            'brain-main:child-session:1'
        )
        ;(engine as any).brainCallbackRetryDelaysMs = [25]

        let resendAttempts = 0
        ;(engine as any).sendBrainCallbackIfNeeded = async () => {
            resendAttempts += 1
        }

        const retryPromise = (engine as any).retryBrainCallback(
            childSession.id,
            mainSession.id,
            'brain-main:child-session:1',
            'brain session unavailable'
        )

        await engine.clearSessionMessages(childSession.id, 10)
        await retryPromise

        expect(resendAttempts).toBe(0)
        expect(
            (engine as any).brainChildLastDeliveredCallbackKeyBySessionId.get(
                childSession.id
            )
        ).toBeUndefined()
        expect(
            (engine as any).brainChildInFlightCallbackKeyBySessionId.get(
                childSession.id
            )
        ).toBeUndefined()
        expect(
            (engine as any).brainChildPendingRetryCallbackKeyBySessionId.get(
                childSession.id
            )
        ).toBeUndefined()
        expect(patchCalls).toEqual([
            {
                sessionId: childSession.id,
                patch: { brainCallbackPending: false },
                namespace: 'default',
            },
        ])
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const machine = createMachine('machine-1', {
            host: 'guang-instance',
            platform: 'linux',
            yohoRemoteCliVersion: 'test',
        })
        machine.active = true
        machine.activeAt = Date.now() - 5_000
        ;(engine as any).machines.set(machine.id, machine)

        const autoResumeCalls: Array<{ machineId: string; namespace: string }> =
            []
        ;(engine as any).autoResumeSessions = async (
            machineId: string,
            namespace: string
        ) => {
            autoResumeCalls.push({ machineId, namespace })
        }

        engine.handleMachineDisconnect({
            machineId: machine.id,
            time: Date.now(),
        })
        expect(machine.active).toBe(false)

        await engine.handleMachineAlive({
            machineId: machine.id,
            time: Date.now(),
        })

        expect(machine.active).toBe(true)
        expect(autoResumeCalls).toEqual([
            { machineId: machine.id, namespace: machine.namespace },
        ])
    })

    test('machine disconnect deactivates its sessions in memory so auto-resume can pick them up', async () => {
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionThinking: async () => {},
        } as any

        const emitted: unknown[] = []
        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast(_event: unknown) { emitted.push(_event) },
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const machine = createMachine('machine-2', {
            host: 'test-host',
            platform: 'linux',
            yohoRemoteCliVersion: 'test',
        })
        machine.active = true
        ;(engine as any).machines.set(machine.id, machine)

        // One active session on this machine
        const session = createSession('sess-1', {
            path: '/tmp/project',
            host: 'test-host',
            machineId: machine.id,
            flavor: 'claude',
            claudeSessionId: 'claude-abc',
            startedFromDaemon: true,
        })
        session.active = true
        session.activeAt = Date.now() - 5_000
        session.thinking = true
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds.add(session.id)

        // One active session on a DIFFERENT machine — must NOT be touched
        const otherSession = createSession('sess-other', {
            path: '/tmp/other',
            host: 'other-host',
            machineId: 'other-machine',
        })
        otherSession.active = true
        ;(engine as any).sessions.set(otherSession.id, otherSession)

        engine.handleMachineDisconnect({ machineId: machine.id, time: Date.now() })

        // Session for this machine is now inactive in memory
        expect(session.active).toBe(false)
        expect(session.thinking).toBe(false)

        // Stays in _dbActiveSessionIds so auto-resume not-in-dbActive check passes
        expect((engine as any)._dbActiveSessionIds.has(session.id)).toBe(true)

        // SSE emitted reconnecting:true so the UI shows "reconnecting" state
        const sessionUpdate = (emitted as Array<{ type: string; sessionId?: string; data?: Record<string, unknown> }>)
            .find(e => (e as { type: string }).type === 'session-updated' && (e as { sessionId?: string }).sessionId === session.id)
        expect(sessionUpdate).toBeDefined()
        expect((sessionUpdate as { data: Record<string, unknown> }).data.active).toBe(false)
        expect((sessionUpdate as { data: Record<string, unknown> }).data.reconnecting).toBe(true)

        // Session on other machine is untouched
        expect(otherSession.active).toBe(true)
    })

    test('archiveSession stamps preArchiveActiveAt only for recoverable cli archives', async () => {
        // Captures real last-activity time so auto-resume's too-old window survives a
        // server restart. Without this, hydrate would reload session.activeAt from DB
        // (where setSessionActive stamps `now` on archive) and the 2h CLI window would
        // measure from the archive event instead of from real idleness.
        const setSessionActiveCalls: Array<{ id: string; active: boolean; activeAt: number }> = []
        const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async (id: string, active: boolean, activeAt: number) => {
                setSessionActiveCalls.push({ id, active, activeAt })
                return true
            },
            patchSessionMetadata: async (id: string, patch: Record<string, unknown>) => {
                patches.push({ id, patch })
                return true
            },
            getSession: async () => null,
        } as any

        const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const machine = createMachine('machine-1', {
            host: 'h',
            platform: 'linux',
            yohoRemoteCliVersion: 't',
        })
        ;(engine as any).machines.set(machine.id, machine)

        const lastHeartbeatAt = 1_700_000_000_000
        const recoverable = createSession('sess-recoverable', {
            path: '/tmp/p',
            host: 'h',
            machineId: machine.id,
            flavor: 'claude',
            claudeSessionId: 'claude-x',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'running',
        })
        recoverable.active = true
        recoverable.activeAt = lastHeartbeatAt
        ;(engine as any).sessions.set(recoverable.id, recoverable)

        const userInitiated = createSession('sess-user-archive', {
            path: '/tmp/p',
            host: 'h',
            machineId: machine.id,
            flavor: 'claude',
            claudeSessionId: 'claude-y',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'running',
        })
        userInitiated.active = true
        userInitiated.activeAt = lastHeartbeatAt
        ;(engine as any).sessions.set(userInitiated.id, userInitiated)

        await engine.archiveSession(recoverable.id, {
            terminateSession: false,
            force: true,
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: missing-host-pid',
        })
        await engine.archiveSession(userInitiated.id, {
            terminateSession: false,
            force: true,
            archivedBy: 'user',
            archiveReason: 'User archived',
        })

        const recoverablePatch = patches.find((p) => p.id === recoverable.id)?.patch
        expect(recoverablePatch).toBeDefined()
        expect(recoverablePatch!.preArchiveActiveAt).toBe(lastHeartbeatAt)
        expect((recoverable.metadata as Record<string, unknown>).preArchiveActiveAt).toBe(lastHeartbeatAt)

        const userPatch = patches.find((p) => p.id === userInitiated.id)?.patch
        expect(userPatch).toBeDefined()
        expect(userPatch!).not.toHaveProperty('preArchiveActiveAt')
        expect((userInitiated.metadata as Record<string, unknown>).preArchiveActiveAt).toBeUndefined()
    })

    test('archiveSession respects caller-supplied preArchiveActiveAt in extraMetadata', async () => {
        const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async () => true,
            patchSessionMetadata: async (id: string, patch: Record<string, unknown>) => {
                patches.push({ id, patch })
                return true
            },
            getSession: async () => null,
        } as any

        const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = createSession('sess-explicit', {
            path: '/tmp/p',
            host: 'h',
            machineId: 'machine-1',
            flavor: 'claude',
            claudeSessionId: 'claude-z',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'running',
        })
        session.active = true
        session.activeAt = 5_000_000
        ;(engine as any).sessions.set(session.id, session)

        const explicitPreArchive = 1_111_111
        await engine.archiveSession(session.id, {
            terminateSession: false,
            force: true,
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'override-test',
            extraMetadata: { preArchiveActiveAt: explicitPreArchive },
        })

        const persistedPatch = patches.find((p) => p.id === session.id)?.patch
        expect(persistedPatch?.preArchiveActiveAt).toBe(explicitPreArchive)
    })

    test('getAutoResumeSkipReasons uses preArchiveActiveAt for too-old window after server restart', async () => {
        // Simulates the post-restart state: hydrate populated session.activeAt from
        // DB (which setSessionActive stamped to the archive event time). Without the
        // preArchiveActiveAt fallback, a session that was idle for 6h before being
        // archived would falsely look fresh after restart and slip past the 2h gate.
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
        } as any
        const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const machine = createMachine('machine-1', {
            host: 'h',
            platform: 'linux',
            yohoRemoteCliVersion: 't',
        })
        ;(engine as any).machines.set(machine.id, machine)

        const now = Date.now()
        const archiveEventAt = now - 60_000 // archived 1 minute ago
        const realLastActivityAt = now - 6 * 60 * 60 * 1000 // 6 hours ago

        const baseMetadata = {
            path: '/tmp/p',
            host: 'h',
            machineId: machine.id,
            flavor: 'claude',
            claudeSessionId: 'claude-x',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'archived',
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: missing-host-pid',
        }

        const withSnapshot = createSession('sess-with-snapshot', {
            ...baseMetadata,
            preArchiveActiveAt: realLastActivityAt,
        })
        withSnapshot.active = false
        withSnapshot.activeAt = archiveEventAt
        ;(engine as any).sessions.set(withSnapshot.id, withSnapshot)

        const withoutSnapshot = createSession('sess-without-snapshot', baseMetadata)
        withoutSnapshot.active = false
        withoutSnapshot.activeAt = archiveEventAt
        ;(engine as any).sessions.set(withoutSnapshot.id, withoutSnapshot)

        const skipReasons = (session: Session): string[] => (engine as any).getAutoResumeSkipReasons(
            session,
            machine.id,
            machine.namespace,
            machine.supportedAgents,
            now,
        )

        // Session with the snapshot correctly trips too-old (real activity 6h ago > 2h window).
        expect(skipReasons(withSnapshot)).toContain('too-old')
        // Session without snapshot falls back to session.activeAt (archive time, 1min ago)
        // and slips through — this is the legacy bug we want to be aware of.
        expect(skipReasons(withoutSnapshot)).not.toContain('too-old')
    })

    test('unarchiveSession clears preArchiveActiveAt so subsequent archive cycles re-baseline', async () => {
        let updateCalls = 0
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            updateSessionMetadata: async (
                _id: string,
                metadata: Record<string, unknown>,
                _expectedVersion: number,
                _orgId: string,
            ) => {
                updateCalls += 1
                return { result: 'success' as const, version: 7, value: metadata }
            },
        } as any

        const io = { of: () => ({ to: () => ({ emit() {} }), emit() {} }) } as any
        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any)
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = createSession('sess-unarchive', {
            path: '/tmp/p',
            host: 'h',
            machineId: 'machine-1',
            flavor: 'claude',
            claudeSessionId: 'claude-x',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'archived',
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery',
            preArchiveActiveAt: 1_700_000_000_000,
        })
        session.active = false
        ;(engine as any).sessions.set(session.id, session)

        const result = await engine.unarchiveSession(session.id, { actor: 'test' })
        expect(result).toEqual({ ok: true })
        expect(updateCalls).toBe(1)
        expect((session.metadata as Record<string, unknown>).preArchiveActiveAt).toBeUndefined()
        expect((session.metadata as Record<string, unknown>).archivedBy).toBeUndefined()
        expect((session.metadata as Record<string, unknown>).lifecycleState).toBe('active')
    })

    test('auto-resume gate handles cli-stale-recovery archives without weakening other gates', async () => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const machine = createMachine('machine-stale-recovery', {
            host: 'test-host',
            platform: 'linux',
            yohoRemoteCliVersion: 'test',
        })
        ;(engine as any).machines.set(machine.id, machine)

        const now = Date.now()
        const baseMetadata = {
            path: '/tmp/project',
            host: 'test-host',
            machineId: machine.id,
            flavor: 'claude',
            claudeSessionId: 'claude-abc',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'archived',
            archivedBy: 'cli-stale-recovery',
            archiveReason: 'stale-on-recovery: missing-host-pid',
        }
        const addSession = (
            id: string,
            metadataPatch: Record<string, unknown>,
            activeAt: number = now - 60_000,
        ): Session => {
            const session = createSession(id, { ...baseMetadata, ...metadataPatch })
            session.active = false
            session.activeAt = activeAt
            ;(engine as any).sessions.set(session.id, session)
            return session
        }

        const recentStaleArchive = addSession('sess-cli-stale-recovery', {})
        const staleArchiveTooOld = addSession('sess-cli-stale-recovery-old', {}, now - 3 * 60 * 60 * 1000)
        const userArchive = addSession('sess-user-archive', { archivedBy: 'user' })
        const systemArchive = addSession('sess-system-archive', { archivedBy: 'system-stale' })
        const notDaemonStarted = addSession('sess-not-daemon', {
            startedFromDaemon: false,
            startedBy: 'user',
        })
        const missingPath = addSession('sess-missing-path', { path: undefined })
        const missingNativeSessionId = addSession('sess-missing-native-id', { claudeSessionId: undefined })
        const missingCodexNativeSessionId = addSession('sess-missing-codex-native-id', {
            flavor: 'codex',
            claudeSessionId: undefined,
            codexSessionId: undefined,
        })
        const codexStaleArchive = addSession('sess-codex-cli-stale-recovery', {
            flavor: 'codex',
            claudeSessionId: undefined,
            codexSessionId: 'codex-abc',
        })
        const wrongMachine = addSession('sess-wrong-machine', { machineId: 'other-machine' })
        const badFlavor = addSession('sess-bad-flavor', { flavor: 'aider' })
        const runningWithoutDbActive = addSession('sess-running-without-db-active', {
            lifecycleState: 'running',
            archivedBy: undefined,
        })
        const runningWithDbActive = addSession('sess-running-with-db-active', {
            lifecycleState: 'running',
            archivedBy: undefined,
        })
        ;(engine as any)._dbActiveSessionIds.add(runningWithDbActive.id)

        const candidates = (engine as any).getAutoResumeCandidates(
            machine.id,
            machine.namespace,
            machine.supportedAgents,
            Date.now()
        ) as Session[]
        const candidateIds = candidates.map((session) => session.id)

        expect(candidateIds).toContain(recentStaleArchive.id)
        expect(candidateIds).toContain(codexStaleArchive.id)
        expect(candidateIds).toContain(runningWithDbActive.id)
        expect(candidateIds).not.toContain(staleArchiveTooOld.id)
        expect(candidateIds).not.toContain(userArchive.id)
        expect(candidateIds).not.toContain(systemArchive.id)
        expect(candidateIds).not.toContain(notDaemonStarted.id)
        expect(candidateIds).not.toContain(missingPath.id)
        expect(candidateIds).not.toContain(missingNativeSessionId.id)
        expect(candidateIds).not.toContain(missingCodexNativeSessionId.id)
        expect(candidateIds).not.toContain(wrongMachine.id)
        expect(candidateIds).not.toContain(badFlavor.id)
        expect(candidateIds).not.toContain(runningWithoutDbActive.id)

        const skipReasons = (session: Session): string[] => (engine as any).getAutoResumeSkipReasons(
            session,
            machine.id,
            machine.namespace,
            machine.supportedAgents,
            now
        )

        expect(skipReasons(recentStaleArchive)).toEqual([])
        expect(skipReasons(codexStaleArchive)).toEqual([])
        expect(skipReasons(recentStaleArchive)).not.toContain('archived:cli-stale-recovery')
        expect(skipReasons(staleArchiveTooOld)).toContain('too-old')
        expect(skipReasons(userArchive)).toContain('archived:user')
        expect(skipReasons(systemArchive)).toContain('archived:system-stale')
        expect(skipReasons(notDaemonStarted)).toContain('not-daemon-started')
        expect(skipReasons(missingPath)).toContain('no-path')
        expect(skipReasons(missingNativeSessionId)).toContain('no-native-session-id')
        expect(skipReasons(missingCodexNativeSessionId)).toContain('no-native-session-id')
        expect(skipReasons(wrongMachine)).toContain('wrong-machine')
        expect(skipReasons(badFlavor)).toContain('bad-flavor:aider')
        expect(skipReasons(runningWithoutDbActive)).toContain('not-in-dbActive')
        expect(skipReasons(runningWithDbActive)).toEqual([])

        for (const session of [missingNativeSessionId, missingCodexNativeSessionId, missingPath, badFlavor]) {
            expect(skipReasons(session)).not.toContain('archived:cli-stale-recovery')
            expect(skipReasons(session)).not.toContain('not-in-dbActive')
        }
    })

    test('auto-resume-failed archives are retryable in short window with attempts cap', async () => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const machine = createMachine('machine-arf', {
            host: 'test-host',
            platform: 'linux',
            yohoRemoteCliVersion: 'test',
        })
        ;(engine as any).machines.set(machine.id, machine)

        const now = Date.now()
        const baseMetadata = {
            path: '/tmp/project',
            host: 'test-host',
            machineId: machine.id,
            flavor: 'claude',
            claudeSessionId: 'claude-abc',
            startedFromDaemon: true,
            startedBy: 'daemon',
            lifecycleState: 'archived',
            archivedBy: 'auto-resume-failed',
            archiveReason: 'auto-resume spawn failed: rpc timeout',
        }
        const addSession = (
            id: string,
            metadataPatch: Record<string, unknown>,
            activeAt: number = now - 60_000,
        ): Session => {
            const session = createSession(id, { ...baseMetadata, ...metadataPatch })
            session.active = false
            session.activeAt = activeAt
            ;(engine as any).sessions.set(session.id, session)
            return session
        }

        const recentFirstFailure = addSession('sess-arf-recent-first', {
            lifecycleStateSince: now - 60_000,
            autoResumeFailureAttempts: 1,
        })
        const recentSecondFailure = addSession('sess-arf-recent-second', {
            lifecycleStateSince: now - 30_000,
            autoResumeFailureAttempts: 2,
        })
        const exhaustedAttempts = addSession('sess-arf-exhausted', {
            lifecycleStateSince: now - 60_000,
            autoResumeFailureAttempts: 3,
        })
        const failureWindowExpired = addSession('sess-arf-window-expired', {
            lifecycleStateSince: now - 3 * 60 * 60 * 1000,
            autoResumeFailureAttempts: 1,
        })
        const activeAtTooOld = addSession(
            'sess-arf-active-too-old',
            {
                lifecycleStateSince: now - 60_000,
                autoResumeFailureAttempts: 1,
            },
            now - 3 * 60 * 60 * 1000
        )
        const userArchive = addSession('sess-user-archive-arf', {
            archivedBy: 'user',
            archiveReason: 'user archived',
            lifecycleStateSince: now - 60_000,
        })
        const serverArchive = addSession('sess-server-archive-arf', {
            archivedBy: 'server',
            archiveReason: 'server archived',
            lifecycleStateSince: now - 60_000,
        })

        const candidates = (engine as any).getAutoResumeCandidates(
            machine.id,
            machine.namespace,
            machine.supportedAgents,
            now
        ) as Session[]
        const candidateIds = candidates.map((session) => session.id)

        expect(candidateIds).toContain(recentFirstFailure.id)
        expect(candidateIds).toContain(recentSecondFailure.id)
        expect(candidateIds).not.toContain(exhaustedAttempts.id)
        expect(candidateIds).not.toContain(failureWindowExpired.id)
        expect(candidateIds).not.toContain(activeAtTooOld.id)
        expect(candidateIds).not.toContain(userArchive.id)
        expect(candidateIds).not.toContain(serverArchive.id)

        const skipReasons = (session: Session): string[] => (engine as any).getAutoResumeSkipReasons(
            session,
            machine.id,
            machine.namespace,
            machine.supportedAgents,
            now
        )

        expect(skipReasons(recentFirstFailure)).toEqual([])
        expect(skipReasons(recentSecondFailure)).toEqual([])
        expect(skipReasons(exhaustedAttempts)).toContain('archived:auto-resume-failed')
        expect(skipReasons(exhaustedAttempts)).toContain('not-in-dbActive')
        expect(skipReasons(failureWindowExpired)).toContain('archived:auto-resume-failed')
        expect(skipReasons(failureWindowExpired)).toContain('not-in-dbActive')
        expect(skipReasons(activeAtTooOld)).toContain('too-old')
        expect(skipReasons(userArchive)).toContain('archived:user')
        expect(skipReasons(userArchive)).toContain('not-in-dbActive')
        expect(skipReasons(serverArchive)).toContain('archived:server')

        for (const session of [userArchive, serverArchive, exhaustedAttempts, failureWindowExpired]) {
            const reasons = skipReasons(session)
            expect(reasons).not.toEqual([])
        }
    })

    test('archiveSession persists extraMetadata alongside archive stamps', async () => {
        type PatchCall = { id: string; patch: Record<string, unknown>; namespace: string }
        const patchCalls: PatchCall[] = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActive: async (
                _id: string,
                _active: boolean,
                _activeAt: number,
                _namespace: string,
                _orgId: unknown
            ) => true,
            patchSessionMetadata: async (
                id: string,
                patch: Record<string, unknown>,
                namespace: string,
            ) => {
                patchCalls.push({ id, patch, namespace })
                return true
            },
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = createSession('sess-archive-extra', {
            path: '/tmp/project',
            machineId: 'machine-arf',
            flavor: 'claude',
            startedFromDaemon: true,
            startedBy: 'daemon',
            autoResumeFailureAttempts: 2,
        })
        session.active = true
        session.activeAt = Date.now() - 60_000
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any)._dbActiveSessionIds.add(session.id)

        const archived = await engine.archiveSession(session.id, {
            terminateSession: false,
            force: true,
            archivedBy: 'auto-resume-failed',
            archiveReason: 'spawn failed: rpc timeout',
            extraMetadata: { autoResumeFailureAttempts: 3 },
        })

        expect(archived).toBe(true)
        expect(patchCalls).toHaveLength(1)
        const patched = patchCalls[0]?.patch ?? {}
        expect(patched.archivedBy).toBe('auto-resume-failed')
        expect(patched.archiveReason).toBe('spawn failed: rpc timeout')
        expect(patched.lifecycleState).toBe('archived')
        expect(patched.autoResumeFailureAttempts).toBe(3)
        expect((session.metadata as any)?.autoResumeFailureAttempts).toBe(3)
        expect((session.metadata as any)?.archivedBy).toBe('auto-resume-failed')
    })

    test('tracks monitor lifecycle from realtime messages', async () => {
        const persisted: unknown[] = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionActiveMonitors: async (
                _id: string,
                activeMonitors: unknown
            ) => {
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorToolCallMessage(1, {
                id: 'mon-1',
                description: 'watch logs',
                timeoutMs: 30_000,
            }),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskStartedMessage(2, 'mon-1', 'task-1'),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([
            {
                id: 'mon-1',
                description: 'watch logs',
                command: 'tail -f app.log',
                persistent: false,
                timeoutMs: 30_000,
                startedAt: 1002,
                taskId: 'task-1',
                state: 'running',
            },
        ])

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskNotificationMessage(
                3,
                'mon-1',
                'completed'
            ),
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        ;(engine as any).sessions.set(session.id, session)

        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskStartedMessage(
                1,
                'not-a-monitor',
                'task-ghost'
            ),
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const session = createSession('session-monitor', {
            host: 'ncu',
            path: '/tmp/project',
        })
        session.activeMonitors = [
            {
                id: 'mon-3',
                description: 'watch logs',
                command: 'tail -f app.log',
                persistent: false,
                timeoutMs: null,
                startedAt: 1001,
                taskId: 'task-1',
                state: 'running',
            },
        ]
        ;(engine as any).sessions.set(session.id, session)

        engine.handleSessionDisconnect({ sid: session.id, time: Date.now() })

        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(engine.getSession(session.id)?.activeMonitors).toEqual([
            {
                id: 'mon-3',
                description: 'watch logs',
                command: 'tail -f app.log',
                persistent: false,
                timeoutMs: null,
                startedAt: 1001,
                taskId: 'task-1',
                state: 'unknown',
            },
        ])
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

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

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
                permissions: { result: 'denied', decision: 'denied' },
            }),
        })
        await engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: createMonitorTaskStartedMessage(
                3,
                'mon-denied',
                'task-denied'
            ),
        })

        expect(engine.getSession(session.id)?.activeMonitors).toEqual([])
    })

    test('cleanupOrphanBrainChildren deletes offline brain-child when parent brain is gone', async () => {
        const deletedIds: string[] = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => [],
            getMessageCount: async () => 0,
            deleteSession: async (id: string) => {
                deletedIds.push(id)
                return true
            },
            setSessionActive: async () => {},
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000
        const orphan = createSession('orphan-child', {
            source: 'brain-child',
            mainSessionId: 'brain-that-no-longer-exists',
        })
        orphan.active = false
        orphan.activeAt = Date.now() - TWENTY_FIVE_HOURS_MS
        ;(engine as any).sessions.set(orphan.id, orphan)

        await engine.cleanupOrphanBrainChildren()

        expect(deletedIds).toContain(orphan.id)
        expect(engine.getSession(orphan.id)).toBeUndefined()
    })

    test('cleanupOrphanBrainChildren keeps offline brain-child when parent brain still exists', async () => {
        const deletedIds: string[] = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => [],
            getMessageCount: async () => 0,
            deleteSession: async (id: string) => {
                deletedIds.push(id)
                return true
            },
            setSessionActive: async () => {},
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000
        const brain = createSession('brain-parent', { source: 'brain' })
        brain.active = false
        brain.activeAt = Date.now() - TWENTY_FIVE_HOURS_MS
        const child = createSession('child-with-parent', {
            source: 'brain-child',
            mainSessionId: brain.id,
        })
        child.active = false
        child.activeAt = Date.now() - TWENTY_FIVE_HOURS_MS
        ;(engine as any).sessions.set(brain.id, brain)
        ;(engine as any).sessions.set(child.id, child)

        await engine.cleanupOrphanBrainChildren()

        expect(deletedIds).toHaveLength(0)
        expect(engine.getSession(child.id)).toBeDefined()
    })

    test('cleanupOrphanBrainChildren skips recently-idle orphan below TTL', async () => {
        const deletedIds: string[] = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getMessages: async () => [],
            getMessageCount: async () => 0,
            deleteSession: async (id: string) => {
                deletedIds.push(id)
                return true
            },
            setSessionActive: async () => {},
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const ONE_HOUR_MS = 60 * 60 * 1000
        const recent = createSession('recent-orphan', {
            source: 'brain-child',
            mainSessionId: 'nonexistent-brain',
        })
        recent.active = false
        recent.activeAt = Date.now() - ONE_HOUR_MS
        ;(engine as any).sessions.set(recent.id, recent)

        await engine.cleanupOrphanBrainChildren()

        expect(deletedIds).toHaveLength(0)
        expect(engine.getSession(recent.id)).toBeDefined()
    })

    test('patchSessionMetadata archive-guard strips unarchive fields for user-archived sessions', async () => {
        const patchCalls: Array<{
            id: string
            patch: Record<string, unknown>
        }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            patchSessionMetadata: async (
                id: string,
                patch: Record<string, unknown>
            ) => {
                patchCalls.push({ id, patch })
                return true
            },
            getSessionByNamespace: async () => null,
        } as any

        const io = {
            of: () => ({ to: () => ({ emit() {} }), emit() {} }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const archived = createSession('archived-child', {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 100,
            archivedBy: 'user',
            archiveReason: 'User archived session',
        })
        ;(engine as any).sessions.set(archived.id, archived)
        ;(engine as any).refreshSession = async () => archived

        const result = await engine.patchSessionMetadata(archived.id, {
            lifecycleState: 'running',
            lifecycleStateSince: 999,
            hostPid: 42,
        })

        expect(result).toEqual({ ok: true })
        expect(patchCalls).toHaveLength(1)
        expect(patchCalls[0].patch).toEqual({ hostPid: 42 })
    })

    test('patchSessionMetadata archive-guard skips store call when patch becomes empty after stripping', async () => {
        let storeCalls = 0

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            patchSessionMetadata: async () => {
                storeCalls += 1
                return true
            },
        } as any

        const io = {
            of: () => ({ to: () => ({ emit() {} }), emit() {} }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const archived = createSession('archived-child-2', {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 100,
            archivedBy: 'brain',
        })
        ;(engine as any).sessions.set(archived.id, archived)

        const result = await engine.patchSessionMetadata(archived.id, {
            lifecycleState: 'running',
            archivedBy: null,
        })

        expect(result).toEqual({ ok: true })
        expect(storeCalls).toBe(0)
    })

    test('patchSessionMetadata archive-guard is a no-op for cli-archived sessions', async () => {
        const patchCalls: Array<{ patch: Record<string, unknown> }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            patchSessionMetadata: async (
                _id: string,
                patch: Record<string, unknown>
            ) => {
                patchCalls.push({ patch })
                return true
            },
        } as any

        const io = {
            of: () => ({ to: () => ({ emit() {} }), emit() {} }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const cliArchived = createSession('cli-archived', {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 100,
            archivedBy: 'cli',
        })
        ;(engine as any).sessions.set(cliArchived.id, cliArchived)
        ;(engine as any).refreshSession = async () => cliArchived

        const result = await engine.patchSessionMetadata(cliArchived.id, {
            lifecycleState: 'running',
            hostPid: 42,
        })

        expect(result).toEqual({ ok: true })
        expect(patchCalls).toHaveLength(1)
        expect(patchCalls[0].patch).toEqual({
            lifecycleState: 'running',
            hostPid: 42,
        })
    })

    test('unarchiveSession clears archive stamps and bumps metadata version', async () => {
        const updateCalls: Array<{
            id: string
            metadata: unknown
            expectedVersion: number
        }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            updateSessionMetadata: async (
                id: string,
                metadata: unknown,
                expectedVersion: number
            ) => {
                updateCalls.push({ id, metadata, expectedVersion })
                return {
                    result: 'success',
                    version: expectedVersion + 1,
                    value: metadata,
                }
            },
        } as any

        const io = {
            of: () => ({ to: () => ({ emit() {} }), emit() {} }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const archived = createSession('archived-child-3', {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 100,
            archivedBy: 'user',
            archiveReason: 'User archived session',
        })
        ;(engine as any).sessions.set(archived.id, archived)

        const result = await engine.unarchiveSession(archived.id, {
            actor: 'resume',
        })

        expect(result).toEqual({ ok: true })
        expect(updateCalls).toHaveLength(1)
        expect(updateCalls[0].expectedVersion).toBe(1)
        const persisted = updateCalls[0].metadata as Record<string, unknown>
        expect(persisted.source).toBe('brain-child')
        expect(persisted.mainSessionId).toBe('brain-1')
        expect(persisted.lifecycleState).toBe('active')
        expect(persisted.archivedBy).toBeUndefined()
        expect(persisted.archiveReason).toBeUndefined()
        const after = engine.getSession(archived.id)?.metadata as Record<
            string,
            unknown
        >
        expect(after.lifecycleState).toBe('active')
        expect(after.archivedBy).toBeUndefined()
        expect(engine.getSession(archived.id)?.metadataVersion).toBe(2)
    })

    test('unarchiveSession returns version-mismatch error when store reports stale version', async () => {
        let storeCalls = 0
        let refreshCalls = 0

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            updateSessionMetadata: async () => {
                storeCalls += 1
                return { result: 'version-mismatch', version: 99, value: {} }
            },
        } as any

        const io = {
            of: () => ({ to: () => ({ emit() {} }), emit() {} }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const archived = createSession('archived-child-4', {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 100,
            archivedBy: 'user',
        })
        ;(engine as any).sessions.set(archived.id, archived)
        ;(engine as any).refreshSession = async () => {
            refreshCalls += 1
            return archived
        }

        const result = await engine.unarchiveSession(archived.id)

        expect(result).toEqual({
            ok: false,
            error: 'Metadata version mismatch during unarchive',
        })
        expect(storeCalls).toBe(1)
        expect(refreshCalls).toBe(1)
    })

    test('unarchiveSession is a no-op for non-archived sessions', async () => {
        let storeCalls = 0
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            updateSessionMetadata: async () => {
                storeCalls += 1
                return { result: 'success', version: 2, value: {} }
            },
        } as any

        const io = {
            of: () => ({ to: () => ({ emit() {} }), emit() {} }),
        } as any

        const engine = new SyncEngine(
            store,
            io,
            {} as any,
            {
                broadcast() {},
                broadcastToGroup() {},
            } as any
        )
        engine.stop()
        await new Promise((resolve) => setTimeout(resolve, 0))

        const running = createSession('running-session', {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'running',
        })
        ;(engine as any).sessions.set(running.id, running)

        const result = await engine.unarchiveSession(running.id)

        expect(result).toEqual({ ok: true })
        expect(storeCalls).toBe(0)
    })
})
