import { QUEUE, type SummarizeSessionPayload } from '../boss'
import { PermanentLLMError, safeLLMCall } from '../llm/errors'
import { extractJobErrorCode, PermanentJobError } from '../jobs/errors'
import type { WorkerJobMetadata } from '../jobs/core'
import {
    buildSkillTags,
    composeMemoryProposalInput,
    isValuableForL3Skill,
} from '../infra/yohoMemory'
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
    let sessionOrgId = payload.orgId

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
        if (!session.orgId || session.orgId !== payload.orgId) {
            await recordRun({
                status: 'error_permanent',
                durationMs: Date.now() - startedAt,
                errorCode: 'session_org_mismatch',
                error: 'Session orgId missing or does not match job payload',
            })
            return
        }
        sessionOrgId = session.orgId

        // Readiness check: if session is still active/thinking, the last L1 job
        // may not have finished yet.  Re-enqueue with a longer delay and skip.
        if (session.thinking) {
            const singletonKey = `session:${sessionOrgId}:${payload.sessionId}`
            await ctx.boss.send(
                QUEUE.SUMMARIZE_SESSION,
                {
                    version: 1 as const,
                    idempotencyKey: singletonKey,
                    payload: { ...payload, orgId: sessionOrgId, namespace: sessionNamespace, scheduledAtMs: Date.now() },
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
        const l2Summaries = await ctx.summaryStore.getSegmentSummaries(sessionOrgId, payload.sessionId)
        let sourceLevel: 1 | 2
        let sourceSummaries: Array<StoredL1Summary | StoredL2Summary>
        let orphanL1Count = 0

        if (l2Summaries.length > 0) {
            const orphanL1s = await ctx.summaryStore.getUnassignedL1Summaries(sessionOrgId, payload.sessionId)
            orphanL1Count = orphanL1s.length
            if (orphanL1Count >= ctx.config.l2SegmentThreshold) {
                const singletonKey = `segment:${sessionOrgId}:${payload.sessionId}:l3-defer:${Math.floor(orphanL1Count / ctx.config.l2SegmentThreshold)}`
                await ctx.boss.send(
                    QUEUE.SUMMARIZE_SEGMENT,
                    {
                        version: 1 as const,
                        idempotencyKey: singletonKey,
                        payload: { sessionId: payload.sessionId, orgId: sessionOrgId, namespace: sessionNamespace, scheduledAtMs: Date.now() },
                    },
                    { singletonKey }
                )
                await ctx.boss.send(
                    QUEUE.SUMMARIZE_SESSION,
                    {
                        version: 1 as const,
                        idempotencyKey: `session:${sessionOrgId}:${payload.sessionId}`,
                        payload: { sessionId: payload.sessionId, orgId: sessionOrgId, namespace: sessionNamespace, scheduledAtMs: Date.now() },
                    },
                    { singletonKey: `session:${sessionOrgId}:${payload.sessionId}`, startAfter: DEFER_WHEN_ACTIVE_SECONDS }
                )
                await recordRun({
                    status: 'skipped',
                    durationMs: Date.now() - startedAt,
                    errorCode: 'pending_l2_segments',
                    error: `Deferred L3 because ${orphanL1Count} orphan L1 summaries should be segmented first`,
                    metadata: { orphan_l1_count: orphanL1Count, threshold: ctx.config.l2SegmentThreshold },
                })
                return
            }
            // Merge and sort chronologically
            const merged: Array<StoredL1Summary | StoredL2Summary> = [...l2Summaries, ...orphanL1s]
            merged.sort((a, b) => (a.seqStart ?? Infinity) - (b.seqStart ?? Infinity))
            sourceSummaries = merged
            sourceLevel = 2
        } else {
            // No L2s yet: fall back to all L1 turn summaries
            sourceSummaries = await ctx.summaryStore.getTurnSummaries(sessionOrgId, payload.sessionId)
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
            const trivialSummary = sourceSummaries
                .map((summary, index) => `${index + 1}. ${summary.summary}`)
                .join('\n')
            try {
                const upserted = await ctx.summaryStore.upsertL3({
                    sessionId: payload.sessionId,
                    namespace: sessionNamespace,
                    orgId: sessionOrgId,
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
            memory_proposal_action: llmResult.memory.action,
            skill_proposal_action: llmResult.skill.action,
        }

        try {
            const upserted = await ctx.summaryStore.upsertL3({
                sessionId: payload.sessionId,
                namespace: sessionNamespace,
                orgId: sessionOrgId,
                summary: llmResult.summary,
                metadata: summaryMetadata,
            })
            const sourceIds = sourceSummaries.map(s => s.id)
            if (
                ctx.memoryClient
                && ctx.config.yohoMemory?.writeL3
                && llmResult.memory.action === 'remember'
                && llmResult.memory.text != null
            ) {
                void ctx.memoryClient.remember({
                    input: composeMemoryProposalInput({
                        sourceLevel: 'L3',
                        sessionId: payload.sessionId,
                        namespace: sessionNamespace,
                        topic: llmResult.topic,
                        text: llmResult.memory.text,
                        tools: llmResult.tools,
                        entities: llmResult.entities,
                        sourceIds,
                    }),
                    source: 'automation',
                    approvedForLongTerm: false,
                    idempotencyKey: `yoho-remote:memory:L3:${upserted.id}`,
                }).catch(() => {})
            }
            const skillProposal = llmResult.skill
            if (
                ctx.memoryClient
                && ctx.config.yohoMemory?.saveSkillFromL3
                && skillProposal.action === 'save'
                && skillProposal.name != null
                && skillProposal.content != null
                && isValuableForL3Skill({
                    topic: llmResult.topic,
                    tools: llmResult.tools,
                    sourceCount: sourceSummaries.length,
                })
            ) {
                void ctx.memoryClient.saveSkill({
                    name: skillProposal.name,
                    category: '工程',
                    description: skillProposal.description ?? skillProposal.name,
                    content: skillProposal.content,
                    tags: skillProposal.tags.length > 0
                        ? skillProposal.tags
                        : buildSkillTags(llmResult.tools, llmResult.entities),
                    requiredTools: skillProposal.requiredTools.length > 0
                        ? skillProposal.requiredTools
                        : llmResult.tools,
                    antiTriggers: skillProposal.antiTriggers,
                    activationMode: 'manual',
                    idempotencyKey: `yoho-remote:skill:L3:${upserted.id}`,
                }).catch(() => {})
            }

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
