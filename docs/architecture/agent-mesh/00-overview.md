# 00 · 总览（Overview）

## 0.1 术语表

| 术语 | 定义 |
| --- | --- |
| **K1** | Brain 里的稳定 AI 人格。通过 `selfSystem` 注入 `appendSystemPrompt`，本质是「pers­ona + long-term self-memory」，不是独立的 runtime。目前通过 Feishu bot 对外暴露。 |
| **M4** | macmini 上运行的 **OpenClaw** 实例。是一个独立的 agent gateway/CLI（作业、插件、active memory、memory dreaming），通过 `https://m4.yohomobile.dev` 暴露，有自己的 Feishu/Telegram 通道。 |
| **H4** | **HermesAgent**（`NousResearch/hermes-agent`）。独立 Python agent，有自己的 memory_manager、procedural skills、background review、cron。本地快照：`~/.yoho-remote/brain-workspace/tmp/hermes-agent-review`。 |
| **IM Channel** | 一条 IM 通道的接入层：Feishu / DingTalk / WeCom / Slack / Telegram。由 `IMAdapter` 抽象。 |
| **Agent Runtime** | 真正执行任务、产生回复的后端：Brain-local（spawn Claude Code / Codex）、M4（OpenClaw gateway）、H4（Hermes HTTP/CLI）。由 `RuntimeAdapter` 抽象（本文档提出）。 |
| **Identity Bridge** | 把 `(platform, senderId, email, ...)` 桥接到稳定 `personSlug` 的解析层。写入 yoho-memory `team/members/` 与候选区。 |
| **Routing** | 一条 chat + 一条 message → 指派给哪个 runtime 的策略层。 |
| **Session Mapping** | `(platform, chatId) ↔ runtimeSessionId ↔ personSlug[]` 的三元映射，支撑消息的多轮连续性。 |

## 0.2 分层架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                        IM Platforms                                    │
│   Feishu WS ┊ DingTalk Webhook ┊ WeCom Callback ┊ Slack Events ┊ ...   │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ raw events
┌───────────────────────────▼────────────────────────────────────────────┐
│ Channel Adapter Layer    （im/channels/<platform>/）                   │
│   FeishuAdapter · DingTalkAdapter · WeComAdapter ...                   │
│   职责：I/O + 平台协议 + 消息归一化 → IMMessage / IMReply              │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ IMMessage (platform-neutral)
┌───────────────────────────▼────────────────────────────────────────────┐
│ Ingress Gateway          （im/bridge/MessageBridge）                   │
│   · 幂等去重（messageId+TTL）                                          │
│   · 入站限流                                                           │
│   · 审计落库（im_inbound_log）                                         │
└───────────────────────────┬────────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────────┐
│ Identity & Session Resolver   （im/identity/ + im/session/）           │
│   senderId/email → resolvedIdentity → personSlug                       │
│   (platform, chatId) → (sessionState, runtimeType, runtimeSessionId)   │
└───────────────────────────┬────────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────────┐
│ Chat Router              （im/routing/）                               │
│   决定本 chat 路由到哪种 runtime：                                     │
│   · 群名规则（含「唯识」→ vijnapti persona 主 Brain）                  │
│   · 命令前缀（`/m4 ...` → OpenClaw；`/h4 ...` → Hermes）                │
│   · 用户偏好 / namespace 默认值                                         │
└───────────────────────────┬────────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────────┐
│ Runtime Adapter Layer    （im/runtimes/）                              │
│   BrainRuntimeAdapter（K1 / Claude Code / Codex，现有 SyncEngine）     │
│   OpenClawRuntimeAdapter（M4，HTTP/WS to m4.yohomobile.dev）           │
│   HermesRuntimeAdapter（H4，HTTP/stdio）                               │
│   契约：createSession · sendMessage · abort · subscribeEvents · health │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ runtime events
┌───────────────────────────▼────────────────────────────────────────────┐
│ Stream Coalescer + Outbound Formatter                                  │
│   · 去抖合并（debounce/throttle）                                      │
│   · 流式编辑（sendPostAndGetId → editMessage）                         │
│   · 最终 summary（从内存或 DB tail 恢复）                              │
│   · 出站 → IMAdapter.sendReply                                         │
└────────────────────────────────────────────────────────────────────────┘
```

> **与现状的对齐**：
> - 现状是一个大 `BrainBridge` 同时承担了 Ingress、Session Mapping、Routing、Runtime 调度、Stream Coalescer 的工作；渠道只有 Feishu；runtime 只有 Brain-local。
> - 本文档把这 5 件事拆成独立分层，并把「runtime」从 Brain-local 扩到 M4/H4。
> - **不是推倒重来**：`IMAdapter` 契约、`selfSystem` 注入、`agentMessage.ts` 解析、`SyncEngine` 订阅都原封保留，只是把 `BrainBridge` 里的职责按层拆开。

## 0.3 目录结构提议（未来态）

```
server/src/im/
├── core/                          # 平台无关类型（保留）
│   ├── types.ts                   # 现 types.ts，IMMessage / IMReply / IMAdapter
│   └── agentMessage.ts            # 现 agentMessage.ts，文本提取（保留）
├── bridge/
│   ├── MessageBridge.ts           # 从 BrainBridge 拆出的 Ingress Gateway（去重、审计、限流）
│   ├── StreamCoalescer.ts         # 流式合并 + 最终 summary 下发
│   └── OutboundFormatter.ts       # runtime 事件 → IMReply
├── identity/
│   ├── IdentityResolver.ts        # senderId/email/keycloakId → resolvedIdentity
│   ├── keycloakLookup.ts          # 保留
│   └── personSlugClient.ts        # 调 yoho-memory identity-bridge skill
├── session/
│   ├── ChatSessionStore.ts        # im_chat_sessions 表 CRUD（替代 feishuChatSessions）
│   └── ChatStateMachine.ts        # idle/busy/manual/aborting 状态机
├── routing/
│   ├── ChatRouter.ts              # 消息 → runtimeType 决策
│   └── policies/                  # 群名规则、命令前缀、namespace 默认值
├── channels/
│   ├── feishu/                    # 保留现有代码，去掉 session 状态
│   ├── dingtalk/                  # 新增
│   ├── wecom/                     # 新增
│   └── slack/                     # 未来
└── runtimes/
    ├── RuntimeAdapter.ts          # 通用契约
    ├── brain/                     # 现 SyncEngine 集成（K1 主 session、selfSystem 注入）
    ├── openclaw/                  # M4 HTTP client
    └── hermes/                    # H4 stdio / HTTP client

server/src/brain/                   # 保留，继续是 Brain-local runtime 的实现细节
├── selfSystem.ts
├── brainSessionPreferences.ts
└── ...
```

| 拆分原因 | 说明 |
| --- | --- |
| `bridge/` vs `channels/` 分离 | 平台适配器只做 I/O，不持有 chat state；多平台共享 `MessageBridge`。 |
| `identity/` 独立 | 身份解析是横切关注点，未来 Web / Telegram / 开放 API 都要用。 |
| `session/` 独立 | `feishuChatSessions` 改名为通用 `im_chat_sessions`，schema 加 `platform` 列。 |
| `routing/` 独立 | 路由策略可配置、可测试，避免嵌在 BrainBridge 的 `if/else` 里膨胀。 |
| `runtimes/` 统一 | K1/M4/H4 对 bridge 层看起来同构，新增 runtime = 新增一个目录。 |

## 0.4 与现有代码的映射

| 现状文件 | 未来归属 | 说明 |
| --- | --- | --- |
| `server/src/im/BrainBridge.ts` | 拆成 `bridge/MessageBridge.ts` + `bridge/StreamCoalescer.ts` + `session/ChatStateMachine.ts` + `routing/ChatRouter.ts` + `runtimes/brain/BrainRuntimeAdapter.ts` | 按职责垂直切 |
| `server/src/im/types.ts` | `core/types.ts` | 不动 |
| `server/src/im/feishu/*` | `channels/feishu/*` | 搬位置 + 去除 session state |
| `server/src/im/keycloakLookup.ts` | `identity/keycloakLookup.ts` | 搬位置 |
| `server/src/im/agentMessage.ts` | `core/agentMessage.ts` | 不动 |
| `server/src/brain/selfSystem.ts` | 原位，作为 BrainRuntimeAdapter 的依赖 | K1 人格仅影响 Brain-local runtime |
| `feishuChatSessions` 表 | 迁移到 `im_chat_sessions`（加 `platform`, `runtimeType`, `runtimeSessionId` 列） | schema 迁移见 `02-identity-session-mapping.md` |

## 0.5 架构不变量（要先讲好再讨论）

1. **一个 chat 在任一时刻只绑定一个 runtime session**。切换 runtime = 结束旧 session + 创建新 session，不允许双绑。
2. **Channel Adapter 不持有状态**。所有状态放 `ChatSessionStore` + 进程级 `ChatStateMachine`。
3. **Runtime Adapter 看不到 IM**。它只接收 `text + metadata`，返回 event stream；IM 相关信息通过 metadata 透传，不泄漏 IM schema 到 runtime。
4. **Identity 是内建，不是可选**。每条 inbound 必须经过 `IdentityResolver` 产出 `resolvedIdentity`（即便退化到 anonymous），下游依赖这个稳定字段。
5. **幂等键是第一等公民**。inbound 用 `(platform, messageId)`；outbound 用 `(runtimeSessionId, seq)`；runtime call 用 `(runtimeSessionId, runId)`。
