import { describe, expect, it } from 'bun:test'
import { SUMMARIZE_SESSION_JOB_VERSION, type SummarizeSessionPayload } from '../boss'
import type { InsertRunInput } from '../db/runStore'
import type { WorkerJobMetadata } from '../jobs/core'
import type { StoredL1Summary, StoredL2Summary, WorkerContext } from '../types'
import { handleSummarizeSession } from './summarizeSession'

const payload: SummarizeSessionPayload = {
    sessionId: 'session-sess-1',
    namespace: 'ns-test',
    scheduledAtMs: 1_717_171_717_000,
}

function createJob(overrides: Partial<WorkerJobMetadata> = {}): WorkerJobMetadata {
    return {
        id: 'job-sess-1',
        name: 'summarize-session',
        family: 'session-summary',
        version: SUMMARIZE_SESSION_JOB_VERSION,
        queueName: 'summarize-session',
        idempotencyKey: 'session:session-sess-1',
        ...overrides,
    }
}

function makeL2(id: string, seqStart: number): StoredL2Summary {
    return { id, seqStart, seqEnd: seqStart + 50, summary: `Segment ${id} summary`, topic: 'Seg', tools: [], entities: [] }
}

function makeL1(id: string, seqStart: number): StoredL1Summary {
    return { id, seqStart, seqEnd: seqStart + 5, summary: `Turn ${id} summary`, topic: 'Turn', tools: [], entities: [] }
}

function createContext(options?: {
    sessionSnapshot?: { id: string; namespace: string; thinking: boolean } | null
    l2Summaries?: StoredL2Summary[]
    l1Summaries?: StoredL1Summary[]
    llmError?: Error
    upsertError?: Error
}) {
    const insertedRuns: InsertRunInput[] = []
    let llmCalls = 0
    let upsertCalls = 0

    const ctx = {
        config: {
            bossSchema: 'yr_boss',
            deepseek: { model: 'deepseek-chat' },
        } as WorkerContext['config'],
        worker: { host: 'worker-a', version: '0.1.0-test' },
        pool: {} as WorkerContext['pool'],
        boss: {} as WorkerContext['boss'],
        sessionStore: {
            getSessionSnapshot: async () =>
                options && 'sessionSnapshot' in options
                    ? options.sessionSnapshot
                    : { id: payload.sessionId, namespace: payload.namespace, thinking: false },
        },
        summaryStore: {
            getSegmentSummaries: async () => options?.l2Summaries ?? [],
            getTurnSummaries: async () => options?.l1Summaries ?? [],
            upsertL3: async (input: unknown) => {
                upsertCalls += 1
                if (options?.upsertError) throw options.upsertError
                return { id: 'l3-id' }
            },
        },
        runStore: {
            insert: async (input: InsertRunInput) => { insertedRuns.push(input) },
        },
        deepseekClient: {
            summarizeSession: async (_summaries: unknown, _level: unknown) => {
                llmCalls += 1
                if (options?.llmError) throw options.llmError
                return {
                    summary: 'Session summary',
                    topic: 'Session topic',
                    tools: ['Bash', 'Read'],
                    entities: ['server/src/index.ts'],
                    tokensIn: 200,
                    tokensOut: 80,
                    rawResponse: '{}',
                    provider: {
                        provider: 'deepseek',
                        model: 'deepseek-chat',
                        statusCode: 200,
                        requestId: 'req-sess',
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
        getUpsertCalls: () => upsertCalls,
    }
}

describe('handleSummarizeSession', () => {
    it('happy path with L2 summaries: calls LLM and upserts L3', async () => {
        const l2s = [makeL2('l2-1', 10), makeL2('l2-2', 60)]
        const { ctx, insertedRuns, getLlmCalls, getUpsertCalls } = createContext({ l2Summaries: l2s })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(getUpsertCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'success',
            level: 3,
        })
        expect(insertedRuns[0]?.metadata).toMatchObject({ source_level: 2, source_count: 2 })
    })

    it('falls back to L1 when no L2 summaries exist', async () => {
        const l1s = [makeL1('l1-a', 10), makeL1('l1-b', 20)]
        const { ctx, insertedRuns, getLlmCalls } = createContext({ l2Summaries: [], l1Summaries: l1s })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'success', level: 3 })
        expect(insertedRuns[0]?.metadata).toMatchObject({ source_level: 1, source_count: 2 })
    })

    it('skips when no L1 or L2 summaries found', async () => {
        const { ctx, insertedRuns, getLlmCalls } = createContext({ l2Summaries: [], l1Summaries: [] })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'skipped', errorCode: 'no_source_summaries' })
    })

    it('returns error_permanent for missing session', async () => {
        const { ctx, insertedRuns, getLlmCalls } = createContext({ sessionSnapshot: null })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'error_permanent', errorCode: 'session_not_found' })
    })

    it('records transient error and rethrows on DB upsert failure', async () => {
        const l2s = [makeL2('l2-x', 10)]
        const { ctx, insertedRuns, getLlmCalls } = createContext({
            l2Summaries: l2s,
            upsertError: new Error('Connection timeout'),
        })

        await expect(handleSummarizeSession(payload, createJob(), ctx)).rejects.toThrow('Connection timeout')

        expect(getLlmCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'error_transient', level: 3 })
    })
})
