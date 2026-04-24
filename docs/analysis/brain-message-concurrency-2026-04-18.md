# Brain 消息并发模型排查

生成时间：2026-04-18

## 结论先看

- 同一 brain session 下，`用户消息`、`child callback`、`渠道/系统消息` 最终都走到 `SyncEngine.sendMessage()`，并以 `role=user` 写进同一张 `messages` 表。
- 入库顺序由 `messages.seq` 决定，而 `seq` 是按同一 session 的数据库事务提交顺序串行分配的，不区分来源优先级。
- CLI 侧消费时只看 `role=user` 和 `seq`，**不看 `meta.sentFrom`**；因此 child callback 和普通用户消息会进入同一个 `MessageQueue2`。
- `MessageQueue2` 会把**同 modeHash** 的连续消息拼成一个 prompt 批次，所以 callback 和用户消息可能被合并消费。
- 当前最严重缺陷不是“会混流”，而是：**abort 会 `queue.reset()`，把已经到达但尚未处理的 callback/user 消息直接清掉**。这些消息仍在 DB，但当前运行中的 agent 不会再看到，因为客户端的 `lastSeenMessageSeq` 已经前移。

## 当前链路图

### 1. 用户消息 / 渠道消息

```text
Web/IM/卡片动作
  -> BrainBridge.onMessage / onCardAction
  -> BrainBridge.flushIncomingMessages
  -> SyncEngine.sendMessage(sessionId, { sentFrom: webapp|feishu..., meta })
  -> store.addMessage(sessionId, role=user, seq=next)
  -> socket update { t: "new-message" }
  -> ApiSessionClient.handleIncomingMessage
  -> enqueueUserMessage
  -> session.onUserMessage
  -> MessageQueue2.push
  -> launcher nextMessage / waitForMessagesAndGetAsString
  -> agent prompt
```

### 2. 子 session callback

```text
brain-child thinking=true -> false
  -> SyncEngine.emitTaskCompleteEvent
  -> SyncEngine.sendBrainCallbackIfNeeded
  -> SyncEngine.sendMessage(mainSessionId, { sentFrom: "brain-callback", meta.brainChildCallback })
  -> store.addMessage(mainSessionId, role=user, seq=next)
  -> socket update { t: "new-message" }
  -> ApiSessionClient.handleIncomingMessage
  -> enqueueUserMessage
  -> session.onUserMessage
  -> MessageQueue2.push
  -> agent prompt
```

### 3. agent 输出 / Brain 对外回复

```text
agent stdout / SDK event
  -> cli socket "message"
  -> server socket handler
  -> store.addMessage(sessionId, role=agent, seq=next)
  -> SyncEngine emit message-received
  -> BrainBridge.handleSyncEvent 累积 agentMessages
  -> thinking=false 时 BrainBridge.sendSummary
  -> 发到 Feishu/Web
```

## 现在的排序与消费语义

### 入库排序

- `server/src/store/postgres.ts` 的 `addMessage()` 会先 `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`，然后取 `MAX(seq)+1`。
- 这保证同一 session 的 `seq` 严格单调，但顺序只等于**事务提交顺序**，不等于“谁先在业务上发生”。
- 因此，用户消息与 callback 同时到来时，最终谁排前面取决于谁先拿到 session 行锁。

### CLI 消费排序

- `ApiSessionClient.handleIncomingMessage()` 只要看到 `role=user`，就会 `enqueueUserMessage()`。
- 它只用 `seq` 去重，不会按 `sentFrom` 做 source-aware 分流。
- `MessageQueue2` 再把相同 modeHash 的相邻消息拼成一个批次。
- 对 brain session 而言，普通用户消息和 `brain-callback` 默认 mode 基本一致，所以天然会被合批。

## 竞态点

### 竞态 1：callback 与用户消息并发写入，同 session 只按 commit 顺序排

- 现象：多条 child callback 和一条用户消息同时写进同一个 brain session 时，顺序由 DB 提交顺序决定。
- 风险：不是“随机丢”，但对 agent 来说可能出现“用户明明是后来补充的纠偏，却被排在几条 callback 前/后”的语义错位。

### 竞态 2：callback 与用户消息被合并成同一批 prompt

- 现象：callback 是 `role=user`，用户消息也是 `role=user`；modeHash 相同就会被 `MessageQueue2` 拼接。
- 风险：agent 会在一次 prompt 里同时收到：
  - 多个 child callback
  - 一条新的用户指令
  - 甚至渠道卡片动作文本
- 结果不是重复消费，而是“来源边界丢失”，模型必须自己从自然语言里分辨哪些是 callback，哪些是人类新输入。

### 竞态 3：IM Brain 忙时，用户纠偏触发 abort；已到达但未消费的 callback 可能被清空

- 路径：
  - child callback 已经通过 `SyncEngine.sendMessage()` 写库并推到 CLI
  - CLI 已经把 callback 放进 `session.queue`
  - 用户在同一 IM chat 里发一条 addressed 消息
  - `BrainBridge.onMessage()` 因为 chat busy，调用 `syncEngine.abortSession()`
  - Claude/Codex launcher 的 abort handler 会 `session.queue.reset()`
- 风险：
  - queue 里的 callback 被清掉
  - 当前进程内不会再消费这些 callback
  - 但 `ApiSessionClient.lastSeenMessageSeq` 已经前移，正常情况下也不会再 backfill 回来

### 竞态 4：callback 没有“已投递到主 brain”幂等标记

- `sendBrainCallbackIfNeeded()` 没有 per-child/per-result 的 delivered marker。
- 现在主要靠 `thinking -> false` 的 cooldown 避免短时间重复 callback。
- 如果 child session 在更长时间窗内再次触发一次 task-complete，理论上存在重复回注的空间。

## 最关键缺陷

## 缺陷 1：abort 会静默丢掉未消费的 callback

- 严重度：高
- 影响：
  - Brain 正在处理某轮任务时，child callback 已到达但还没被主 brain 消费。
  - 此时用户又发一条纠偏消息，IM Brain 会 abort 当前轮。
  - abort 直接 `queue.reset()`，把 callback 一起清掉。
- 结果：
  - DB 里有这条 callback
  - 当前进程不会再处理它
  - 主 brain 对 child 完成结果“失忆”

## 缺陷 2：不同来源输入没有 source-aware 隔离，callback 与用户消息会被合批

- 严重度：高
- 影响：
  - callback 风暴时，agent 可能一次吃进很多条 `[子 session 任务完成]...`
  - 用户新消息如果也在同一时间窗内到达，会被拼进同一个 prompt
- 结果：
  - 不一定丢消息，但会显著放大提示噪音和语义混叠
  - 用户以为自己“打断并改派”了，其实模型收到的是“若干 callback + 新消息”的混合输入

## 缺陷 3：跨来源顺序没有业务优先级，只有 DB commit 顺序

- 严重度：中
- 结果：
  - 在多 callback + 用户消息并发时，session 内的因果顺序不稳定
  - 前端和 CLI 看到的是严格 seq，但 seq 不表达“谁应该优先让 agent 处理”

## 建议修复点

### 修复 1：abort 不要无条件 `queue.reset()`

- 最低限度做法：
  - 只丢弃“当前被中断那一轮”之前尚未消费的**同源用户消息**
  - 对 `brain-callback` 保留队列，或迁移到单独的 callback backlog
- 更稳妥做法：
  - `MessageQueue2` 支持按 source 分类清理
  - abort 时只清理 `interactive-user`，不清理 `brain-callback`

### 修复 2：把 callback 从普通 user message 流里拆出来

- 方向：
  - 仍可写入 `messages` 表供 UI 展示
  - 但 CLI 侧消费不要再把 `sentFrom=brain-callback` 走普通 `onUserMessage -> MessageQueue2.push`
  - 改成独立 callback queue / isolate queue / session event queue
- 目标：
  - callback 可以逐条消费
  - callback 不与用户消息自然拼接

### 修复 3：给 callback 加幂等投递标记

- 方向：
  - 以 `(childSessionId, resultSeq)` 或 callback envelope hash 做 delivered key
  - 主 brain 已收过同一 callback 时，后续重复 task-complete 不再重新注入

### 修复 4：为 brain session 引入 source-aware batching 策略

- 建议规则：
  - `brain-callback` 默认 `isolate`
  - `webapp/IM 用户消息` 可继续按 modeHash 合批
  - 如果同一时刻既有 callback 又有用户新消息：
    - 先决定是否用户消息优先
    - 或先消费 callback backlog，再消费用户消息
  - 这个决策应显式编码，而不是依赖自然到达顺序

### 修复 5：补回归测试

- 最关键的最小回归：
  - child callback 已入 queue、未处理
  - 用户消息触发 abort
  - 断言 abort 后 callback 仍可被后续一轮消费，而不是静默消失
- 第二类回归：
  - callback + 用户消息同批到达
  - 断言不会被默认拼成同一 prompt，或至少拼接规则可控、可测试

## 当前最小复现证据

- `cli/src/api/apiSession.test.ts`
  - 已补一条测试，证明 `brain-callback` 和普通 `webapp` 消息在 `ApiSessionClient` 里都被当成同类 queueable user input。
- `cli/src/utils/MessageQueue2.test.ts`
  - 现有测试已证明相同 modeHash 的消息会被自动合批。

把这两点和 launcher 的 `abort -> queue.reset()` 拼起来，就是当前最关键的并发问题。
