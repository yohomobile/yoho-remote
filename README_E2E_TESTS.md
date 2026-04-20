# 🚀 yoho-remote 端到端集成测试文档

本项目为 yoho-remote 摘要系统（L1→L2→L3）编写端到端集成测试提供完整参考资料。

## 📚 文档列表

| 文档 | 大小 | 用途 | 何时使用 |
|------|------|------|---------|
| **E2E_INTEGRATION_TEST_REFERENCE.md** | 7.8K | 系统设计全面参考 | 需要理解系统架构、表结构、接口签名 |
| **E2E_TEST_SNIPPETS.md** | 16K | 可复制粘贴的代码模板 | 编写测试时复制初始化代码、mock 工厂 |
| **INTEGRATION_TEST_CHECKLIST.md** | 7.4K | 测试场景检查清单 | 开发过程中逐项检查测试覆盖 |
| **E2E_TEST_OVERVIEW.txt** | 13K | 快速导航和数据表 | 首次阅读，快速了解全景 |
| **README_E2E_TESTS.md** | 本文 | 文档导航 | 不知道从哪开始 |

## 🎯 快速开始

### 第一次接触这个项目？

1. **阅读 E2E_TEST_OVERVIEW.txt**
   - 了解 4 份文档的组织结构
   - 查看"关键数据速查"表（L1/L2/L3 阈值、队列配置、错误分类）
   - 理解"快速开始流程"的 5 个步骤

2. **理解系统核心**
   - 阅读 E2E_INTEGRATION_TEST_REFERENCE.md 的第 1-3 节
   - 学习 L1/L2/L3 的触发条件、表结构、幂等性机制

3. **开始写代码**
   - 从 E2E_TEST_SNIPPETS.md 复制初始化函数和 mock 工厂
   - 参考片段 7-10 编写各层的测试用例

### 已经有测试框架，想补充集成测试？

1. **查看 INTEGRATION_TEST_CHECKLIST.md**
   - 找到"L1 测试场景"、"L2 触发测试"等相关部分
   - 逐项检查现有测试是否覆盖

2. **参考 E2E_TEST_SNIPPETS.md 的对应片段**
   - 例如：需要 L2 测试 → 查看"L2 触发测试"片段

3. **跨越文档使用**
   - 遇到环境变量问题 → E2E_INTEGRATION_TEST_REFERENCE.md 第 6 节
   - 遇到错误代码问题 → CHECKLIST "错误代码清单"

## 🗂️ 文档内容速查

### 需要什么信息？

**数据库表结构和字段**
  - → E2E_INTEGRATION_TEST_REFERENCE.md 第 2 节

**L1/L2/L3 的触发条件和阈值**
  - → E2E_TEST_OVERVIEW.txt "关键数据速查" 或 REFERENCE.md 第 1 节

**幂等性 key 如何生成**
  - → REFERENCE.md 第 3 节（完整）或 OVERVIEW.txt（快速）

**pg-boss 队列配置（重试次数、延迟等）**
  - → OVERVIEW.txt "pg-boss 队列配置" 表（快速）或 REFERENCE.md 第 5 节（详细）

**所有环境变量**
  - → REFERENCE.md 第 6 节 或 E2E_TEST_SNIPPETS.md 片段 1

**DeepSeek client 方法签名**
  - → REFERENCE.md 第 7 节

**完整的测试代码示例**
  - → E2E_TEST_SNIPPETS.md 片段 7-10

**错误处理和错误代码**
  - → OVERVIEW.txt "错误分类" 或 CHECKLIST "错误代码清单"

**Catch-up 机制**
  - → REFERENCE.md 第 4 节（详细）或 CHECKLIST "Catch-up 机制测试"

**如何 mock DeepSeek**
  - → E2E_TEST_SNIPPETS.md 片段 5 或 REFERENCE.md 第 7 节

## 🛠️ 常见开发任务

### 编写 L1 handler 测试

1. 阅读 REFERENCE.md 第 1 节了解触发条件
2. 复制 E2E_TEST_SNIPPETS.md 的初始化代码（片段 1-6）
3. 参考片段 7 的 L1 测试模板
4. 用 CHECKLIST "L1 测试场景"逐项验证

### 测试 L1→L2 集成

1. 先完成 L1 测试（上面的步骤）
2. 参考 SNIPPETS 片段 8 "L2 触发测试"
3. 检查 boss.send() 被正确调用（queue、idempotencyKey、singletonKey）
4. 验证 L1.parent_id 被更新

### 添加缓存测试

1. 查看 REFERENCE.md 第 1 节"缓存命中条件"
2. 参考 SNIPPETS 片段 9
3. 插入 error_transient 记录 + metadata.cached_result
4. 验证 getLatestCachedL1Result() 返回缓存
5. 确认 LLM 未被调用（mock 检查）

### 测试 Catch-up 机制

1. 阅读 REFERENCE.md 第 4 节或 OVERVIEW.txt Catch-up 规则
2. 参考 SNIPPETS 片段 10
3. 创建旧的孤儿 L1（created_at > 10min ago）
4. 运行 runCatchup()
5. 验证 boss.send(QUEUE.SUMMARIZE_SEGMENT) 被调用

### 验证错误处理

1. 查看 CHECKLIST "错误代码清单" 了解分类
2. 根据错误类型查看对应的测试场景
3. 验证 summarization_runs 的 status、error_code、metadata 字段
4. 检查是否触发重试（transient）或直接返回（permanent）

## 📊 系统架构速查

### L1 → L2 → L3 流程图

```
User sends message (seq=userSeq)
        ↓
Server calls queuePublisher.send(SUMMARIZE_TURN, jobData)
        ↓
Worker dequeues L1 task
        ↓
handleSummarizeTurn()
  ├─ Check message validity
  ├─ Call DeepSeek
  ├─ Insert L1 summary
  └─ Call enqueueSegmentIfNeeded() ─────┐
                                        ↓
                        If countUnassignedL1 >= threshold
                                        ↓
                        Send SUMMARIZE_SEGMENT job
                                        ↓
                        Worker dequeues L2 task
                                        ↓
                        handleSummarizeSegment()
                          ├─ Fetch unassigned L1s
                          ├─ Call DeepSeek
                          └─ Insert L2 + update L1.parent_id
                                        ↓
                        (Optionally triggered by server)
                                        ↓
                        Server calls sendSessionSummary()
                                        ↓
                        Worker dequeues L3 task
                                        ↓
                        handleSummarizeSession()
                          ├─ Fetch L2s or L1s
                          ├─ Call DeepSeek
                          └─ Upsert L3 summary
```

### 数据库关键字段

| 表 | 关键字段 | 用途 |
|----|---------|------|
| session_summaries | id, session_id, level, seq_start, parent_id, summary | 存储三层摘要 |
| summarization_runs | session_id, level, status, idempotency_key, job_name | 记录执行日志 |

### 队列和重试

| 队列 | 重试 | 延迟 | 特点 |
|------|------|------|------|
| summarize-turn | 4 | 15s | 逐个 user seq |
| summarize-segment | 4 | 30s | 同一 session singleton |
| summarize-session | 3 | 60s | 同一 session singleton |

## 🎓 学习路径

**初级（理解系统）**
1. E2E_TEST_OVERVIEW.txt
2. REFERENCE.md 第 1-3 节
3. OVERVIEW.txt "关键数据速查"表

**中级（编写简单测试）**
1. SNIPPETS 片段 1-7（初始化和 L1 测试）
2. CHECKLIST "基础设置" + "L1 测试场景"
3. 修改示例代码适应自己的需求

**高级（完整集成测试）**
1. SNIPPETS 片段 8-10（L2、Catch-up）
2. CHECKLIST "幂等性测试" + "Catch-up 机制测试"
3. REFERENCE.md 第 4、5 节（深度理解）
4. 测试缓存、错误重试、边界情况

## ✅ 最终检查清单

编写完测试后，用这个清单确保覆盖完整：

- [ ] L1 成功路径和 3 种跳过场景
- [ ] L1 缓存命中和未命中
- [ ] L1→L2 自动触发（>= 5 个 L1）
- [ ] L2 成功和跳过（< 2 个 L1）
- [ ] L3 手动触发 + 优先级（L2 > L1）
- [ ] Catch-up 扫描（10 分钟旧孤儿）
- [ ] 幂等性：相同 idempotencyKey 只产生一条摘要
- [ ] 错误重试：transient 重试，permanent 不重试
- [ ] 数据库约束：UNIQUE 索引、FK 关系
- [ ] 边界情况：NULL seqStart、空消息数组、超长文本截断

## 🔗 外部资源

- **现有测试文件**：`worker/src/**/*.test.ts`（参考代码风格）
- **主要源文件**：
  - `worker/src/handlers/summarize*.ts`（L1/L2/L3 逻辑）
  - `worker/src/db/summaryStore.ts`（数据库操作）
  - `server/src/sync/summarizeTurnQueue.ts`（队列发送）
  - `worker/src/boss.ts`（队列定义）

---

**快速链接**：需要什么 → 看表 → 跳转文档 → 完成！

祝你编写高质量的集成测试！🎉
