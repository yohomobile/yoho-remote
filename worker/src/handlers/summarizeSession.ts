import type { SummarizeSessionPayload } from '../boss'
import { PermanentLLMError, safeLLMCall } from '../llm/errors'
import { extractJobErrorCode, PermanentJobError } from '../jobs/errors'
import type { WorkerJobMetadata } from '../jobs/core'
import type { WorkerContext } from '../types'

const TRIVIAL_SUMMARY_THRESHOLD = 6

export async function handleSummarizeSession(
    payload: SummarizeSessionPayload,
    job: WorkerJobMetadata,
    ctx: WorkerContext
): Promise<void> {
    const startedAt = Date.now()
    let outcomeRecorded = false
    let sessionNamespace = payload.namespace

    const recordRun = async (input: {
        status: 'success' | 'error_transient' | 'error_permanent' | 'skipped'
        durationMs: number
        tokensIn?: number | null
        tokensOut?: number | null
        errorCode?: string | null
        error?: string | null
        metadata?: Record<string, unknown> | null
    }): Promise<void> => {
        outcomeRecorded = true
        await ctx.runStore.insert({
            sessionId: payload.sessionId,
            namespace: sessionNamespace,
            level: 3,
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
            errorCode: input.errorCode ?? null,
            error: input.error ?? null,
            metadata: input.metadata ?? null,
        })
    }

    try {
        const session = await ctx.sessionStore.getSessionSnapshot(payload.sessionId)
        if (!session) {
            await recordRun({
                status: 'error_permanent',
                durationMs: Date.now() - startedAt,
                errorCode: 'session_not_found',
                error: 'Session not found',
            })
            return
        }
        sessionNamespace = session.namespace

        // Try L2 segments first; fallback to L1 turns
        let sourceLevel: 1 | 2 = 2
        let sourceSummaries = await ctx.summaryStore.getSegmentSummaries(payload.sessionId)
        if (sourceSummaries.length === 0) {
            sourceLevel = 1
            sourceSummaries = await ctx.summaryStore.getTurnSummaries(payload.sessionId)
        }

        if (sourceSummaries.length === 0) {
            await recordRun({
                status: 'skipped',
                durationMs: Date.now() - startedAt,
                errorCode: 'no_source_summaries',
                error: 'No L1 or L2 summaries found for this session',
                metadata: { source_level: sourceLevel },
            })
            return
        }

        const isTrivial = sourceSummaries.length < TRIVIAL_SUMMARY_THRESHOLD && sourceLevel === 1

        const llmInput = sourceSummaries.map(s => ({ summary: s.summary, topic: s.topic }))
        const llmResult = await safeLLMCall(() =>
            ctx.deepseekClient.summarizeSession(llmInput, sourceLevel)
        )

        const summaryMetadata: Record<string, unknown> = {
            topic: llmResult.topic,
            tools: llmResult.tools,
            entities: llmResult.entities,
            source_level: sourceLevel,
            source_count: sourceSummaries.length,
            trivial: isTrivial,
            scheduled_at_ms: payload.scheduledAtMs,
            provider: llmResult.provider.provider,
            provider_model: llmResult.provider.model,
            provider_status: llmResult.provider.statusCode,
        }

        try {
            const upserted = await ctx.summaryStore.upsertL3({
                sessionId: payload.sessionId,
                namespace: sessionNamespace,
                summary: llmResult.summary,
                metadata: summaryMetadata,
            })

            await recordRun({
                status: 'success',
                durationMs: Date.now() - startedAt,
                tokensIn: llmResult.tokensIn,
                tokensOut: llmResult.tokensOut,
                metadata: {
                    l3_id: upserted.id,
                    source_level: sourceLevel,
                    source_count: sourceSummaries.length,
                    trivial: isTrivial,
                },
            })
        } catch (error) {
            const transientError = error as Error
            await recordRun({
                status: 'error_transient',
                durationMs: Date.now() - startedAt,
                tokensIn: llmResult.tokensIn,
                tokensOut: llmResult.tokensOut,
                errorCode: extractJobErrorCode(error),
                error: transientError.message,
                metadata: { source_level: sourceLevel, source_count: sourceSummaries.length },
            })
            throw transientError
        }
    } catch (error) {
        if (error instanceof PermanentLLMError || error instanceof PermanentJobError) {
            if (!outcomeRecorded) {
                await ctx.runStore.insert({
                    sessionId: payload.sessionId,
                    namespace: sessionNamespace,
                    level: 3,
                    jobId: job.id ?? null,
                    jobName: job.name,
                    jobFamily: job.family,
                    jobVersion: job.version,
                    idempotencyKey: job.idempotencyKey,
                    status: 'error_permanent',
                    durationMs: Date.now() - startedAt,
                    errorCode: extractJobErrorCode(error),
                    error: (error as Error).message,
                })
            }
            return
        }

        if (!outcomeRecorded) {
            await ctx.runStore.insert({
                sessionId: payload.sessionId,
                namespace: sessionNamespace,
                level: 3,
                jobId: job.id ?? null,
                jobName: job.name,
                jobFamily: job.family,
                jobVersion: job.version,
                idempotencyKey: job.idempotencyKey,
                status: 'error_transient',
                durationMs: Date.now() - startedAt,
                errorCode: extractJobErrorCode(error),
                error: (error as Error).message,
            }).catch(() => {})
        }
        throw error
    }
}
