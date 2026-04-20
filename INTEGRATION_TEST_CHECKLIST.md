# 集成测试编写检查清单

快速参考表，确保没有遗漏关键细节。

## ✅ 基础设置

- [ ] 创建测试数据库连接 pool（pg.Pool）
- [ ] 运行 `initTestDatabase()` 创建所有表（sessions, session_messages, session_summaries, summarization_runs）
- [ ] 初始化 WorkerContext（pool, boss mock, stores, deepseek client mock）
- [ ] 创建测试 session 并插入初始消息

## ✅ L1 (summarize-turn) 测试场景

### 成功路径
- [ ] Turn 包含 >= 2 条实际活动消息
- [ ] 第一条消息是 role='user' + type='text'（isTurnStartUserMessage）
- [ ] Assistant 回复长度 >= 200 字符 OR 包含 tool_use
- [ ] DeepSeek 返回有效 JSON 响应
- [ ] L1 摘要被插入到 session_summaries（level=1）
- [ ] 运行记录被插入到 summarization_runs（status='success'）

### 跳过场景
- [ ] realMessageCount < 2 → status='skipped', error_code='insufficient_real_messages'
- [ ] assistantText < 200 chars && no tools → status='skipped', error_code='trivial_turn'
- [ ] Turn 开始 message 不是 user text → error_code='invalid_turn_start_message'
- [ ] Session 在 thinking 状态 → error_code='session_still_thinking' (transient)
- [ ] Session 不存在 → error_code='session_not_found' (permanent)

### 缓存命中
- [ ] 缓存条件：status='error_transient' + metadata.cached_result exists
- [ ] 查询条件：session_id + level=1 + job_name + job_version + metadata->>'seq_start' = userSeq
- [ ] 缓存命中时：cacheHit=true，不调用 LLM
- [ ] 缓存未命中：正常调用 DeepSeek

### 重试与错误
- [ ] LLM 调用失败 → 保存 cached_result，记录 status='error_transient'
- [ ] 持久性错误（400/401/permission）→ status='error_permanent'，不重试
- [ ] 暂时性错误（网络/超时/5xx）→ status='error_transient'，pg-boss 重试 4 次

## ✅ L2 (summarize-segment) 测试场景

### 触发条件
- [ ] 调用 `enqueueSegmentIfNeeded()` 时，countUnassignedL1 >= threshold
- [ ] idempotencyKey = `segment:{sessionId}`（singleton 模式）
- [ ] 通过 boss.send() 发送任务到 QUEUE.SUMMARIZE_SEGMENT

### 成功路径
- [ ] 获取所有 unassigned L1（parent_id IS NULL）
- [ ] L1 数量 >= 2
- [ ] 调用 DeepSeek summarizeSegment()
- [ ] L2 摘要被 insertL2()（可能 skipped 如果 CONFLICT）
- [ ] 更新 L1s 的 parent_id = L2.id（markL1sAsSegmented）
- [ ] 运行记录 status='success'

### 跳过场景
- [ ] L1 数量 < 2 → status='skipped', error_code='insufficient_l1_summaries'
- [ ] countUnassignedL1 < threshold → enqueueSegmentIfNeeded() 返回，不发送

### 重试与错误
- [ ] LLM 失败 → 保存 cached_summary，status='error_transient'
- [ ] 数据库写入失败 → status='error_transient'
- [ ] 重试策略：4 次，初始延迟 30s，最大 600s

## ✅ L3 (summarize-session) 测试场景

### 触发条件
- [ ] 手动调用 `queuePublisher.sendSessionSummary(sessionId, namespace)`
- [ ] idempotencyKey = `session:{sessionId}`（singleton 模式）

### 成功路径
- [ ] 优先使用 L2 摘要（getSegmentSummaries）
- [ ] 无 L2 则降级到 L1（getTurnSummaries）
- [ ] 源摘要数 > 0
- [ ] 调用 DeepSeek summarizeSession(summaries, sourceLevel)
- [ ] L3 被 upsertL3()（ON CONFLICT DO UPDATE）
- [ ] 运行记录 status='success'

### 跳过场景
- [ ] 无 L2 且无 L1 → status='skipped', error_code='no_source_summaries'
- [ ] Session 不存在 → status='skipped', error_code='session_not_found'

### 关键点
- [ ] sourceLevel=1 && source_count < 6 → metadata.trivial=true
- [ ] sourceLevel=2 → metadata.trivial=false（不检查数量）

## ✅ Catch-up 机制测试

- [ ] 创建 5+ 旧 L1（created_at > 10 分钟前）
- [ ] 所有 L1 都是 parent_id IS NULL（未被聚合）
- [ ] 运行 `runCatchup()`
- [ ] 应自动调用 `enqueueSegmentIfNeeded()` 对匹配的 session
- [ ] boss.send() 被调用，QUEUE.SUMMARIZE_SEGMENT

## ✅ 幂等性测试

### L1 幂等性
- [ ] idempotencyKey = `{sessionId}:{userSeq}:v1`
- [ ] 相同 key 多次调用，只产生一条 L1 摘要（CONFLICT ON ... DO NOTHING）
- [ ] 运行记录多条，但 L1 摘要只有一条

### L2 幂等性
- [ ] singletonKey = `segment:{sessionId}`
- [ ] pg-boss singleton 模式确保同一时间只有一个任务 pending
- [ ] 多次 enqueueSegmentIfNeeded() → boss 队列中同一 sessionId 只有一个任务

### L3 幂等性
- [ ] singletonKey = `session:{sessionId}`
- [ ] upsertL3() 使用 ON CONFLICT DO UPDATE
- [ ] 多次发送 → L3 摘要被更新，不创建新记录

## ✅ 数据库约束验证

- [ ] session_summaries.metadata 是 JSONB，能存储任意结构
- [ ] session_summaries (level=1,2) 有 UNIQUE 索引 ON (session_id, level, seq_start)
- [ ] session_summaries (level=3) 有 UNIQUE 索引 ON (session_id)
- [ ] session_summaries.parent_id 引用同表，支持 L1→L2 链接
- [ ] summarization_runs 记录完整执行上下文（tokens、provider、retry 等）

## ✅ 错误处理与日志

### 运行记录字段检查
- [ ] job_id, job_name, job_version 来自 job metadata
- [ ] idempotency_key 用于去重
- [ ] status: 'success' | 'error_transient' | 'error_permanent' | 'skipped'
- [ ] duration_ms: startedAt 到 completedAt 的耗时
- [ ] tokens_in/tokens_out: LLM 返回的 token 数
- [ ] provider_*: DeepSeek 返回的遥测数据
- [ ] error_code: 自定义错误分类
- [ ] metadata: 执行上下文（seq_start、message_count、cache_hit 等）

### 错误代码清单
- `session_not_found` → permanent
- `session_still_thinking` → transient
- `turn_incomplete_mid_tool_use` → transient
- `insufficient_real_messages` → skipped
- `trivial_turn` → skipped
- `insufficient_l1_summaries` → skipped
- `no_source_summaries` → skipped
- `cache_hit` → skipped（metadata.provider_skipped_reason）

## ✅ 边界情况

- [ ] 消息序列号有间隙（e.g., seq 1,3,5）→ 仍计为有效 turn
- [ ] 文本截断（userText > 4000, assistantText > 8000）→ handler 截断后传给 LLM
- [ ] 响应数组包含多个 content 块 → extractContentText() 合并为一个字符串
- [ ] metadata 中 tools/entities 重复 → normalizeStringArray() 去重
- [ ] seqStart/seqEnd 为 NULL（如 L3）→ insertL2() 支持 NULL
- [ ] 批量更新（markL1sAsSegmented）→ 空列表时直接返回

## ✅ 清理和 Teardown

- [ ] 删除插入的 sessions（CASCADE 自动删除 messages/summaries/runs）
- [ ] 关闭 pool 连接
- [ ] 验证 mock 调用次数（如需要）
- [ ] 清除 vi.fn() 的记录（mockClear）

## ✅ 配置验证

环境变量（来自 .env.test）：
- [ ] PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_BOSS_SCHEMA
- [ ] DEEPSEEK_API_KEY (mock)
- [ ] L2_SEGMENT_THRESHOLD (default: 5)
- [ ] CATCHUP_INTERVAL_MS (default: 3600000)
- [ ] SUMMARIZE_TURN_RETRY_LIMIT (default: 4)
- [ ] 其他 retry 参数

loadConfig() 确保：
- [ ] 必需变量存在
- [ ] 数值范围有效（L2_SEGMENT_THRESHOLD >= 2）
- [ ] 连接字符串正确构建

## ✅ 集成测试命令

```bash
# 单个测试文件
npm test -- worker/src/handlers/summarizeTurn.test.ts

# 所有 handler 测试
npm test -- worker/src/handlers/

# 覆盖率报告
npm test -- --coverage worker/src/

# 监听模式（开发）
npm test -- --watch worker/src/handlers/
```

---

**最后检查**：运行所有 E2E 测试，确保从 L1→L2→L3 的完整流程能正确执行，数据库一致性保持，错误处理符合预期。
