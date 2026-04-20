/**
 * Phase 1 Worker L1/L2/L3 Pipeline — End-to-End Integration Tests
 *
 * Uses real PostgreSQL (yoho_remote) + mock DeepSeek LLM.
 * Each test case gets an isolated session_id so they never collide.
 * All inserted rows are cleaned up in afterAll.
 *
 * Scenarios covered:
 *  1. Schema: ensureWorkerSchema creates session_summaries + summarization_runs
 *  2. Server initSchema equivalent (same DDL applied idempotently)
 *  3. L1 turn summarization (normal path)
 *  3b. Trivial turn skip (< 200 chars assistantText, no tools)
 *  4. L2 segment: 5+ unassigned L1s → enqueue segment → handleSummarizeSegment
 *  5. L3 session: handleSummarizeSession from L2 sources
 *  6. Full pipeline: all 3 levels in session_summaries + summarization_runs
 *  7. Catch-up: orphaned L1s (> 10 min old) found by scan → L2 enqueued
 *  8. Idempotency: duplicate L1 insert deduped by DB unique index;
 *                  duplicate enqueueSegmentIfNeeded uses same singletonKey
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { QUEUE } from '../../src/boss'
import { RunStore } from '../../src/db/runStore'
import { ensureWorkerSchema } from '../../src/db/schema'
import { SessionStore } from '../../src/db/sessionStore'
import { SummaryStore } from '../../src/db/summaryStore'
import { enqueueSegmentIfNeeded, handleSummarizeSegment } from '../../src/handlers/summarizeSegment'
import { handleSummarizeSession } from '../../src/handlers/summarizeSession'
import { handleSummarizeTurn } from '../../src/handlers/summarizeTurn'
import type { WorkerJobMetadata } from '../../src/jobs/core'
import type { WorkerContext } from '../../src/types'

// ---------------------------------------------------------------------------
// DB credentials
// ---------------------------------------------------------------------------
const DB_CONFIG = {
    host: '101.100.174.21',
    port: 5432,
    user: 'guang',
    password: 'Root,./000000',
    database: 'yoho_remote',
    ssl: false as const,
}

const TEST_NAMESPACE = 'test-e2e-ns'

let pool: Pool
let summaryStore: SummaryStore
let runStore: RunStore
let sessionStore: SessionStore

/** All test session IDs — deleted in afterAll */
const createdSessionIds: string[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newSessionId(label: string): string {
    const id = `test-e2e-${label}-${randomUUID()}`
    createdSessionIds.push(id)
    return id
}

async function insertSession(id: string, namespace = TEST_NAMESPACE): Promise<void> {
    const now = Date.now()
    await pool.query(
        `INSERT INTO sessions (id, namespace, created_at, updated_at, thinking)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT (id) DO NOTHING`,
        [id, namespace, now, now],
    )
}

async function insertMessage(
    sessionId: string,
    seq: number,
    content: unknown,
    createdAt = Date.now(),
): Promise<void> {
    await pool.query(
        `INSERT INTO messages (id, session_id, seq, content, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (id) DO NOTHING`,
        [randomUUID(), sessionId, seq, JSON.stringify(content), createdAt],
    )
}

/** Insert a turn: user turn-start at userSeq, agent response at userSeq+1 */
async function insertSubstantialTurn(sessionId: string, userSeq: number): Promise<void> {
    await insertMessage(sessionId, userSeq, {
        role: 'user',
        content: { type: 'text', text: '请检查 deepseek.ts 配置并确认摘要字段正确' },
    })
    await insertMessage(sessionId, userSeq + 1, {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: `toolu_${userSeq}`,
                            name: 'Read',
                            input: { file_path: '/home/workspaces/repos/yoho-remote/worker/src/llm/deepseek.ts' },
                        },
                        {
                            type: 'text',
                            text: '我已经检查了 deepseek.ts 的完整配置。摘要字段已经正确设置，包括 summary、topic、tools 和 entities 四个必填字段。'
                                + '验证逻辑使用 Zod schema 确保返回格式符合预期。L1/L2/L3 三层都有对应的 schema 验证。'
                                + '配置完全正确，无需修改。',
                        },
                    ],
                },
            },
        },
    })
}

/** Insert a trivial turn: user + assistant with < 200 chars, no tools */
async function insertTrivialTurn(sessionId: string, userSeq: number): Promise<void> {
    await insertMessage(sessionId, userSeq, {
        role: 'user',
        content: { type: 'text', text: '继续' },
    })
    await insertMessage(sessionId, userSeq + 1, {
        role: 'assistant',
        content: '好的',
    })
}

// ---------------------------------------------------------------------------
// Mock LLM client
// ---------------------------------------------------------------------------

function makeMockLLM() {
    return {
        summarizeTurn: async () => ({
            summary: 'L1 摘要：用户请求检查 deepseek.ts 配置，assistant 使用 Read 工具读取文件后确认配置正确。',
            topic: 'DeepSeek 配置检查',
            tools: ['Read'],
            entities: ['deepseek.ts'],
            tokensIn: 120,
            tokensOut: 45,
            rawResponse: '{}',
            provider: {
                provider: 'deepseek',
                model: 'deepseek-chat',
                statusCode: 200,
                requestId: `mock-l1-${randomUUID()}`,
                finishReason: 'stop',
                errorCode: null,
            },
        }),
        summarizeSegment: async () => ({
            summary: 'L2 摘要：多个 turn 聚焦于配置检查和测试搭建，最终所有配置已验证通过。',
            topic: '配置与测试搭建',
            tools: ['Read', 'Edit'],
            entities: ['deepseek.ts', 'worker/'],
            tokensIn: 250,
            tokensOut: 90,
            rawResponse: '{}',
            provider: {
                provider: 'deepseek',
                model: 'deepseek-chat',
                statusCode: 200,
                requestId: `mock-l2-${randomUUID()}`,
                finishReason: 'stop',
                errorCode: null,
            },
        }),
        summarizeSession: async () => ({
            summary: 'L3 摘要：本 session 实现了 Phase1 Worker L1/L2/L3 摘要管道，包含配置检查、测试搭建及全部场景验证。',
            topic: 'Phase1 Worker 管道实现',
            tools: ['Read', 'Edit', 'Bash', 'Write'],
            entities: ['worker/', 'server/', 'deepseek.ts', 'phase1-e2e.test.ts'],
            tokensIn: 500,
            tokensOut: 180,
            rawResponse: '{}',
            provider: {
                provider: 'deepseek',
                model: 'deepseek-chat',
                statusCode: 200,
                requestId: `mock-l3-${randomUUID()}`,
                finishReason: 'stop',
                errorCode: null,
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// Mock boss
// ---------------------------------------------------------------------------

type SentJob = { queueName: string; payload: unknown; options?: { singletonKey?: string } }

function makeMockBoss(): { boss: WorkerContext['boss']; sentJobs: SentJob[] } {
    const sentJobs: SentJob[] = []
    const boss = {
        send: async (queueName: string, payload: unknown, options?: { singletonKey?: string }) => {
            sentJobs.push({ queueName, payload, options })
            return null
        },
    } as unknown as WorkerContext['boss']
    return { boss, sentJobs }
}

// ---------------------------------------------------------------------------
// WorkerContext factory
// ---------------------------------------------------------------------------

function makeCtx(
    boss: WorkerContext['boss'],
    l2Threshold = 5,
): WorkerContext {
    return {
        config: {
            bossSchema: 'yr_boss',
            l2SegmentThreshold: l2Threshold,
            deepseek: { model: 'deepseek-chat' },
        } as WorkerContext['config'],
        worker: { host: 'test-worker', version: '0.1.0-test' },
        pool,
        boss,
        sessionStore,
        summaryStore,
        runStore,
        deepseekClient: makeMockLLM() as unknown as WorkerContext['deepseekClient'],
    }
}

// ---------------------------------------------------------------------------
// Job metadata helpers
// ---------------------------------------------------------------------------

function makeL1Job(sessionId: string, userSeq: number): WorkerJobMetadata {
    return {
        id: `job-l1-${randomUUID()}`,
        name: QUEUE.SUMMARIZE_TURN,
        family: 'session-summary',
        version: 1,
        queueName: QUEUE.SUMMARIZE_TURN,
        idempotencyKey: `turn:${sessionId}:${userSeq}`,
    }
}

function makeL2Job(sessionId: string): WorkerJobMetadata {
    return {
        id: `job-l2-${randomUUID()}`,
        name: QUEUE.SUMMARIZE_SEGMENT,
        family: 'session-summary',
        version: 1,
        queueName: QUEUE.SUMMARIZE_SEGMENT,
        idempotencyKey: `segment:${sessionId}`,
    }
}

function makeL3Job(sessionId: string): WorkerJobMetadata {
    return {
        id: `job-l3-${randomUUID()}`,
        name: QUEUE.SUMMARIZE_SESSION,
        family: 'session-summary',
        version: 1,
        queueName: QUEUE.SUMMARIZE_SESSION,
        idempotencyKey: `session:${sessionId}`,
    }
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanupSessions(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await pool.query(
        `DELETE FROM session_summaries WHERE session_id = ANY($1::text[])`,
        [ids],
    )
    await pool.query(
        `DELETE FROM summarization_runs WHERE session_id = ANY($1::text[])`,
        [ids],
    )
    // messages cascade from sessions via FK
    await pool.query(`DELETE FROM sessions WHERE id = ANY($1::text[])`, [ids])
}

// ---------------------------------------------------------------------------
// DB query helpers for assertions
// ---------------------------------------------------------------------------

async function countSummaries(sessionId: string, level: 1 | 2 | 3): Promise<number> {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM session_summaries WHERE session_id = $1 AND level = $2`,
        [sessionId, level],
    )
    return Number(r.rows[0]?.cnt ?? 0)
}

async function getSummaries(sessionId: string, level: 1 | 2 | 3) {
    const r = await pool.query(
        `SELECT id, level, seq_start, seq_end, summary, metadata, parent_id
         FROM session_summaries WHERE session_id = $1 AND level = $2
         ORDER BY created_at ASC`,
        [sessionId, level],
    )
    return r.rows as Array<{
        id: string
        level: number
        seq_start: number | null
        seq_end: number | null
        summary: string
        metadata: Record<string, unknown>
        parent_id: string | null
    }>
}

async function getRuns(sessionId: string, level: 1 | 2 | 3) {
    const r = await pool.query(
        `SELECT id, level, status, error_code, idempotency_key, tokens_in, tokens_out
         FROM summarization_runs WHERE session_id = $1 AND level = $2
         ORDER BY created_at ASC`,
        [sessionId, level],
    )
    return r.rows as Array<{
        id: string
        level: number
        status: string
        error_code: string | null
        idempotency_key: string | null
        tokens_in: number | null
        tokens_out: number | null
    }>
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
    pool = new Pool({
        ...DB_CONFIG,
        max: 5,
        idleTimeoutMillis: 15_000,
        connectionTimeoutMillis: 8_000,
        statement_timeout: 30_000,
    })
    await pool.query('SELECT 1') // warm up

    summaryStore = new SummaryStore(pool)
    runStore = new RunStore(pool)
    sessionStore = new SessionStore(pool)

    await ensureWorkerSchema(pool)
})

afterAll(async () => {
    await cleanupSessions(createdSessionIds)
    await pool.end()
})

// ===========================================================================
// SCENARIO 1 + 2: Schema Creation
// ===========================================================================

describe('Scenario 1+2: Schema creation', () => {
    it('ensureWorkerSchema creates session_summaries and summarization_runs tables', async () => {
        // Called in beforeAll; just verify the tables actually exist
        const r = await pool.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('session_summaries', 'summarization_runs')
            ORDER BY table_name
        `)
        const names = r.rows.map((row: Record<string, unknown>) => row.table_name)
        expect(names).toContain('session_summaries')
        expect(names).toContain('summarization_runs')
    })

    it('key indexes exist on session_summaries', async () => {
        const r = await pool.query(`
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'session_summaries'
        `)
        const names = r.rows.map((row: Record<string, unknown>) => row.indexname as string)
        expect(names).toContain('idx_ss_dedup')
        expect(names).toContain('idx_ss_l3_unique')
        expect(names).toContain('idx_ss_session_level')
    })

    it('server initSchema DDL is idempotent (double-apply does not error)', async () => {
        // The DDLs use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — re-applying must be safe
        await expect(ensureWorkerSchema(pool)).resolves.toBeUndefined()
    })
})

// ===========================================================================
// SCENARIO 3a: L1 Turn Summarization — Normal Path
// ===========================================================================

describe('Scenario 3a: L1 turn summarization (normal path)', () => {
    it('summarizes a turn with tool use, inserts L1 row, records success run', async () => {
        const sessionId = newSessionId('l1-normal')
        await insertSession(sessionId)
        await insertSubstantialTurn(sessionId, 10)

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, userSeq: 10, scheduledAtMs: Date.now() }
        const job = makeL1Job(sessionId, 10)

        await handleSummarizeTurn(payload, job, ctx)

        // session_summaries: 1 L1 row
        const summaries = await getSummaries(sessionId, 1)
        expect(summaries).toHaveLength(1)
        expect(summaries[0]!.summary).toContain('L1 摘要')
        expect(summaries[0]!.seq_start).toBe(10)
        expect(summaries[0]!.parent_id).toBeNull()
        expect(summaries[0]!.metadata.topic).toBe('DeepSeek 配置检查')

        // summarization_runs: 1 success row
        const runs = await getRuns(sessionId, 1)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.status).toBe('success')
        expect(runs[0]!.error_code).toBeNull()
        expect(runs[0]!.idempotency_key).toBe(`turn:${sessionId}:10`)
    })
})

// ===========================================================================
// SCENARIO 3b: Trivial Turn Skip
// ===========================================================================

describe('Scenario 3b: Trivial turn skip (< 200 chars assistantText, no tools)', () => {
    it('records skipped run, does NOT insert L1 summary', async () => {
        const sessionId = newSessionId('l1-trivial')
        await insertSession(sessionId)
        await insertTrivialTurn(sessionId, 10)

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, userSeq: 10, scheduledAtMs: Date.now() }
        const job = makeL1Job(sessionId, 10)

        await handleSummarizeTurn(payload, job, ctx)

        // No session_summaries row
        expect(await countSummaries(sessionId, 1)).toBe(0)

        // summarization_runs: skipped
        const runs = await getRuns(sessionId, 1)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.status).toBe('skipped')
        expect(runs[0]!.error_code).toBe('trivial_turn')
    })

    it('also skips when realMessageCount < 2 (only user message)', async () => {
        const sessionId = newSessionId('l1-insufficient')
        await insertSession(sessionId)
        // Only user message, no assistant
        await insertMessage(sessionId, 10, {
            role: 'user',
            content: { type: 'text', text: '只有用户消息，没有 assistant 回复' },
        })

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, userSeq: 10, scheduledAtMs: Date.now() }
        const job = makeL1Job(sessionId, 10)

        await handleSummarizeTurn(payload, job, ctx)

        expect(await countSummaries(sessionId, 1)).toBe(0)
        const runs = await getRuns(sessionId, 1)
        expect(runs[0]!.status).toBe('skipped')
        expect(runs[0]!.error_code).toBe('insufficient_real_messages')
    })
})

// ===========================================================================
// SCENARIO 4: L2 Segment Summarization (5+ unassigned L1s → enqueue → handle)
// ===========================================================================

describe('Scenario 4: L2 segment summarization', () => {
    it('enqueueSegmentIfNeeded sends SUMMARIZE_SEGMENT job when unassigned L1 count >= threshold', async () => {
        const sessionId = newSessionId('l2-trigger')
        await insertSession(sessionId)

        // Insert 5 L1 summaries directly via summaryStore
        for (let i = 0; i < 5; i++) {
            await summaryStore.insertL1({
                sessionId,
                namespace: TEST_NAMESPACE,
                seqStart: i * 10,
                seqEnd: i * 10 + 5,
                summary: `L1 turn ${i} 摘要 — 用户检查配置，assistant 确认正确`,
                metadata: { topic: `Turn ${i}`, tools: [], entities: [] },
            })
        }

        const { boss, sentJobs } = makeMockBoss()
        const ctx = makeCtx(boss, 5)

        await enqueueSegmentIfNeeded(sessionId, TEST_NAMESPACE, ctx, 5)

        expect(sentJobs).toHaveLength(1)
        expect(sentJobs[0]!.queueName).toBe(QUEUE.SUMMARIZE_SEGMENT)
        expect((sentJobs[0]!.options as { singletonKey?: string })?.singletonKey).toBe(`segment:${sessionId}`)
        const jobPayload = sentJobs[0]!.payload as { payload: { sessionId: string } }
        expect(jobPayload.payload.sessionId).toBe(sessionId)
    })

    it('does NOT send job when unassigned L1 count < threshold', async () => {
        const sessionId = newSessionId('l2-no-trigger')
        await insertSession(sessionId)

        // Only 3 L1s — below threshold of 5
        for (let i = 0; i < 3; i++) {
            await summaryStore.insertL1({
                sessionId,
                namespace: TEST_NAMESPACE,
                seqStart: i * 10,
                seqEnd: i * 10 + 5,
                summary: `L1 turn ${i} short`,
                metadata: { topic: `Turn ${i}`, tools: [], entities: [] },
            })
        }

        const { boss, sentJobs } = makeMockBoss()
        const ctx = makeCtx(boss, 5)

        await enqueueSegmentIfNeeded(sessionId, TEST_NAMESPACE, ctx, 5)

        expect(sentJobs).toHaveLength(0)
    })

    it('handleSummarizeSegment inserts L2 row, marks L1 parent_ids, records success run', async () => {
        const sessionId = newSessionId('l2-handle')
        await insertSession(sessionId)

        // Insert 5 L1 summaries
        for (let i = 0; i < 5; i++) {
            await summaryStore.insertL1({
                sessionId,
                namespace: TEST_NAMESPACE,
                seqStart: i * 10,
                seqEnd: i * 10 + 5,
                summary: `Turn ${i}: 检查配置文件，确认摘要字段正确，无需修改`,
                metadata: { topic: `配置检查 ${i}`, tools: ['Read'], entities: ['deepseek.ts'] },
            })
        }

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }
        const job = makeL2Job(sessionId)

        await handleSummarizeSegment(payload, job, ctx)

        // session_summaries: 1 L2 row
        const l2s = await getSummaries(sessionId, 2)
        expect(l2s).toHaveLength(1)
        expect(l2s[0]!.summary).toContain('L2 摘要')
        expect(l2s[0]!.metadata.l1_count).toBe(5)

        // All 5 L1s should have parent_id = L2 id
        const l1s = await getSummaries(sessionId, 1)
        expect(l1s).toHaveLength(5)
        for (const l1 of l1s) {
            expect(l1.parent_id).toBe(l2s[0]!.id)
        }

        // summarization_runs: success
        const runs = await getRuns(sessionId, 2)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.status).toBe('success')
    })
})

// ===========================================================================
// SCENARIO 5: L3 Session Summarization
// ===========================================================================

describe('Scenario 5: L3 session summarization', () => {
    it('summarizes session from L2 sources, inserts level=3 row', async () => {
        const sessionId = newSessionId('l3-from-l2')
        await insertSession(sessionId)

        // Insert 2 L2 summaries directly
        await summaryStore.insertL2({
            sessionId,
            namespace: TEST_NAMESPACE,
            seqStart: 0,
            seqEnd: 49,
            summary: 'Segment 1: 配置检查和基础搭建完成',
            metadata: { topic: '配置搭建', tools: ['Read'], entities: [] },
        })
        await summaryStore.insertL2({
            sessionId,
            namespace: TEST_NAMESPACE,
            seqStart: 50,
            seqEnd: 99,
            summary: 'Segment 2: 集成测试实现，全部场景覆盖',
            metadata: { topic: '集成测试', tools: ['Write', 'Bash'], entities: [] },
        })

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }
        const job = makeL3Job(sessionId)

        await handleSummarizeSession(payload, job, ctx)

        // session_summaries: 1 L3 row
        const l3s = await getSummaries(sessionId, 3)
        expect(l3s).toHaveLength(1)
        expect(l3s[0]!.summary.length).toBeGreaterThan(10)
        expect(l3s[0]!.metadata.source_level).toBe(2)
        expect(l3s[0]!.metadata.source_count).toBe(2)

        // summarization_runs: success
        const runs = await getRuns(sessionId, 3)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.status).toBe('success')
    })

    it('falls back to L1 sources when no L2 exists, marks trivial=true when source_count < 6', async () => {
        const sessionId = newSessionId('l3-from-l1')
        await insertSession(sessionId)

        // Insert 3 L1 summaries (below trivial threshold of 6)
        for (let i = 0; i < 3; i++) {
            await summaryStore.insertL1({
                sessionId,
                namespace: TEST_NAMESPACE,
                seqStart: i * 10,
                seqEnd: i * 10 + 5,
                summary: `L1 turn ${i}: 检查配置并确认正确`,
                metadata: { topic: `Turn ${i}`, tools: [], entities: [] },
            })
        }

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }
        const job = makeL3Job(sessionId)

        await handleSummarizeSession(payload, job, ctx)

        const l3s = await getSummaries(sessionId, 3)
        expect(l3s).toHaveLength(1)
        expect(l3s[0]!.metadata.source_level).toBe(1)
        expect(l3s[0]!.metadata.trivial).toBe(true)

        const runs = await getRuns(sessionId, 3)
        expect(runs[0]!.status).toBe('success')
    })

    it('skips L3 when no source summaries exist at all', async () => {
        const sessionId = newSessionId('l3-skip-empty')
        await insertSession(sessionId)

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }
        const job = makeL3Job(sessionId)

        await handleSummarizeSession(payload, job, ctx)

        expect(await countSummaries(sessionId, 3)).toBe(0)
        const runs = await getRuns(sessionId, 3)
        expect(runs[0]!.status).toBe('skipped')
        expect(runs[0]!.error_code).toBe('no_source_summaries')
    })

    it('upsertL3 overwrites existing L3 on re-run (ON CONFLICT DO UPDATE)', async () => {
        const sessionId = newSessionId('l3-upsert')
        await insertSession(sessionId)

        // Insert 1 L1 source
        await summaryStore.insertL1({
            sessionId,
            namespace: TEST_NAMESPACE,
            seqStart: 0,
            seqEnd: 10,
            summary: '初次 L1 摘要',
            metadata: { topic: 'First', tools: [], entities: [] },
        })

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }

        // First L3 run
        await handleSummarizeSession(payload, makeL3Job(sessionId), ctx)
        // Second L3 run (session ended again, or reprocessed)
        await handleSummarizeSession(payload, makeL3Job(sessionId), ctx)

        // Still only 1 L3 row (upsert)
        expect(await countSummaries(sessionId, 3)).toBe(1)
        // But 2 run records
        const runs = await getRuns(sessionId, 3)
        expect(runs.length).toBe(2)
        expect(runs.every(r => r.status === 'success')).toBe(true)
    })
})

// ===========================================================================
// SCENARIO 6: Full Pipeline — All 3 Levels in One Session
// ===========================================================================

describe('Scenario 6: Full pipeline — L1 → L2 → L3 in one session', () => {
    it('session_summaries has rows for level 1, 2 and 3; summarization_runs records all 3', async () => {
        const sessionId = newSessionId('full-pipeline')
        await insertSession(sessionId)

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss, 5)

        // Step 1: 5 L1 turns (each at seq 10, 30, 50, 70, 90)
        for (let i = 0; i < 5; i++) {
            const userSeq = 10 + i * 20
            await insertSubstantialTurn(sessionId, userSeq)
            const l1Payload = {
                sessionId,
                namespace: TEST_NAMESPACE,
                userSeq,
                scheduledAtMs: Date.now(),
            }
            await handleSummarizeTurn(l1Payload, makeL1Job(sessionId, userSeq), ctx)
        }

        // Verify 5 L1s in DB
        expect(await countSummaries(sessionId, 1)).toBe(5)

        // Step 2: handleSummarizeSegment
        const l2Payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }
        await handleSummarizeSegment(l2Payload, makeL2Job(sessionId), ctx)

        // Verify L2 inserted
        expect(await countSummaries(sessionId, 2)).toBe(1)

        // Step 3: handleSummarizeSession (session ended)
        const l3Payload = { sessionId, namespace: TEST_NAMESPACE, scheduledAtMs: Date.now() }
        await handleSummarizeSession(l3Payload, makeL3Job(sessionId), ctx)

        // ---- Assertions ----
        // All 3 levels in session_summaries
        expect(await countSummaries(sessionId, 1)).toBe(5)
        expect(await countSummaries(sessionId, 2)).toBe(1)
        expect(await countSummaries(sessionId, 3)).toBe(1)

        // summarization_runs has records for each level
        const l1Runs = await getRuns(sessionId, 1)
        const l2Runs = await getRuns(sessionId, 2)
        const l3Runs = await getRuns(sessionId, 3)
        expect(l1Runs).toHaveLength(5)
        expect(l2Runs).toHaveLength(1)
        expect(l3Runs).toHaveLength(1)

        expect(l1Runs.every(r => r.status === 'success')).toBe(true)
        expect(l2Runs[0]!.status).toBe('success')
        expect(l3Runs[0]!.status).toBe('success')

        // L3 summary content is reasonable
        const l3 = (await getSummaries(sessionId, 3))[0]!
        expect(l3.summary.length).toBeGreaterThan(20)
        expect(l3.metadata.source_level).toBe(2)

        // All 5 L1s have parent_id pointing to L2
        const l2 = (await getSummaries(sessionId, 2))[0]!
        const l1s = await getSummaries(sessionId, 1)
        for (const l1 of l1s) {
            expect(l1.parent_id).toBe(l2.id)
        }
    })
})

// ===========================================================================
// SCENARIO 7: Catch-up Mechanism
// ===========================================================================

describe('Scenario 7: Catch-up mechanism (orphaned L1s → L2 enqueued)', () => {
    it('catch-up query finds sessions with >= threshold orphaned L1s older than 10 min', async () => {
        const sessionId = newSessionId('catchup')
        await insertSession(sessionId)

        const ORPHAN_AGE_MS = 10 * 60 * 1000
        const oldCreatedAt = Date.now() - ORPHAN_AGE_MS - 60_000 // 11 min ago

        // Insert 5 L1 summaries with old created_at
        for (let i = 0; i < 5; i++) {
            await pool.query(
                `INSERT INTO session_summaries (id, session_id, namespace, level, seq_start, seq_end, summary, metadata, created_at)
                 VALUES ($1, $2, $3, 1, $4, $5, $6, $7::jsonb, $8)
                 ON CONFLICT DO NOTHING`,
                [
                    randomUUID(),
                    sessionId,
                    TEST_NAMESPACE,
                    i * 10,
                    i * 10 + 5,
                    `Orphaned L1 turn ${i}`,
                    JSON.stringify({ topic: `Turn ${i}`, tools: [], entities: [] }),
                    oldCreatedAt,
                ],
            )
        }

        // Run the catch-up SQL from index.ts runCatchup
        const cutoff = Date.now() - ORPHAN_AGE_MS
        const r = await pool.query(
            `SELECT session_id, namespace, COUNT(*)::int AS cnt
             FROM session_summaries
             WHERE level = 1 AND parent_id IS NULL AND created_at < $1
             GROUP BY session_id, namespace
             HAVING COUNT(*) >= $2`,
            [cutoff, 5],
        )

        const rows = r.rows as Array<{ session_id: string; namespace: string; cnt: number }>
        const found = rows.find(row => row.session_id === sessionId)
        expect(found).toBeDefined()
        expect(found!.cnt).toBe(5)
        expect(found!.namespace).toBe(TEST_NAMESPACE)
    })

    it('catch-up: enqueueSegmentIfNeeded sends segment job for orphaned session', async () => {
        const sessionId = newSessionId('catchup-enqueue')
        await insertSession(sessionId)

        const oldCreatedAt = Date.now() - 11 * 60 * 1000

        // Insert 5 orphaned L1s
        for (let i = 0; i < 5; i++) {
            await pool.query(
                `INSERT INTO session_summaries (id, session_id, namespace, level, seq_start, seq_end, summary, metadata, created_at)
                 VALUES ($1, $2, $3, 1, $4, $5, $6, $7::jsonb, $8)
                 ON CONFLICT DO NOTHING`,
                [
                    randomUUID(),
                    sessionId,
                    TEST_NAMESPACE,
                    i * 10,
                    i * 10 + 5,
                    `Orphaned turn ${i}`,
                    JSON.stringify({ topic: `Turn ${i}`, tools: [], entities: [] }),
                    oldCreatedAt,
                ],
            )
        }

        const { boss, sentJobs } = makeMockBoss()
        const ctx = makeCtx(boss, 5)

        // Simulate catch-up: enqueueSegmentIfNeeded for this session
        await enqueueSegmentIfNeeded(sessionId, TEST_NAMESPACE, ctx, 5)

        expect(sentJobs).toHaveLength(1)
        expect(sentJobs[0]!.queueName).toBe(QUEUE.SUMMARIZE_SEGMENT)
        expect((sentJobs[0]!.options as { singletonKey?: string })?.singletonKey).toBe(`segment:${sessionId}`)
    })
})

// ===========================================================================
// SCENARIO 8: Idempotency
// ===========================================================================

describe('Scenario 8: Idempotency', () => {
    it('duplicate L1 insert (same sessionId + seqStart) is deduped by DB unique index', async () => {
        const sessionId = newSessionId('idem-l1-db')
        await insertSession(sessionId)

        const input = {
            sessionId,
            namespace: TEST_NAMESPACE,
            seqStart: 10,
            seqEnd: 15,
            summary: '第一次插入',
            metadata: { topic: 'Test', tools: [], entities: [] },
        }

        const result1 = await summaryStore.insertL1(input)
        const result2 = await summaryStore.insertL1({ ...input, summary: '第二次插入（应被忽略）' })

        expect(result1.inserted).toBe(true)
        expect(result1.id).not.toBeNull()

        // Second insert: ON CONFLICT DO NOTHING
        expect(result2.inserted).toBe(false)
        expect(result2.id).toBeNull()

        // DB: only 1 row with original content
        const summaries = await getSummaries(sessionId, 1)
        expect(summaries).toHaveLength(1)
        expect(summaries[0]!.summary).toBe('第一次插入')
    })

    it('duplicate L2 insert (same sessionId + seqStart) is also deduped', async () => {
        const sessionId = newSessionId('idem-l2-db')
        await insertSession(sessionId)

        const input = {
            sessionId,
            namespace: TEST_NAMESPACE,
            seqStart: 0,
            seqEnd: 49,
            summary: 'L2 第一次',
            metadata: { topic: 'Segment', tools: [], entities: [] },
        }

        const r1 = await summaryStore.insertL2(input)
        const r2 = await summaryStore.insertL2({ ...input, summary: 'L2 第二次（应被忽略）' })

        expect(r1.inserted).toBe(true)
        expect(r2.inserted).toBe(false)

        const l2s = await getSummaries(sessionId, 2)
        expect(l2s).toHaveLength(1)
        expect(l2s[0]!.summary).toBe('L2 第一次')
    })

    it('enqueueSegmentIfNeeded always uses singletonKey = "segment:{sessionId}"', async () => {
        const sessionId = newSessionId('idem-singleton')
        await insertSession(sessionId)

        // Insert 5 L1s
        for (let i = 0; i < 5; i++) {
            await summaryStore.insertL1({
                sessionId,
                namespace: TEST_NAMESPACE,
                seqStart: i * 10,
                seqEnd: i * 10 + 5,
                summary: `Turn ${i}`,
                metadata: { topic: `T${i}`, tools: [], entities: [] },
            })
        }

        const { boss, sentJobs } = makeMockBoss()
        const ctx = makeCtx(boss, 5)

        // Call twice — both use the same singletonKey (pg-boss deduplicates in real env)
        await enqueueSegmentIfNeeded(sessionId, TEST_NAMESPACE, ctx, 5)
        await enqueueSegmentIfNeeded(sessionId, TEST_NAMESPACE, ctx, 5)

        expect(sentJobs).toHaveLength(2)
        // Both use identical singletonKey
        const key0 = (sentJobs[0]!.options as { singletonKey?: string })?.singletonKey
        const key1 = (sentJobs[1]!.options as { singletonKey?: string })?.singletonKey
        expect(key0).toBe(`segment:${sessionId}`)
        expect(key1).toBe(key0)
    })

    it('L1 handleSummarizeTurn with same idempotencyKey: second run is deduped at DB level', async () => {
        const sessionId = newSessionId('idem-l1-handle')
        await insertSession(sessionId)
        await insertSubstantialTurn(sessionId, 10)

        const { boss } = makeMockBoss()
        const ctx = makeCtx(boss)
        const payload = { sessionId, namespace: TEST_NAMESPACE, userSeq: 10, scheduledAtMs: Date.now() }
        const job = makeL1Job(sessionId, 10)

        // Run twice with same payload
        await handleSummarizeTurn(payload, job, ctx)
        await handleSummarizeTurn(payload, job, ctx)

        // session_summaries: still only 1 row (ON CONFLICT DO NOTHING)
        expect(await countSummaries(sessionId, 1)).toBe(1)

        // But summarization_runs has 2 rows (both recorded as success)
        const runs = await getRuns(sessionId, 1)
        expect(runs).toHaveLength(2)
        expect(runs.every(r => r.status === 'success')).toBe(true)
    })
})
