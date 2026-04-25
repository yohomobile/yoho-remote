import { describe, expect, it } from 'bun:test'
import { SUMMARIZE_SESSION_JOB_VERSION, type SummarizeSessionPayload } from '../boss'
import type { InsertRunInput } from '../db/runStore'
import type { WorkerJobMetadata } from '../jobs/core'
import type { StoredL1Summary, StoredL2Summary, WorkerContext } from '../types'
import { handleSummarizeSession } from './summarizeSession'

const payload: SummarizeSessionPayload = {
    sessionId: 'session-sess-1',
    namespace: 'org-test',
    orgId: 'org-test',
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
    sessionSnapshot?: { id: string; namespace: string; orgId: string | null; thinking: boolean } | null
    l2Summaries?: StoredL2Summary[]
    l1Summaries?: StoredL1Summary[]
    orphanL1s?: StoredL1Summary[]
    llmError?: Error
    upsertError?: Error
    llmTopic?: string
    llmTools?: string[]
    memoryClientEnabled?: boolean
}) {
    const insertedRuns: InsertRunInput[] = []
    const remembered: Array<Record<string, unknown>> = []
    const savedSkills: Array<Record<string, unknown>> = []
    let llmCalls = 0
    let upsertCalls = 0
    let bossSendCalls = 0

    const ctx = {
        config: {
            bossSchema: 'yr_boss',
            l2SegmentThreshold: 5,
            deepseek: { model: 'deepseek-chat' },
            yohoMemory: {
                enabled: true,
                url: 'http://127.0.0.1:3100',
                token: 'token',
                writeL1: true,
                writeL2: true,
                writeL3: true,
                saveSkillFromL2: true,
                saveSkillFromL3: true,
                requestTimeoutMs: 5000,
            },
        } as WorkerContext['config'],
        worker: { host: 'worker-a', version: '0.1.0-test' },
        pool: {} as WorkerContext['pool'],
        boss: {
            send: async () => { bossSendCalls += 1; return null },
        } as unknown as WorkerContext['boss'],
        sessionStore: {
            getSessionSnapshot: async () =>
                options && 'sessionSnapshot' in options
                    ? options.sessionSnapshot
                    : { id: payload.sessionId, namespace: payload.namespace, orgId: payload.orgId, thinking: false },
        },
        summaryStore: {
            getSegmentSummaries: async () => options?.l2Summaries ?? [],
            getTurnSummaries: async () => options?.l1Summaries ?? [],
            getUnassignedL1Summaries: async () => options?.orphanL1s ?? [],
            upsertL3: async (_input: unknown) => {
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
                    topic: options?.llmTopic ?? 'Session topic',
                    tools: options?.llmTools ?? ['Bash', 'Read'],
                    entities: ['server/src/index.ts'],
                    memory: {
                        action: 'remember',
                        text: 'Session 完成 worker 摘要链路验证，保留关键配置、测试依据和残留风险。',
                        reason: 'session 级结论可供后续继续工作',
                    },
                    skill: {
                        action: 'save',
                        name: 'Worker 摘要链路排查',
                        description: '排查 worker session 摘要生成、记忆写入和候选 skill 生成。',
                        content: [
                            '# Worker 摘要链路排查',
                            '',
                            '## 适用场景',
                            '- worker L3 摘要或记忆候选生成异常。',
                            '',
                            '## 步骤',
                            '1. 检查 L1/L2 来源。',
                            '2. 检查 L3 upsert。',
                            '3. 验证 remember/skill_save 调用。',
                            '',
                            '## 验证',
                            '- summarizeSession tests 通过。',
                        ].join('\n'),
                        tags: ['worker', 'memory'],
                        requiredTools: ['Bash', 'Read'],
                        antiTriggers: ['一次性实现结果'],
                        reason: '具备触发场景、步骤和验证方式',
                    },
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
        memoryClient: options?.memoryClientEnabled
            ? {
                remember: async (body: Record<string, unknown>) => {
                    remembered.push(body)
                },
                saveSkill: async (body: Record<string, unknown>) => {
                    savedSkills.push(body)
                },
            }
            : null,
    } as unknown as WorkerContext

    return {
        ctx,
        insertedRuns,
        remembered,
        savedSkills,
        getLlmCalls: () => llmCalls,
        getUpsertCalls: () => upsertCalls,
        getBossSendCalls: () => bossSendCalls,
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
        expect(insertedRuns[0]).toMatchObject({ status: 'success', level: 3 })
        expect(insertedRuns[0]?.metadata).toMatchObject({ source_level: 2, source_count: 2 })
    })

    it('writes L3 memory and candidate skill for focused sessions', async () => {
        const l2s = [makeL2('l2-1', 10), makeL2('l2-2', 60)]
        const { ctx, remembered, savedSkills } = createContext({
            l2Summaries: l2s,
            memoryClientEnabled: true,
        })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(remembered).toHaveLength(1)
        expect(remembered[0]).toMatchObject({
            source: 'automation',
            approvedForLongTerm: false,
            idempotencyKey: 'yoho-remote:memory:L3:l3-id',
        })
        expect(String(remembered[0]?.input)).toContain('[yoho-remote memory proposal L3]')
        expect(String(remembered[0]?.input)).toContain('Session 完成 worker 摘要链路验证')
        expect(savedSkills).toHaveLength(1)
        expect(savedSkills[0]).toMatchObject({
            name: 'Worker 摘要链路排查',
            category: '工程',
            activationMode: 'manual',
            idempotencyKey: 'yoho-remote:skill:L3:l3-id',
            requiredTools: ['Bash', 'Read'],
            antiTriggers: ['一次性实现结果'],
        })
        expect(String(savedSkills[0]?.content)).toContain('## 适用场景')
    })

    it('includes orphan L1s when L2s exist', async () => {
        const l2s = [makeL2('l2-1', 0)]
        const orphans = [makeL1('orphan-1', 100)]
        const { ctx, insertedRuns, getLlmCalls } = createContext({ l2Summaries: l2s, orphanL1s: orphans })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'success' })
        expect(insertedRuns[0]?.metadata).toMatchObject({ source_level: 2, source_count: 2, orphan_l1_count: 1 })
    })

    it('falls back to L1 when no L2 summaries exist (non-trivial: 7 turns)', async () => {
        const l1s = Array.from({ length: 7 }, (_, i) => makeL1(`l1-${i}`, i * 10))
        const { ctx, insertedRuns, getLlmCalls } = createContext({ l2Summaries: [], l1Summaries: l1s })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'success', level: 3 })
        expect(insertedRuns[0]?.metadata).toMatchObject({ source_level: 1, source_count: 7 })
    })

    it('trivial session writes L3 without calling DeepSeek (< 6 turns)', async () => {
        const l1s = [makeL1('l1-a', 10), makeL1('l1-b', 20), makeL1('l1-c', 30)]
        const { ctx, insertedRuns, getLlmCalls, getUpsertCalls } = createContext({
            l2Summaries: [],
            l1Summaries: l1s,
        })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(getUpsertCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'success', level: 3 })
        expect(insertedRuns[0]?.metadata).toMatchObject({ trivial: true, source_level: 1, source_count: 3 })
    })

    it('does not write trivial L3 sessions to memory or skill candidates', async () => {
        const l1s = [makeL1('l1-a', 10), makeL1('l1-b', 20), makeL1('l1-c', 30)]
        const { ctx, remembered, savedSkills } = createContext({
            l2Summaries: [],
            l1Summaries: l1s,
            memoryClientEnabled: true,
        })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(remembered).toHaveLength(0)
        expect(savedSkills).toHaveLength(0)
    })

    it('defers L3 and records skipped when session is still thinking', async () => {
        const { ctx, insertedRuns, getLlmCalls, getBossSendCalls } = createContext({
            sessionSnapshot: { id: payload.sessionId, namespace: payload.namespace, orgId: payload.orgId, thinking: true },
        })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(getBossSendCalls()).toBe(1)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'skipped', errorCode: 'session_still_active' })
    })

    it('defers L3 when orphan L1s should first be rolled into L2', async () => {
        const orphanL1s = [1, 2, 3, 4, 5].map(index => makeL1(`orphan-${index}`, index * 10))
        const { ctx, insertedRuns, getLlmCalls, getBossSendCalls } = createContext({
            l2Summaries: [makeL2('l2-existing', 1)],
            orphanL1s,
        })

        await handleSummarizeSession(payload, createJob(), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(getBossSendCalls()).toBe(2)
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({ status: 'skipped', errorCode: 'pending_l2_segments' })
        expect(insertedRuns[0]?.metadata).toMatchObject({ orphan_l1_count: 5, threshold: 5 })
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
