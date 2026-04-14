import { describe, expect, test } from 'bun:test'
import { SyncEngine, type Machine, type Session } from './syncEngine'

function createSession(id: string, metadata: Record<string, unknown>): Session {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: metadata as Session['metadata'],
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
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

    test('prefers result text over assistant narration in brain callback', async () => {
        const sent: Array<{ sessionId: string; payload: { text: string } }> = []
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
        ;(engine as any).sendMessage = async (sessionId: string, payload: { text: string }) => {
            sent.push({ sessionId, payload })
        }

        await (engine as any).sendBrainCallbackIfNeeded(childSession)

        expect(sent).toHaveLength(1)
        expect(sent[0]?.payload.text).toContain('总订单数：254')
        expect(sent[0]?.payload.text).not.toContain('让我汇总关键数据并生成执行报告')
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

    test('marks disconnected sessions inactive in memory and allows heartbeat reactivation', async () => {
        const setSessionActiveCalls: Array<{ id: string; active: boolean; activeAt: number; namespace: string }> = []
        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            getSession: async () => ({ active: true }),
            setSessionActive: async (id: string, active: boolean, activeAt: number, namespace: string) => {
                setSessionActiveCalls.push({ id, active, activeAt, namespace })
            },
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
})
