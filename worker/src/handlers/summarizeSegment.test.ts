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

const DEFAULT_L1S = [makeL1('l1-1', 10), makeL1('l1-2', 20), makeL1('l1-3', 30)]

function createContext(options?: {
    sessionSnapshot?: { id: string; namespace: string; thinking: boolean } | null
    unassignedL1s?: StoredL1Summary[]
    insertL2AndMarkL1sError?: Error
    llmError?: Error
}) {
    const insertedRuns: InsertRunInput[] = []
    let llmCalls = 0
    let l2AndMarkCalls = 0
    let capturedL1Ids: string[] = []
    let bossSendCalls = 0

    const l1s = options?.unassignedL1s ?? DEFAULT_L1S

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
            getUnassignedL1Summaries: async () => l1s,
            countUnassignedL1: async () => l1s.length,
            insertL2AndMarkL1s: async (_input: unknown, ids: string[]) => {
                l2AndMarkCalls += 1
                capturedL1Ids = ids
                if (options?.insertL2AndMarkL1sError) throw options.insertL2AndMarkL1sError
                return { id: 'l2-inserted' }
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
        getL2AndMarkCalls: () => l2AndMarkCalls,
        getCapturedL1Ids: () => capturedL1Ids,
        getBossSendCalls: () => bossSendCalls,
    }
}

describe('handleSummarizeSegment', () => {
    it('happy path: calls LLM, inserts L2, marks L1s atomically', async () => {
        const l1s = [makeL1('l1-a', 10), makeL1('l1-b', 20), makeL1('l1-c', 30)]
        const { ctx, insertedRuns, getLlmCalls, getL2AndMarkCalls, getCapturedL1Ids } =
            createContext({ unassignedL1s: l1s })

        await handleSummarizeSegment(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(getL2AndMarkCalls()).toBe(1)
        expect(getCapturedL1Ids()).toEqual(['l1-a', 'l1-b', 'l1-c'])
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'success', level: 2 })
        expect(insertedRuns[0]?.metadata).toMatchObject({ l2_id: 'l2-inserted', l1_count: 3 })
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

    it('records transient error and rethrows when atomic insert+mark fails', async () => {
        const l1s = [makeL1('l1-x', 10), makeL1('l1-y', 20), makeL1('l1-z', 30)]
        const { ctx, insertedRuns, getLlmCalls } = createContext({
            unassignedL1s: l1s,
            insertL2AndMarkL1sError: new Error('DB connection lost'),
        })

        await expect(handleSummarizeSegment(payload, createJob(), ctx)).rejects.toThrow('DB connection lost')

        expect(getLlmCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'error_transient', level: 2 })
    })

    it('retry: second invocation succeeds after first insertL2AndMarkL1s failure', async () => {
        const l1s = [makeL1('l1-r1', 10), makeL1('l1-r2', 20), makeL1('l1-r3', 30)]
        let callCount = 0
        const { ctx, getLlmCalls } = createContext({ unassignedL1s: l1s })

        ;(ctx.summaryStore as any).insertL2AndMarkL1s = async (_input: unknown, _ids: string[]) => {
            callCount += 1
            if (callCount === 1) throw new Error('Transient DB error')
            return { id: 'l2-retry-ok' }
        }

        // First attempt fails
        await expect(handleSummarizeSegment(payload, createJob(), ctx)).rejects.toThrow('Transient DB error')

        // Second attempt (pg-boss retry) succeeds
        const runs2: InsertRunInput[] = []
        ;(ctx.runStore as any).insert = async (input: InsertRunInput) => { runs2.push(input) }
        await handleSummarizeSegment(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(2)
        expect(runs2[0]).toMatchObject({ status: 'success', level: 2 })
    })
})
