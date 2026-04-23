import type { SummarizeTurnPayload } from '../boss'
import { extractTurnContent, isMidStreamToolUse, isTurnStartUserMessage } from '../extract/messageExtractor'
import { enqueueSegmentIfNeeded } from './summarizeSegment'
import { PermanentLLMError, safeLLMCall } from '../llm/errors'
import { extractJobErrorCode, PermanentJobError, TransientJobError } from '../jobs/errors'
import type { WorkerJobMetadata } from '../jobs/core'
import type { DbMessage, L1SummaryRecord, ProviderTelemetry, WorkerContext } from '../types'

const TRIVIAL_ASSISTANT_CHAR_THRESHOLD = 200
const MAX_USER_TEXT_CHARS = 4_000
const MAX_ASSISTANT_TEXT_CHARS = 8_000
const OPERATIONAL_IMPORTANCE_PATTERNS: RegExp[] = [
    /\b(error|failed|failure|exception|timeout|blocked|blocker|fix|fixed|rollback|deploy|deployment|config|configuration|token|secret|key|env|systemd|healthz|readyz|stats|smoke|test|typecheck|queue|schema|worker|server|postgres|pg-boss|deepseek|max_connections|http\s*[45]\d\d)\b/i,
    /(失败|错误|异常|超时|阻塞|修正|修复|回滚|部署|配置|凭据|密钥|脱敏|队列|摘要|验证|测试|通过|健康检查|连接|权限|残留|风险|不兼容|误判)/,
]

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value
    }
    return `${value.slice(0, maxLength - 3)}...`
}

function asEpochMs(value: Date | null | undefined): number | null {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null
    }
    return value.getTime()
}

function hasOperationalImportance(input: { userText: string; assistantText: string; files: string[] }): boolean {
    if (input.files.length > 0) {
        return true
    }

    const text = `${input.userText}\n${input.assistantText}`
    return OPERATIONAL_IMPORTANCE_PATTERNS.some((pattern) => pattern.test(text))
}

function extractProviderTelemetry(error: unknown): ProviderTelemetry | null {
    const record = error as {
        provider?: string | null
        model?: string | null
        status?: number
        statusCode?: number
        requestId?: string | null
        finishReason?: string | null
        code?: string | null
    }
    const statusCode = typeof record?.statusCode === 'number'
        ? record.statusCode
        : typeof record?.status === 'number'
        ? record.status
        : null
    const provider = record?.provider ?? null
    const model = record?.model ?? null
    const requestId = record?.requestId ?? null
    const finishReason = record?.finishReason ?? null
    const errorCode = record?.code ?? null
    const hasProviderContext = provider != null
        || model != null
        || statusCode != null
        || requestId != null
        || finishReason != null

    if (!hasProviderContext) {
        return null
    }

    return {
        provider: provider ?? 'deepseek',
        model,
        statusCode,
        requestId,
        finishReason,
        errorCode,
    }
}

function buildRunMetadata(input: {
    payload: SummarizeTurnPayload
    sessionNamespace: string
    workerHost: string
    workerVersion: string
    queueSchema: string
    job: WorkerJobMetadata
    seqEnd?: number | null
    messageCount?: number
    realMessageCount?: number
    toolUseCount?: number
    fileCount?: number
    insertedSummary?: boolean
    cachedResult?: L1SummaryRecord
    cacheHit?: boolean | null
    provider?: ProviderTelemetry | null
    providerSkippedReason?: string | null
}): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
        job_family: input.job.family,
        job_name: input.job.name,
        job_version: input.job.version,
        idempotency_key: input.job.idempotencyKey,
        payload_namespace: input.payload.namespace,
        session_namespace: input.sessionNamespace,
        user_seq: input.payload.userSeq,
        seq_start: input.payload.userSeq,
        scheduled_at_ms: input.payload.scheduledAtMs,
        queue_name: input.job.queueName,
        queue_schema: input.queueSchema,
        worker_host: input.workerHost,
        worker_version: input.workerVersion,
    }

    if (input.seqEnd != null) {
        metadata.seq_end = input.seqEnd
    }
    if (typeof input.messageCount === 'number') {
        metadata.message_count = input.messageCount
    }
    if (typeof input.realMessageCount === 'number') {
        metadata.real_message_count = input.realMessageCount
    }
    if (typeof input.toolUseCount === 'number') {
        metadata.tool_use_count = input.toolUseCount
    }
    if (typeof input.fileCount === 'number') {
        metadata.file_count = input.fileCount
    }
    if (typeof input.insertedSummary === 'boolean') {
        metadata.inserted_summary = input.insertedSummary
    }
    if (typeof input.cacheHit === 'boolean') {
        metadata.cache_hit = input.cacheHit
    }
    if (typeof input.job.retryDelay === 'number') {
        metadata.retry_delay_seconds = input.job.retryDelay
    }
    if (typeof input.job.retryBackoff === 'boolean') {
        metadata.retry_backoff = input.job.retryBackoff
    }
    if (typeof input.job.retryDelayMax === 'number') {
        metadata.retry_delay_max_seconds = input.job.retryDelayMax
    }
    if (typeof input.job.singletonKey === 'string') {
        metadata.singleton_key = input.job.singletonKey
    }
    const jobCreatedOnMs = asEpochMs(input.job.createdOn)
    if (jobCreatedOnMs != null) {
        metadata.job_created_on_ms = jobCreatedOnMs
    }
    const jobStartedOnMs = asEpochMs(input.job.startedOn)
    if (jobStartedOnMs != null) {
        metadata.job_started_on_ms = jobStartedOnMs
    }
    if (input.provider) {
        metadata.provider = input.provider.provider
        if (input.provider.model != null) {
            metadata.provider_model = input.provider.model
        }
        if (input.provider.statusCode != null) {
            metadata.provider_status = input.provider.statusCode
        }
        if (input.provider.requestId != null) {
            metadata.provider_request_id = input.provider.requestId
        }
        if (input.provider.finishReason != null) {
            metadata.provider_finish_reason = input.provider.finishReason
        }
        if (input.provider.errorCode != null) {
            metadata.provider_error_code = input.provider.errorCode
        }
    }
    if (input.providerSkippedReason) {
        metadata.provider_skipped_reason = input.providerSkippedReason
    }
    if (input.cachedResult) {
        metadata.cached_result = input.cachedResult
    }

    return metadata
}

function getLastAssistantLikeMessage(messages: DbMessage[]): DbMessage | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        const record = message && typeof message.content === 'object'
            ? message.content as Record<string, unknown>
            : null
        if (!record) {
            continue
        }
        if (record.role === 'assistant') {
            return message
        }
        if (record.role === 'agent') {
            const inner = record.content && typeof record.content === 'object'
                ? record.content as Record<string, unknown>
                : null
            if (Array.isArray(record.content) || inner?.type === 'output') {
                return message
            }
        }
    }
    return null
}

export async function handleSummarizeTurn(
    payload: SummarizeTurnPayload,
    job: WorkerJobMetadata,
    ctx: WorkerContext
): Promise<void> {
    const startedAt = Date.now()
    let outcomeRecorded = false
    let sessionNamespace = payload.namespace
    let seqEnd: number | null = null
    let messageCount = 0
    let realMessageCount = 0
    let toolUseCount = 0
    let fileCount = 0
    let cacheHit: boolean | null = null
    let provider: ProviderTelemetry | null = null
    let providerSkippedReason: string | null = null

    const buildRunInput = (input: {
        status: 'success' | 'error_transient' | 'error_permanent' | 'skipped'
        durationMs: number
        tokensIn?: number | null
        tokensOut?: number | null
        errorCode?: string | null
        error?: string | null
        metadata?: Record<string, unknown> | null
    }): Parameters<typeof ctx.runStore.insert>[0] => ({
        sessionId: payload.sessionId,
        namespace: sessionNamespace,
        level: 1,
        jobId: job.id ?? null,
        jobName: job.name,
        jobFamily: job.family,
        jobVersion: job.version,
        idempotencyKey: job.idempotencyKey,
        status: input.status,
        durationMs: input.durationMs,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        workerHost: ctx.worker.host,
        workerVersion: ctx.worker.version,
        queueSchema: ctx.config.bossSchema,
        retryCount: typeof job.retryCount === 'number' ? job.retryCount : null,
        retryLimit: typeof job.retryLimit === 'number' ? job.retryLimit : null,
        cacheHit,
        providerName: provider?.provider ?? null,
        providerModel: provider?.model ?? null,
        providerStatus: provider?.statusCode ?? null,
        providerRequestId: provider?.requestId ?? null,
        providerFinishReason: provider?.finishReason ?? null,
        errorCode: input.errorCode ?? null,
        error: input.error ?? null,
        metadata: input.metadata ?? null,
    })

    const recordRun = async (input: Parameters<typeof ctx.runStore.insert>[0]): Promise<void> => {
        outcomeRecorded = true
        await ctx.runStore.insert(input)
    }

    const buildMetadata = (input: {
        insertedSummary?: boolean
        cachedResult?: L1SummaryRecord
    } = {}): Record<string, unknown> => buildRunMetadata({
        payload,
        sessionNamespace,
        workerHost: ctx.worker.host,
        workerVersion: ctx.worker.version,
        queueSchema: ctx.config.bossSchema,
        job,
        seqEnd,
        messageCount,
        realMessageCount,
        toolUseCount,
        fileCount,
        insertedSummary: input.insertedSummary,
        cachedResult: input.cachedResult,
        cacheHit,
        provider,
        providerSkippedReason,
    })

    try {
        const session = await ctx.sessionStore.getSessionSnapshot(payload.sessionId)
        if (!session) {
            providerSkippedReason = 'session_not_found'
            await recordRun(buildRunInput({
                status: 'error_permanent',
                durationMs: Date.now() - startedAt,
                errorCode: 'session_not_found',
                error: 'Session not found',
                metadata: buildMetadata(),
            }))
            return
        }

        sessionNamespace = session.namespace
        if (session.thinking) {
            providerSkippedReason = 'session_still_thinking'
            const error = new TransientJobError(
                'session_still_thinking',
                'Session still thinking — retry later'
            )
            await recordRun(buildRunInput({
                status: 'error_transient',
                durationMs: Date.now() - startedAt,
                errorCode: error.code,
                error: error.message,
                metadata: buildMetadata(),
            }))
            throw error
        }

        const messages = await ctx.sessionStore.getTurnMessages(payload.sessionId, payload.userSeq)
        messageCount = messages.length
        if (messages.length === 0) {
            providerSkippedReason = 'turn_start_not_found'
            throw new PermanentJobError(
                'turn_start_not_found',
                `Turn start seq ${payload.userSeq} not found`
            )
        }
        if (messages[0]?.seq !== payload.userSeq || !isTurnStartUserMessage(messages[0]?.content)) {
            providerSkippedReason = 'invalid_turn_start_message'
            throw new PermanentJobError(
                'invalid_turn_start_message',
                `Turn start seq ${payload.userSeq} is not a user text message`
            )
        }

        const lastRawMessage = messages[messages.length - 1]
        seqEnd = lastRawMessage?.seq ?? payload.userSeq
        const lastAssistantMessage = getLastAssistantLikeMessage(messages)
        if (lastAssistantMessage && isMidStreamToolUse(lastAssistantMessage.content)) {
            providerSkippedReason = 'turn_incomplete_mid_tool_use'
            const error = new TransientJobError(
                'turn_incomplete_mid_tool_use',
                'Turn appears incomplete (last assistant-like message is tool_use) — retry later'
            )
            await recordRun(buildRunInput({
                status: 'error_transient',
                durationMs: Date.now() - startedAt,
                errorCode: error.code,
                error: error.message,
                metadata: buildMetadata(),
            }))
            throw error
        }

        const extracted = extractTurnContent(messages)
        realMessageCount = extracted.realMessageCount
        toolUseCount = extracted.toolUses.length
        fileCount = extracted.files.length

        if (realMessageCount < 2) {
            providerSkippedReason = 'insufficient_real_messages'
            await recordRun(buildRunInput({
                status: 'skipped',
                durationMs: Date.now() - startedAt,
                errorCode: 'insufficient_real_messages',
                error: 'Turn has fewer than 2 real activity messages',
                metadata: buildMetadata(),
            }))
            return
        }

        const isShortNoToolTurn = extracted.assistantText.length < TRIVIAL_ASSISTANT_CHAR_THRESHOLD && extracted.toolUses.length === 0
        if (isShortNoToolTurn && !hasOperationalImportance({
            userText: extracted.userText,
            assistantText: extracted.assistantText,
            files: extracted.files,
        })) {
            providerSkippedReason = 'trivial_turn'
            await recordRun(buildRunInput({
                status: 'skipped',
                durationMs: Date.now() - startedAt,
                errorCode: 'trivial_turn',
                error: 'trivial turn (assistantText < 200 chars, no tool_use)',
                metadata: buildMetadata(),
            }))
            return
        }

        const cachedResult = await ctx.runStore.getLatestCachedL1Result(
            payload.sessionId,
            payload.userSeq,
            job.name,
            job.version
        )
        cacheHit = cachedResult !== null
        providerSkippedReason = cacheHit ? 'cache_hit' : null

        const llmResult = cachedResult
            ? {
                ...cachedResult,
                tokensIn: null,
                tokensOut: null,
                rawResponse: JSON.stringify(cachedResult),
                provider: cachedResult.provider ?? {
                    provider: 'deepseek',
                    model: ctx.config.deepseek.model,
                    statusCode: null,
                    requestId: null,
                    finishReason: null,
                    errorCode: null,
                },
            }
            : await safeLLMCall(() => ctx.deepseekClient.summarizeTurn({
                userText: truncate(extracted.userText, MAX_USER_TEXT_CHARS),
                assistantText: truncate(extracted.assistantText, MAX_ASSISTANT_TEXT_CHARS),
                toolUses: extracted.toolUses,
                files: extracted.files,
            }))
        provider = llmResult.provider

        const summaryMetadata: Record<string, unknown> = {
            topic: llmResult.topic,
            tools: llmResult.tools,
            files: extracted.files,
            skill_refs: extracted.skillRefs,
            entities: llmResult.entities,
            user_seq: payload.userSeq,
            scheduled_at_ms: payload.scheduledAtMs,
            message_count: messageCount,
            real_message_count: realMessageCount,
            cache_hit: cacheHit,
            provider: llmResult.provider.provider,
            provider_model: llmResult.provider.model,
            provider_status: llmResult.provider.statusCode,
            provider_request_id: llmResult.provider.requestId,
            provider_finish_reason: llmResult.provider.finishReason,
        }
        if (cacheHit) {
            summaryMetadata.provider_replayed_from_cache = true
        }

        try {
            const inserted = await ctx.summaryStore.insertL1({
                sessionId: payload.sessionId,
                namespace: sessionNamespace,
                seqStart: payload.userSeq,
                seqEnd: seqEnd ?? payload.userSeq,
                summary: llmResult.summary,
                metadata: summaryMetadata,
            })

            await recordRun(buildRunInput({
                status: 'success',
                durationMs: Date.now() - startedAt,
                tokensIn: llmResult.tokensIn,
                tokensOut: llmResult.tokensOut,
                metadata: buildMetadata({
                    insertedSummary: inserted.inserted,
                }),
            }))

            // Trigger L2 segment summarization if enough unassigned L1s have accumulated
            enqueueSegmentIfNeeded(
                payload.sessionId,
                sessionNamespace,
                ctx,
                ctx.config.l2SegmentThreshold
            ).catch(err => {
                console.error(`[summarizeTurn] failed to enqueue segment for session ${payload.sessionId}:`, err)
            })

            return
        } catch (error) {
            const transientError = error as Error
            await recordRun(buildRunInput({
                status: 'error_transient',
                durationMs: Date.now() - startedAt,
                tokensIn: llmResult.tokensIn,
                tokensOut: llmResult.tokensOut,
                errorCode: extractJobErrorCode(error),
                error: transientError.message,
                metadata: buildMetadata({
                    cachedResult: {
                        summary: llmResult.summary,
                        topic: llmResult.topic,
                        tools: llmResult.tools,
                        entities: llmResult.entities,
                        provider: llmResult.provider,
                    },
                }),
            }))
            throw transientError
        }
    } catch (error) {
        provider = provider ?? extractProviderTelemetry(error)
        const errorCode = extractJobErrorCode(error)
        if (!provider && error instanceof PermanentLLMError) {
            provider = {
                provider: 'deepseek',
                model: ctx.config.deepseek.model,
                statusCode: error.statusCode ?? null,
                requestId: error.requestId ?? null,
                finishReason: error.finishReason ?? null,
                errorCode: error.code ?? null,
            }
        }

        if (error instanceof PermanentLLMError || error instanceof PermanentJobError) {
            if (!outcomeRecorded) {
                await ctx.runStore.insert(buildRunInput({
                    status: 'error_permanent',
                    durationMs: Date.now() - startedAt,
                    errorCode,
                    error: error.message,
                    metadata: buildMetadata(),
                }))
            }
            return
        }

        if (!outcomeRecorded) {
            await ctx.runStore.insert(buildRunInput({
                status: 'error_transient',
                durationMs: Date.now() - startedAt,
                errorCode,
                error: (error as Error).message,
                metadata: buildMetadata(),
            })).catch(() => {})
        }
        throw error
    }
}
