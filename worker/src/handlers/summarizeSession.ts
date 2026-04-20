import { QUEUE, type SummarizeSessionPayload } from '../boss'
import { PermanentLLMError, safeLLMCall } from '../llm/errors'
import { extractJobErrorCode, PermanentJobError } from '../jobs/errors'
import type { WorkerJobMetadata } from '../jobs/core'
import type { StoredL1Summary, StoredL2Summary } from '../types'
import type { WorkerContext } from '../types'

// Sessions with fewer than this many turns (L1-only path) are trivial:
// write a minimal L3 without calling the LLM.
const TRIVIAL_TURN_THRESHOLD = 6

// How long to defer L3 (seconds) when the session is still thinking.
const DEFER_WHEN_ACTIVE_SECONDS = 60

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

        // Readiness check: if session is still active/thinking, the last L1 job
        // may not have finished yet.  Re-enqueue with a longer delay and skip.
        if (session.thinking) {
            const singletonKey = `session:${payload.sessionId}`
            await ctx.boss.send(
                QUEUE.SUMMARIZE_SESSION,
                {
                    version: 1 as const,
                    idempotencyKey: singletonKey,
                    payload: { ...payload, scheduledAtMs: Date.now() },
                },
                { singletonKey, startAfter: DEFER_WHEN_ACTIVE_SECONDS }
            )
            await recordRun({
                status: 'skipped',
                durationMs: Date.now() - startedAt,
                errorCode: 'session_still_active',
                error: `Session is still thinking; L3 deferred ${DEFER_WHEN_ACTIVE_SECONDS}s`,
            })
            return
        }

        // Build the merged source list: all L2 segments ∪ orphan L1s (parent_id IS NULL).
        // This ensures the last few turns that haven't been rolled into a segment yet
        // are still included in L3.
        const l2Summaries = await ctx.summaryStore.getSegmentSummaries(payload.sessionId)
        let sourceLevel: 1 | 2
        let sourceSummaries: Array<StoredL1Summary | StoredL2Summary>
        let orphanL1Count = 0

        if (l2Summaries.length > 0) {
            const orphanL1s = await ctx.summaryStore.getUnassignedL1Summaries(payload.sessionId)
            orphanL1Count = orphanL1s.length
            // Merge and sort chronologically
            const merged: Array<StoredL1Summary | StoredL2Summary> = [...l2Summaries, ...orphanL1s]
            merged.sort((a, b) => (a.seqStart ?? Infinity) - (b.seqStart ?? Infinity))
            sourceSummaries = merged
            sourceLevel = 2
        } else {
            // No L2s yet: fall back to all L1 turn summaries
            sourceSummaries = await ctx.summaryStore.getTurnSummaries(payload.sessionId)
            sourceLevel = 1
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

        // Trivial path: very short pure-L1 sessions don't warrant an LLM call.
        // Write a minimal L3 summary locally and return.
        const isTrivial = sourceLevel === 1 && sourceSummaries.length < TRIVIAL_TURN_THRESHOLD
        if (isTrivial) {
            const trivialSummary = `Short session (${sourceSummaries.length} turn${sourceSummaries.length === 1 ? '' : 's'}).`
            try {
                const upserted = await ctx.summaryStore.upsertL3({
                    sessionId: payload.sessionId,
                    namespace: sessionNamespace,
                    summary: trivialSummary,
                    metadata: {
                        source_level: 1,
                        source_count: sourceSummaries.length,
                        trivial: true,
                        scheduled_at_ms: payload.scheduledAtMs,
                    },
                })
                await recordRun({
                    status: 'success',
                    durationMs: Date.now() - startedAt,
                    metadata: { l3_id: upserted.id, source_level: 1, source_count: sourceSummaries.length, trivial: true },
                })
            } catch (error) {
                const transientError = error as Error
                await recordRun({
                    status: 'error_transient',
                    durationMs: Date.now() - startedAt,
                    errorCode: extractJobErrorCode(error),
                    error: transientError.message,
                    metadata: { source_level: 1, source_count: sourceSummaries.length, trivial: true },
                })
                throw transientError
            }
            return
        }

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
            orphan_l1_count: orphanL1Count,
            trivial: false,
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
                    orphan_l1_count: orphanL1Count,
                    trivial: false,
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
