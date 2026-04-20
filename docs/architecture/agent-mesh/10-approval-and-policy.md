# 10 · Policy & Approval 系统:高风险动作的准入约束

> **状态**:与 [`09-hosted-vs-external-runtime.md`](./09-hosted-vs-external-runtime.md) 并列的权威性架构原则。09 章定义"谁能进 remote 的执行路径",本章定义"进入之后,哪些动作必须被拦截/审批"。**不是 Brain 的局部功能,不是 K1 的专属插件,而是全 mesh 的架构能力**。
>
> **适用范围**:所有 hosted bundle(K1 及未来的 K2 / DingTalk-K1 / …)、所有 capability API 消费方(M4 / H2 / 未来 external peer)、所有 MCP 工具调用、所有 remote 出站触发。**没有例外**。

## 10.1 为什么必须把审批放在架构层

- **单点风险**:agent 决定调用一个写接口、发邮件、下单、改生产配置 —— 中间没有拦截就等于相信模型推理。
- **多入口事实**:K1 会成为第一个 bot-surface,但不会是最后一个;M4 / H2 会陆续接入 capability API。"只在 Brain 里做"的策略会在下一个 bundle 上被旁路。
- **事后 audit ≠ 事前 policy**:事后日志能复盘,但不能阻止;必须前置。
- **权限模型可进化**:policy 与 approval 分离,可以先把 rule 写死、再慢慢引入评分 / RBAC / 人审。架构位置先占住。

结论:在 "runtime 或 capability 真正执行副作用" 之前,**必须有一层 PolicyGate 拦一次**。这是 mesh 不可分拆的硬层。

## 10.2 核心概念术语

| 概念 | 定义 | 例子 |
| --- | --- | --- |
| **Actor / Requester** | 发起动作的主体。包含 hosted runtime(如 K1 当前会话)、external consumer(如 M4 app token)、人工操作者(如 SRE via CLI) | `{ kind: 'hosted', bundle: 'k1-feishu-yoho-mobile', sessionId, personSlug }` |
| **Requested Action** | 想执行什么,结构化描述 | `{ verb: 'tool.call', tool: 'feishu.send_message', resource: 'chat:oc_xxx', payload: {...} }` |
| **Resource Scope** | 动作触及的对象与范围 | namespace = `yoho-mobile`、channel = `feishu`、bundle = `k1-*`、external target = `stripe.customer:cus_x` |
| **Policy** | 一组规则,决定某个 (actor, action, scope) 的结果 | "K1 在 namespace=yoho-mobile 内对 feishu.send_message 自动放行,但附带 rate-limit 10/min" |
| **Policy Decision** | PolicyGate 的输出,**四种之一** | `allow` / `allow_with_audit` / `require_approval` / `deny` |
| **Approval Ticket** | policy 说需要人审时产生的工单 | `{ ticketId, requesterSnapshot, actionSnapshot, approvers, expiresAt, state }` |
| **Approver** | 有权批准该 ticket 的人/系统 | 可以是个人(email/飞书 UID)、组(`group:oncall-yoho-mobile`)、自动机(如 "CI ok + 2 reviewer") |
| **Approval Decision** | 批准结果 | `approved` / `rejected` / `expired` / `revoked` |
| **Audit Log** | 全链路不可改日志 | `policy_decision_log` + `approval_ticket_log` + `action_execution_log`,append-only |
| **Expire / Revoke** | 批准本身是有生命周期的 | 批后 TTL 内可执行;发起执行前再查一次是否被 revoke |

所有这些概念在 DB、代码、审计日志中都必须用**同一套术语**,不允许每个 bundle 自定义别名。

## 10.3 动作风险分层(policy → decision)

PolicyGate 对每个请求按以下等级归类。分级规则存在**策略文件**里(`brain_config.extra.policyProfiles[]`),不是硬编码。

| 等级 | 描述 | 默认 decision | 典型例子 |
| --- | --- | --- | --- |
| **L0 Passive read** | 只读、无副作用、无隐私 | `allow` | 查 persona 元信息、查 bundle list |
| **L1 Contextual read** | 读取可能涉及多租户数据 | `allow_with_audit` | 读会话历史、读 yoho-memory 中 namespace 作用域内的记忆 |
| **L2 Reversible write** | 可写但可撤销/低代价 | `allow_with_audit`(或 `require_approval`,按 profile) | 往 im_chat_audit append 一条事件、更新本 agent 内部缓存 |
| **L3 External side-effect** | 影响外部系统/用户可见 | `require_approval` | 发 IM 消息给非本 chat 的群、调 Stripe/支付/CRM、发邮件、创建日历事件 |
| **L4 Privileged / high-blast** | 生产配置、跨 namespace、凭证、批量 | `require_approval`(高权 approver) | 修改 `brain_config.extra`、下发凭证、批量出站、写 prod DB schema |
| **L5 Forbidden** | 不允许,policy 应直接拒 | `deny` | 读 channel 凭证本体、为 external peer 开 remote session(见 09.1.1)、删除 audit 日志 |

每个动作在代码侧的入口必须显式携带 `riskLevel` 或由 policy 从动作特征推出。不允许"静默当 L0"。

## 10.4 审批流程(最小版本)

```
Actor 发起 Action
        │
        ▼
┌────────────────────┐
│ 1. PolicyGate.check│  ← 输入: Actor / Action / Scope / Context
│   (本地 rule)      │
└──────────┬─────────┘
           │
  ┌────────┴─────────┐
  │                  │
  ▼                  ▼
allow /           require_approval         deny
allow_with_audit          │                  │
  │                       ▼                  ▼
  │              ┌─────────────────────┐   返回 407-like 错误,落 audit
  │              │ 2. ApprovalService  │
  │              │    .createTicket    │
  │              └─────────┬───────────┘
  │                        │
  │                        ▼
  │              ┌─────────────────────┐
  │              │ 3. Notify approvers │  ← 飞书/邮件/Slack/在线面板
  │              │    (per profile)    │
  │              └─────────┬───────────┘
  │                        │
  │                   approved / rejected / expired / revoked
  │                        │
  │                        ▼
  │              ┌─────────────────────┐
  │              │ 4. Actor 重放 Action │
  │              │   带 approvalToken  │
  │              └─────────┬───────────┘
  │                        │
  │                        ▼
  │              ┌─────────────────────┐
  │              │ 5. PolicyGate.verify │ ← 复查 ticket 状态 + scope
  │              │    (防止伪造/revoke)│
  │              └─────────┬───────────┘
  ▼                        ▼
  ┌───────────────────────────────────┐
  │ 6. Executor 执行                   │  ← tool call / outbound / write
  │ 7. Audit log 写 action_execution   │
  └───────────────────────────────────┘
```

关键点:
- **一次 approval、一次执行**:ticket 绑定具体 action 快照;approver 批准的是"这个请求",不是"未来任意同类请求"。重放必须带 `approvalToken`,且 PolicyGate 会在第 5 步再次 verify。
- **Ticket 过期**:默认 TTL 由 profile 设定(如 15 分钟)。过期即 `expired`,不能执行。
- **Revoke**:approver / 运维可在执行前撤销 ticket;第 5 步 verify 必须发现 revoke 并拒绝。
- **幂等 token**:`approvalToken` 一次有效;执行完即消费。防止重放攻击。
- **降级通道**:ApprovalService 不可用 → PolicyGate 默认 `deny`(fail closed),**不** fail open。

## 10.5 PolicyGate 在 hosted 路径与 capability 路径上的位置

### Hosted 路径(K1 / brain-local 的每一轮)

```
FeishuAdapter ─► MessageBridge ─► IdentityResolver ─► ChatRouter
                                                          │
                                                          ▼
                                               BrainRuntimeAdapter
                                                          │
                                       (Claude Code 每次 tool call /
                                        每次 outbound 侧边效应)
                                                          │
                                                          ▼
                                                    PolicyGate
                                                          │
                                              allow / approval / deny
                                                          │
                                                          ▼
                                                     Tool Executor
                                                          │
                                                          ▼
                                                StreamCoalescer → 用户
```

- Brain 里的 tool use 和对外发送 **都**要过 PolicyGate;不是"BrainBridge 内部自动帮你放行"。
- Actor 快照填 `{ kind: 'hosted', bundle, sessionId, turnId, personSlug }`,便于事后审计能追到具体 chat 和人设。

### Capability 路径(M4 / H2 调 remote 的每一次)

```
External Consumer (M4/H2) ─► capability server (HTTP/MCP)
                                      │
                                      ▼
                               Auth + RateLimit
                                      │
                                      ▼
                                 PolicyGate
                                      │
                          allow / approval / deny
                                      │
                                      ▼
                        capability handler (memory/outbound/…)
                                      │
                                      ▼
                             Audit + Response
```

- 同一份 PolicyGate 代码、同一份 policy profile 语法,只是 Actor 的 `kind = 'external'` 且 payload 里有 `externalSystem = 'm4'|'h2'|…`。
- capability `outbound` 这类 L3/L4 动作默认 `require_approval`,具体 approver 由 bundle 的 `approvalProfile` 决定。

### 人工路径(SRE / 后台)

- CLI / 后台也是 Actor(`kind = 'human', identity`),同样走 PolicyGate。区别是人工常被 policy 识别为"自己就是 approver",从而得到 `allow_with_audit`。
- 但高权动作(L4)仍可能要求"4 眼原则":另一个人点批。

## 10.6 Policy Profile 与 Approval Profile

两个 profile 同时存在,在 bundle / externalConsumer / human role 上分别绑定。

### Policy Profile(规则层)

```jsonc
{
  "profileId": "k1-default",
  "rules": [
    { "match": { "verb": "tool.call", "tool": "feishu.send_message",
                 "scope": { "channel": "feishu", "chatIn": "$currentChat" } },
      "decision": "allow_with_audit",
      "rate": "10/min" },

    { "match": { "verb": "tool.call", "tool": "feishu.send_message",
                 "scope": { "chatOut": "$currentChat" } },
      "decision": "require_approval",
      "approvalProfile": "broadcast-review" },

    { "match": { "verb": "capability.outbound",
                 "scope": { "bundle": { "any": true } } },
      "decision": "require_approval",
      "approvalProfile": "external-outbound" },

    { "match": { "verb": "open.remote_session.external" },
      "decision": "deny",           // 09.1.1 硬禁止,policy 侧再兜一道
      "reason": "external runtime peers must not open remote session (see 09.1.1)" }
  ],
  "defaultDecision": "deny"
}
```

- `defaultDecision: deny`:所有 profile 在无匹配时默认拒。fail closed。
- 规则可引用 `$currentChat` / `$callerBundle` 等上下文变量,避免写死。
- L5 禁止项必须写成显式 `deny` rule,不依赖默认值 —— 留审计痕迹。

### Approval Profile(审批层)

```jsonc
{
  "profileId": "broadcast-review",
  "approvers": [
    { "kind": "group", "ref": "group:bundle-owner:k1-feishu-yoho-mobile" },
    { "kind": "group", "ref": "group:oncall-yoho-mobile" }
  ],
  "quorum": 1,
  "ttlSeconds": 900,
  "notify": ["feishu:bundle-owner-oncall", "email:oncall@yoho"],
  "allowSelfApprove": false
}
```

- `quorum`:最少几个 approver 同意。敏感动作(L4)设 2。
- `ttlSeconds`:ticket 过期时间。
- `allowSelfApprove: false`:Actor 就算在 approver 组也不能自己批自己的 ticket。

## 10.7 数据存储与审计表

| 表 | 作用 | 关键列 |
| --- | --- | --- |
| `policy_decision_log` | 每次 PolicyGate.check 落一行 | `id, actorSnapshot jsonb, action jsonb, scope jsonb, decision, matchedRuleId, at` |
| `approval_tickets` | 需要审批的动作 ticket | `ticketId, state, actionSnapshot jsonb, approvalProfile, approvers jsonb, createdAt, expiresAt, resolvedAt, resolvedBy, resolution, approvalToken` |
| `approval_ticket_events` | ticket 生命周期事件 | `ticketId, eventType(created/notified/voted/approved/rejected/expired/revoked), actor, at, payload` |
| `action_execution_log` | 实际执行结果 | `executionId, ticketId?, action jsonb, actor jsonb, startAt, finishAt, ok, errorSummary, auditRef` |

- 所有表 **append-only**;修正只能通过新增 "correction" 事件,不允许 update/delete。
- `policy_decision_log` 即便 `decision=deny` 也落;用于发现策略漏洞与尝试恶意入口。
- `action_execution_log.ticketId` 为空仅当 decision 是 `allow` / `allow_with_audit`;否则必填,未填视为审计完整性事故。

## 10.8 Actor 端 API(runtime / capability 侧如何接入)

两类实现,都只调 PolicyGate 的一个入口:

### TypeScript(hosted 侧)

```ts
const gateResult = await policyGate.evaluate({
  actor: {
    kind: 'hosted',
    bundle: 'k1-feishu-yoho-mobile',
    sessionId,
    turnId,
    personSlug,
  },
  action: {
    verb: 'tool.call',
    tool: 'feishu.send_message',
    payload: { chatId, text },
  },
  scope: { channel: 'feishu', chatIn: chatId },
});

switch (gateResult.decision) {
  case 'allow':
  case 'allow_with_audit':
    await toolExecutor.run(gateResult.executionToken);
    break;
  case 'require_approval':
    const ticket = await approvals.createFromGate(gateResult);
    await notifyActorAboutPending(ticket);
    return;                // 不阻塞本轮;K1 可以告知用户正在审批
  case 'deny':
    await handleDeniedByPolicy(gateResult);
    return;
}
```

### Capability 侧(HTTP handler 内)

每个 capability handler 第一步固定写:

```ts
const gate = await policyGate.evaluate({
  actor: buildExternalActor(req),
  action: describeActionFromRoute(req),
  scope: extractScope(req),
});
if (gate.decision === 'deny') return res.status(403).json(gate);
if (gate.decision === 'require_approval') return res.status(202).json(await approvals.createFromGate(gate));
// allow / allow_with_audit → 继续
```

handler 里**严禁**跳过 PolicyGate 直接写业务;lint rule + code review 层把关。

### 10.8.1 入口统一语义：plugin / SDK / MCP / skill 都只是运输层

- 不管入口长什么样,进入 PolicyGate 的都必须是同一类 `actor + action + scope` 请求;**入口形态不能决定放行与否**。
- MCP tool、external consumer SDK、host-specific thin plugin、portable skill/schema package,在 `yoho-remote` 侧都只能映射成 capability 或 policy action,不能自带特权。
- `skill` 只能描述能力、schema、约束和 manifest,不能偷渡执行主权。
- `plugin` 只能做宿主适配或薄封装,不能绕过 PolicyGate,不能直接拿 `approvalToken` 当通行证。
- `SDK` 只是把请求发得更顺手,不是越权通道;每次调用仍然要经过 PolicyGate,高风险仍然要 Approval Ticket。
- `MCP` 只是换了 transport,语义不变;所有写操作、外部副作用、敏感配置变更都按 10.3 分级。

## 10.9 不需要审批 vs 需要审批 vs 必须人工审批

| 场景 | 路径 | 备注 |
| --- | --- | --- |
| 查 persona 配置 | PolicyGate → allow | L0,通常无需 audit |
| 读会话历史 / 读 memory | PolicyGate → allow_with_audit | L1,留痕但自动放行 |
| agent 在本聊 chat 内回复 | PolicyGate → allow_with_audit(rate-limited) | L1-L2,属于本 chat 范围内的出站 |
| agent 想往另一个群发消息 | PolicyGate → require_approval | L3,approver 由 bundle owner 组决定 |
| capability.outbound 到指定 bundle | PolicyGate → require_approval | L3/L4,external peer 发起的出站永远审批 |
| 修改生产 config | PolicyGate → require_approval(quorum=2) | L4,两个 approver |
| 为 external peer 开 remote session | PolicyGate → deny | L5,09.1.1 硬禁止,policy 冗余拦一次 |
| 删 audit 日志 / 拿 channel 凭证 | PolicyGate → deny | L5,无条件拒 |

"默认放行 + 偶尔拦"是**错**的设计;本架构是"默认审计 + 高风险拦 + 未匹配拒"。

## 10.10 与 00–09 章的对齐(修正点)

| 原章节 | 修正 |
| --- | --- |
| 03 章 `RuntimeAdapter` 契约 | 新增约束:**所有 tool use / outbound / 副作用写 必经 PolicyGate**;adapter 实现不能内嵌旁路。|
| 04 章端到端流 | 在 runtime 调用前、在 capability handler 内各插一次 PolicyGate;失败路径明确:`require_approval` 时本轮不继续,返回"已提审"提示,审批完后由 actor 重放。|
| 06 章 可观测 | 必须暴露 `policy_decision_total{decision}`、`approval_ticket_total{state}`、`approval_ticket_duration_seconds`、`action_execution_total{riskLevel, ok}`。|
| 07 章 迁移 | 新增 M10 里程碑"Policy & Approval 骨架落地"作为 hosted 全量上线(M5 完成)和 capability 全量上线(M7′)的**前置**,不得并行后置。|
| 09 章 | 9.1.1 的硬禁止在 policy 侧以显式 `deny` rule 冗余兜底(10.6 示例)。|

## 10.11 实施里程碑(作为 07 章 M10 的详稿)

- **M10.0**:术语表、profile schema 定稿,policy_decision_log / approval_tickets DDL 落地。flag 全关,shadow 执行(只记录不拦截)。
- **M10.1**:K1 hosted 路径接入 PolicyGate(enforce),先覆盖 L3 以上写/外部副作用。L0/L1 保持 allow。
- **M10.2**:ApprovalService 最小实现 + 飞书通知渠道;人工审批走飞书卡片 + Web 面板。
- **M10.3**:capability server 所有 handler 前置 PolicyGate(enforce);`open.remote_session.external` 的 deny rule 永久生效。
- **M10.4**:扩展 profile 覆盖 L4 场景(生产配置、凭证下发、批量出站);quorum、revoke、TTL 稳定。
- **M10.5**:把 PolicyGate 作为新 bundle / 新 capability / 新 tool 上线的 CI 硬检查(无 profile 绑定不许发布)。

## 10.12 一句话结论

> **Agent 与 external peer 想做的每一件"会离开自己进程"的事,都先问 PolicyGate;高风险动作在执行前必须有 Approval Ticket;没有 token 就没有执行,也没有漏网的 bundle。**
