import { describe, expect, test } from 'bun:test'
import { SyncEngine, type Session } from './syncEngine'
import {
    SUMMARIZE_TURN_QUEUE_NAME,
    SUMMARIZE_TURN_JOB_VERSION,
    type SummarizeTurnJobData,
    type SummarizeTurnQueuePublisher
} from './summarizeTurnQueue'

function createSession(id: string): Session {
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
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        activeMonitors: [],
        thinking: true,
        thinkingAt: 0,
        modelMode: 'default',
    }
}

describe('SyncEngine summarize-turn publisher contract', () => {
    test('enqueues summarize-turn with stable payload and singleton key when thinking flips to false', async () => {
        const setSessionThinkingCalls: Array<{ id: string; thinking: boolean; namespace: string }> = []
        const getTurnBoundaryCalls: string[] = []
        const sendCalls: Array<{
            queueName: string
            payload: SummarizeTurnJobData
            options?: { singletonKey?: string }
        }> = []

        const store = {
            getSessions: async () => [],
            getMachines: async () => [],
            setSessionThinking: async (id: string, thinking: boolean, namespace: string) => {
                setSessionThinkingCalls.push({ id, thinking, namespace })
            },
            getTurnBoundary: async (sessionId: string) => {
                getTurnBoundaryCalls.push(sessionId)
                return {
                    turnStartSeq: 5,
                    turnEndSeq: 8
                }
            },
            getSessionNotificationRecipientClientIds: async () => [],
            setSessionModelConfig: async () => true,
        } as any

        const io = {
            of: () => ({
                to: () => ({ emit() {} }),
                emit() {},
            }),
        } as any

        const boss: SummarizeTurnQueuePublisher = {
            async send(queueName, payload, options) {
                sendCalls.push({ queueName, payload, options })
                return 'job-1'
            },
            async sendSessionSummary(_sessionId, _namespace) {
                return 'job-session'
            },
            async stop() {}
        }

        const engine = new SyncEngine(store, io, {} as any, {
            broadcast() {},
            broadcastToGroup() {},
        } as any, boss)
        engine.stop()
        await new Promise(resolve => setTimeout(resolve, 0))

        const session = createSession('session-1')
        ;(engine as any).sessions.set(session.id, session)
        ;(engine as any).waitForSessionMessagesToSettle = async () => {}

        const startedAt = Date.now()
        await engine.handleSessionAlive({
            sid: session.id,
            time: startedAt,
            thinking: false
        })
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(setSessionThinkingCalls).toEqual([{
            id: session.id,
            thinking: false,
            namespace: session.namespace
        }])
        expect(getTurnBoundaryCalls).toEqual([session.id])
        expect(sendCalls).toHaveLength(1)
        expect(sendCalls[0]?.queueName).toBe(SUMMARIZE_TURN_QUEUE_NAME)
        expect(sendCalls[0]?.payload.version).toBe(SUMMARIZE_TURN_JOB_VERSION)
        expect(sendCalls[0]?.payload.idempotencyKey).toBe(`turn:${session.id}:5`)
        expect(sendCalls[0]?.payload.payload.sessionId).toBe(session.id)
        expect(sendCalls[0]?.payload.payload.namespace).toBe(session.namespace)
        expect(sendCalls[0]?.payload.payload.userSeq).toBe(5)
        expect(sendCalls[0]?.payload.payload.scheduledAtMs).toBeGreaterThanOrEqual(startedAt)
        expect(sendCalls[0]?.payload.payload.scheduledAtMs).toBeLessThanOrEqual(Date.now())
        expect(sendCalls[0]?.options).toEqual({
            singletonKey: `turn:${session.id}:5`
        })
    })
})
