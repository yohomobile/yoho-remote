# yoho-remote 端到端集成测试参考文档

## 📋 概述

本文档汇总了 yoho-remote 的核心系统信息，用于编写端到端集成测试。涵盖 L1/L2/L3 摘要流程、数据库模式、pg-boss 队列配置、DeepSeek LLM 接口、幂等性机制等。

---

## 1. L1/L2/L3 三层触发条件与阈值

### L1 摘要 (Turn Summarization)
**触发方式**：Server 端 `summarizeTurnQueue` 发送任务到 `summarize-turn` 队列

触发条件：
- 用户发送新消息（seq = userSeq）
- 必须是 "user text message"（isTurnStartUserMessage）
- 不在 mid-stream tool_use 状态
- 不能是 session_still_thinking

跳过条件（skipped）：
- realMessageCount < 2：少于 2 条实际活动消息
- assistantText.length < 200 && toolUses.length === 0：trivial turn
- 其他 session 异常

缓存命中条件（cache_hit）：
- getLatestCachedL1Result() 找到 status='error_transient' 的缓存结果

### L2 摘要 (Segment Summarization)
**触发方式**：L1 完成后自动调用 `enqueueSegmentIfNeeded()`

触发条件：
- 未分配的 L1 摘要数 >= l2SegmentThreshold（默认 5）
- singletonKey = "segment:{sessionId}" 确保幂等性

跳过条件（skipped）：
- l1Summaries.length < 2：不足 2 个 L1 摘要

### L3 摘要 (Session Summarization)
**触发方式**：Server 端 `syncEngine` 调用 `queuePublisher.sendSessionSummary()`

触发条件：
- 手动调用（例如 session 创建时、archiving 时）
- singletonKey = "session:{sessionId}" 确保幂等性

数据源优先级：
1. 优先使用 L2 摘要（if exists）
2. 降级到 L1 摘要
3. 没有摘要则 skip

输出：
- upsert 到 session_summaries (level=3, session_id 唯一)

---

## 2. 数据库表结构

### `session_summaries` 表（完整 DDL）

```sql
CREATE TABLE session_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    level SMALLINT NOT NULL,
    seq_start INTEGER,
    seq_end INTEGER,
    parent_id TEXT,
    summary TEXT NOT NULL,
    metadata JSONB,
    created_at BIGINT NOT NULL DEFAULT (now()::bigint * 1000)
);

CREATE UNIQUE INDEX idx_ss_dedup ON session_summaries(session_id, level, seq_start) WHERE level IN (1, 2);
CREATE UNIQUE INDEX idx_ss_l3_unique ON session_summaries(session_id) WHERE level = 3;
CREATE INDEX idx_ss_session_level ON session_summaries(session_id, level);
CREATE INDEX idx_ss_created ON session_summaries(created_at DESC);
```

### `summarization_runs` 表（执行日志）

```sql
CREATE TABLE summarization_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    level SMALLINT NOT NULL,
    job_id TEXT,
    job_name TEXT,
    job_family TEXT,
    job_version INTEGER,
    idempotency_key TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    worker_host TEXT,
    worker_version TEXT,
    queue_schema TEXT,
    retry_count INTEGER,
    retry_limit INTEGER,
    cache_hit BOOLEAN,
    provider_name TEXT,
    provider_model TEXT,
    provider_status INTEGER,
    provider_request_id TEXT,
    provider_finish_reason TEXT,
    error_code TEXT,
    error TEXT,
    metadata JSONB,
    created_at BIGINT NOT NULL DEFAULT (now()::bigint * 1000)
);

CREATE INDEX idx_sr_session ON summarization_runs(session_id, level);
CREATE INDEX idx_sr_idempotency_key ON summarization_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

---

## 3. 幂等性机制（singletonKey 生成规则）

### 规则

L1 (summarize-turn)：
idempotencyKey = `${sessionId}:${userSeq}:v${SUMMARIZE_TURN_JOB_VERSION}`

L2 (summarize-segment)：
singletonKey = `segment:${sessionId}`
idempotencyKey = singletonKey

L3 (summarize-session)：
singletonKey = `session:${sessionId}`
idempotencyKey = singletonKey

---

## 4. Catch-up 机制（孤儿 L1 扫描）

作用：定期扫描未被聚合的 L1 摘要，自动触发 L2 摘要生成。

条件：
- parent_id IS NULL：L1 未被 L2 聚合
- created_at < cutoff：超过 10 分钟未被处理
- COUNT(*) >= l2SegmentThreshold：至少有 5 个孤儿 L1

启动时运行一次，后续每隔 config.catchupIntervalMs 运行一次（默认 1 小时）

---

## 5. Worker 配置（pg-boss）

### 队列名与版本

SUMMARIZE_TURN = 'summarize-turn'
SUMMARIZE_SEGMENT = 'summarize-segment'
SUMMARIZE_SESSION = 'summarize-session'
JOB_FAMILY = 'session-summary'

### 重试策略

L1: retryLimit=4, retryDelay=15s, retryBackoff=true, retryDelayMax=300s
L2: retryLimit=4, retryDelay=30s, retryBackoff=true, retryDelayMax=600s
L3: retryLimit=3, retryDelay=60s, retryBackoff=true, retryDelayMax=900s

---

## 6. 环境变量列表

### 数据库配置
PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_BOSS_SCHEMA, PG_SSL

### LLM 配置
DEEPSEEK_API_KEY (必需)
DEEPSEEK_BASE_URL (default: https://api.deepseek.com)
DEEPSEEK_MODEL (default: deepseek-chat)
DEEPSEEK_TIMEOUT_MS (default: 60000, min: 5000)

### Worker 配置
WORKER_CONCURRENCY (default: 1)
SUMMARIZATION_RUN_RETENTION_DAYS (default: 30)
L2_SEGMENT_THRESHOLD (default: 5)
CATCHUP_INTERVAL_MS (default: 3600000)

---

## 7. DeepSeek Client 接口

### 公开方法

async summarizeTurn(input: SummarizeTurnInput): Promise<L1SummaryResult>
async summarizeSegment(input: SummarizeSegmentInput[]): Promise<LLMSummaryResult>
async summarizeSession(input: SummarizeSummaryInput[], sourceLevel: 1 | 2): Promise<LLMSummaryResult>

### 返回类型约束

- summary: 最多 1500 字符
- topic: 最多 80 字符
- tools: 最多 20 项，每项最多 120 字符
- entities: 最多 30 项，每项最多 160 字符
- tokensIn/tokensOut: 可为 null
- provider: ProviderTelemetry

### ProviderTelemetry 结构

{
    provider: "deepseek",
    model: string | null,
    statusCode: number | null,
    requestId: string | null,
    finishReason: string | null,
    errorCode: string | null
}

---

## 8. summarizeTurnQueue 工作方式

### 接口

interface SummarizeTurnQueuePublisher {
    send(queueName, payload, options): Promise<unknown>
    sendSessionSummary(sessionId, namespace): Promise<unknown>
    stop(): Promise<void>
}

### 工作流程

1. Server 检测到新消息（seq = userSeq）
2. 调用 queuePublisher.send(QUEUE.SUMMARIZE_TURN, jobData)
3. pg-boss 将任务写入数据库
4. Worker 从 summarize-turn 队列轮询任务
5. Worker 执行 handleSummarizeTurn()
6. 成功时，插入 L1 摘要 + 尝试 enqueueSegmentIfNeeded()
7. 失败时，pg-boss 自动重试

---

## 9. 已有的测试文件

worker/src/config.test.ts
worker/src/db/sessionStore.test.ts
worker/src/handlers/summarizeTurn.test.ts
worker/src/handlers/summarizeSegment.test.ts
worker/src/handlers/summarizeSession.test.ts
worker/src/jobs/core.test.ts
worker/src/llm/deepseek.test.ts
worker/src/llm/errors.test.ts

框架：vitest，支持 mock 和异步

---

## 10. 快速参考表

| 项目 | 值 |
|------|-----|
| L1 队列名 | summarize-turn |
| L2 队列名 | summarize-segment |
| L3 队列名 | summarize-session |
| L2 触发阈值 | 5 (configurable) |
| Catch-up 扫描孤儿年龄 | 10 分钟 |
| L1 重试次数 | 4 |
| L2 重试次数 | 4 |
| L3 重试次数 | 3 |
| L1 重试延迟 | 15s (初始) |
| summary 最大长度 | 1500 |
| topic 最大长度 | 80 |
| 最大 tools | 20 |
| 最大 entities | 30 |
| L1 trivial 阈值 | 200 字符（assistantText） |
| 最小实际消息数 | 2 |
| 最小 L1 用于 L2 | 2 |
| L3 trivial 阈值 | < 6 source summaries (L1 only) |

---

## 核心文件位置

- DB Schema：server/src/store/session-summaries-ddl.ts
- Worker Config：worker/src/config.ts
- Job Definitions：worker/src/jobs/summarizeTurn.ts
- Handler Logic：worker/src/handlers/*.ts
- LLM Client：worker/src/llm/deepseek.ts
- Queue Publisher：server/src/sync/summarizeTurnQueue.ts
- Catch-up Logic：worker/src/index.ts
- Existing Tests：worker/src/**/*.test.ts
