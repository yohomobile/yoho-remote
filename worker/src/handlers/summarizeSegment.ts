import type { SummarizeSegmentPayload } from '../boss'
import { QUEUE } from '../boss'
import { PermanentLLMError, safeLLMCall } from '../llm/errors'
import { extractJobErrorCode, PermanentJobError, TransientJobError } from '../jobs/errors'
import type { WorkerJobMetadata } from '../jobs/core'
import {
    buildSkillTags,
    composeMemoryProposalInput,
    isValuableForL2Skill,
} from '../infra/yohoMemory'
import type { WorkerContext } from '../types'

const L1_CLAIM_TTL_MS = 10 * 60 * 1000

export async function handleSummarizeSegment(
    payload: SummarizeSegmentPayload,
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
            orgId: sessionOrgId,
            level: 2,
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

        const threshold = ctx.config.l2SegmentThreshold
        const claimed = await ctx.summaryStore.claimUnassignedL1ForSegment(
            sessionOrgId,
            payload.sessionId,
            threshold,
            L1_CLAIM_TTL_MS
        )
        const l1Summaries = claimed.summaries
        if (l1Summaries.length < threshold) {
            await ctx.summaryStore.releaseL1Claim(sessionOrgId, claimed.batchId)
            await recordRun({
                status: 'skipped',
                durationMs: Date.now() - startedAt,
                errorCode: 'insufficient_l1_summaries',
                error: `Only ${l1Summaries.length} claimable L1(s); need >= ${threshold}`,
                metadata: { l1_count: l1Summaries.length, threshold, segment_batch_id: claimed.batchId },
            })
            return
        }

        try {

        const seqStart = l1Summaries[0]?.seqStart ?? null
        const seqEnd = l1Summaries[l1Summaries.length - 1]?.seqEnd ?? null

        const sources = l1Summaries.map(s => ({
            id: s.id,
            level: 1 as const,
            seqStart: s.seqStart,
            seqEnd: s.seqEnd,
        }))
        const llmInput = l1Summaries.map(s => ({ summary: s.summary, topic: s.topic }))
        const llmResult = await safeLLMCall(() => ctx.deepseekClient.summarizeSegment(llmInput))

        const summaryMetadata: Record<string, unknown> = {
            topic: llmResult.topic,
            tools: llmResult.tools,
            entities: llmResult.entities,
            l1_count: l1Summaries.length,
            l1_ids: l1Summaries.map(s => s.id),
            segment_batch_id: claimed.batchId,
            sources,
            scheduled_at_ms: payload.scheduledAtMs,
            provider: llmResult.provider.provider,
            provider_model: llmResult.provider.model,
            provider_status: llmResult.provider.statusCode,
            memory_proposal_action: llmResult.memory.action,
            skill_proposal_action: llmResult.skill.action,
        }

        try {
            const l1Ids = l1Summaries.map(s => s.id)
            const { id: l2Id } = await ctx.summaryStore.insertL2AndMarkClaimedL1s(
                {
                    sessionId: payload.sessionId,
                    namespace: sessionNamespace,
                    orgId: sessionOrgId,
                    seqStart,
                    seqEnd,
                    summary: llmResult.summary,
                    metadata: summaryMetadata,
                    batchId: claimed.batchId,
                },
                l1Ids
            )
            if (
                ctx.memoryClient
                && ctx.config.yohoMemory?.writeL2
                && llmResult.memory.action === 'remember'
                && llmResult.memory.text != null
            ) {
                void ctx.memoryClient.remember({
                    input: composeMemoryProposalInput({
                        sourceLevel: 'L2',
                        sessionId: payload.sessionId,
                        namespace: sessionNamespace,
                        topic: llmResult.topic,
                        text: llmResult.memory.text,
                        tools: llmResult.tools,
                        entities: llmResult.entities,
                        sourceIds: l1Ids,
                    }),
                    source: 'automation',
                    approvedForLongTerm: false,
                    idempotencyKey: `yoho-remote:memory:L2:${l2Id}`,
                }).catch(() => {})
            }
            const skillProposal = llmResult.skill
            if (
                ctx.memoryClient
                && ctx.config.yohoMemory?.saveSkillFromL2
                && skillProposal.action === 'save'
                && skillProposal.name != null
                && skillProposal.content != null
                && isValuableForL2Skill({
                    topic: llmResult.topic,
                    tools: llmResult.tools,
                    l1Count: l1Summaries.length,
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
                    idempotencyKey: `yoho-remote:skill:L2:${l2Id}`,
                }).catch(() => {})
            }

            await recordRun({
                status: 'success',
                durationMs: Date.now() - startedAt,
                tokensIn: llmResult.tokensIn,
                tokensOut: llmResult.tokensOut,
                metadata: {
                    l1_count: l1Summaries.length,
                    l2_id: l2Id,
                    seq_start: seqStart,
                    seq_end: seqEnd,
                    segment_batch_id: claimed.batchId,
                    sources,
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
                metadata: {
                    l1_count: l1Summaries.length,
                    cached_summary: llmResult.summary,
                    segment_batch_id: claimed.batchId,
                    sources,
                },
            })
            throw transientError
        }
        } catch (error) {
            await ctx.summaryStore.releaseL1Claim(sessionOrgId, claimed.batchId)
            throw error
        }
    } catch (error) {
        if (error instanceof PermanentLLMError || error instanceof PermanentJobError) {
            if (!outcomeRecorded) {
                await ctx.runStore.insert({
                    sessionId: payload.sessionId,
                    namespace: sessionNamespace,
                    orgId: sessionOrgId,
                    level: 2,
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
                orgId: sessionOrgId,
                level: 2,
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

export async function enqueueSegmentIfNeeded(
    sessionId: string,
    namespace: string,
    orgId: string,
    ctx: WorkerContext,
    threshold = 5,
): Promise<void> {
    const count = await ctx.summaryStore.countUnassignedL1(orgId, sessionId)
    if (count < threshold) return

    const singletonKey = `segment:${orgId}:${sessionId}:${Math.floor(count / threshold)}`
    await ctx.boss.send(
        QUEUE.SUMMARIZE_SEGMENT,
        {
            version: 1 as const,
            idempotencyKey: singletonKey,
            payload: { sessionId, orgId, namespace, scheduledAtMs: Date.now() },
        },
        { singletonKey }
    )
}
