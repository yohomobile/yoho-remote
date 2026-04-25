import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { L1SummaryRecord } from '../types'

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return []
    }
    return value.filter((item): item is string => typeof item === 'string')
}

export type InsertRunInput = {
    sessionId: string
    namespace: string
    level: 1 | 2 | 3
    jobId?: string | null
    jobName?: string | null
    jobFamily?: string | null
    jobVersion?: number | null
    idempotencyKey?: string | null
    status: 'success' | 'error_transient' | 'error_permanent' | 'skipped'
    durationMs?: number | null
    tokensIn?: number | null
    tokensOut?: number | null
    workerHost?: string | null
    workerVersion?: string | null
    queueSchema?: string | null
    retryCount?: number | null
    retryLimit?: number | null
    cacheHit?: boolean | null
    providerName?: string | null
    providerModel?: string | null
    providerStatus?: number | null
    providerRequestId?: string | null
    providerFinishReason?: string | null
    errorCode?: string | null
    error?: string | null
    metadata?: Record<string, unknown> | null
}

export class RunStore {
    constructor(private readonly pool: Pool) {}

    async insert(input: InsertRunInput): Promise<void> {
        await this.pool.query(
            `INSERT INTO summarization_runs (
                id, session_id, namespace, level, job_id, job_name, job_family, job_version, idempotency_key, status,
                duration_ms, tokens_in, tokens_out,
                worker_host, worker_version, queue_schema,
                retry_count, retry_limit, cache_hit,
                provider_name, provider_model, provider_status, provider_request_id, provider_finish_reason,
                error_code, error, metadata, created_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13,
                $14, $15, $16,
                $17, $18, $19,
                $20, $21, $22, $23, $24,
                $25, $26, $27, $28
            )`,
            [
                randomUUID(),
                input.sessionId,
                input.namespace,
                input.level,
                input.jobId ?? null,
                input.jobName ?? null,
                input.jobFamily ?? null,
                input.jobVersion ?? null,
                input.idempotencyKey ?? null,
                input.status,
                input.durationMs ?? null,
                input.tokensIn ?? null,
                input.tokensOut ?? null,
                input.workerHost ?? null,
                input.workerVersion ?? null,
                input.queueSchema ?? null,
                input.retryCount ?? null,
                input.retryLimit ?? null,
                input.cacheHit ?? null,
                input.providerName ?? null,
                input.providerModel ?? null,
                input.providerStatus ?? null,
                input.providerRequestId ?? null,
                input.providerFinishReason ?? null,
                input.errorCode ?? null,
                input.error ?? null,
                input.metadata ?? null,
                Date.now(),
            ]
        )
    }

    async getLatestCachedL1Result(
        orgId: string,
        sessionId: string,
        seqStart: number,
        jobName: string,
        jobVersion: number
    ): Promise<L1SummaryRecord | null> {
        const result = await this.pool.query(
            `SELECT metadata
             FROM summarization_runs
             WHERE namespace = $1
               AND session_id = $2
               AND level = 1
               AND job_name = $4
               AND job_version = $5
               AND status = 'error_transient'
               AND metadata->>'seq_start' = $3
               AND metadata ? 'cached_result'
             ORDER BY created_at DESC
             LIMIT 1`,
            [orgId, sessionId, String(seqStart), jobName, jobVersion]
        )

        const metadata = asRecord(result.rows[0]?.metadata)
        const cached = asRecord(metadata?.cached_result)
        const cachedProvider = asRecord(cached?.provider)
        const summary = asString(cached?.summary)
        const topic = asString(cached?.topic)
        if (!summary || !topic) {
            return null
        }

        return {
            summary,
            topic,
            tools: asStringArray(cached?.tools),
            entities: asStringArray(cached?.entities),
            provider: cachedProvider
                ? {
                    provider: asString(cachedProvider.provider) ?? 'deepseek',
                    model: asString(cachedProvider.model),
                    statusCode: typeof cachedProvider.statusCode === 'number'
                        ? cachedProvider.statusCode
                        : null,
                    requestId: asString(cachedProvider.requestId),
                    finishReason: asString(cachedProvider.finishReason),
                    errorCode: asString(cachedProvider.errorCode),
                }
                : null,
        }
    }

    async pruneOlderThan(cutoffMs: number): Promise<number> {
        const result = await this.pool.query(
            'DELETE FROM summarization_runs WHERE created_at < $1',
            [cutoffMs]
        )
        return result.rowCount ?? 0
    }
}
