import { describe, expect, test } from 'bun:test'
import { SyncEngine, type Session } from './syncEngine'

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
})
