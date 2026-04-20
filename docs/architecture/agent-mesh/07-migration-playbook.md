# 07 · 迁移 Playbook & 验收清单

> **用途**:把 00-06 的蓝图拆成可按周推进的工程节奏。团队拿这份清单就能开工,不需要再回去读愿景。
>
> **前提**:所有步骤在 **不破坏 Feishu 现网**、**不强制下线 BrainBridge**、**任何一步可回滚** 的约束下进行。本文档不含业务代码改动指引,只规定「改什么 / 改到什么程度 / 怎么验证 / 怎么回滚」。
>
> ⛔ **两条架构硬约束贯穿本章(2026-04-20)**:
>
> 1. **M7 / M8 已被 [`09-hosted-vs-external-runtime.md`](./09-hosted-vs-external-runtime.md) 重定义为 M7′ / M8′**:原 `OpenClawRuntimeAdapter` / `HermesRuntimeAdapter` 思路作废 —— M4 / H2 是外部 peer,**永远不走** `RuntimeAdapter` 路径,也**永远不在 remote 打开 session**,没有 pilot / shadow / debug 分支。M7′ = capability API / MCP 对 M4 暴露 + m4 接 external consumer SDK;M8′ = 复用 M7′ 的 capability,给 H2 发 consumer。**风险、回滚、checkpoint 里不再出现"代 M4/H2 跑 session"的分支**。
> 2. **Policy & Approval 是新增的 M10,且是 hosted 全量上线(M5)与 capability 全量上线(M7′)的硬前置**。没有 PolicyGate 就不许把 BrainBridge 流量切到 BrainRuntimeAdapter、不许打开 capability 生产流量。详见 [`10-approval-and-policy.md`](./10-approval-and-policy.md)。

## 7.1 总览里程碑

| 阶段 | 名称 | 预估 | 前置 | 关键产出 | 主要 flag |
| --- | --- | --- | --- | --- | --- |
| **M0** | 基线 & 脚手架 | 1–2w | — | feature flag 框架、基线指标、审计表 | — |
| **M1** | 身份权威层迁移 | 2–3w | M0 | `platform_identities` 表 + `IdentityResolver` 服务 | `agentMesh.identity.*` |
| **M2** | `im_chat_sessions` 通用化 | 2w | M0 | 通用表 + 双写 + 切读 | `agentMesh.chatSessions.*` |
| **M3** | `ChatStateMachine` CAS | 2w | M2 | `state` 列 + 状态机 + watchdog 迁移 | `agentMesh.chatState.*` |
| **M4** | per-chat Actor + Outbox + CancelToken | 3w | M2, M3 | 串行执行器 + 出站幂等表 + 打断协议 | `agentMesh.chatActor.*` |
| **M10** | Policy & Approval 骨架 ⛔ 前置 | 3–4w | M0, M2 | PolicyGate + ApprovalService + DDL + profile schema | `agentMesh.policy.*` + `agentMesh.approval.*` |
| **M5** | `RuntimeAdapter` 抽取(Brain) | 3–4w | M3, M4, **M10** | `BrainRuntimeAdapter` + MessageBridge 编排 + 接 PolicyGate | `agentMesh.runtimeAdapter.brain` |
| **M6** | DingTalk Adapter | 2w | M1, M2, M4, **M10** | `DingTalkAdapter` + 单租户灰度 + 绑定 approvalProfile | `agentMesh.channels.dingtalk.*` |
| **M7′** | OpenClaw (M4) capability 接入 ⚠️ | 3–4w | M5, **M10** | capability API/MCP 暴露 + `externalConsumers['m4']` 配额 + 所有 handler 前置 PolicyGate | `agentMesh.capabilities.*` + `agentMesh.externalConsumers.m4.*` |
| **M8′** | Hermes (H2) capability 接入(实验)⚠️ | 2–3w | M7′ | 复用 M7′ capability + `externalConsumers['h2']` + approval profile | `agentMesh.externalConsumers.h2.*` |
| **M9** | 收尾 | 1–2w | M5 完成 | 移除双写/旧表/旧 bool/旧 BrainBridge | 删 flag |

> 总工期 25–34 周(约 6–8 个月)。并行性:M2 与 M1 可部分重叠;**M10 与 M3/M4 可并行**(不同 subsystem),但必须在 M5 切 enforce 前跑完 M10.0–M10.1;M6 可在 M5 接近完成时启动;M7′ 在 M5 + M10.3 都完成后启动;M8′ 依赖 M7′ 产出的 capability + policy profile。
>
> ⚠️ M7′ / M8′ 的产出里不再出现任何"在 remote 开 session 跑 M4/H2"的动作;M10 是所有 hosted / capability 路径打开 enforce 的共同前置,不允许跳过或先上线后补。

## 7.2 Feature flag 约定(全局规则)

### 命名

- 前缀一律 `agentMesh.`
- 分层:`agentMesh.<subsystem>.<capability>` — 如 `agentMesh.identity.dualRead`、`agentMesh.chatSessions.readNew`。
- 灰度粒度 flag 后缀带维度:`...<namespace>`、`...<chatId>`。

### 默认值

- **全部默认 OFF**。上线 = 显式在 flag 管理后台打开,不能靠代码 default。
- 每个 flag 在本 playbook 中都必须标注「启用条件 / 观察窗口 / 关闭回滚步骤」。

### 生命周期

- 每个 flag 进 M9 都应被删除(代码与配置)。M9 前 flag 不清理属正常负债,M9 后仍存在的 flag 算线上遗留缺陷。

## 7.3 验收门槛(通用模板)

每个里程碑至少要过以下四道门:

1. **功能门**:关键路径手测 + 自动化测试全绿。
2. **指标门**:观察 **≥ 72h 稳定期**,对比基线无回归(见 7.4 指标清单)。
3. **兼容门**:Feishu 现网无用户可感知差异(回复内容、时延、错误率)。
4. **回滚演练门**:在 staging 或灰度 namespace 执行一次「打开 flag → 回滚 flag」完整流程,耗时 < 5min。

不通过任一门 → 不进入下一里程碑。

## 7.4 基线指标(M0 固化,后续全程对比)

| 指标 | 来源 | 回归阈值 |
| --- | --- | --- |
| IM inbound QPS(P50 / P99) | `im_inbound_total` | 无新增丢弃 |
| 首 token 时延 P50 / P95 | Brain trace | +10% 内 |
| 流式编辑次数 / turn P95 | `im_stream_edit_count` | ±1 次内 |
| busy 时长 P95 | `im_runtime_busy_duration_seconds` | ±20% 内 |
| abort 成功率 | `im_abort_total{outcome=confirmed}` / total | 不下降 |
| 崩溃恢复命中率 | 启动扫描 `chatsToRecover` 后成功 finalize 数 | 不下降 |
| identity resolve P95 延迟 | `identity_resolver_latency_seconds` | < 200ms |
| identity 降级率 | `identity_resolver_fallback_total{reason=timeout}` | < 0.5% |

## 7.5 Feishu 兼容红线(贯穿 M1–M9)

任一里程碑只要触发以下之一,**必须立刻回滚**:

- Feishu 任意群/p2p 出现:消息丢失、重复出站、回复顺序错乱、流式编辑到错消息、abort 卡死 > 30s。
- `im_outbound_log.state='failed'` 比例较基线翻倍。
- 现网报错类型分布新增出现率 > 0.1% 的错误。
- 用户主观反馈(Slack / 群)出现「bot 变傻 / 不回复 / 回别人的话」。

红线判定人:值班工程师 + 产品 owner 任一即可触发回滚,事后复盘。

## 7.6 里程碑详述

### M0 · 基线 & 脚手架(1–2w)

**目标**:把"可回滚"、"可观测"两件事备齐,不动业务。

**动作**
- [ ] 确认 feature flag 基础设施(若无则先引入最简版:`brain_config.extra.featureFlags` + namespace 级覆盖)。
- [ ] 在 `server/src/im/` 打埋点,覆盖 7.4 全部指标(Prometheus + OTEL)。
- [ ] 新建审计表 `im_chat_audit`(见 `06-observability-tenancy.md` 6.2),先空跑,不写数据。
- [ ] 整理 Feishu 现网 **golden trace**(10 条 happy path + 5 条 abort + 3 条崩溃恢复)作为后续对比样本。

**验收**
- 72h 指标面板跑通,全量埋点 no-op 无异常。
- `featureFlags` 在 staging 可读/可改/热生效。

**回滚**:本阶段纯新增,flag 关闭 = 回到现状。

---

### M1 · 身份权威层迁移(2–3w)

**目标**:把"谁是谁"的真相从 yoho-memory 文本 + 进程内逻辑 挪到 yoho-remote PostgreSQL,yoho-memory 退化为异步同步源与候选画像仓。

**动作**
- [ ] DDL:`platform_identities(platform, channel_id, platform_user_id, person_slug, email, display_name, first_seen_at, last_seen_at, confidence, UNIQUE(platform, channel_id, platform_user_id))`。
- [ ] 新增 `IdentityResolver` 服务(模块放在 `server/src/im/identity/`)。
- [ ] **Shadow 阶段**(flag `agentMesh.identity.shadow`):入站仍走老路径,同时 resolver 并行解析并落 `platform_identities`,对比输出,不影响决策。
- [ ] **双读阶段**(flag `agentMesh.identity.dualRead`):resolver 先查本地表 → miss 回落 `keycloakLookup` + yoho-memory → 异步 upsert。
- [ ] **权威阶段**(flag `agentMesh.identity.authoritative`):bridge 不再直接用 `senderName + senderEmail`,只用 `ResolvedIdentity`。

**双写策略**
- yoho-memory identity-bridge skill 仍是 candidate 写入点。
- `platform_identities` 为**读写权威**;每次 resolve 命中后异步 upsert + 打 `last_seen_at`。

**切读切点**
- `agentMesh.identity.authoritative` 打开 = 切读。同时保留 `dualRead` 48h,两者输出不一致记 `identity_resolver_mismatch_total`。mismatch 率 < 0.5% 持续 48h 才允许进 M2。

**回滚**
- 关 `authoritative` → 回到 `dualRead` 行为(本地查不到就回退)。
- 关 `dualRead` → 回到 M0 的老路径。
- 表保留(反正只读)。

**验收**
- resolver 命中率 > 95%,P95 < 150ms。
- mismatch 率 < 0.5%。
- 现网任意一个历史 openId 解出的 personSlug 与 yoho-memory team/members 一致(抽 200 个核对)。

**红线**
- personSlug 漂移(同一 openId 昨天是 A 今天是 B)→ 立刻回滚,查 yoho-memory identity-bridge 决策。

---

### M2 · `im_chat_sessions` 通用化(2w)

**目标**:从 `feishuChatSessions` 迁到 `im_chat_sessions(platform, channel_id, chat_id, runtime_type, runtime_session, state, ...)`,Feishu 逻辑不感知。

**动作**
- [ ] DDL 见 `01-multi-channel-ingress.md`;先**只建表**,不迁数据。
- [ ] `ChatSessionStore` 抽象封装读写,当前实现内部仍走 `feishuChatSessions`(shadow 写新表)。
- [ ] **Shadow 写**(flag `agentMesh.chatSessions.shadowWrite`):每次老表写时同步写 `im_chat_sessions`(platform='feishu')。新表只写不读。
- [ ] **双读校对**(flag `agentMesh.chatSessions.dualRead`):ChatSessionStore 读时两表都查,diff 记 `im_chat_sessions_divergence_total`;以老表为准。
- [ ] **切读**(flag `agentMesh.chatSessions.readNew`):ChatSessionStore 读新表;老表只 shadow 写。
- [ ] **停写老表**(flag `agentMesh.chatSessions.writeOnlyNew`,M9 才开)。

**回滚**
- 任何一级 flag 关闭即退回上一级行为。
- 老表数据完整保留到 M9。

**验收**
- dualRead 窗口 ≥ 7 天,divergence < 10 条/天 且全部可解释(多为时序抖动)。
- 崩溃恢复场景在 readNew 下也能正确识别 `chatsToRecover`(staging 模拟 kill -9 × 5 次)。

**红线**
- 切读后出现 chatSession 丢失导致 Feishu 群不回复 → 立刻回 `dualRead`。

---

### M3 · `ChatStateMachine` CAS(2w)

**目标**:把散落的 `busy`、`creating`、`lastBatchPassive`、`debounceTimer` 等 bool/timer 收口到显式状态机,换 CAS 防并发。

**动作**
- [ ] `im_chat_sessions.state` 新列(默认 `idle`),带值 enum:`idle | busy | manual | aborting`。
- [ ] 新模块 `server/src/im/state/ChatStateMachine.ts`:唯一入口 `transition(id, from, to, reason)` 走 DB CAS。
- [ ] **Shadow 阶段**(flag `agentMesh.chatState.shadow`):bridge 内部根据现有 bool 推导 state,写入新列,不读。
- [ ] **切换阶段**(flag `agentMesh.chatState.enabled`):bridge 决策读 state;写仍两路(bool + state)以便回滚。
- [ ] `busyWatchdog` 迁到 state machine 事件驱动(从定时扫 `busySinceAt` 改为订阅 `busy` 超时)。

**回滚**
- 关 `enabled` → bridge 回到读 bool。state 列继续写(影子)。

**验收**
- 72h 内 `chat_state_transition_total` 分布正常,无 `aborting → busy` 之类非法转换。
- CAS 冲突率 < 0.1%(高了说明并发边界不对)。
- busyWatchdog 命中率 ≥ 基线。

**红线**
- 出现 `state=busy` 但实际 runtime 已 close 超 10min 的僵尸 → 回滚并审计 state 流转日志。

---

### M4 · per-chat Actor + Outbox + CancelToken(3w)

**目标**:把「同一 chat 串行」「出站幂等」「打断可取消」三件事在同一层收口。不解决它们 = 并发必炸。

**动作**
- [ ] `ChatActor`(per chatSessionId Promise queue + 显式 `cancelToken`,内存实现;跨进程串行已由 state CAS 保证)。
- [ ] 出站 outbox:新表 `im_outbound_log(platform, channel_id, chat_id, turn_id, reply_index, state, sent_at)` UNIQUE `(platform, channel_id, chat_id, turn_id, reply_index)`。
  - 先 shadow 写(flag `agentMesh.outbox.shadowWrite`):每次 `sendReply` 后补记;不阻塞发送。
  - 再切成「先写 outbox → 发送 → 更新 state」(flag `agentMesh.outbox.enforced`)。
- [ ] CancelToken:每轮 flush 时生成,abort 时 `cancel()`,StreamCoalescer、DB tail 恢复、编辑 throttle 都订阅同一个 token。
- [ ] **Shadow 模式**(flag `agentMesh.chatActor.shadow`):actor 计算决策 + outbox 幂等检查,但仍走旧路径;对比差异记录。
- [ ] **切换**(flag `agentMesh.chatActor.enabled`):所有入站/出站/abort 走 actor。

**双写/回滚**
- outbox 表先 shadow 7 天,再 enforced;enforced 打开后若 `im_outbound_log.state='failed'` 上涨立刻回退 shadow。
- actor 关闭 = 回到当前 BrainBridge 单例处理。

**验收**
- shadow 一致率 > 99.9%(actor 决策与旧路径结果相同)。
- 人为注入重复 inbound(同 messageId)× 100,outbox 不产生重复出站。
- 人为注入 abort 风暴(50 次连续 abort)× 10 chat,无死锁、无 state 漂移。

**红线**
- Feishu 出站时延 P95 > 基线 × 1.3 → 回退 shadow。

---

### M10 · Policy & Approval 骨架(3–4w,hosted 与 capability 全量上线的硬前置)

> 详细设计见 [`10-approval-and-policy.md`](./10-approval-and-policy.md) 的 10.11。本里程碑在 07 章独立列出,是因为它是 M5 切 enforce、M6 DingTalk 灰度、M7′/M8′ capability 放量的**共同前置**,不允许并行或后置。

**目标**:在 hosted runtime 和 capability server 共享的路径上落一层 PolicyGate + ApprovalService,先 shadow 后 enforce,使 M5 切换与 M7′ 上线可以在"执行前拦截"的保障下进行。

**动作**
- [ ] `server/src/policy/` 骨架:`PolicyGate.evaluate`、actor/action/scope schema、profile loader、`policy_decision_log` DDL。
- [ ] `server/src/approvals/` 骨架:`ApprovalService.createFromGate`、approvalToken 签发 / 校验、`approval_tickets` + `approval_ticket_events` DDL。
- [ ] 飞书卡片 + Web 面板通知渠道(最小版本)。
- [ ] **Shadow 模式**(flag `agentMesh.policy.shadow`):调用点把 action 与 scope 构造出来,送入 PolicyGate 只记录不拦截,用 3-7 天观察假阳/假阴。
- [ ] **Enforce 模式**(flag `agentMesh.policy.enforce.<path>`):按子路径(brain-runtime / capability-memory / capability-outbound 等)逐条切 enforce。
- [ ] `open.remote_session.external` 永久 `deny` rule 写入 policy profile 基线(冗余兜底 09.1.1)。
- [ ] CI guard:禁止 profile 文件包含任何"对 external peer 放行 hosted session"的条件。

**双写/回滚**
- shadow 与 enforce 同 flag 位,关 enforce 回 shadow,关 shadow 回完全旁路(仅 M10.0 过渡期允许)。
- 一旦 M5 切 enforce,本里程碑不允许整体回滚 —— 回滚单条 rule 而非关整层。

**验收**
- Shadow 期间 `policy_decision_log` 对 hosted runtime 7 天流量全覆盖、无 handler 漏接。
- Approval 端到端 e2e:发起 → 通知 → 批 → 执行 全链路 < 2min(人工场景)。
- Fail-closed 演练:ApprovalService 宕机时,命中 `require_approval` 的动作返回"已提审失败",**不** fail open。
- `deny` rule 覆盖测试:尝试以 external actor 触发"开 remote session"动作,必须 100% 被 policy 拦下。

**红线**
- 发现任何路径绕过 PolicyGate(直接调 tool / 直接出站)→ 立刻 block 合并,补丁上线前冻结相关 handler。
- approvalToken 出现可重放、跨 ticket 有效、可伪造 → 立刻回滚 approval enforce 并冻结发布。

---

### M5 · `RuntimeAdapter` 抽取(Brain)(3–4w,依赖 M10.0 + M10.1)

**目标**:把 `BrainBridge` 里调 SyncEngine 的代码剥出来成 `BrainRuntimeAdapter`,BrainBridge 降格为 MessageBridge(入站 + 路由 + 出站编排);所有 tool use / 出站在 adapter 内必经 PolicyGate。

**动作**
- [ ] 新模块 `server/src/im/runtimes/BrainRuntimeAdapter.ts` 实现 `RuntimeAdapter` 契约(见 `03-agent-runtimes.md` 3.3)。
- [ ] SyncEngine 事件 → `RuntimeEvent` 映射层单独测试(golden events)。
- [ ] **Shadow 模式**(flag `agentMesh.runtimeAdapter.brain.shadow`):
  - 老路径:BrainBridge 直接调 SyncEngine,正常工作。
  - 新路径:BrainRuntimeAdapter 并行订阅同一 session 的事件流,映射成 RuntimeEvent,与老路径输出对比,不发消息。
- [ ] **切换**(flag `agentMesh.runtimeAdapter.brain.enabled`):MessageBridge 通过 adapter 调用,老直连路径保留但短路不执行。
- [ ] 既有 `sendSummary` / DB tail fallback / `agentMessages` 解析保留在 adapter 内部。
- [ ] **PolicyGate 接入**(依赖 M10):adapter 内所有 tool use 与出站副作用在执行前 `policyGate.evaluate`;`require_approval` 本轮提审并返回 "已提交审批" 提示,不阻塞 abort;`deny` 直接拒并落 audit。

**双写/回滚**
- shadow 与 enabled 共存 7 天,事件流一致率 > 99.9% 再切。
- 关 `enabled` 回到直连;关 `shadow` 回到纯老路径。

**验收**
- shadow 窗口内事件一致率 > 99.9%(按 seq 对齐,忽略时序抖动 < 200ms)。
- 切换后流式编辑次数 / turn、summary 内容 SHA 对 100 条 happy path 全一致。
- `im_runtime_error_total{runtime=brain,retryable}` 分布不变。

**红线**
- 流式编辑错消息、summary 内容 drift > 1% → 立刻回滚。

---

### M6 · DingTalk Adapter(2w,依赖 M1 / M2 / M4)

**目标**:第一个非 Feishu 渠道,用来验证 01 章的抽象。不接 runtime(延续现有 Brain),只验 ingress。

**动作**
- [ ] `server/src/im/platforms/dingtalk/DingTalkAdapter.ts` 实现 `IMAdapter` 契约。
- [ ] 签名校验(HMAC-SHA256 outgoing callback)+ 去重(`im_inbound_log` UNIQUE)。
- [ ] 注册到 `ChannelRegistry`,配置走 `brain_config.extra.channels.dingtalk.<namespace>`。
- [ ] **灰度 flag**(namespace 级):`agentMesh.channels.dingtalk.<namespace>.enabled`。
- [ ] 凭证走 `yoho-credentials`(新增 `dingtalk/<namespace>`)。

**灰度顺序**
1. 内测 namespace 1 个 chat(owner 自测) × 3 天。
2. 内测 namespace 全量 × 3 天。
3. 首个客户 namespace。

**回滚**
- 关 namespace flag → DingTalk 入站直接 401(同 channel 未启用)。
- 适配器代码保留,影响面只在 channel 层。

**验收**
- 签名校验:恶意篡改请求 × 50 全部 401,合法请求 0 误判。
- 去重:同 messageId 10s 内 × 20 仅 1 次入 runtime。
- 出站 meta-action 兼容降级:`[recall]`、`[pin]` 等在 DingTalk 不支持的静默降级,不抛错。

**红线**
- Feishu 指标不动(本里程碑不应影响 Feishu)。

---

### M7′ · OpenClaw (M4) 外部接入 · Capability 接口与客户端(3–4w,依赖 M5 + M10.3)

> ⛔ **硬约束(2026-04-20)**:本里程碑**不**产出任何 `OpenClawRuntimeAdapter`,**不**在 `server/src/im/runtimes/` 下新增文件,**不**让 M4 走 remote bridge,**不**开任何形式的 remote session。若设计评审出现"让 M4 走 session 跑一轮"的提案,按 9.1.1 直接否。

**目标**:把 M4 变成 remote 的 **capability 消费者**。remote 侧交付 capability API / MCP,M4 侧接客户端。双方通过 HTTP + MCP 协作;M4 仍用它自己的 IM bot / 调度器处理用户消息。

**动作**
- [ ] `server/src/capabilities/api/{memory,identity,audit,config,outbound}.ts` 按 09.3 表格落地。
- [ ] `server/src/capabilities/auth/` 发 app token、按 `(externalSystem × namespace)` 限流。
- [ ] `server/src/capabilities/mcp/` MCP server,toolset 镜像 API 能力。
- [ ] `brain_config.extra.externalConsumers[].id = 'm4'`,绑定 `approvalProfile` 与 `canTriggerOutbound` 白名单。
- [ ] **PolicyGate 强制前置**(依赖 M10.3):所有 handler 首行 `policyGate.evaluate`;`outbound` 默认 `require_approval`。
- [ ] M4 侧接入 external consumer SDK(在 openclaw 仓内),改造原先直连 yoho-memory 的调用走 `/v1/memory/*`。
- [ ] **验证路径全走 9.6 替代方案**:capability mock(fixture)、sandbox capability server、录制回放、M4 自家 e2e harness —— **不**在 remote 代跑 session。

**灰度**
- Flag:`agentMesh.capabilities.<endpoint>.m4.enabled`(per endpoint × external system)、`agentMesh.externalConsumers.m4.namespace.<ns>.enabled`。
- 顺序:M4 打 sandbox capability × 2 周 → 生产 capability(read-only endpoint) × 1 周 → 开放 `outbound`(带 approval)。

**回滚**
- 关 endpoint flag:对应 handler 返回 503;M4 侧自动 fallback 到自家存储(降级路径在 M4 仓内实现)。
- 撤销 app token(运维动作,≤ 5min)。
- 对已发出的 approval ticket 可调用 revoke。

**验收**
- 契约:M4 侧 SDK 对所有 endpoint 的回归测跑通 sandbox;生产灰度 7 天无 5xx spike。
- Policy:L3/L4 动作 100% 经 approval;尝试直连数据库 / 直连 yoho-memory 的行为 0 次。
- Audit:`external_capability_audit` 对 M4 流量全覆盖,字段(policy_decision / approval_ticket_id 等)无空值。

**红线**
- 发现 capability handler 漏接 PolicyGate → 立刻下线该 endpoint,不回滚整个里程碑。
- 发现任何提议"让 remote 代 M4 开 session" 的 PR → 直接 deny,本 playbook 依据 9.1.1 拦。

---

### M8′ · Hermes (H2) 外部接入 · 实验性 capability 消费(2–3w,依赖 M7′)

> ⛔ **硬约束**:与 M7′ 相同。**不**产出 `HermesRuntimeAdapter`,**不**开"实验 namespace 托管 H2 session";`/h2` 前缀在 hosted 流永为拒绝。

**目标**:H2 作为第二个 external consumer 接入,验证 capability API 对新 peer 的扩展成本。

**动作**
- [ ] 复用 M7′ 产出的 capability API / MCP / auth / PolicyGate,不新增路径。
- [ ] `externalConsumers[].id = 'h2'`,更严的限流、独立的 approvalProfile(实验场景 approver 列表不同)。
- [ ] H2 侧接 external consumer SDK,读写 yoho-memory 通过 `/v1/memory/*`;audit 通过 `/v1/audit/*`。
- [ ] 校验 capability 契约对 H2 的 Python 客户端同样可用(跨语言 OpenAPI schema)。
- [ ] 验证路径同样走 9.6 替代方案(capability mock、sandbox、回放、H2 自家 e2e harness)。

**灰度**
- Flag:`agentMesh.externalConsumers.h2.namespace.<experiment>.enabled`,仅对实验 namespace 开。
- 内部成员 sandbox 2 周 → 实验 namespace 生产 read-only 1 周 → 按需开 `outbound`。

**回滚**
- 撤 app token;关 endpoint flag;revoke 未执行的 approval ticket。

**验收**
- H2 客户端对 capability endpoint 的契约测试通过。
- 跨语言 schema 无 drift(OpenAPI CI 校验)。
- 实验期间 `policy_decision_log{externalSystem=h2, decision=deny}` 与预期规则 100% 一致。

**红线**
- 出现"跳过 PolicyGate 直连数据库 / 跳过 approval 直接 outbound"的旁路 → 立即冻结 H2 流量。

---

### M9 · 收尾(1–2w)

**目标**:清理双写、移除老代码、定版监控面板。

**动作**
- [ ] 打开 `agentMesh.chatSessions.writeOnlyNew`,停写老 `feishuChatSessions`。
- [ ] 数据归档老表 → `feishuChatSessions_archive_202604`。
- [ ] 删除旧 bool 标志、旧 BrainBridge 直连逻辑、旧 identity 直查路径。
- [ ] 删除 `agentMesh.*.shadow` / `agentMesh.*.dualRead` / `agentMesh.*.enabled` 等 flag 及配置。
- [ ] 监控 dashboard 正式化:7.4 指标全量 + Chapter 06 指标全量。
- [ ] 文档更新:在 `00-overview.md` 标注「实现已对齐」章节。

**回滚**:本阶段不可回滚(单向收尾)。因此 M9 之前所有门必须严格通过。

## 7.7 回滚矩阵

| 里程碑 | 可回滚级别 | 单向点 | 回滚时效 |
| --- | --- | --- | --- |
| M0 | 完全 | — | 立即 |
| M1 | flag 级 | personSlug 一旦对外暴露写入 yoho-memory canonical | ≤ 5min |
| M2 | flag 级 | 新表独立,老表完整;writeOnlyNew 是单向点 | ≤ 5min(前)/ 1 周(后) |
| M3 | flag 级 | state 列保留 | ≤ 5min |
| M4 | flag 级 | outbox UNIQUE 一旦 enforced 依赖其唯一约束 | ≤ 5min(shadow)/ 30min(enforced) |
| M10 | path-level flag | 一旦 enforce 打开 → 回 shadow 即失保护,只能按 rule 级回滚 | 单 rule ≤ 5min;整层不回滚 |
| M5 | flag 级 | — | ≤ 5min |
| M6 | namespace flag | DingTalk 凭证一旦配置 | ≤ 5min |
| M7′ | consumer flag + endpoint flag | M4 接 external consumer 后撤销 app token 需组织沟通 | ≤ 5min(撤 token / 关 endpoint)|
| M8′ | consumer flag | — | ≤ 5min |
| M9 | 不可回滚 | 全部 | — |

**原则**:每个"单向点"跨越前必须开工程评审会,产出 GO/NO-GO 结论并留档。

## 7.8 按角色的推进清单

### 值班/SRE 每次里程碑切换前

- [ ] 确认 7.4 基线指标当天对比 7 天均值无异常。
- [ ] 确认回滚演练在本 namespace 过了 dry-run。
- [ ] 检查告警规则是否覆盖本里程碑新增指标。

### 工程 owner 切换中

- [ ] 在 `#yoho-remote-oncall` 广播 flag 名、切换时间、回滚决策人。
- [ ] 开启本里程碑专属 dashboard,保持 2h 人工观察。
- [ ] 任一红线触发 → 不讨论,直接回滚,事后复盘。

### 产品 owner 切换后

- [ ] 72h 验收窗口内每天收一次用户反馈摘要。
- [ ] 出现用户可感知异常 → 升级为 P1,工程同步回滚。

## 7.9 工程评审 checkpoint(硬门)

以下节点必须进工程评审会,不能单人拍板:

1. **M1 切权威前**(personSlug 真正从本地表来)。
2. **M2 切读前**(chat session 读新表)。
3. **M4 outbox enforced 前**(UNIQUE 约束会影响写失败语义)。
4. **M10 PolicyGate 切 enforce 前**(profile 覆盖面、approver 列表、fail-closed 演练一次性定盘)。
5. **M5 BrainRuntimeAdapter 切换前**(主链路替换,必须已挂 PolicyGate)。
6. **M7′ capability API 对外暴露前**(安全、配额、审计、token 管理、approval profile 一次性定盘,跨系统组织动作)。
7. **M9 所有清理动作**(每项独立评审)。

每次评审产出结构化记录入 `docs/analysis/agent-mesh-migration-decisions-YYYY-MM.md`。

## 7.10 不做清单(避免 scope creep)

本次迁移**不做**:

- 重写 Brain CLI 的 session 持久化机制(那是 Brain 内部事)。
- 把 yoho-memory 本身替换成 PostgreSQL(它仍然是 canonical 文档源,只是 yoho-remote 不再直查)。
- 统一 M4 / H2 的 skill / memory 模型(它们各自的演化闭环继续各做各的;remote 只代理必要的读写,不接管建模)。
- **把 M4 / H2 变成 remote hosted runtime / 代跑 session —— 硬禁止,09 章不留例外**。
- **任何"pilot / shadow / debug 场景下让 external peer 借用 remote session"的方案 —— 不做**;需要这类验证就用 9.6 的 capability mock / sandbox / 录制回放 / external test harness。
- 改前端 AssistantChat UI(除非具体 runtime 事件字段变化要前端配合,那也单独开 ticket)。
- 引入新的工作流引擎 / 状态机库(自己写薄的就够)。
- 把 PolicyGate 做成某 runtime 的私有模块(它必须是全 mesh 共享的架构层)。

## 7.11 结束态判定

本迁移 "完成" 的定义:

1. Feishu + DingTalk 两渠道稳定运行 ≥ 30 天,无 7.5 红线事件。
2. M4 作为 external consumer(`externalConsumers['m4']`)在生产 namespace 稳定调 capability API ≥ 14 天,配额/鉴权/审计/policy/approval 全覆盖;全程**零**在 remote 开 session。
3. H2 作为 external consumer(`externalConsumers['h2']`)在实验 namespace 稳定调 capability API ≥ 14 天(或明确 deprecated);同样零 remote session。
4. `feishuChatSessions` 表已归档,`BrainBridge` 代码已删除,`RuntimeAdapter` 是唯一 **hosted** runtime 入口(external peer 走 capability API,不占这个入口)。
5. **PolicyGate + ApprovalService enforce** 覆盖 hosted runtime(brain)与全部 capability endpoint;`open.remote_session.external` deny rule 在生产 profile 常驻,CI guard 阻止任何绕开提交。
6. 监控面板覆盖 7.4 全部指标 + 06 章全部指标 + `policy_decision_total` / `approval_ticket_*`,告警规则上线。
7. 本 playbook 自身归档到 `docs/analysis/agent-mesh-migration-retrospective-YYYY-MM.md`,替换为对齐后的 runbook。

在 6 项之前任一项不满足 = 迁移未结束,本文档继续为活文档,修订追加记录。
