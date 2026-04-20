import { describe, expect, it } from 'bun:test'
import { SUMMARIZE_SEGMENT_JOB_VERSION, type SummarizeSegmentPayload } from '../boss'
import type { InsertRunInput } from '../db/runStore'
import type { WorkerJobMetadata } from '../jobs/core'
import type { StoredL1Summary, WorkerContext } from '../types'
import { handleSummarizeSegment } from './summarizeSegment'

const payload: SummarizeSegmentPayload = {
    sessionId: 'session-seg-1',
    namespace: 'ns-test',
    scheduledAtMs: 1_717_171_717_000,
}

function createJob(overrides: Partial<WorkerJobMetadata> = {}): WorkerJobMetadata {
    return {
        id: 'job-seg-1',
        name: 'summarize-segment',
        family: 'session-summary',
        version: SUMMARIZE_SEGMENT_JOB_VERSION,
        queueName: 'summarize-segment',
        idempotencyKey: 'segment:session-seg-1',
        ...overrides,
    }
}

function makeL1(id: string, seqStart: number): StoredL1Summary {
    return { id, seqStart, seqEnd: seqStart + 5, summary: `Turn ${id} summary`, topic: 'Test', tools: [], entities: [] }
}

function createContext(options?: {
    sessionSnapshot?: { id: string; namespace: string; thinking: boolean } | null
    unassignedL1s?: StoredL1Summary[]
    insertL2Result?: { id: string | null; inserted: boolean }
    llmError?: Error
}) {
    const insertedRuns: InsertRunInput[] = []
    let llmCalls = 0
    let l2InsertCalls = 0
    let markedL1Ids: string[] = []
    let markedL2Id: string | null = null
    let bossSendCalls = 0

    const ctx = {
        config: {
            bossSchema: 'yr_boss',
            l2SegmentThreshold: 5,
            deepseek: { model: 'deepseek-chat' },
        } as WorkerContext['config'],
        worker: { host: 'worker-a', version: '0.1.0-test' },
        pool: {} as WorkerContext['pool'],
        boss: {
            send: async () => { bossSendCalls += 1 },
        } as unknown as WorkerContext['boss'],
        sessionStore: {
            getSessionSnapshot: async () =>
                options && 'sessionSnapshot' in options
                    ? options.sessionSnapshot
                    : { id: payload.sessionId, namespace: payload.namespace, thinking: false },
        },
        summaryStore: {
            getUnassignedL1Summaries: async () =>
                options?.unassignedL1s ?? [makeL1('l1-1', 10), makeL1('l1-2', 20), makeL1('l1-3', 30)],
            countUnassignedL1: async () => (options?.unassignedL1s ?? []).length,
            insertL2: async () => {
                l2InsertCalls += 1
                return options?.insertL2Result ?? { id: 'l2-inserted', inserted: true }
            },
            markL1sAsSegmented: async (ids: string[], l2Id: string) => {
                markedL1Ids = ids
                markedL2Id = l2Id
            },
        },
        runStore: {
            insert: async (input: InsertRunInput) => { insertedRuns.push(input) },
        },
        deepseekClient: {
            summarizeSegment: async () => {
                llmCalls += 1
                if (options?.llmError) throw options.llmError
                return {
                    summary: 'Segment summary text',
                    topic: 'Segment topic',
                    tools: ['Bash'],
                    entities: ['config.ts'],
                    tokensIn: 100,
                    tokensOut: 50,
                    rawResponse: '{}',
                    provider: {
                        provider: 'deepseek',
                        model: 'deepseek-chat',
                        statusCode: 200,
                        requestId: 'req-1',
                        finishReason: 'stop',
                        errorCode: null,
                    },
                }
            },
        },
    } as unknown as WorkerContext

    return {
        ctx,
        insertedRuns,
        getLlmCalls: () => llmCalls,
        getL2InsertCalls: () => l2InsertCalls,
        getMarkedL1Ids: () => markedL1Ids,
        getMarkedL2Id: () => markedL2Id,
        getBossSendCalls: () => bossSendCalls,
    }
}

describe('handleSummarizeSegment', () => {
    it('happy path: calls LLM, inserts L2, marks L1s as segmented', async () => {
        const l1s = [makeL1('l1-a', 10), makeL1('l1-b', 20), makeL1('l1-c', 30)]
        const { ctx, insertedRuns, getLlmCalls, getL2InsertCalls, getMarkedL1Ids, getMarkedL2Id } =
            createContext({ unassignedL1s: l1s })

        await handleSummarizeSegment(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(getL2InsertCalls()).toBe(1)
        expect(getMarkedL1Ids()).toEqual(['l1-a', 'l1-b', 'l1-c'])
        expect(getMarkedL2Id()).toBe('l2-inserted')
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'success', level: 2 })
    })

    it('skips when fewer than MIN_L1_TO_SEGMENT unassigned L1s', async () => {
        const { ctx, insertedRuns, getLlmCalls } = createContext({ unassignedL1s: [makeL1('l1-only', 10)] })

        await handleSummarizeSegment(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'skipped',
            errorCode: 'insufficient_l1_summaries',
        })
    })

    it('returns error_permanent for missing session', async () => {
        const { ctx, insertedRuns, getLlmCalls } = createContext({ sessionSnapshot: null })

        await handleSummarizeSegment(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'error_permanent', errorCode: 'session_not_found' })
    })

    it('records transient error and rethrows on DB write failure', async () => {
        const l1s = [makeL1('l1-x', 10), makeL1('l1-y', 20), makeL1('l1-z', 30)]
        const { ctx, insertedRuns, getLlmCalls } = createContext({ unassignedL1s: l1s })

        // Patch insertL2 to throw
        ;(ctx.summaryStore as any).insertL2 = async () => { throw new Error('DB connection lost') }

        await expect(handleSummarizeSegment(payload, createJob(), ctx)).rejects.toThrow('DB connection lost')

        expect(getLlmCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'error_transient', level: 2 })
    })
})
