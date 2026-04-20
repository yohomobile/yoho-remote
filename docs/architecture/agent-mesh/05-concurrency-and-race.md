# 05 · 竞态专题（Concurrency & Race Treatment）

> 这篇独立拆出来，是因为「群聊持续发消息 + AI 任务运行中 + 多 runtime 并存」的组合下，**并发正确性是最容易被口头设计忽略、也是最容易线上炸**的一层。

## 5.1 问题空间分类

| 维度 | 现状已有机制 | 新增需求 |
| --- | --- | --- |
| 入站幂等 | Feishu 60s messageId 去重、卡片动作 2s 去重 | 跨 channel 统一、持久化去重（不靠进程内 Set） |
| 消息排队 | addressed 3s / passive 20s debounce + buffer merge | 跨 runtime 一致的 turn 概念、背压 |
| Busy 管理 | `chatStates.busy` bool + `busySinceAt` + 10min watchdog | 状态机化（idle/busy/manual/aborting） |
| 打断/取消 | `shouldAbortBusyBrainTurn` 文本匹配 + `syncEngine.abortSession` | 权限判定（谁可以打断）+ abort 确认 |
| 流式输出 | `sendPostAndGetId` + 10s throttle edit + 3 次上限 | 跨平台 capability 感知的流式 |
| 最终 summary | `sendSummary` + DB tail fallback + lastDeliveredSeq 水位 | 多 runtime 的 tail 源统一 |
| 人工接管 | 无 | `manual` 状态 + 接管/释放协议 |
| 崩溃恢复 | 启动扫 busy + agentMessages → `chatsToRecover` | 多平台一视同仁 + 幂等恢复 |
| 多群并发 | per-chat 独立 state | 无显式锁，沿用 per-chat 串行 |
| 跨 runtime 竞态 | 无 | 切换 runtime 的 lease / 不允许双绑 |

## 5.2 状态机：ChatStateMachine

取代现在的 `chatStates.busy` 布尔值和散的 `creating` / `lastBatchPassive` 标志。

```
        ┌──────────── finalize / closed ─────────────┐
        │                                            │
   ┌────▼────┐   inbound+flush     ┌──────────┐      │
   │  idle   ├────────────────────►│   busy   ├──────┘
   │         │                     │          │
   │         │◄───── manual release┤          │──── abort ───► ┌────────────┐
   └────┬────┘                     └──────────┘                │  aborting  │
        │                                  ▲                   └─────┬──────┘
        │ admin takeover                   │                         │  aborted
        ▼                                  │                         ▼
   ┌─────────┐                             │                    ┌──────────┐
   │ manual  ├─────── release ─────────────┘                    │   idle   │
   └─────────┘                                                  └──────────┘
```

| 状态 | 入口 | 合法转换 | 行为 |
| --- | --- | --- | --- |
| `idle` | 初始 / finalize / aborted / manual release | `inbound flush → busy`；`takeover → manual` | 接受新 inbound flush |
| `busy` | flush 完成 runtime.sendMessage | `finalize → idle`；`abort → aborting`；`takeover → manual`（软打断） | 新 inbound 入 buffer，不立刻 flush；被动消息可被同一 turn 合入下一 debounce |
| `aborting` | busy + `abort` 请求发出 | `aborted event → idle`；`timeout(10s) → idle (forced)` | 不接受新 flush，缓冲入 buffer |
| `manual` | 管理员/用户手动接管 | `release → idle` | 静默：收到 runtime 事件暂存，不出站 |

**不变量**：
- 每个 chat **任一时刻只能在一个状态**。转换必须通过 `ChatStateMachine.transition(chatSessionId, from, to)`（CAS 于 DB）。
- 转换失败（CAS 未命中）意味着有并发写，直接丢弃本次 transition 意图并重新读状态。

## 5.3 幂等三层

```
inbound 幂等键:        (platform, channelId, messageId)
turn 幂等键:           turnId (uuid v7) ← MessageBridge 生成
runtime 幂等键:        (runtimeSessionId, turnId) ← RuntimeAdapter 内部保证不重发
outbound 幂等键:       (platform, channelId, chatId, turnId, replyIndex)
```

- **持久化去重**：`im_inbound_log` 的 `(platform, channelId, messageId)` UNIQUE 索引。进程内的 60s Set 只是一层 fast path。
- **turnId**：同一个 `turnId` 重试时，runtime 必须识别"已处理"直接返回（Brain 层通过 `SyncEngine.sendMessage(sessionId, {turnId})` 查重，M4/H4 由 Adapter 维护 in-flight Map）。
- **outbound 幂等**：`im_outbound_log` 的 `(platform, channelId, chatId, turnId, replyIndex)` UNIQUE；重复发送先查。

## 5.4 打断 / 取消协议

现状 `shouldAbortBusyBrainTurn` 只看文本模式。新架构补齐三件事：

1. **权限判断**（who can abort）：
   - p2p：对话双方可 abort。
   - 群聊：本轮 `turnSenders` 里的人 + 群主 + 管理员可 abort；其他人说「停」不生效，但会记到 `im_chat_audit` 作为异常信号。
2. **显式 vs 隐式意图**：
   - 正向文本（"继续"、"补充上下文"）→ 不 abort。
   - 明确打断文本（"停"、"取消"、"换个方向"） → abort。
   - 歧义 → 不 abort，改为 "加入队列"（转由 busy→busy 的 buffer 合入下一轮）。
3. **abort 两段式**：
   ```
   bridge.requestAbort(chatSession, reason):
     state: busy → aborting
     runtime.abort({sessionId, reason})
     wait for 'aborted' event OR 10s timeout
     on aborted:  state → idle; clear turn buffer
     on timeout:  state → idle (forced); mark lastAbortTimeout
   ```

## 5.5 流式与最终 summary 的竞态

**场景**：本轮 runtime 一边在发 `assistant-delta`，一边 throttle edit，消息还没 flush，thinking 突然 false（final）。

```
guard:
  1. StreamCoalescer 用 per-turn mutex 保护 edit + final flush。
  2. final flush 必须 read-modify-write lastDeliveredSeq：
     if (incomingFinal.seq <= lastDeliveredSeq) return  // stale
     sendReply(...)
     lastDeliveredSeq = incomingFinal.seq               // CAS 于 DB
  3. abort 在 aborting 状态下到达的 delta 全部丢弃。
```

**DB tail 回补**：
- 仅当 `agentMessages.last.seq < lastDeliveredSeq` 或 `agentMessages.empty` 时触发。
- tail 查询本身也要带 `seq > lastDeliveredSeq` 条件，避免重复。

**post 编辑 3 次上限**：
- 到上限后不再 edit，后续 delta 只在内存累积，等 final 一次性下发。
- 这是既有策略，延续。

## 5.6 多群并发（Per-chat 串行化）

- 每个 chat（= `im_chat_sessions.id`）是**串行边界**：入站处理、flush、runtime 调用、出站、finalize 全部 **per-chat 顺序执行**。
- 工程实现：per-chat Promise queue（内存中），同时 DB 的 `im_chat_sessions.state` 作为跨进程串行化 CAS。
- 跨 chat 无锁，天然并发。

## 5.7 跨 runtime 竞态（切换 runtime）

> ⛔ **09.1.1 / 03 章纠偏覆盖**:本节仅讨论 **hosted runtime** 之间的切换(当前 hosted 只有 brain-local,所以实操中不会触发)。形如 `/m4 换你来` 的前缀在 hosted 路径上**恒为拒绝 / no-op** —— M4 / H2 是外部 peer,没有 hosted slot 可切;router 遇到 `/m4` `/h2` 前缀应拒绝,而不是走本节的 `onSwitchRuntime` 流。

场景(仅示意 hosted↔hosted 未来可能性):用户在 busy 时明确要求切换到另一个 hosted runtime。

```
onSwitchRuntime(chatSession, newType):
  if state != idle:
      await requestAbort(chatSession, 'runtime-switch')   // 见 5.4
  acquire lease: UPDATE im_chat_sessions
                   SET runtime_type=?, runtime_session=null
                 WHERE id=? AND runtime_type=<oldType>
                 RETURNING ...
  if lease未拿到: 放弃切换（并发保护）
  close old runtime session
  state → idle（下轮 flush 时再 create）
```

不允许:同一 chat 同时有多个 **hosted runtime** session 存活(当前 hosted 只有 brain-local,故实际不会并存)。**注意**:M4 / H2 是 external peer,**永远不**在 remote 打开 session(见 09.1.1),因此"同时有 brain 和 m4 的 session"这种组合本身就不应出现 —— 不是靠 runtime-switch 来避免,而是 `runtimeType` 枚举里根本没有 m4 / h2。

## 5.8 人工接管协议

```
/takeover           → state: any → manual；runtime 事件静默缓存
/handover [ai]      → state: manual → idle；runtime 视状态 finalize 或丢弃
```

- manual 下 bridge 收到 runtime 事件不出站，但继续消费 stream（避免 runtime backpressure）。
- 接管期间的用户 inbound 也只落 `im_inbound_log`，不喂 runtime（除非用户明确用 `/brain` `/m4` 前缀发回）。
- 这是**新增能力**，现状无对应实现。

## 5.9 崩溃恢复

启动流程（每个 server 实例）：

1. `loadChatSessions(state IN ('busy','aborting'))` → `chatsToRecover`。
2. 对每个 chat：
   - 拿到 `(runtimeType, runtimeSessionId)`。
   - `runtime.healthCheck()` + 尝试 `runtime.subscribe()`。
   - 若 runtime 已完成（`SyncEngine.getSession(sid).active === false` 或 M4 `runId` 已完成）→ `finalizeTurn` + `state → idle`。
   - 若 runtime 仍活 → 重新订阅 stream，`state` 维持 `busy`，busyWatchdog 继续计时。
   - 若 runtime 消失（查不到）→ `state → idle`，清空 turn buffer，发一条"上次任务中断，已复位"提示。
3. 对 `state = 'idle'` 但 `agentMessages` 非空的 chat（当前 bug fix 覆盖的路径）→ 立刻 finalize 下发。

## 5.10 背压 / 限流

| 位置 | 策略 |
| --- | --- |
| Channel → Bridge | per-chat 令牌桶：默认 30 msg/min；超过 burn 429/忽略并在 `im_inbound_log` 标 `throttled`。 |
| Bridge → Runtime | per-runtime 全局并发上限（brain 默认 20 并发 session，M4 遵循 gateway QPS）。排队超过 5s 回退"我现在忙，稍后" |
| Runtime → Bridge | event stream 若处理不过来，StreamCoalescer 丢弃 `assistant-delta`（保留 final），保留 `tool-use/result/thinking`。|
| Bridge → Channel | adapter 的 `qpsLimit` 感知；消息队列超过 10 条触发合并（把多条 assistant 合成一条 post）。|

## 5.11 观测埋点（竞态相关）

- `im.state.transition`（from, to, chatSessionId, reason）
- `im.abort.request` / `im.abort.confirmed` / `im.abort.timeout`
- `im.takeover.start` / `im.takeover.release`
- `im.recovery.count`（启动时恢复的 chat 数）
- `im.inbound.duplicate`（去重命中）
- `im.runtime.switch`（前后 runtime、耗时）
- `im.stream.edit.count`（per turn）
- `im.stream.dropped_deltas`（背压丢弃）

## 5.12 推荐 vs 不推荐

| 选择点 | 推荐 | 不推荐 | 理由 |
| --- | --- | --- | --- |
| 状态模型 | 4 态状态机 + CAS | 多个 bool 标志 | bool 组合爆炸，bug 密集 |
| 幂等 | 持久化（DB UNIQUE） + 进程内 fast path | 仅进程内 Set | 多实例/重启就失效 |
| 打断判定 | 文本匹配 + 权限 + abort 两段式 | 只看文本 | 群聊噪音下误 abort、或 abort 卡死 |
| Runtime 切换 | lease + 显式关闭旧 session | "新 session 自然覆盖" | 事件错流，流式编辑错消息 |
| 人工接管 | 显式 manual 状态 + 静默缓存事件 | "拔插头"停订阅 | 断开会丢 event，恢复时对不上序 |
| 崩溃恢复 | 健康检查 + 三分支（完成 / 活 / 消失） | 盲重启 session | runtime 仍活时重建会出现双 session |
| 背压 | 丢 delta 保 final | 丢 final 保 delta | final 是用户真正要看的 |
| 观测 | 事件埋点 + 指标 | 只打日志 | 竞态 bug 只能靠指标发现 |
