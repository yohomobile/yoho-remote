# 09 · Hosted vs External Runtime:架构分野原则

> **状态**:本文档是 **权威性架构原则**。它澄清之前 00–08 章把 M4 / H2 当作"remote 侧 runtime 适配器"这条线路的误导。凡与本文冲突的叙述,以本文为准。
>
> **触发**:用户于 2026-04-20 确认 —— OpenClaw (M4) 与 Hermes (H2) 是**独立的外部 agent 系统**,它们通过 yoho-remote 的**能力接口**(API / MCP / 配置 / 记忆 / 审计)与 remote 协作;**永远不打开 yoho-remote 的 session**,不作为可评估的例外路径。
>
> **与审批系统的关系**:本章定义"谁有资格进入 remote 的 runtime 执行路径"。另一维度"已经进入的执行路径里,哪些动作需要被 policy/approval 拦截" 由 [`10-approval-and-policy.md`](./10-approval-and-policy.md) 定义。两章共同构成准入 + 执行期的双层安全约束。

## 9.1 原则陈述(不可误读)

> **yoho-remote 同时扮演两个角色**:
>
> 1. **Bot 托管方(Runtime Host)**:托管自己的 bot-surface(如 K1),为这些 bot 提供 channel 接入 + 内建 runtime(brain-local) + session 生命周期 + 状态机 + 出站编排。**K1 就是这条路径上的第一个 bundle**。
> 2. **能力提供方(Capability Provider)**:向外部 agent 系统(M4 = OpenClaw、H2 = Hermes,以及未来类似的 peer)暴露可调用的能力接口(API / MCP / 配置 / 记忆 / 审计)。这些外部系统**不**通过 remote 的 bridge 收发消息,**不**开 remote session,**不**走 remote 的 ChatStateMachine。

### 9.1.1 硬约束(HARD BAN)

> **M4 / H2 永远不在 yoho-remote 打开 session —— prohibited / out of scope。**
>
> - **不存在**"默认不开,例外可开"这种语义。**没有例外路径**。
> - **不存在** pilot / shadow / debug / 对齐验证 作为"可申请开 session"的理由。
> - `runtimeType` 的合法值永远不包括 `openclaw` / `hermes` / 其它 external peer 标识。
> - `server/src/im/runtimes/` 永远不放 `OpenClawRuntimeAdapter` / `HermesRuntimeAdapter` 或其等价物。
> - `brain_config.extra.channels[].runtime.type` 任何时刻都**不**允许填 external peer。
> - ChatRouter 不存在 "切换到 external runtime" 这种分支;`/m4` `/h2` 前缀在 hosted bundle 内**恒为拒绝**或无效,无法通过 flag 打开。
>
> 如果需求看起来"必须让 remote 为 M4 / H2 承载一条 session 才能做",结论一律:**改需求**,用 9.6 给出的非 session 替代方案,不以 session 作价。

`RuntimeAdapter` 抽象只服务于托管型 runtime(brain-local 以及未来的其它 hosted runtime),**不**是给 M4 / H2 用的,也**不会**在未来以任何 flag / 评审 / 实验室形式打开。这条线不是灰度,是禁区。

## 9.2 Hosted Runtime vs External Runtime 对照

| 维度 | Hosted Runtime(如 brain-local,承载 K1 及未来同类 bundle) | External Runtime(如 M4 / H2 / 未来 peer) |
| --- | --- | --- |
| **Session 生命周期** | 由 remote 创建、持久化(`im_chat_sessions` + `SyncEngine`)、回收 | 由外部系统自管(OpenClaw 有自己的 `sessionKey`;Hermes 有自己的 profile/snapshot) |
| **消息驱动方向** | 用户 → channel → remote bridge → runtime | 外部 agent 自己的入口(CLI、cron、它自己的 IM bot、workflow 触发);remote 不是它的入口 |
| **状态机** | 走 remote 的 `ChatStateMachine`(idle/busy/manual/aborting) | 不经过;外部 agent 自己保证一致性 |
| **流式/打断协议** | 走 remote 的 StreamCoalescer + abort 两段式 | 外部自理;remote 不感知 |
| **凭证与路由** | remote 的 channel 凭证 + bundle 配置 | 外部自己的凭证;调 remote 时走 capability auth(app token / OAuth),并受 approval 拦截(见 10 章) |
| **输出回到用户的路径** | remote 出站到用户所在 channel | 外部系统通过自己的 channel 输出;或在显式授权的 bundle 白名单内调 `capabilities/outbound`,受 policy 拦截 |
| **Remote 能看到的内容** | 全量(inbound/outbound/state/事件) | 只看到对方通过能力接口调用的那些请求(API / MCP / audit write);agent 内部推理 remote 不可见 |
| **纳入 `RuntimeAdapter` 契约?** | 是 | **否(永远)** |
| **可在 remote 开 session?** | 是(就是它的工作方式) | **否(永远,无例外)** |

**一句话**:K1 是 remote 的**客人**(住在 remote 里);M4 / H2 是 remote 的**同事**(住在别处,只通过契约化接口借东西)。

## 9.3 Remote 向外部 Runtime 暴露的能力接口(Capability Surface)

外部 agent 与 remote 协作,**全部经由下列接口**。这一层是契约化、可审计、可限流、**可 approval 拦截**的(见 10 章)。

| 类别 | 典型能力 | 建议接口形态 | 认证 | 是否触发 approval |
| --- | --- | --- | --- | --- |
| **API** | 查 persona / bundle / channel 配置(只读);读会话历史(只读);触发出站到指定 bundle(限权) | HTTP + OpenAPI | App token(per external system,按 namespace scope) | 只读默认放行;出站触发 → **policy 预检 + 高风险命中走 approval** |
| **MCP** | 把 remote 持有的工具(如 channel 管理、身份解析、会话查询)暴露给 agent loop 作为 MCP tool | MCP server(remote 进程托管) | MCP 的 session token | 逐 tool 分级;写/外部副作用类 tool 必经 policy |
| **配置(Config)** | `brain_config.extra` 查询(只读) | HTTP GET | App token | 只读放行;不开写 |
| **记忆(Memory)** | 代理访问 yoho-memory(含 namespace 过滤、审计打点) | HTTP proxy or MCP | 双层认证:remote app token + yoho-memory credential | read 放行、write 进 policy(可能走 approval) |
| **审计(Audit)** | 写入 `im_chat_audit` / `external_capability_audit` | HTTP POST append-only | App token | 允许 append,不能 delete/mutate |
| **身份解析(Identity)** | `(platform, platformUserId) → personSlug` 查询 | HTTP GET / MCP tool | App token | 只读;写由 remote 的 IdentityResolver 统一做 |

**不暴露的**:
- Remote 的 runtime 调度入口(`SyncEngine.sendMessage` / MessageBridge 内部)。
- channel 凭证本体。
- yoho-memory 的原始写权限(经 remote 中继,带审计 + policy)。
- 私有队列、内部 state machine 操作。
- "开一条 remote session 给 external peer 跑"这类工具 —— **不存在,也不会加**。

**速率与租户**:所有 capability 端点必须按 (外部系统 id × namespace) 双维限流,超限返回 429 并落 audit。

## 9.4 K1 作为 Hosted Bundle 的运作方式(回顾)

K1 是 remote 的典型 hosted bundle,配置上长这样(示意):

```jsonc
{
  "bundleName": "k1-feishu-yoho-mobile",
  "botSurface": {
    "platform": "feishu",
    "appId": "<K1 的飞书 app_id>",
    "displayName": "K1"
  },
  "runtime": {
    "type": "brain-local",          // remote 内建,唯一允许值
    "preferences": { "sessionPreset": "k1" }
  },
  "persona": {
    "ref": "k1-persona"              // 住在 yoho-memory
  },
  "namespace": "yoho-mobile",
  "credentials": {
    "feishu": "vault://feishu/yoho-mobile",
    "yohoMemory": "vault://yoho-memory/yoho-mobile"
  },
  "approvalProfile": "k1-default"     // 绑定 10 章的 approval policy profile
}
```

K1 的每一条消息走 remote 的完整 hosted path:`FeishuAdapter → MessageBridge → IdentityResolver → ChatRouter → PolicyGate(见 10 章) → BrainRuntimeAdapter(brain-local) → StreamCoalescer → FeishuAdapter.sendReply`。未来新增"K2 飞书 bot"或"K1 钉钉 bot"都只是再加 bundle,路径不变,而且**同样**接 approval 层。

## 9.5 M4 / H2 作为 External Runtime 的运作方式

典型形态:

```
OpenClaw (M4)                                          yoho-remote
───────────────                                         ────────────
┌─────────────────┐                                    ┌──────────────────┐
│ Scheduler       │                                    │ Capability API    │
│  (cron / tasks) │                                    │  /v1/memory/...   │
│ Skills / agent  │──── HTTPS / MCP (app token) ──────►│  /v1/identity/... │
│ loop            │          │                         │  /v1/audit/...    │
│ Its own IM bot  │          │       ┌────────────────►│  /v1/config/...   │
│  (Feishu/TG)    │          │       │                 │  /v1/outbound/... │
└─────────────────┘          │       │                 │                   │
                             ▼       ▲                 │  ↓ 每一个 request │
                       PolicyGate  (10章)              │  过 PolicyGate    │
                       (高风险→approval flow)          └──────────────────┘
```

- M4 有**自己的 IM bot**(Feishu / Telegram)、**自己的调度器**、**自己的 session 模型**。
- 需要 memory / audit / config 时,调 remote 的 capability API,**每一次调用**都经 PolicyGate(10.5)。
- **remote 永远不向 M4 dispatch 用户消息**;用户在 M4 IM bot 下的对话走 M4 自己的 channel adapter,跟 remote 的 bridge 无关。
- H2 同理。

关键:**M4 / H2 对 remote 是 B2B 关系(系统间 API 调用),不是 remote 内部 runtime**,也**不会在任何例外里**变成 remote 内部 runtime。

## 9.6 替代验证方案(不依赖 remote session)

过去草稿里用 shadow / pilot / debug 作为"临时开 remote session 的借口"。这种做法**已被取消**。验证 / 对齐 / 调试一律使用下面这组**不触 remote session**的手段。它们比 session 借用更安全,因为:

1. 不混淆生产 chat 状态机,不占用 `im_chat_sessions` 插槽。
2. 不产生"这条消息由 remote 代 M4 发出"的用户可见副作用。
3. 可重现、可回放、可在 CI 跑,不依赖生产凭证。
4. 验证结束无"忘关 flag"的风险面。

### 9.6.1 Capability Mock / Fixture

- 在 `server/src/capabilities/__mocks__/` 维护一组 fixture:预制 request/response 样本,覆盖 memory.read、identity.get、audit.append、outbound.trigger 等端点。
- 本地单测与 CI 跑 agent loop 时指向 mock,不碰真实 remote。
- 用途:M4 / H2 的 capability client SDK 回归测试、新 endpoint 的契约校验。

### 9.6.2 HTTP / MCP Sandbox

- 在 staging 跑一套独立进程的 capability server(`capabilities/sandbox`),共享 API schema 但后端连 staging 数据库和 staging yoho-memory。
- 发放专用 sandbox app token,scope 限定 `namespace = sandbox-*`。
- 用途:M4 / H2 在集成联调期把真实流量打向 sandbox,验证 rate-limit、authn、audit、policy 行为。
- 约束:sandbox 与生产 **物理隔离**;任何生产凭证不下发 sandbox。

### 9.6.3 录制回放(Recording Replay)

- 在 staging capability server 开启请求录制(仅 sandbox namespace,带 redact),落到 `external_capability_audit_sandbox` 表。
- 回放工具(`tools/capability-replay`)按 sandbox 录制重放到任意目标 capability server,比对 response diff。
- 用途:验证 M4 / H2 的新版客户端是否与 capability 契约保持兼容;事故复盘时重建当时的调用序列。

### 9.6.4 独立 External Test Harness

- M4 / H2 自建 e2e harness(各自仓库内),覆盖"自家 agent loop → capability client → sandbox capability server"全链路。
- remote 侧只对外提供 sandbox server 与录制数据,不托管 harness。
- 用途:M4 / H2 各自证明自己的发布不破坏契约,**无需 remote 内部代跑一条 session**。

### 9.6.5 什么绝对不做

- **不**搭"pilot session":不借 `im_chat_sessions` 记一行 fake 条目给 M4 / H2 跑一轮。
- **不**跑"shadow runtime":不在 remote 进程内嵌 M4 / H2 的推理调用并把结果拼到 StreamCoalescer。
- **不**提供"debug session flag":不会出现 `agentMesh.experimental.externalDispatch.*` 或任何"临时授权 external peer 进入 hosted path"的 flag。
- **不**允许"单条消息手工甩给 M4 跑一轮":需要这种能力的需求,拆成 "K1 通过 capability client 主动调 M4 的公开接口" —— 发起方是 K1,session 仍只属于 K1,不是 M4 的 session 在 remote 里。

> 关键原则:**验证外部系统的代码,不需要让它住进我家**。

## 9.7 External Consumer 接入指南（M4 / H2 写法）

> **正式定义**:OpenClaw(M4) 与 Hermes(H2) 在 `yoho-remote` 中一律定义为 **external capability consumer**。它们不是 hosted runtime,不是 `RuntimeAdapter` 实现目标,不是 remote 的 session 宿主,也不是可以“先开起来试试”的灰度对象。
>
> **落地原则**:`yoho-remote` 对外部 consumer 提供的是 **接入件** 和 **能力面**。接入件可以是 MCP、SDK、thin plugin、skill/schema package;但无论哪一种,进入 `yoho-remote` 的都只能是能力调用,不能是外部主 session。

### 9.7.1 允许形态与优先级

按优先级从高到低,只有以下四类形态可以采用:

| 优先级 | 形态 | 定义 | 适用边界 |
| --- | --- | --- | --- |
| **P1** | **MCP server** | 由 `yoho-remote` 暴露标准 MCP tool,让 OpenClaw/Hermes 作为外部 consumer 通过 tool 调用 capability | 首选。适合需要清晰审计、统一权限、统一速率控制的接入 |
| **P2** | **external consumer SDK** | 提供官方 SDK,由 OpenClaw/Hermes 自己在宿主内调用 `yoho-remote` capability API | 推荐。适合需要稳定接口、强类型、统一 retry / approval 语义的接入 |
| **P3** | **host-specific thin plugin** | 仅做宿主适配的薄插件,负责把宿主事件翻译成 SDK/MCP 调用,不持有业务状态 | 仅在宿主强绑定、需要本地体验时使用。插件只能薄封装,不能承载主 session |
| **P4** | **portable skill/schema package** | 只携带 skill 定义、schema、manifest、policy hint,不携带执行主权 | 最弱形态。只适合能力声明、schema 分发、回放或离线校验 |

### 9.7.2 三类禁止形态

以下形态一律禁止,没有例外:

1. **把 OpenClaw/Hermes 装进 remote 宿主里当 runtime 插件**。这等于把外部 consumer 变成 hosted runtime,直接破坏 9.1.1。
2. **通过 `/v1/sessions` 或任何会创建 remote session 的路径做“接入”**。external consumer 不拥有 remote session,也不借 remote session 跑主流程。
3. **把 capability 调用伪装成 runtimeType 切换、shadow session、pilot session、debug session**。这些名字只是绕路,不是架构。

### 9.7.3 认证、配置、调用、approval 语义

- **认证**:external consumer 必须持有独立的 app token 或 OAuth 凭证,按 `externalSystem × namespace` 绑定 scope。不得共享 hosted bundle 的 channel 凭证,不得读取凭证本体。
- **配置**:只允许读取 capability 级配置、namespace 级配置、policy profile 绑定信息。禁止读取 remote 的 session 内部状态机和私有队列。
- **调用**:每次调用都必须是显式 capability request,例如 `memory.read`、`identity.lookup`、`audit.append`、`outbound.request`。调用语义是“请求能力”,不是“让 remote 替我开 session”。
- **approval pending**:当 PolicyGate 评估结果是 `require_approval` 时,请求必须停在 pending 状态,返回 ticket 信息,不执行副作用,不假装成功,不自动重试成放行。
- **approvalToken**:审批通过后才能带 `approvalToken` 重放同一动作。`approvalToken` 只对绑定的 action snapshot 有效,一次性,过期或撤销即失效。
- **本地 sandbox**:联调只能进 sandbox capability server,只能用 sandbox token,只能打 sandbox namespace。生产凭证不得下发到 sandbox,也不得用 sandbox token 触生产 endpoint。

### 9.7.4 本地 sandbox 规则

- sandbox 只用于契约校验、错误回放、审批流联调。
- sandbox 必须与生产物理隔离。
- sandbox 只能通过 mock fixture、录制回放或独立 sandbox endpoint 接入。
- sandbox 内允许验证 approval pending、ticket 轮转、approvalToken replay,但不得触发真实生产副作用。

### 9.7.5 禁止项速查

看到以下任一写法,直接判定为错误:

- “在 remote 里开一条 session 给 M4/H2 跑”
- “把 M4/H2 做成 `RuntimeAdapter`”
- “通过 `/v1/sessions` 让 external consumer 代跑”
- “传 `runtimeType=openclaw/hermes`”
- “用 shadow / pilot / debug session 规避审批”
- “绕过 PolicyGate 直接打 capability handler”

### 9.7.6 一句话落地要求

> **OpenClaw/Hermes 作为 external capability consumer，只能通过 MCP、SDK、thin plugin 或 skill/schema package 进入 `yoho-remote`；它们永远不进入 remote session，不进入 hosted runtime，不进入 `RuntimeAdapter`。**
>
> 更细的工程接入步骤、错误处理和 sandbox 操作，见 [`docs/guide/external-consumer-sdk.md`](../../guide/external-consumer-sdk.md)。

## 9.8 与 00–08 章的对齐(修正点)

| 原章节 | 原意图 | 按 09 的重读 |
| --- | --- | --- |
| 00 章术语"Agent Runtime" | 列了 Brain-local / M4 / H2 三种 | **改**:runtime 分两类 —— **hosted**(brain-local,remote 内建)与 **external peer**(M4 / H2,不在 remote 的 runtime 列表里)。`RuntimeAdapter` 的 `runtimeType` 只枚举 hosted 值。|
| 03 章 3.1 表格 | 把 K1 / M4 / H2 作为三选一 "角色" | **废**。K1 = hosted bundle;brain-local = K1 底下的 hosted runtime;M4 / H2 属于外部 peer,单列。|
| 03 章 3.2 子节 | 定义 K1/M4/H2 擅长不擅长 | M4 / H2 的"擅长 / 不做"部分改为"外部系统固有能力,不是 remote 设计范围";remote 关心它调用了哪些 capability。|
| 03 章 3.3 `RuntimeAdapter` 契约 | `runtimeType = 'brain' \| 'openclaw' \| 'hermes'` | **改**:`runtimeType` 只保留 hosted 值(当下就是 `'brain'`)。`OpenClawRuntimeAdapter` / `HermesRuntimeAdapter` 永不存在;需要调 M4 / H2 时走 `server/src/external/` 里的 **capability client**(不是 adapter)。|
| 03 章 3.4 路由策略 | `/m4` `/h2` 前缀切 runtime | **改**:前缀在 hosted bundle 里永为 **拒绝或 no-op**,没有可开关。|
| 03 章 3.6 runtime 接入成本 | 把 M4 / H2 作为 adapter 工作量评估 | **重构**:M4 / H2 的接入成本是"定义 capability API + 客户端 SDK + 审计/限流 + policy 规则",与 RuntimeAdapter 无关。|
| 04 章端到端时序图 | 默认所有 runtime 走同一个流 | **限定**:04 章的流**只适用于 hosted runtime**(K1 / brain-local),并在 runtime 调用前插入 PolicyGate(见 10.5)。M4 / H2 的端到端流在 9.5。|
| 06 章观测指标 | `im_runtime_*{runtime=openclaw\|hermes}` | **改**:这些 metric 只覆盖 hosted runtime。外部 runtime 调用 capability 的指标走 `capability_api_call_total{externalSystem, endpoint}` 及 `policy_decision_total{outcome}`。|
| 07 章 M7 / M8 里程碑 | "OpenClaw / Hermes runtime 接入" | **重命名 + 重定义**:M7′ = "M4 外部接入 · Capability 接口与客户端";M8′ = "H2 外部接入 · 实验性 capability 消费"。两者都不产出 `RuntimeAdapter`,也不包含"在 remote 代跑 session"的分支。|
| 08 章 8.3 分类表 M4 / H2 行 | 标为"integration-bundle / runtime-integration-id(remote 侧接入)" | **收紧**:分类改为 **external runtime peer / capability client identifier**,在 remote 只表现为 app token 持有者。|

## 9.9 实施层影响

### 代码目录

```
server/src/
├── im/                           # hosted path(K1 + 未来 hosted bundle)
│   ├── channels/
│   ├── identity/
│   ├── state/
│   ├── runtimes/
│   │   └── BrainRuntimeAdapter.ts   # 唯一的 hosted runtime 实现(短期)
│   └── bridge/
├── capabilities/                 # ← 向外暴露的能力接口(只被 external peer / 工具用)
│   ├── api/                      # HTTP endpoints
│   │   ├── memory.ts
│   │   ├── identity.ts
│   │   ├── audit.ts
│   │   ├── config.ts
│   │   └── outbound.ts            # 触发 remote 出站,受 PolicyGate 拦截
│   ├── mcp/                      # MCP server(tools: remote 持有的)
│   ├── auth/                     # app token / quota / rate-limit
│   └── __mocks__/                # fixture,供 9.6.1
├── external/                     # ← remote 作为 client 反向调用外部(主动调 M4/H2 公开接口)
│   ├── openclaw/                 # M4 client(只作为 capability client,不代跑 session)
│   └── hermes/                   # H2 client(同上)
└── policy/                       # ← 见 10 章
```

**`server/src/im/runtimes/` 永远只放 hosted runtime adapter**,不容纳 external peer 的任何实现。`server/src/external/` 的角色被严格限定为"K1/brain 想主动调 M4/H2 对外公开接口时的客户端"—— 不是"代 M4/H2 跑一条 session 的壳子"。

### 配置

- `brain_config.extra.channels[].runtime.type` 合法枚举:**仅** `'brain-local'`(短期)。校验代码必须 reject 其它值。
- 外部系统通过 `brain_config.extra.externalConsumers[]` 声明(含 app token ref、namespace scope、允许的 capability 列表、限流配额、绑定的 approval policy profile)。
- 新字段 `externalConsumers[].canTriggerOutbound: bundleName[]` —— 默认空;只有明确授权的 bundle 才可被外部通过 `/v1/capabilities/outbound` 触发出站,且每次触发过 PolicyGate。

### Feature flag

- 保留 `agentMesh.runtimeAdapter.brain.*`(hosted)。
- **永久禁列** `agentMesh.runtimeAdapter.openclaw.*` / `agentMesh.runtimeAdapter.hermes.*` / `agentMesh.experimental.externalDispatch.*` —— 这些 flag 名字进入代码或 config 应直接 CI 拒绝。
- **新增** `agentMesh.capabilities.<endpoint>.<externalSystem>.enabled` —— per 外部系统 × per endpoint 开关。
- **新增** `agentMesh.policy.<profile>.enforce` —— PolicyGate 的执行模式(见 10 章)。

### 审计

- 所有外部调用落 `external_capability_audit(external_system, app_token_hash, namespace, endpoint, bundle, request_summary, ok, latency_ms, policy_decision, approval_ticket_id?, at)`。
- 不存在"例外 dispatch" audit 类型 —— 因为例外本身不存在。

## 9.10 判定规则(给实施者一条决策树)

面对一个新需求问自己:

```
需求是:remote 要不要让 M4/H2 直接处理用户消息并通过 remote 出站?
│
├─ 是 ──────► STOP。本章 9.1.1 硬禁止。改需求,走 9.6 的非 session 替代方案。
│             没有"申请开 session"这条路。
│
└─ 否 ──────► 走 9.5 的 capability 模式。M4/H2 自己处理,通过 capability API
              取需要的 memory/config/identity/audit;每次调用经 PolicyGate(10 章)。
              这是唯一路径。
```

**额外 guard**:如果实现代码里出现以下任一迹象,视为违反 9.1.1,直接拒绝合并:
- 在 `runtimeType` 枚举 / DB CHECK / Zod schema 里添加 `'openclaw'` `'hermes'` 或同义标识。
- 在 `server/src/im/runtimes/` 下新增文件指向 M4 / H2。
- 出现以"pilot" / "shadow" / "debug external" 为名的 flag 或绕道入口。
- ChatRouter 加 `/m4` `/h2` 前缀派发到 hosted 流。
- `im_chat_sessions` 新行的 `runtimeType` 不等于 hosted 集合中的值。

如果你发现自己在 `server/src/im/runtimes/` 里想加 `OpenClawRuntimeAdapter.ts`,**停下来**,回读 9.1.1。

## 9.11 一句话结论

> **K1 是 remote 托管的 bot;M4 / H2 是 remote 的外部同事。托管 runtime 走 `RuntimeAdapter` 并在 PolicyGate 之下执行;外部 runtime 走 capability API 且每次调用同样经过 PolicyGate。M4 / H2 永远不在 remote 打开 session,没有例外,也不会有例外。**

## 9.11 External Consumer 接入指南(M4 / H2 写法)

> **编号说明**:9.7–9.10 已被对齐 / 实施 / 决策树 / 结论占用。本节作为"作业指南"追加在章末,承接 9.5 的抽象定义,给实施者 **可直接照做** 的落地形态。

### 9.11.1 正式定义

**M4 (OpenClaw)、H2 (Hermes) 在 yoho-remote 架构中的身份是 external capability consumer**。不是 runtime,不是 bundle,不是 `RuntimeAdapter`,不是 remote session 的一种变体。它们是独立部署、自持 agent loop、通过 HTTPS / MCP 调用 yoho-remote capability 的**外部客户端**。

**唯一合法的集成方向**:把 yoho-remote 做成它们可以安装 / 连接的 **接入件**(MCP server、client SDK、host-specific thin plugin、portable skill),而**不是**把 OpenClaw / Hermes 装进 yoho-remote。

> OpenClaw 和 Hermes 的官方插件系统(`openclaw.plugin.json` + `register(api)` / `~/.hermes/plugins/` + `register(ctx)`)都是**宿主进程内的 in-process 扩展**。把 yoho-remote 装进这种插件槽是"宿主扩展"而非"借用 remote",与 9.1.1 不冲突;反之把它们装进 yoho-remote 的 hosted 执行路径则直接违反 9.1.1。

### 9.11.2 四种允许形态(按优先级 P1 → P4)

| 优先级 | 形态 | 装在哪 | 本质 | 推荐包命名 |
| --- | --- | --- | --- | --- |
| **P1** | **Capability MCP Server** | remote 侧暴露;外部 agent 用其 MCP client 连接 | yoho-remote 把 capability 作为一组 MCP tools 公开(`memory.*` / `identity.*` / `audit.*` / `config.*` / `outbound.*`),外部用 stdio 或 HTTP+OAuth 2.1 PKCE 接入 | `@yoho-remote/mcp-capability-server`(npm 分发 launcher);endpoint `mcp.yoho-remote.internal/v1/mcp` |
| **P2** | **External Consumer SDK** | 外部 agent 进程内(npm / pypi / go mod) | 封装 capability REST + MCP + auth 刷新 + approval pending 轮询 + 重试语义,语言原生,无协议细节外泄 | `@yoho-remote/capability-client`(TS) / `yoho_remote_capability`(Py) / `yohoremote-capability`(go) |
| **P3** | **Host-specific thin plugin** | 对方宿主(OpenClaw 插件 或 Hermes 插件) | **薄包装层**,仅把 P2 SDK 转成宿主原生扩展形状(OpenClaw `register(api)` → `registerTool` / `registerProvider`;Hermes `register(ctx)` → `ctx.register_tool` + `_setup_argparse`),不含业务逻辑 | `openclaw-plugin-yoho-remote`(ClawHub / npm) / `hermes-plugin-yoho-remote`(pypi / `~/.hermes/plugins/yoho-remote/`) |
| **P4** | **Portable skill / schema package** | 任意宿主(agentskills.io 兼容) | 纯 prompt + schema,**不含执行代码**;告诉别的 agent "这是 yoho-remote capability 的调用风格",执行仍落到 P1/P2/P3 | `skill-yoho-remote-*`(skills.io 发布) + OpenAPI / MCP descriptor |

**工程团队该做的**:

1. 先做 **P1**(MCP server)和 **P2**(SDK):这是所有上游形态的底座。P3/P4 都依赖它们。
2. 再做 **P3**:OpenClaw / Hermes 各一份 thin plugin,都只是 adapter,禁止重新实现业务逻辑。
3. **P4** 按需出:面向社区 / 第三方 agent 宿主的自助接入。

**装在哪一侧**(一图流):

```
      ┌─────────────────────────────────────────────────────────┐
      │                yoho-remote (this repo)                    │
      │   暴露:                                                   │
      │     P1  Capability MCP Server                             │
      │         (server/src/capabilities/mcp/)                    │
      │     Capability REST                                       │
      │         (server/src/capabilities/api/)                    │
      │     → 所有入口前置 PolicyGate (10.5) + 需要时 Approval     │
      └───────────────▲──────────────────────▲──────────────────┘
                      │ MCP / HTTPS          │ MCP / HTTPS
                      │                      │
         ┌────────────┴───────┐   ┌─────────┴──────────┐
         │ OpenClaw (M4)        │   │ Hermes (H2)         │
         │ host process         │   │ host process        │
         │ ┌──────────────────┐ │   │ ┌────────────────┐ │
         │ │ P3 thin plugin   │ │   │ │ P3 thin plugin │ │
         │ │  (OpenClaw       │ │   │ │ (Hermes         │ │
         │ │   register(api)) │ │   │ │  register(ctx)) │ │
         │ └────────┬─────────┘ │   │ └────────┬───────┘ │
         │          │ depends   │   │          │         │
         │     ┌────▼────────┐  │   │     ┌────▼──────┐  │
         │     │ P2 SDK (TS) │  │   │     │ P2 SDK(Py)│  │
         │     └─────────────┘  │   │     └───────────┘  │
         └──────────────────────┘   └─────────────────────┘
```

### 9.11.3 三种禁止形态(命中即合并阻止)

| 禁项 | 表现 | 为什么禁 |
| --- | --- | --- |
| **F1 Runtime plugin in remote** | 在 `server/src/im/runtimes/` 加 `OpenClawRuntimeAdapter.ts`;或用任何 loader 把 OpenClaw/Hermes 的 `register(api)` / `register(ctx)` 加载进 remote 进程 | 等价 9.1.1 被旁路:以插件壳伪装 hosted runtime,ChatRouter 会开始向它派发,产生 session |
| **F2 Remote 伪装成 OpenClaw channel target** | 在 OpenClaw 侧 `registerChannel({ plugin })` 把 yoho-remote 描述为 OpenClaw 的一条 messaging channel,让 OpenClaw 把用户消息 send 到 remote | OpenClaw 的 channel plugin 是"消息收发通路",把 remote 当 channel 会让 OpenClaw 代替用户下消息给 remote → 等价 M4 在 remote 开 session |
| **F3 借 bundle / loader 变相开 session** | 用 OpenClaw bundle 格式(`.codex-plugin/` / `.claude-plugin/` / `.cursor-plugin/`)或 Hermes pip entry-point(`[project.entry-points."hermes_agent.plugins"]`) 反向塞入 remote;或搞一个"remote-hermes-loader" 把 Hermes 代码跑在 remote 进程 | bundle / loader 只是换壳;凡在 remote 侧 in-process 执行 external runtime 代码 = 违反 9.1.1 |

CI 硬检查(落入 M10.5):

- `server/src/im/runtimes/` 目录只接受白名单文件名(`BrainRuntimeAdapter.ts` 等 hosted 实现)。
- 禁止在 remote 的 `package.json` / `pyproject.toml` 出现 `openclaw` / `hermes` / `hermes-agent` 为**运行时依赖**(dev/test 依赖可容忍,用作 fixture/spec)。
- 禁止 `server/src/**` 出现 `from openclaw/plugin-sdk/*` 或 `import hermes_agent.*` 的产物代码。

### 9.11.4 接入速查(实施者 cheatsheet)

| 主题 | 规范 |
| --- | --- |
| **认证** | OIDC client_credentials(首选,短 token ≤ 1h + 刷新);mTLS(备选,适合同内网固定节点)。**禁止**长期 API key。`externalConsumerId` 写入每条审计 |
| **配置** | `brain_config.extra.externalConsumers[]` 声明 consumer(见 9.8)。新增字段对照:`id` / `authMethod` / `namespaceScope[]` / `allowedCapabilities[]` / `rateLimit` / `policyProfile` / `approvalProfile` / `canTriggerOutbound: bundleName[]` |
| **调用入口** | P1 MCP:`mcp://.../v1/mcp`(tools 按 capability 分组);P2 REST:`https://.../v1/{memory,identity,audit,config,outbound}/*`;Capability manifest semver 携带 `X-Capability-Version` |
| **Approval pending 语义** | HTTP:`202 { status: 'pending', ticketId, pollUrl, expiresAt }`;MCP:tool 返回结构化 `{ pending: true, ticketId, ... }`;SDK 内置 `await client.approval.waitFor(ticketId)` 并在决议后以 `approvalToken` **单次重放** |
| **本地开发 sandbox** | 9.6.2 `capabilities/sandbox` server + 专用 sandbox app token + `namespace = sandbox-*`;**不下发任何生产凭证** |
| **Fixture / mock** | 9.6.1 `server/src/capabilities/__mocks__/` 提供单测 fixture;P2 SDK 发布 `@yoho-remote/capability-client/testing` 子入口暴露 mock server |
| **错误 / fail-closed** | capability server 不可用、policy 决策失败、approval 服务不可达 → SDK 抛错,**不降级执行**(10 章语义一致) |
| **版本协商** | Manifest semver;breaking change 双写期 ≥ 30 天;server 拒绝不兼容版本并返回 `deprecation` header + audit 一行 |
| **不许做(速记)** | `❌` 调 `/v1/sessions` 相关路由(不存在给 external 用的) / `❌` 传 `runtimeType` / `❌` 要求 remote "代我发一轮消息给用户" / `❌` 把 remote webhook 接去接 M4/H2 自家 IM 平台的入站 / `❌` 在 thin plugin 里重复实现 SDK 做过的事 |

### 9.11.5 工程团队职责边界

| 团队 | 负责 | 不负责 |
| --- | --- | --- |
| **yoho-remote 核心** | P1 MCP server、P2 SDK(TS/Py/Go)、capability manifest、PolicyGate/Approval、sandbox、fixture 发布 | 任何"把 M4/H2 装进 remote"的事;任何 P3 thin plugin 的业务实现 |
| **OpenClaw (M4) 团队** | `openclaw-plugin-yoho-remote`(P3 薄包装,消费 P2 SDK);在 M4 自家 release note 里说明安装路径 | 绕过 P2 SDK 自己重写调用栈;让 remote 代跑 M4 的 session |
| **Hermes (H2) 团队** | `hermes-plugin-yoho-remote`(P3 薄包装,消费 P2 SDK);自家 e2e harness 打向 sandbox | 同上;以及用 Hermes pip entry-point 倒装 yoho-remote 代码 |
| **第三方宿主 / 社区** | 基于 P4 portable skill 自助接入(可选),用 P1 MCP 直连 | 无 |

### 9.11.6 与 09 / 10 章的关系

- **9.1.1 / 9.5 / 9.6** 定义**不能做什么**;本节定义**要做什么 / 怎么做**。
- **10.5 / 10.8** 定义 PolicyGate 位置与 API 形态;本节的 P1/P2/P3/P4 全部在 PolicyGate 之后执行,approval pending 走 10.4 的 ticket 流程。
- **10.9** 的风险层级直接决定 P1 每个 endpoint 默认 `decision`:`memory.read` = allow_with_audit、`outbound.trigger` = require_approval、`config.write(production)` = require_approval(quorum=2)、`session.open.external` = deny。

### 9.11.7 依据

- **OpenClaw 官方扩展机制**:`openclaw.plugin.json` manifest、`register(api)` / `registerProvider` / `registerChannel` / `registerTool` / `registerHook`、native in-process 加载模型、`openclaw plugins install` 分发([docs.openclaw.ai/tools/plugin](https://docs.openclaw.ai/tools/plugin)、[plugin-sdk/plugin-entry](https://docs.openclaw.ai/plugins/sdk-entrypoints))。
- **Hermes 官方扩展机制**:`~/.hermes/plugins/<name>/` + `plugin.yaml` + `register(ctx)`、`ctx.register_tool` / `ctx.register_hook`、pip entry-point `[project.entry-points."hermes_agent.plugins"]`、原生 MCP server 支持(stdio + HTTP + OAuth 2.1 PKCE)、skills 作为 agentskills.io 开放标准([hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/)、`NousResearch/hermes-agent`)。
- **本仓库硬约束**:[`09.1.1`](#91-原则陈述不可误读)、[`10-approval-and-policy.md`](./10-approval-and-policy.md)。
