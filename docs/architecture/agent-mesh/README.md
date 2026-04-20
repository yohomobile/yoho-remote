# Agent Mesh 架构设计（IM × Agent Runtime）

> ⛔ **两条架构硬约束(2026-04-20,必读,不可误读)**:
>
> 1. **M4 (OpenClaw) / H2 (Hermes) 永远不在 yoho-remote 打开 session —— prohibited / out of scope。** 没有"默认不开,例外可开"这种语义,没有 pilot / shadow / debug 分支。K1 是 remote 托管的 bot;M4 / H2 只通过能力接口(API / MCP / 配置 / 记忆 / 审计)与 remote 协作。详见 [`09-hosted-vs-external-runtime.md`](./09-hosted-vs-external-runtime.md) 的 9.1.1。
> 2. **Policy & Approval 是架构级能力,不是某 runtime 的局部功能**:所有 hosted bundle(K1 / 未来 K2 / DingTalk-K1 …)和所有 capability 消费方(M4 / H2 / 未来 peer)在执行任何外部副作用 / 写操作 / 高权读取 / 敏感配置变更前,**必须**过 PolicyGate;命中高风险规则的动作必须走 Approval Ticket 流程。详见 [`10-approval-and-policy.md`](./10-approval-and-policy.md)。
>
> ⚠️ **命名纠偏(2026-04-20)**:本套文档最初把 K1 当成 persona、把 K1/M4/H4 并列成三个 runtime,**都是错的**。请配套读 [`08-naming-errata.md`](./08-naming-errata.md):Hermes 集成名是 **H2**(非 H4);真正的主轴是 `channel × hosted runtime`,外部 peer 走能力接口。00–07 原文尚未重写,以 08 / 09 / 10 为准。

> **定位**:这是 yoho-remote 的一套跨 IM 渠道 + **hosted runtime** + **external capability consumer** 协作的架构蓝图。不是某个 feature 的设计,也不是现成代码的说明书。它描述 **未来代码应该如何分层**,以承接:飞书 / 钉钉 等 channel × K1 等 hosted bundle × M4 / H2 等外部 consumer 的组合模式。

## 为什么落在这里（`docs/architecture/agent-mesh/`）

- `docs/design/` 现有内容是「单一 feature 的实现设计」（如 `auto-iteration-feature.md`），本文档跨越 IM、Brain、外部 runtime 三个子系统，属于 **architecture** 层，不应和 feature 设计混在一起。
- `docs/guide/` 是面向用户的使用文档，本文档是面向工程团队的设计依据，不适合放这里。
- `docs/analysis/` 是事后分析/调研报告（BRAIN_SESSION_*、brain-session-frontend-*），本文档是前瞻性蓝图，不是分析。
- 因此单开 `docs/architecture/`，第一份内容就是这套 Agent Mesh。未来若再有架构级蓝图（例如存储重构、权限模型），继续在 `architecture/` 下并排放。

## 本套文档的结构

| 文件 | 作用 |
| --- | --- |
| [00-overview.md](./00-overview.md) | 术语表、分层架构总览、目录结构提议 |
| [01-multi-channel-ingress.md](./01-multi-channel-ingress.md) | 多 IM 接入层（Feishu 已落地 / DingTalk / WeCom 扩展路径） |
| [02-identity-session-mapping.md](./02-identity-session-mapping.md) | 身份解析 + 会话映射，统一 `(platform, chatId) ↔ runtimeSessionId ↔ personSlug` |
| [03-agent-runtimes.md](./03-agent-runtimes.md) | K1 / M4 / H4 的职责边界、路由策略、RuntimeAdapter 契约 |
| [04-message-flow.md](./04-message-flow.md) | 入站 → 路由 → runtime → 流式回复 → 出站的端到端事件流 |
| [05-concurrency-and-race.md](./05-concurrency-and-race.md) | **竞态专题**：幂等、去重、排队、打断、流式、人工接管、崩溃恢复 |
| [06-observability-tenancy.md](./06-observability-tenancy.md) | 日志、指标、追踪、权限与多租户隔离 |
| [07-migration-playbook.md](./07-migration-playbook.md) | **迁移 Playbook**:分阶段里程碑、feature flag、双写/切读/回滚、验收门槛 |
| [08-naming-errata.md](./08-naming-errata.md) | ⚠️ **命名与主轴纠偏**:K1 / M4 / H2 分类、为什么不作为主轴、正确主轴、对 00–07 章的修正点 |
| [09-hosted-vs-external-runtime.md](./09-hosted-vs-external-runtime.md) | ⛔ **Hosted vs External 分野**:K1 是 hosted bot;M4 / H2 是外部 peer;**永远不在 remote 开 session**,无例外;capability 接口 + 非 session 替代验证方案 |
| [10-approval-and-policy.md](./10-approval-and-policy.md) | ⛔ **Policy & Approval 体系**:PolicyGate + Approval Ticket 覆盖所有 hosted runtime 与 capability 调用,高风险动作必须审批后执行 |

## 设计目标（按优先级）

1. **可扩展渠道**：新增一个 IM 平台应在 1 个适配器 + 1 条路由注册完成，不触碰 bridge 核心。
2. **可扩展 hosted runtime**:接入一个新的**托管型** runtime 应只写一个 `RuntimeAdapter`,不改 ingress 和 identity。外部 peer(M4 / H2)**永远不走**这条路径,只走 capability API(见 09 章)。
3. **架构级准入约束**:所有 hosted bundle 与 capability 消费方在执行外部副作用 / 写 / 高权动作前必须过 PolicyGate,高风险必须 Approval;不是某 runtime 的内部功能(见 10 章)。
4. **并发正确**:同一个 chat 在 agent 忙时,新消息行为必须可预测(合并 / 打断 / 排队三选一),不能出现消息丢失、幽灵回复、或 double-abort。
5. **可观测**:每一条 inbound → outbound 都可溯源到 traceparent + runId + sessionId + personSlug,policy decision 与 approval ticket 全链路留痕。
6. **租户隔离**:namespace / org 级别的配置、凭证、路由策略必须独立,渠道密钥不能跨租户泄露。

## 本文档不设计什么

- 不设计 UI / 前端交互。
- 不设计 yoho-memory 内部如何存储（已有 `memories/team/members/` canonical 模板）。
- 不设计 Brain session 内部 spawn 机制（属 `server/src/brain/` 与 `cli/` 的既有职责）。
- 不替换现有代码——它是未来改造的方向图，**不是迁移 PR**。

## 阅读顺序建议

- 新人先读 `00-overview.md` 了解全局,再按 01→06 顺序看细节,最后读 09 / 10 确立硬约束。
- 想扩一个 IM:`00 → 01 → 02 → 04 → 05 → 10`(approval 是新 channel 上线的前置)。
- 想接一个 hosted runtime:`00 → 03 → 04 → 05 → 10`。
- 想接一个 external peer(M4 / H2 / 新):`09 → 10`,只走 capability + policy,不碰 hosted 流。
- 排查并发/竞态问题:直接看 `05-concurrency-and-race.md`。
- **准备开工迁移**:直接看 `07-migration-playbook.md`,先照清单干,再按需回查 00–06 的设计细节。**注意**:07 章 M7 / M8 的原定语义已被 09 章重定义(改为 capability 暴露,不再是 adapter 接入);M10 (Policy & Approval) 是 hosted 与 capability 全量上线的前置。
- **已被 00–07 的 K1/M4/H4 命名绕晕**:先读 `08-naming-errata.md`。
- **面对"是否让 M4 / H2 走 remote session"**:直接读 `09-hosted-vs-external-runtime.md` 的 9.1.1 + 9.10。答案是"不,永远不,没有例外"。
- **面对"如何把 OpenClaw / Hermes 当 external consumer 接入"**:直接读 `09-hosted-vs-external-runtime.md` 的 9.7 + `docs/guide/external-consumer-sdk.md`。
- **面对"这个动作要不要审批"**:读 `10-approval-and-policy.md` 的 10.3 风险分层 + 10.9 对照表。
