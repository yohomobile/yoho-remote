# 04 · 端到端消息流

> ⛔ **适用范围限定**:本章描述的完整 `IM → bridge → runtime → 回复` 时序**只适用于 hosted runtime**(K1 / brain-local)。**M4 (OpenClaw)、H2 (Hermes) 不在此流中,也永远不会在此流中** —— 它们是外部 peer,有自己的入口(各自的 IM bot / CLI / cron),**永远不通过 remote bridge 接收用户消息**,也**永远不走** remote 的 StreamCoalescer 出站。没有 pilot / shadow / debug 能让这条限制松动,见 09.1.1。M4 / H2 与 remote 的交互只走 capability 接口。详见 [`09-hosted-vs-external-runtime.md`](./09-hosted-vs-external-runtime.md) 的 9.5。
>
> ⛔ **Policy 硬卡点**:本章 Step 7–8 中 RuntimeAdapter 每次 tool use / 出站副作用在**真正执行前**必须经过 PolicyGate;命中 `require_approval` 的动作本轮不再继续执行,转为提审并返回"已提交审批"提示,待 approver 批准后由 actor 重放带 `approvalToken`。`deny` 直接拒,不重试。详见 [`10-approval-and-policy.md`](./10-approval-and-policy.md) 的 10.4 / 10.5。
>
> ⚠️ 本章提到的 RuntimeAdapter 调用(Step 7–9)、`runtime_events_log`(4.4)、DB tail 恢复(4.6)全部限定 hosted runtime。外部 peer 的可观测性走 `external_capability_audit`,详见 09.8;PolicyGate 决策额外落 `policy_decision_log`、approval ticket 生命周期落 `approval_tickets` / `approval_ticket_events`,详见 10.7。

## 4.1 入站时序图（Happy Path,hosted runtime）

```
User                Channel           MessageBridge          Identity            Router          RuntimeAdapter          StreamCoalescer       Channel
 │  IM message        │                   │                    │                   │                   │                      │                   │
 ├───────────────────►│                   │                    │                   │                   │                      │                   │
 │                    │  normalize →      │                    │                   │                   │                      │                   │
 │                    │  IMMessage        │                    │                   │                   │                      │                   │
 │                    ├──────────────────►│                    │                   │                   │                      │                   │
 │                    │                   │ dedupe(messageId)  │                   │                   │                      │                   │
 │                    │                   │ resolveIdentity ──►│                   │                   │                      │                   │
 │                    │                   │◄── personSlug      │                   │                   │                      │                   │
 │                    │                   │ loadChatSession    │                   │                   │                      │                   │
 │                    │                   │ route(chatSession, ────────────────►  │                   │                      │                   │
 │                    │                   │        inbound)                        │                   │                      │                   │
 │                    │                   │◄────────────  decision(create/reuse/skip)                  │                      │                   │
 │                    │                   │ enqueue(inbound, chatSession)                              │                      │                   │
 │                    │                   │ debounce 3s/20s …                                           │                      │                   │
 │                    │                   │                    ┌───── flush turn ─────┐                │                      │                   │
 │                    │                   │                    ▼                      ▼                │                      │                   │
 │                    │                   │               ensureSession(create/reuse) ───────────────► │                      │                   │
 │                    │                   │               sendMessage(turnId, text, appendSysPrompt) ─►│                      │                   │
 │                    │                   │               subscribe → forward events ────────────────► │                      │                   │
 │                    │                   │                                                            │  events              │                   │
 │                    │                   │                                                            ├────────────────────►│                   │
 │                    │                   │                                                            │                      │ coalesce & format │
 │                    │                   │                                                            │                      ├──────────────────►│
 │                    │                   │                                                            │                      │  sendReply        │
 │                    │                   │                                                            │                      │                   ├─► User
 │                    │                   │                                                            │  thinking:false      │                   │
 │                    │                   │                                                            ├────────────────────► │                   │
 │                    │                   │                                                            │                      │ finalizeSummary   │
 │                    │                   │                                                            │                      ├──────────────────►│
 │                    │                   │  patchChatSession(state=idle, lastDeliveredSeq=…)                                 │                   │
 │                    │                   │◄───────────────────────────────── done ──────────────────────────────────────────┤                   │
```

## 4.2 关键步骤详述

### Step 1 · Channel 归一化
- Adapter 内完成：at-token 还原、markdown → plain、媒体下载、Feishu 云文档 enrich (`<feishu-doc>` 标签)、DingTalk outgoing callback 签名校验。
- 输出：`IMMessage { text, messageId, senderName, senderId, senderEmail, chatType, addressed, mentions?, attachmentRefs? }`。

### Step 2 · MessageBridge 入站闸
- **去重**：`(platform, channelId, messageId)` + 60s TTL（延续 `FeishuAdapter` 现行策略）。
- **限流**：per-chat 令牌桶，防止恶意刷屏把 runtime 拖垮。
- **审计落库**：`im_inbound_log(id, platform, chatId, messageId, rawJson, receivedAt)`。
- **namespace 绑定**：来自 channel 实例配置。

### Step 3 · IdentityResolver
- 见 `02-identity-session-mapping.md` 的 5 步流程。
- 输出 `ResolvedIdentity`，同一 inbound 对象在后面流程里一直带着。

### Step 4 · ChatSessionStore.getOrCreate
- 返回 `ChatSession { id, runtimeType, runtimeSessionId, state, lastDeliveredSeq, ... }`。
- `state` 值：
  - `idle`：空闲，可直接发起新轮。
  - `busy`：runtime 正在思考。
  - `manual`：人工接管中，bridge 静默。
  - `aborting`：刚发出 abort，等 runtime `aborted` 事件。

### Step 5 · ChatRouter.route
- 见 `03-agent-runtimes.md` 3.4。输出 4 种 action。
- `skip` 用于：`state === 'manual'`、群聊中消息未 @bot 且 namespace 策略不订阅旁听。

### Step 6 · Debounce & Turn Flush
- `addressed=true` → 3s debounce；`addressed=false`（旁听模式）→ 20s debounce。
- 同 chat 的 buffer 在 flush 时合并，每个 message 带前缀 `[指令] 姓名：...` / `[旁听模式] 姓名：...`。
- flush 时：
  ```
  turnId = uuid()
  text = mergeBuffer(buffer)
  appendSystemPrompt = buildPerTurnPrompt(personSlug, recent turn context)
  ```

### Step 7 · ensureSession + sendMessage
- 若 `runtimeSessionId == null`：
  ```
  const handle = await runtime.createSession({
      namespace, initPrompt, personSlug, metadata, preferences
  })
  chatSession.runtimeSessionId = handle.id
  chatSession.state = 'busy'
  persist()
  ```
- 否则直接 `runtime.sendMessage({ sessionId, text, turnId, appendSystemPrompt })`。
- `state → 'busy'`，`busySinceAt = now`。

### Step 8 · StreamCoalescer（事件消费）
- 订阅 `runtime.subscribe(sessionId, handler)`。
- 事件到 handler 后：
  - `assistant-delta`：累积到本轮 `streamBuffer`，按 throttle（10s 编辑一次）调 `adapter.editMessage(messageId, streamBuffer)`。
  - `assistant-final`：替换本轮 final text，等 `thinking:false` 后统一发 summary。
  - `tool-use`：根据 `capabilities.supportsCard` 选择发工具卡片或折叠。
  - `thinking: true→false`：触发 `finalizeTurn`。
- 本轮首条 assistant delta 发消息时用 `sendPostAndGetId` 取 messageId，后续编辑同一条。

### Step 9 · Finalize Turn
```
onThinkingEnd:
  agentMessages = collectPendingAgentMessages(chatSession, lastDeliveredSeq)
  if (empty && runtimeType === 'brain'):
      tail = await store.getMessagesAfter(runtimeSessionId, lastDeliveredSeq)
      agentMessages = extractFromDbTail(tail)
  summary = mergeAndFormat(agentMessages)
  actions = extractActions(summary)   // [at:...] / [edit:...] / [pin:...] 等
  await adapter.sendReply(chatId, { text: summary, ...actions })
  chatSession.lastDeliveredSeq = last(agentMessages).seq
  chatSession.state = 'idle'
  persist()
```

## 4.3 出站 meta-actions

现有 `sendSummary` 已支持 `[at:]`, `[edit:]`, `[recall:]`, `[forward:]`, `[pin:]`, `[urgent:]` 等控制标记。未来扩展：

| 标记 | 行为 | 适配器方法 | 平台兼容 |
| --- | --- | --- | --- |
| `[at: ou_xxx]` | @用户 | `sendReply.atIds` | Feishu ✅ / DingTalk ✅ / WeCom ✅ |
| `[edit: msgId newText]` | 编辑旧消息 | `editMessage` | Feishu ✅ / DingTalk ✅ / Slack ✅ |
| `[recall: msgId]` | 撤回消息 | `recallMessage` | Feishu ✅ / DingTalk ⚠️(有效期) |
| `[forward: msgId targetChatId]` | 转发 | `forwardMessage` | Feishu ✅ / 其他 ⚠️ |
| `[pin: msgId]` | 置顶 | `pinMessage` | Feishu ✅ / DingTalk ✅ |
| `[urgent: type userIds]` | 紧急通知 | `urgentMessage` | Feishu ✅ / 其他 ❌ |
| `[silent]` | 跳过发送 | (不调 adapter) | 全平台 ✅ |
| `[sticker: id]` | 表情贴纸 | `sendReply.extras` | Feishu ✅ / 其他 ❌ |

适配器通过 `capabilities.*` 声明支持情况，`OutboundFormatter` 对不支持的 meta-action **降级成提示文本或静默忽略**，不应抛错。

## 4.4 事件/数据持久化

| 数据 | 表 | 何时写 | 用途 |
| --- | --- | --- | --- |
| inbound 原始消息 | `im_inbound_log` | Step 2 | 审计、重放 |
| 归一化 IMMessage | 不落库（留在内存 turn buffer） | — | 本轮 flush 后丢弃 |
| chat session 状态 | `im_chat_sessions` | Step 4/7/9 | 崩溃恢复 |
| runtime 事件 | Brain 走 `SyncEngine.messages`；M4/H4 走 `runtime_events_log(platform, runtimeSessionId, seq, payload)` | Step 8 | 流式 fallback（从 DB tail 恢复） |
| 成功发出的 reply | `im_outbound_log(platform, chatId, messageId, text, at, action, sentAt)` | Step 9 | 审计、编辑/撤回引用 |
| 身份 | `platform_identities` | IdentityResolver | cache + 追溯 |

## 4.5 错误 & 重试

| 位置 | 错误 | 策略 |
| --- | --- | --- |
| Channel → Bridge | 重复 `messageId` | 去重，不回复 |
| Bridge → Identity | yoho-memory 超时 | 降级临时 slug（见 02.2.3） |
| Bridge → Runtime | runtime 不可用 | fallback runtime（`brain`）或友好错误回执 |
| Runtime → Bridge | `error{retryable:true}` | 退避重试 3 次，再降级 |
| Bridge → Channel | adapter 发送失败 | 指数退避 3 次；仍失败写 `im_outbound_log.state='failed'` + 告警 |
| 人工接管中 | 收到 assistant-delta | 静默缓存，state 转回 bridge 时合并发一次 |

## 4.6 DB tail 恢复（从既有 fallback 演化）

当前 `sendSummary` 已实现：内存 `agentMessages` 若落后 `lastDeliveredSeq`，从 `store.getMessagesAfter` 拉取补齐（见 `BrainBridge.test.ts:126-197`）。保留该机制，但扩展到多 runtime：

- Brain：走 `SyncEngine.messages`（现有）。
- OpenClaw：走 `runtime_events_log` 表（新建），按 `(platform, runtimeSessionId, seq)` 索引。
- Hermes：同上。

Runtime event 持久化可选：若 runtime 本身有可靠事件 ID（Brain 的 `seq` 是可靠的），可以只落「最后 N 条」做 tail；若不可靠（早期 Hermes CLI），要全量落库。

## 4.7 推荐 vs 不推荐

| 选择点 | 推荐 | 不推荐 | 理由 |
| --- | --- | --- | --- |
| 入站审计 | 原始 JSON 全量落 `im_inbound_log` | 只记 messageId | 调试跨平台 format 问题时必须看原文 |
| 流式编辑 ID 管理 | 本轮 `streamMessageId` 存在 `chatSession.metadata.currentTurn` | 进程内 Map | 重启时仍能恢复编辑 |
| 工具调用展示 | 默认折叠为一行，用户可在 per-chat preferences 打开 | 默认全展开 | 群聊里会刷屏；用户有需要再打开 |
| meta-action 扩展 | 平台不支持就静默降级 | 抛错打断本轮输出 | 一个不支持的 action 不应导致整轮失败 |
| DB tail 恢复条件 | 仅在 `agentMessages.last.seq < lastDeliveredSeq or agentMessages 空` 时触发 | 每次 finalize 都查 DB | 省一次查询 |
