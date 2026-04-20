# 03 · Agent Runtimes：K1 / M4 / H4 职责边界

> ⛔ **本章部分前提已被 [`09-hosted-vs-external-runtime.md`](./09-hosted-vs-external-runtime.md) 与 [`10-approval-and-policy.md`](./10-approval-and-policy.md) 推翻,必读先修**:
> - **M4 / H2 不是 remote 的 runtime**,它们是**外部 peer agent 系统**。本章把它们和 brain-local 并列为三选一 `RuntimeAdapter` 实现 —— **错**。
> - `RuntimeAdapter` 契约只服务 **hosted runtime**(当前就一个:`brain-local`)。**永远**不要在 `server/src/im/runtimes/` 下建 `OpenClawRuntimeAdapter` / `HermesRuntimeAdapter`(硬禁止,见 09.1.1)。
> - M4 / H2 与 remote 的交互**只**走 **capability 接口**(API / MCP / 配置 / 记忆 / 审计),**永远不开 remote session**。没有 pilot / shadow / debug 分支可以绕过。详见 09.3 / 09.5 / 09.6。
> - ChatRouter 的 `/m4` `/h2` 前缀恒为 **拒绝或 no-op**,没有 flag 可以把它们切到 hosted 流。
> - **所有** `RuntimeAdapter` 实现内的 tool use / outbound / 写操作,在执行前必须先过 PolicyGate;高风险动作走 Approval Ticket(见 10.4 / 10.5)。adapter 不允许内嵌旁路。
>
> ⚠️ **命名已纠偏,请配套读 [`08-naming-errata.md`](./08-naming-errata.md)**:
> - K1 是 hosted bundle(bot-surface + brain-local + k1-persona),不是 persona。
> - Hermes 的集成代号是 **H2**,本章所有 `H4` 应读作 `H2`。
> - runtime 类型仍用英文通名,但**只枚举 hosted 值**(短期:`'brain'`),code/DB 层应通过 CI 拒绝 `openclaw` / `hermes` 进入枚举。
>
> 本章**仍然有效的部分**:3.3 `RuntimeAdapter` 契约、`RuntimeEvent` 事件类型、3.5 健康/容错策略 —— 它们限定在 hosted runtime 范围内继续使用,且都从 PolicyGate 之后开始。

## 3.1 角色定位（先对齐事实，再谈边界）

| 角色 | 实际是什么 | yoho-remote 当前接入状态 | 独立文档/证据 |
| --- | --- | --- | --- |
| **K1** | Brain 里的「稳定 AI 人格」。=（ai_profile + self-memory recall）注入 Brain session 的 `appendSystemPrompt`。底下 runtime 仍是 Claude Code / Codex。 | ✅ 已接入。`server/src/brain/selfSystem.ts` + `server/src/im/BrainBridge.ts`。 | `memories/projects/vijnapti-ai/k1-self-memory-normalization-checklist.md`、`memories/projects/yoho-memory/k1-skill-orchestration.md` |
| **M4** | **OpenClaw** 在 macmini 上的实例。独立 agent gateway/CLI：cron、skills、active memory、memory dreaming、Feishu/Telegram 自带通道、`https://m4.yohomobile.dev` 对外暴露。 | ❌ 未接入。现在是 yoho-remote 的「姊妹系统」，各管各的 Feishu bot。 | `memories/engineering/openclaw/*`、`/home/guang/softwares/openclaw/docs/`、`~/.yoho-remote/brain-workspace/reports/openclaw-hermes-mechanisms.md` |
| **H4** | **HermesAgent**（NousResearch/hermes-agent）。独立 Python agent：memory_manager、procedural skills（`skill_manage`）、background review、cron。 | ❌ 未接入。本地只有快照 `~/.yoho-remote/brain-workspace/tmp/hermes-agent-review`。 | 同上报告第 3 章 |

> **重要澄清**（来自 `openclaw-hermes-mechanisms.md` 第 5 节）：OpenClaw 的「候选 skill / 候选 prompt / 候选策略自动晋升」**证据不足**。已证实的是 `memory-dreaming` 的 **recall candidates → long-term memory** 晋升。Hermes 的学习闭环 = `background review → memory / skill 写回`。这两点会直接影响我们设计 M4/H4 Adapter 的 event 流——**不要把不存在的机制硬做成接口**。

## 3.2 三者的职责边界（不可越界）

### K1（Brain-local）
- **擅长**：长上下文推理、tool use、写代码、跨 MCP 工具编排、自我系统注入。
- **不做**：独立 cron（yoho-remote 不持有 scheduler）、离线 skill 演化。
- **唯一 runtime**：`BrainRuntimeAdapter`，底层 `SyncEngine` + spawn `claude` / `codex`。
- **persona 注入点**：仅在 initPrompt + 可选的 per-turn context。

### M4（OpenClaw）
- **擅长**：定时任务（cron delay/every/ISO）、workspace 级 plugins、active memory（结构化 memory index）、memory dreaming（候选 memory 晋升）、独立 Feishu/Telegram 通道。
- **不做**：yoho-remote 的统一 session 管理（它的 session 是 OpenClaw 自己的 `sessionKey`，不兼容 `SyncEngine.sessionId`）、K1 的 persona（它有自己的 system prompt layering）。
- **Adapter 形态**：HTTP/WS 客户端，调 m4 gateway；runtimeSession = OpenClaw 的 `runId`（见 `agent-events.d.ts`）。
- **使用场景**：用户说「让 M4 跑这个 skill」、「把这件事加到 m4 的 cron」。

### H4（Hermes）
- **擅长**：memory snapshot 注入、agent-managed skills（`skill_manage` tool）、background review 写回 memory/skill、cron（fresh session isolation）。
- **不做**：yoho-remote 的统一 session 管理、K1 persona、多 IM 通道。
- **Adapter 形态**：HTTP/stdio 客户端，按 Hermes CLI 协议对话；需要处理 Hermes `skip_context_files / skip_memory / platform='cron'` 等隔离参数。
- **使用场景**：需要 skill self-improvement loop 的实验；长期 learning 的任务。

## 3.3 RuntimeAdapter 契约（统一抽象）

```typescript
// server/src/im/runtimes/RuntimeAdapter.ts
export interface RuntimeAdapter {
    // ⛔ 09.1.1 / 08 章覆盖:`runtimeType` 只枚举 hosted 值,短期就是 `'brain'`。
    //    `'openclaw'` / `'hermes'` 已永久禁列,不进入 Zod schema / DB CHECK / metric label。
    //    原文此处 union 只作历史追溯,实施时应改为:  readonly runtimeType: 'brain'
    readonly runtimeType: 'brain' | 'openclaw' | 'hermes'  // 仅历史参考,不是接入清单

    /**
     * 创建一个 runtime session（不等价于 chat session）。
     * metadata 仅用于审计/路由，runtime 不必消费。
     */
    createSession(opts: {
        namespace: string
        initPrompt: string
        personSlug: string | null
        metadata: Record<string, unknown>
        preferences?: Record<string, unknown>   // brain: brainSessionPreferences；openclaw: workspace；hermes: profile
    }): Promise<RuntimeSessionHandle>

    /**
     * 向已创建的 runtime session 发送一轮用户消息。
     * appendSystemPrompt 可为空；runtime 负责把它合入当前轮 system context（brain 用 meta.appendSystemPrompt；hermes 用 memory injector；openclaw 用 dynamic suffix）。
     */
    sendMessage(opts: {
        sessionId: string           // runtime session id
        text: string
        attachments?: RuntimeAttachment[]
        appendSystemPrompt?: string
        turnId: string              // 幂等键：同 turnId 不重复执行
    }): Promise<void>

    /**
     * 打断当前轮。由 bridge 层判断「是否允许打断」后调用，runtime 只负责执行。
     */
    abort(opts: { sessionId: string; reason: string }): Promise<void>

    /**
     * 订阅 runtime 事件流。语义统一为 RuntimeEvent，内部如何取决于 runtime：
     * - brain: 订阅 SyncEngine event → 映射
     * - openclaw: WS 订阅 agent-events.d.ts → 映射
     * - hermes: stdout/stream → 映射
     */
    subscribe(sessionId: string, handler: (ev: RuntimeEvent) => void): Unsubscribe

    /** 关闭 session（runtime 侧清理） */
    close(sessionId: string): Promise<void>

    /** 健康检查：连通性、版本、quota */
    healthCheck(): Promise<RuntimeHealth>
}

export type RuntimeEvent =
    | { kind: 'assistant-delta'; seq: number; text: string; messageId?: string }
    | { kind: 'assistant-final'; seq: number; text: string; messageId?: string }
    | { kind: 'tool-use';        seq: number; toolName: string; toolInput: unknown }
    | { kind: 'tool-result';     seq: number; toolName: string; ok: boolean; summary?: string }
    | { kind: 'thinking';        thinking: boolean; wasThinking: boolean }
    | { kind: 'error';           error: string; retryable: boolean }
    | { kind: 'aborted';         reason: string }
    | { kind: 'closed' }
```

### 为什么统一成这几类事件

- `assistant-delta` / `assistant-final` 覆盖 stream vs 全量；`messageId` 支撑流式编辑同一条 IM 消息。
- `tool-use` / `tool-result` 为出站格式化器提供「是否展示工具执行过程」的选择权。
- `thinking` 用来驱动 busy 状态机（现有 BrainBridge 就是用这个字段切 busy）。
- `aborted` 作为 abort 请求的确认；没有它 bridge 层无法推进 cleanup。
- `error` 带 `retryable` 标志，驱动 circuit breaker。

## 3.4 路由策略（ChatRouter）

`ChatRouter` 输入 `(chatSession, inboundMessage)`，输出 `{ runtimeType, runtimePreferences }`。

```typescript
type RoutingDecision =
    | { action: 'reuse'; runtimeType; runtimeSessionId }     // 已有 runtime session
    | { action: 'create'; runtimeType; preferences }         // 需要创建
    | { action: 'switch'; newRuntimeType; preferences }      // 切换 runtime
    | { action: 'skip'; reason }                             // 旁听/静默/人工接管
```

### 策略源（按优先级）

1. **显式命令前缀**：消息以 `/m4 ...` 开头 → `openclaw`；`/h4 ...` → `hermes`；`/brain ...` → `brain`（默认）。
2. **群聊规则**：
   - 群名含「唯识」→ `brain` + `vijnapti` persona preset。
   - 群名含「M4 作业」/「hermes lab」 → 对应 runtime。
3. **chat 级 sticky**：`im_chat_sessions.metadata.stickyRuntime` 记录用户上次选择，默认粘住。
4. **namespace 默认值**：`brain_config.extra.channels[platform][channelId].defaultRuntime`。
5. **用户级默认**：personSlug 画像里的 `preferredRuntime`（来自 yoho-memory team/members/）。

### 切换 runtime 的语义

- 不允许隐式切换（例如 user 没加前缀但系统"聪明"地改 runtime）。
- 显式切换：立刻调 `oldRuntime.close()` + `newRuntime.createSession()`；**前一轮未完成的输出被丢弃**（或归档到 `im_chat_audit`），不与新 runtime 混合。
- 同一 chat 不允许并联两 runtime（00 章的不变量 #1）。

## 3.5 健康/容错

| 事件 | Adapter 行为 | Bridge 反应 |
| --- | --- | --- |
| `healthCheck` 失败 3 次 | circuit breaker open 60s | 新 inbound 按 routing fallback 降级（例如 M4 不可用 → brain） |
| `subscribe` 断线 | 指数退避重连，最多 5 次 | 期间 `session.state = 'busy'`，不发新 inbound，回复时带 "连接恢复中" 提示 |
| `sendMessage` 超时 30s | 报 `error{retryable:false}` | `state → idle`，给用户错误回执 |
| `abort` 超时 10s | 强制本地 `state → idle`，但不清远端 session | 标记 `session.metadata.lastAbortTimeout=true`，下次 inbound 强制 `close` |

## 3.6 runtime 接入成本对比

> ⛔ **09.1.1 / 08 章纠偏覆盖**:本表只评估 **hosted runtime** 的接入(当前仅 brain-local)。OpenClaw (M4) / Hermes (H2) **不产出 `RuntimeAdapter`**,也**不**在 `server/src/im/runtimes/` 下出现;它们作为外部 peer 走 capability 接口(9.3 / 9.8),"接入工作量"应改读为 "capability API + 客户端 SDK + 审计限流 + PolicyGate + Approval"。下表第二、三行保留仅为历史追溯,**不是 M7′ / M8′ 的目标**。

| runtime | 主要工作量 | 已知坑 |
| --- | --- | --- |
| Brain-local(K1 当前 hosted runtime) | 重构 `BrainBridge` 为 `BrainRuntimeAdapter`(继承 RuntimeAdapter),事件流映射到 `RuntimeEvent`;tool 执行前接 PolicyGate | 现有消息解析(`agentMessage.ts`)已经是可复用部件,不要重写 |
| ~~OpenClaw(M4)~~ | **不适用**:M4 是外部 peer,不产出 `OpenClawRuntimeAdapter`,不跑 remote session。接入工作改为 capability API 暴露 + `server/src/external/openclaw/` 客户端(K1 主动调 M4 时才用)+ PolicyGate。详见 09.3 / 07 章 M7′。 | — |
| ~~Hermes(H2)~~ | **不适用**:H2 是外部 peer,不产出 `HermesRuntimeAdapter`。接入工作改为实验性 capability + externalConsumer 配额 + PolicyGate(高风险走 Approval)。详见 09.3 / 07 章 M8′。 | — |

## 3.7 推荐 vs 不推荐

| 选择点 | 推荐 | 不推荐 | 理由 |
| --- | --- | --- | --- |
| K1 / M4 / H2 的关系 | K1 是 hosted bundle(channel+hosted runtime+persona);M4 / H2 是外部 peer,走 capability 接口(见 08 章、09 章) | 把 K1 和 M4 / H2 并列成"三个 runtime";把 M4 / H2 塞进 `RuntimeAdapter` 枚举 | M4 / H2 不跑 remote session,属不同层;并列会诱导把它们当 hosted runtime 接入 |
| RuntimeAdapter 事件流 | 统一 `RuntimeEvent`,**仅 hosted runtime** 内部负责映射;所有 outbound 经 PolicyGate(见 10 章) | 直接暴露 SyncEngine / agent-events.d.ts / hermes stdout;把 M4 / H2 的事件塞进 `RuntimeEvent` | bridge 层会被 3 套 schema 污染;M4 / H2 根本不跑 RuntimeAdapter |
| runtime 切换 | 显式命令或群规则,**仅限 hosted runtime** 之间(当前只有 brain-local,故实际不切换) | 按上下文"智能"猜;以"切到 M4"作为切换目标 | 用户无法理解风格变化;M4 是 external peer,没有 hosted slot 可切 |
| M4 / H2 的 IM 通道 | **保留不动** —— M4 / H2 自家的 IM bot / 调度器 / session 归它们自己,remote **不**接管、**不**代跑、**不**开 session(见 09.1.1) | 由 yoho-remote 关掉 M4 / H2 的 Feishu/Telegram 通道统一接管;或在 remote 为它们开"代跑 session" | 代跑即等于把外部 peer 伪装成 hosted runtime,违反 09 章硬约束 |
| Hermes 接入节奏 | feature flag + 默认关闭 + 先单租户灰度 | 开箱默认启用 | 成熟度证据不足（见 3.1） |
| H4 的 skill 自演化 | 记一张白名单说「已证实 = 写回 memory/skill；未证实 = 候选 prompt/strategy 池」 | 按 PLAN 描述去设计接口 | 避免接口为未落地的机制预留过多扩展点 |
