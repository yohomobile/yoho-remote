# 端到端集成测试代码片段库

快速复制-粘贴的测试辅助代码。

## 1. 环境变量配置（.env.test）

```bash
PG_HOST=localhost
PG_PORT=5432
PG_USER=test_user
PG_PASSWORD=test_pass
PG_DATABASE=yoho_remote_test
PG_BOSS_SCHEMA=pgboss_test
PG_SSL=false

DEEPSEEK_API_KEY=test-key-12345
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=60000

WORKER_CONCURRENCY=1
SUMMARIZATION_RUN_RETENTION_DAYS=30
L2_SEGMENT_THRESHOLD=5
CATCHUP_INTERVAL_MS=3600000

SUMMARIZE_TURN_RETRY_LIMIT=4
SUMMARIZE_TURN_RETRY_DELAY_SECONDS=15
SUMMARIZE_TURN_RETRY_BACKOFF=true
SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS=300

SUMMARIZE_SEGMENT_RETRY_LIMIT=4
SUMMARIZE_SEGMENT_RETRY_DELAY_SECONDS=30
SUMMARIZE_SEGMENT_RETRY_BACKOFF=true
SUMMARIZE_SEGMENT_RETRY_DELAY_MAX_SECONDS=600

SUMMARIZE_SESSION_RETRY_LIMIT=3
SUMMARIZE_SESSION_RETRY_DELAY_SECONDS=60
SUMMARIZE_SESSION_RETRY_BACKOFF=true
SUMMARIZE_SESSION_RETRY_DELAY_MAX_SECONDS=900
```

## 2. 测试数据库初始化

```typescript
import { Pool } from 'pg'
import { SESSION_SUMMARIES_DDL, SUMMARIZATION_RUNS_DDL } from '../server/src/store/session-summaries-ddl'

export async function initTestDatabase(pool: Pool): Promise<void> {
    // 创建 sessions 表（最小依赖）
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL,
            created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
    `)
    
    // 创建 messages 表（用于 turn 内容）
    await pool.query(`
        CREATE TABLE IF NOT EXISTS session_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            content JSONB NOT NULL,
            created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
            PRIMARY KEY (session_id, seq)
        )
    `)
    
    // 创建摘要和运行表
    await pool.query(SESSION_SUMMARIES_DDL)
    await pool.query(SUMMARIZATION_RUNS_DDL)
}

export async function cleanupTestDatabase(pool: Pool): Promise<void> {
    await pool.query('DROP TABLE IF EXISTS summarization_runs CASCADE')
    await pool.query('DROP TABLE IF EXISTS session_summaries CASCADE')
    await pool.query('DROP TABLE IF EXISTS session_messages CASCADE')
    await pool.query('DROP TABLE IF EXISTS sessions CASCADE')
}
```

## 3. WorkerContext Mock 工厂

```typescript
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { vi } from 'vitest'
import { loadConfig } from '../src/config'
import { SessionStore } from '../src/db/sessionStore'
import { SummaryStore } from '../src/db/summaryStore'
import { RunStore } from '../src/db/runStore'
import { DeepSeekClient } from '../src/llm/deepseek'
import type { WorkerContext } from '../src/types'

export async function createMockWorkerContext(pool: Pool): Promise<WorkerContext> {
    const config = loadConfig({
        PG_HOST: process.env.PG_HOST || 'localhost',
        PG_PORT: process.env.PG_PORT || '5432',
        PG_USER: process.env.PG_USER || 'test',
        PG_PASSWORD: process.env.PG_PASSWORD || '',
        PG_DATABASE: process.env.PG_DATABASE || 'test_db',
        PG_BOSS_SCHEMA: process.env.PG_BOSS_SCHEMA || 'pgboss',
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'test-key',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_MODEL: 'deepseek-chat',
        DEEPSEEK_TIMEOUT_MS: '60000',
        WORKER_CONCURRENCY: '1',
        L2_SEGMENT_THRESHOLD: '5',
        CATCHUP_INTERVAL_MS: '3600000',
    })
    
    const mockBoss = {
        send: vi.fn().mockResolvedValue({}),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as PgBoss
    
    const mockDeepseekClient = {
        summarizeTurn: vi.fn(),
        summarizeSegment: vi.fn(),
        summarizeSession: vi.fn(),
    } as unknown as DeepSeekClient
    
    return {
        config,
        worker: { host: 'test-host', version: '1.0.0' },
        pool,
        boss: mockBoss,
        sessionStore: new SessionStore(pool),
        summaryStore: new SummaryStore(pool),
        runStore: new RunStore(pool),
        deepseekClient: mockDeepseekClient,
    }
}
```

## 4. 测试会话创建辅助函数

```typescript
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export async function createTestSession(pool: Pool, namespace = 'test'): Promise<string> {
    const sessionId = randomUUID()
    await pool.query(
        'INSERT INTO sessions (id, namespace) VALUES ($1, $2)',
        [sessionId, namespace]
    )
    return sessionId
}

export async function insertTestMessage(
    pool: Pool,
    sessionId: string,
    seq: number,
    content: Record<string, unknown>
): Promise<void> {
    await pool.query(
        `INSERT INTO session_messages (session_id, seq, content)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [sessionId, seq, content]
    )
}

export async function insertTurnMessages(
    pool: Pool,
    sessionId: string,
    userSeq: number,
    messages: Array<{ seq: number; content: Record<string, unknown> }>
): Promise<void> {
    for (const msg of messages) {
        await insertTestMessage(pool, sessionId, msg.seq, msg.content)
    }
}
```

## 5. Mock DeepSeek 响应工厂

```typescript
import type { L1SummaryResult, LLMSummaryResult, ProviderTelemetry } from '../src/types'
import { vi } from 'vitest'

export function mockDeepseekL1Response(overrides?: Partial<L1SummaryResult>): L1SummaryResult {
    const provider: ProviderTelemetry = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        statusCode: 200,
        requestId: 'req-' + Math.random().toString(36).slice(2, 9),
        finishReason: 'stop',
        errorCode: null,
        ...overrides?.provider,
    }
    
    return {
        summary: 'Test L1 summary',
        topic: 'test topic',
        tools: ['test-tool'],
        entities: ['test-entity'],
        tokensIn: 1000,
        tokensOut: 500,
        rawResponse: '{"summary":"..."}',
        provider,
        ...overrides,
    }
}

export function mockDeepseekL2Response(overrides?: Partial<LLMSummaryResult>): LLMSummaryResult {
    const provider: ProviderTelemetry = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        statusCode: 200,
        requestId: 'req-' + Math.random().toString(36).slice(2, 9),
        finishReason: 'stop',
        errorCode: null,
        ...overrides?.provider,
    }
    
    return {
        summary: 'Test L2 summary',
        topic: 'test segment',
        tools: ['tool1', 'tool2'],
        entities: ['entity1', 'entity2'],
        tokensIn: 2000,
        tokensOut: 1000,
        rawResponse: '{"summary":"..."}',
        provider,
        ...overrides,
    }
}
```

## 6. Mock JobMetadata 工厂

```typescript
import { QUEUE, JOB_FAMILY, SUMMARIZE_TURN_JOB_VERSION } from '../src/boss'
import type { WorkerJobMetadata } from '../src/jobs/core'

export function createMockJobMetadata(overrides?: Partial<WorkerJobMetadata>): WorkerJobMetadata {
    return {
        id: 'job-' + Math.random().toString(36).slice(2, 9),
        name: QUEUE.SUMMARIZE_TURN,
        family: JOB_FAMILY.SESSION_SUMMARY,
        version: SUMMARIZE_TURN_JOB_VERSION,
        queueName: QUEUE.SUMMARIZE_TURN,
        idempotencyKey: 'idem-' + Math.random().toString(36).slice(2, 9),
        singletonKey: null,
        retryCount: 0,
        retryLimit: 4,
        retryDelay: 15,
        retryBackoff: true,
        retryDelayMax: 300,
        createdOn: new Date(),
        startedOn: new Date(),
        ...overrides,
    }
}
```

## 7. 标准测试用例模板

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Pool } from 'pg'
import { handleSummarizeTurn } from '../src/handlers/summarizeTurn'
import type { SummarizeTurnPayload } from '../src/boss'
import type { WorkerContext } from '../src/types'

describe('E2E L1 Handler', () => {
    let pool: Pool
    let ctx: WorkerContext
    let sessionId: string
    
    beforeEach(async () => {
        // 1. 初始化测试数据库
        pool = new Pool({
            host: process.env.PG_HOST || 'localhost',
            port: parseInt(process.env.PG_PORT || '5432'),
            user: process.env.PG_USER || 'test',
            password: process.env.PG_PASSWORD || '',
            database: process.env.PG_DATABASE || 'test_db',
        })
        
        await initTestDatabase(pool)
        
        // 2. 创建 mock 上下文
        ctx = await createMockWorkerContext(pool)
        
        // 3. 创建测试 session
        sessionId = await createTestSession(pool, 'test')
    })
    
    afterEach(async () => {
        await cleanupTestDatabase(pool)
        await pool.end()
    })
    
    it('should create L1 summary for valid turn', async () => {
        // 1. 准备 turn 消息
        const userSeq = 10
        await insertTurnMessages(pool, sessionId, userSeq, [
            {
                seq: userSeq,
                content: {
                    role: 'user',
                    type: 'text',
                    text: 'Hello, fix this bug'
                }
            },
            {
                seq: userSeq + 1,
                content: {
                    role: 'assistant',
                    type: 'text',
                    text: 'I found the issue in module.ts. It needs refactoring.'
                }
            },
            {
                seq: userSeq + 2,
                content: {
                    role: 'user',
                    type: 'text',
                    text: 'Great, apply the fix'
                }
            }
        ])
        
        // 2. 设置 DeepSeek mock
        const mockDeepseekClient = ctx.deepseekClient as any
        const mockResponse = mockDeepseekL1Response()
        mockDeepseekClient.summarizeTurn.mockResolvedValue(mockResponse)
        
        // 3. 执行 handler
        const payload: SummarizeTurnPayload = {
            sessionId,
            namespace: 'test',
            userSeq,
            scheduledAtMs: Date.now()
        }
        const job = createMockJobMetadata()
        
        await expect(handleSummarizeTurn(payload, job, ctx)).resolves.not.toThrow()
        
        // 4. 验证 L1 摘要被插入
        const result = await pool.query(
            'SELECT * FROM session_summaries WHERE session_id = $1 AND level = 1',
            [sessionId]
        )
        expect(result.rows.length).toBe(1)
        expect(result.rows[0].summary).toBe(mockResponse.summary)
        expect(result.rows[0].metadata.topic).toBe(mockResponse.topic)
        
        // 5. 验证运行记录被记录
        const runResult = await pool.query(
            'SELECT * FROM summarization_runs WHERE session_id = $1 AND level = 1',
            [sessionId]
        )
        expect(runResult.rows.length).toBeGreaterThan(0)
        expect(runResult.rows[0].status).toBe('success')
    })
    
    it('should skip trivial turn (< 200 chars assistant + no tools)', async () => {
        const userSeq = 10
        await insertTurnMessages(pool, sessionId, userSeq, [
            {
                seq: userSeq,
                content: { role: 'user', type: 'text', text: 'hi' }
            },
            {
                seq: userSeq + 1,
                content: { role: 'assistant', type: 'text', text: 'ok' }
            }
        ])
        
        const payload: SummarizeTurnPayload = {
            sessionId,
            namespace: 'test',
            userSeq,
            scheduledAtMs: Date.now()
        }
        const job = createMockJobMetadata()
        
        await handleSummarizeTurn(payload, job, ctx)
        
        const runResult = await pool.query(
            'SELECT * FROM summarization_runs WHERE session_id = $1 AND level = 1',
            [sessionId]
        )
        expect(runResult.rows[0].status).toBe('skipped')
        expect(runResult.rows[0].error_code).toBe('trivial_turn')
    })
})
```

## 8. L2 触发测试

```typescript
import { enqueueSegmentIfNeeded } from '../src/handlers/summarizeSegment'
import { QUEUE } from '../src/boss'

describe('E2E L2 Trigger', () => {
    it('should enqueue segment when L1 count reaches threshold', async () => {
        // 1. 插入 5 个 L1 摘要（达到阈值）
        for (let i = 0; i < 5; i++) {
            await ctx.summaryStore.insertL1({
                sessionId,
                namespace: 'test',
                seqStart: i * 10,
                seqEnd: (i + 1) * 10,
                summary: `L1 summary ${i}`,
                metadata: {
                    topic: `topic ${i}`,
                    tools: [],
                    entities: []
                }
            })
        }
        
        // 2. 调用 enqueueSegmentIfNeeded
        const mockBoss = ctx.boss as any
        mockBoss.send.mockClear()
        
        await enqueueSegmentIfNeeded(sessionId, 'test', ctx, 5)
        
        // 3. 验证 send 被调用
        expect(mockBoss.send).toHaveBeenCalledWith(
            QUEUE.SUMMARIZE_SEGMENT,
            expect.objectContaining({
                version: 1,
                idempotencyKey: `segment:${sessionId}`,
            }),
            { singletonKey: `segment:${sessionId}` }
        )
    })
})
```

## 9. 缓存命中测试

```typescript
describe('E2E Cache Hit', () => {
    it('should use cached result on L1 retry', async () => {
        const userSeq = 10
        
        // 1. 插入一条缓存记录
        const cachedResult = mockDeepseekL1Response()
        await ctx.runStore.insert({
            sessionId,
            namespace: 'test',
            level: 1,
            jobName: QUEUE.SUMMARIZE_TURN,
            jobVersion: 1,
            idempotencyKey: `${sessionId}:${userSeq}:v1`,
            status: 'error_transient',
            durationMs: 100,
            metadata: {
                seq_start: String(userSeq),
                cached_result: cachedResult,
            }
        })
        
        // 2. 再次执行，应读取缓存
        const cached = await ctx.runStore.getLatestCachedL1Result(
            sessionId,
            userSeq,
            QUEUE.SUMMARIZE_TURN,
            1
        )
        
        expect(cached).not.toBeNull()
        expect(cached?.summary).toBe(cachedResult.summary)
    })
})
```

## 10. Catch-up 测试

```typescript
import { runCatchup } from '../src/index'

describe('E2E Catch-up', () => {
    it('should detect and enqueue orphan L1s older than 10 minutes', async () => {
        // 1. 插入 5 个旧的孤儿 L1
        const cutoff = Date.now() - 11 * 60 * 1000
        const l1Ids: string[] = []
        
        for (let i = 0; i < 5; i++) {
            const result = await ctx.summaryStore.insertL1({
                sessionId,
                namespace: 'test',
                seqStart: i * 10,
                seqEnd: (i + 1) * 10,
                summary: `orphan L1 ${i}`,
                metadata: {}
            })
            if (result.inserted && result.id) {
                l1Ids.push(result.id)
            }
        }
        
        // 2. 手动更新 created_at（模拟旧记录）
        for (let i = 0; i < 5; i++) {
            await ctx.pool.query(
                `UPDATE session_summaries SET created_at = $1 WHERE seq_start = $2`,
                [cutoff, i * 10]
            )
        }
        
        // 3. 运行 catch-up
        const mockBoss = ctx.boss as any
        mockBoss.send.mockClear()
        
        await runCatchup(ctx)
        
        // 4. 验证 segment 任务被发送
        expect(mockBoss.send).toHaveBeenCalledWith(
            QUEUE.SUMMARIZE_SEGMENT,
            expect.any(Object),
            { singletonKey: `segment:${sessionId}` }
        )
    })
})
```

---

**使用建议**：这些片段可直接复制到你的测试文件中。根据需要调整 beforeEach、afterEach 和断言。
