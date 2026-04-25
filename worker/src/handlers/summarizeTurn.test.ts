import { describe, expect, it } from 'bun:test'
import { SUMMARIZE_TURN_JOB_VERSION, type SummarizeTurnPayload } from '../boss'
import type { InsertRunInput } from '../db/runStore'
import type { InsertL1SummaryInput } from '../db/summaryStore'
import type { WorkerJobMetadata } from '../jobs/core'
import { handleSummarizeTurn } from './summarizeTurn'
import type { DbMessage, L1SummaryRecord, WorkerContext } from '../types'

const payload: SummarizeTurnPayload = {
    sessionId: 'session-1',
    namespace: 'org-test',
    orgId: 'org-test',
    userSeq: 10,
    scheduledAtMs: 1_717_171_717_000,
}

function message(seq: number, content: unknown): DbMessage {
    return {
        id: `msg-${seq}`,
        seq,
        content,
        createdAt: seq * 1000,
    }
}

function createJob(overrides: Partial<WorkerJobMetadata> = {}): WorkerJobMetadata {
    return {
        id: 'job-default',
        name: 'summarize-turn',
        family: 'session-summary',
        version: SUMMARIZE_TURN_JOB_VERSION,
        queueName: 'summarize-turn',
        idempotencyKey: 'turn:session-1:10',
        ...overrides,
    }
}

function createContext(options?: {
    sessionSnapshot?: { id: string; namespace: string; orgId: string | null; thinking: boolean } | null
    turnMessages?: DbMessage[]
    cachedResult?: L1SummaryRecord | null
    memoryClientEnabled?: boolean
}) {
    const insertedRuns: InsertRunInput[] = []
    const insertedSummaries: InsertL1SummaryInput[] = []
    const remembered: Array<Record<string, unknown>> = []
    let llmCalls = 0
    let summaryInsertCalls = 0

    const ctx = {
        config: {
            bossSchema: 'yr_boss',
            deepseek: {
                model: 'deepseek-chat',
            },
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
        worker: {
            host: 'worker-a',
            version: '0.1.0-test',
        },
        pool: {} as WorkerContext['pool'],
        boss: {} as WorkerContext['boss'],
        sessionStore: {
            getSessionSnapshot: async () => options?.sessionSnapshot ?? {
                id: payload.sessionId,
                namespace: payload.namespace,
                orgId: payload.orgId,
                thinking: false,
            },
            getTurnMessages: async () => options?.turnMessages ?? [],
        },
        summaryStore: {
            insertL1: async (input: InsertL1SummaryInput) => {
                summaryInsertCalls += 1
                insertedSummaries.push(input)
                return { id: 'summary-1', inserted: true }
            },
            countUnassignedL1: async () => 0,
        },
        runStore: {
            insert: async (input: InsertRunInput) => {
                insertedRuns.push(input)
            },
            getLatestCachedL1Result: async (
                _orgId: string,
                _sessionId: string,
                _seqStart: number,
                _jobName: string,
                _jobVersion: number
            ) => {
                return options?.cachedResult ?? null
            },
            pruneOlderThan: async () => 0,
        },
        deepseekClient: {
            summarizeTurn: async () => {
                llmCalls += 1
                return {
                    summary: '完成摘要',
                    topic: '测试',
                    tools: ['Bash'],
                    entities: ['bun test'],
                    memory: {
                        action: 'remember',
                        text: 'worker 摘要管线已验证：L1 摘要插入成功，相关测试通过。',
                        reason: '包含可复用的验证结果',
                    },
                    skill: {
                        action: 'skip',
                        name: null,
                        description: null,
                        content: null,
                        tags: [],
                        requiredTools: [],
                        antiTriggers: [],
                        reason: 'L1 不生成 skill',
                    },
                    tokensIn: 10,
                    tokensOut: 5,
                    rawResponse: '{"summary":"完成摘要"}',
                    provider: {
                        provider: 'deepseek',
                        model: 'deepseek-chat',
                        statusCode: 200,
                        requestId: 'req-success-1',
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
                saveSkill: async () => {},
            }
            : null,
    } as unknown as WorkerContext

    return {
        ctx,
        insertedRuns,
        insertedSummaries,
        remembered,
        getLlmCalls: () => llmCalls,
        getSummaryInsertCalls: () => summaryInsertCalls,
    }
}

describe('handleSummarizeTurn', () => {
    it('skips trivial turns without calling llm or writing summaries', async () => {
        const { ctx, insertedRuns, getLlmCalls, getSummaryInsertCalls } = createContext({
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '继续' },
                }),
                message(11, {
                    role: 'assistant',
                    content: '好的',
                }),
            ],
        })

        await handleSummarizeTurn(payload, createJob({ id: 'job-trivial' }), ctx)

        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'skipped',
            jobName: 'summarize-turn',
            jobFamily: 'session-summary',
            jobVersion: SUMMARIZE_TURN_JOB_VERSION,
            idempotencyKey: 'turn:session-1:10',
            errorCode: 'trivial_turn',
        })
        expect(insertedRuns[0]?.error).toContain('trivial turn')
        expect(getLlmCalls()).toBe(0)
        expect(getSummaryInsertCalls()).toBe(0)
    })

    it('summarizes short operational turns even without tool_use', async () => {
        const { ctx, insertedRuns, insertedSummaries, getLlmCalls, getSummaryInsertCalls } = createContext({
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '部署 worker' },
                }),
                message(11, {
                    role: 'assistant',
                    content: '缺 DEEPSEEK_API_KEY，部署阻塞。',
                }),
            ],
        })

        await handleSummarizeTurn(payload, createJob({ id: 'job-short-operational' }), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(getSummaryInsertCalls()).toBe(1)
        expect(insertedSummaries).toHaveLength(1)
        expect(insertedSummaries[0]?.summary).toBe('完成摘要')
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'success',
            errorCode: null,
            cacheHit: false,
        })
        expect(insertedRuns[0]?.metadata).toMatchObject({
            inserted_summary: true,
            real_message_count: 2,
            tool_use_count: 0,
        })
    })

    it('records transient failure and throws when session is still thinking', async () => {
        const { ctx, insertedRuns, getLlmCalls } = createContext({
            sessionSnapshot: {
                id: payload.sessionId,
                namespace: payload.namespace,
                orgId: payload.orgId,
                thinking: true,
            },
        })

        await expect(handleSummarizeTurn(payload, createJob({ id: 'job-thinking' }), ctx)).rejects.toThrow(
            'Session still thinking'
        )

        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'error_transient',
            errorCode: 'session_still_thinking',
        })
        expect(insertedRuns[0]?.error).toContain('Session still thinking')
        expect(getLlmCalls()).toBe(0)
    })

    it('records transient failure and throws when the last assistant-like message is mid-stream tool_use', async () => {
        const { ctx, insertedRuns, getLlmCalls } = createContext({
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '读一下配置文件' },
                }),
                message(11, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/config.ts' } },
                                ],
                            },
                        },
                    },
                }),
            ],
        })

        await expect(handleSummarizeTurn(payload, createJob({ id: 'job-mid-stream' }), ctx)).rejects.toThrow(
            'Turn appears incomplete'
        )

        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'error_transient',
            errorCode: 'turn_incomplete_mid_tool_use',
        })
        expect(insertedRuns[0]?.error).toContain('Turn appears incomplete')
        expect(getLlmCalls()).toBe(0)
    })

    it('writes a summary and records success on the normal llm path', async () => {
        const { ctx, insertedRuns, insertedSummaries, getLlmCalls, getSummaryInsertCalls } = createContext({
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '检查 DeepSeek JSON Output 配置' },
                }),
                message(11, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/deepseek.ts' } },
                                    { type: 'text', text: '我已经核对了配置和摘要字段，当前实现符合预期。' },
                                ],
                            },
                        },
                    },
                }),
            ],
        })

        await handleSummarizeTurn(payload, createJob({
            id: 'job-success',
            retryCount: 2,
            retryLimit: 4,
            retryDelay: 15,
            retryBackoff: true,
            retryDelayMax: 300,
            singletonKey: 'turn:session-1:10',
            createdOn: new Date(1_717_171_700_000),
            startedOn: new Date(1_717_171_705_000),
        }), ctx)

        expect(getLlmCalls()).toBe(1)
        expect(getSummaryInsertCalls()).toBe(1)
        expect(insertedSummaries).toHaveLength(1)
        expect(insertedSummaries[0]?.summary).toBe('完成摘要')
        expect(insertedSummaries[0]?.metadata.topic).toBe('测试')
        expect(insertedSummaries[0]?.metadata).toMatchObject({
            cache_hit: false,
            provider: 'deepseek',
            provider_model: 'deepseek-chat',
            provider_request_id: 'req-success-1',
            provider_finish_reason: 'stop',
        })
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'success',
            jobName: 'summarize-turn',
            jobFamily: 'session-summary',
            jobVersion: SUMMARIZE_TURN_JOB_VERSION,
            idempotencyKey: 'turn:session-1:10',
            workerHost: 'worker-a',
            workerVersion: '0.1.0-test',
            queueSchema: 'yr_boss',
            retryCount: 2,
            retryLimit: 4,
            cacheHit: false,
            providerName: 'deepseek',
            providerModel: 'deepseek-chat',
            providerStatus: 200,
            providerRequestId: 'req-success-1',
            providerFinishReason: 'stop',
        })
        expect(insertedRuns[0]?.metadata).toMatchObject({
            inserted_summary: true,
            seq_start: payload.userSeq,
            retry_delay_seconds: 15,
            retry_backoff: true,
            retry_delay_max_seconds: 300,
            job_name: 'summarize-turn',
            job_family: 'session-summary',
            job_version: SUMMARIZE_TURN_JOB_VERSION,
            idempotency_key: 'turn:session-1:10',
            singleton_key: 'turn:session-1:10',
            worker_host: 'worker-a',
            worker_version: '0.1.0-test',
            queue_schema: 'yr_boss',
            provider_request_id: 'req-success-1',
            provider_finish_reason: 'stop',
        })
    })

    it('writes fresh L1 summaries to yoho-memory without blocking the main path', async () => {
        const { ctx, remembered } = createContext({
            memoryClientEnabled: true,
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '检查 worker 摘要管线' },
                }),
                message(11, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/worker.ts' } },
                                    { type: 'text', text: '摘要管线已检查，L1 写入正常。' },
                                ],
                            },
                        },
                    },
                }),
            ],
        })

        await handleSummarizeTurn(payload, createJob({ id: 'job-memory' }), ctx)

        expect(remembered).toHaveLength(1)
        expect(remembered[0]).toMatchObject({
            source: 'automation',
            approvedForLongTerm: false,
            idempotencyKey: 'yoho-remote:memory:L1:session-1:10',
        })
        expect(String(remembered[0]?.input)).toContain('[yoho-remote memory proposal L1]')
        expect(String(remembered[0]?.input)).toContain('Topic: 测试')
        expect(String(remembered[0]?.input)).toContain('worker 摘要管线已验证')
    })

    it('replays cached results without calling llm again', async () => {
        const { ctx, insertedRuns, insertedSummaries, getLlmCalls, getSummaryInsertCalls } = createContext({
            cachedResult: {
                summary: '缓存摘要',
                topic: '缓存主题',
                tools: ['Read'],
                entities: ['deepseek.ts'],
                provider: {
                    provider: 'deepseek',
                    model: 'deepseek-chat',
                    statusCode: 200,
                    requestId: 'req-cache-1',
                    finishReason: 'stop',
                    errorCode: null,
                },
            },
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '重放上次摘要结果' },
                }),
                message(11, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/deepseek.ts' } },
                                    { type: 'text', text: '我会直接复用缓存摘要，不再重新请求 LLM。' },
                                ],
                            },
                        },
                    },
                }),
            ],
        })

        await handleSummarizeTurn(payload, createJob({ id: 'job-cache-hit' }), ctx)

        expect(getLlmCalls()).toBe(0)
        expect(getSummaryInsertCalls()).toBe(1)
        expect(insertedSummaries).toHaveLength(1)
        expect(insertedSummaries[0]?.summary).toBe('缓存摘要')
        expect(insertedSummaries[0]?.metadata.topic).toBe('缓存主题')
        expect(insertedRuns).toHaveLength(1)
        expect(insertedRuns[0]).toMatchObject({
            status: 'success',
            jobName: 'summarize-turn',
            jobVersion: SUMMARIZE_TURN_JOB_VERSION,
            idempotencyKey: 'turn:session-1:10',
            cacheHit: true,
            providerName: 'deepseek',
            providerRequestId: 'req-cache-1',
            providerFinishReason: 'stop',
        })
        expect(insertedRuns[0]?.metadata).toMatchObject({
            cache_hit: true,
            inserted_summary: true,
            provider_skipped_reason: 'cache_hit',
            provider_request_id: 'req-cache-1',
        })
    })

    it('does not write L1 summaries to yoho-memory on cache replay', async () => {
        const { ctx, remembered } = createContext({
            memoryClientEnabled: true,
            cachedResult: {
                summary: '缓存摘要',
                topic: '缓存主题',
                tools: ['Read'],
                entities: ['deepseek.ts'],
                provider: null,
            },
            turnMessages: [
                message(10, {
                    role: 'user',
                    content: { type: 'text', text: '重放上次摘要结果' },
                }),
                message(11, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/deepseek.ts' } },
                                    { type: 'text', text: '缓存摘要已经足够用于本轮。' },
                                ],
                            },
                        },
                    },
                }),
            ],
        })

        await handleSummarizeTurn(payload, createJob({ id: 'job-cache-memory' }), ctx)

        expect(remembered).toHaveLength(0)
    })
})
