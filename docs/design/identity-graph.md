# Yoho Remote 多渠道身份关联与 Identity Graph 设计

## 1. 背景

当前仓库里已经存在多条“身份链”，但它们彼此没有统一成一个可审计、可确认、可回滚的实体模型：

- Web/PWA 通过 Keycloak 登录，服务端在 `server/src/web/middleware/auth.ts` 里只把 `userId=sub`、`email`、`name`、`role` 放到请求上下文。
- Session 归属仍以 `sessions.created_by=email` 为主，`server/src/web/routes/sessions.ts` 和 `server/src/web/routes/guards.ts` 也按 email 做共享和访问控制。
- Telegram 只有 `users(platform, platform_user_id, namespace)` 这种轻量绑定，适合通知，不适合做“同一人”解析。
- Feishu BrainBridge 已经存在：`server/src/im/BrainBridge.ts` + `server/src/im/feishu/FeishuAdapter.ts` 会拿到 `open_id`、姓名、企业邮箱，并且把 chat 到 session 的映射存在 `feishu_chat_sessions`，但“飞书用户 <-> Keycloak 用户”的关系目前只是临时查 Keycloak，再写一份文本到 yoho-memory，不是 PostgreSQL 里的权威绑定。
- `server/src/im/types.ts` 已经把 IM 侧抽象成平台无关适配器，这给接入自定义 IM / 企业微信提供了很好的扩展点。

结论：现在系统有“账号”和“会话”，但没有“人”。本设计要补上的就是这一层。

## 2. 目标与非目标

### 2.1 目标

1. 在 Feishu、yoho-remote（Keycloak/Web/PWA）、自定义 IM / 企业微信之间建立“同一人”的统一图谱。
2. 同时支持：
   - 高置信自动匹配
   - 管理员确认 / 拒绝 / 拆绑 / 合并
3. 让 session 在不破坏现有架构的前提下拿到 `resolved person`：
   - 单人入口：session 级默认人
   - 多人群聊：消息级 actor
4. 处理以下风险场景：
   - impersonation
   - 误绑
   - 多人共号
   - 改名
   - 离职 / 停用
   - 设备更换
5. 落到当前 PostgreSQL + Hono + SyncEngine + BrainBridge 架构里，而不是引入图数据库。

### 2.2 非目标

1. 第一阶段不替换现有基于 email 的权限模型。
   - `createdBy/email/shareAllSessions/session_shares` 先保留，identity graph 先做“归因”和“解析”，不是马上重写授权。
2. 第一阶段不回写历史消息，不重写旧 session 的归属。
3. 第一阶段不把 CLI namespace token 直接当“人”。
   - CLI token 更接近“机器/命名空间凭证”，不是稳定的人类身份。

## 3. 设计原则

### 3.1 Person 与 Identity 分离

- `Person` 是“人”的语义实体。
- `Identity` 是某个平台上的账号、主体或账号别名。
- 二者通过 link 关联，而不是把 email / open_id 直接塞进 session。

### 3.2 稳定 ID 优先，展示字段只做证据

高置信自动匹配只能依赖稳定、平台签发的字段：

- Keycloak `sub`
- Feishu `open_id` / `union_id` / 企业邮箱
- 企业微信 `userid` / `external_userid` / 企业邮箱 / 员工号
- 自定义 IM 的平台内稳定用户 ID

以下字段只能做辅助证据，不能单独自动绑定：

- display name
- 群昵称
- 签名
- 手工输入的 email
- 最近用过的设备

### 3.3 兼容现有 session/message 存储

- Session 级身份上下文继续放 `sessions.metadata` JSONB。
- 消息级 actor 上下文继续放 `messages.content.meta`。
- 真正权威的人与账号绑定，放新增表里，不放 yoho-memory 文本。

### 3.4 自动匹配必须可追溯、可撤销

每一次自动绑定都必须记录：

- 评分
- 证据
- 匹配版本
- 触发源
- 决策人或自动决策原因

## 4. 实体模型

本设计不需要真正的 graph database。用 PostgreSQL 的“节点 + 边”模型即可。

### 4.1 persons

表示“同一个自然人/服务主体”。

```sql
CREATE TABLE persons (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    org_id TEXT,
    person_type TEXT NOT NULL DEFAULT 'human',   -- human | shared | service | bot
    status TEXT NOT NULL DEFAULT 'active',       -- active | suspended | departed | merged
    canonical_name TEXT,
    primary_email TEXT,
    employee_code TEXT,
    avatar_url TEXT,
    attributes JSONB NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    created_by TEXT,
    merged_into_person_id TEXT
);
CREATE INDEX idx_persons_namespace_org ON persons(namespace, org_id);
CREATE INDEX idx_persons_primary_email ON persons(primary_email);
CREATE INDEX idx_persons_employee_code ON persons(employee_code);
```

说明：

- `org_id` 建议优先落到组织级，而不是纯全局。当前 session、machine、token source 都已经和 org 强相关。
- `person_type=shared` 用来表示共号。
- `status=departed` 表示离职，但历史归因仍然保留。

### 4.2 person_identities

表示各渠道账号节点。

```sql
CREATE TABLE person_identities (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    org_id TEXT,
    channel TEXT NOT NULL,                       -- keycloak | feishu | wecom | custom-im | telegram | cli
    provider_tenant_id TEXT,
    external_id TEXT NOT NULL,                  -- sub / open_id / userid / chat principal id
    secondary_id TEXT,                          -- union_id / employee_id / email hash 等
    account_type TEXT NOT NULL DEFAULT 'human', -- human | shared | service | bot | unknown
    assurance TEXT NOT NULL DEFAULT 'medium',   -- high | medium | low
    canonical_email TEXT,
    display_name TEXT,
    login_name TEXT,
    employee_code TEXT,
    status TEXT NOT NULL DEFAULT 'active',      -- active | disabled | departed | conflict
    attributes JSONB NOT NULL DEFAULT '{}',
    first_seen_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(channel, provider_tenant_id, external_id)
);
CREATE INDEX idx_person_identities_email ON person_identities(namespace, org_id, canonical_email);
CREATE INDEX idx_person_identities_employee_code ON person_identities(namespace, org_id, employee_code);
```

说明：

- `provider_tenant_id` 很重要。没有 tenant 边界时，跨企业重名或同 email 域误撞的风险会大很多。
- `assurance` 由接入方给出：
  - `high`: 平台签名 webhook + 平台稳定 user id + 平台目录查询
  - `medium`: 平台稳定 user id + 企业邮箱
  - `low`: 只有昵称、转发 payload、未经校验的外部字段

### 4.3 person_identity_links

表示 Person 与 Identity 的边。

```sql
CREATE TABLE person_identity_links (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'primary',   -- primary | alias | shared-access | historical
    state TEXT NOT NULL,                             -- auto_verified | admin_verified | pending | rejected | detached
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL,                            -- auto | admin | migration | import
    evidence JSONB NOT NULL DEFAULT '[]',
    decision_reason TEXT,
    valid_from BIGINT NOT NULL,
    valid_to BIGINT,
    decided_by TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX uniq_active_person_identity_link
    ON person_identity_links(identity_id, relation_type)
    WHERE valid_to IS NULL AND state IN ('auto_verified', 'admin_verified');
CREATE INDEX idx_person_identity_links_person ON person_identity_links(person_id);
```

关键约束：

- 普通 `human` 身份只允许一个激活中的 primary link。
- `shared` / `service` 身份允许多个 `shared-access` link。
- 历史 link 不删除，只通过 `valid_to` 关闭。

### 4.4 person_identity_candidates

表示等待管理员确认的候选绑定。

```sql
CREATE TABLE person_identity_candidates (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    org_id TEXT,
    identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
    candidate_person_id TEXT REFERENCES persons(id) ON DELETE CASCADE,
    score REAL NOT NULL,
    auto_action TEXT NOT NULL DEFAULT 'review',      -- auto_bind | review | ignore
    status TEXT NOT NULL DEFAULT 'open',             -- open | confirmed | rejected | superseded | expired
    risk_flags JSONB NOT NULL DEFAULT '[]',
    evidence JSONB NOT NULL DEFAULT '[]',
    matcher_version TEXT NOT NULL,
    suppress_until BIGINT,
    decided_by TEXT,
    decided_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX idx_person_identity_candidates_open
    ON person_identity_candidates(namespace, org_id, status, created_at DESC);
```

作用：

- 自动匹配不够确定时，不直接绑，先入 review queue。
- 管理员拒绝后，可通过 `suppress_until` 防止同一对关系被立刻重新建议。

### 4.5 Phase 1 不单独建审计表

第一阶段先不引入独立 `person_identity_audits` 表，避免把最小闭环做重。

Phase 1 的最小审计信息直接落在：

- `person_identity_links.source / decision_reason / decided_by / updated_at`
- `person_identity_candidates.status / evidence / decided_by / decided_at`
- 服务端结构化日志

如果第二阶段发现“谁在什么时间做了哪次拆绑/合并/批量修复”无法满足排障与审计，再补独立审计表。

## 5. Session 与 Message 的身份上下文

### 5.1 session.metadata.identityContext

利用现有 `sessions.metadata JSONB`，新增一个轻量上下文，不单独建新表。

建议结构：

```json
{
    "identityContext": {
        "version": 1,
        "mode": "single-actor",
        "defaultActor": {
            "channel": "keycloak",
            "identityId": "ident_123",
            "personId": "person_123",
            "resolution": "auto_verified",
            "displayName": "张三",
            "email": "zhangsan@example.com",
            "accountType": "human"
        },
        "chat": {
            "platform": "feishu",
            "chatId": "oc_xxx",
            "chatType": "p2p"
        }
    }
}
```

规则：

- Web/PWA 创建的 session：`mode=single-actor`，`defaultActor` 来自当前 Keycloak 用户。
- Feishu / WeCom 单聊 session：`mode=single-actor`，`defaultActor` 来自当前聊天对端。
- 群聊 / 共号 session：`mode=multi-actor`，不设置唯一 `defaultActor`，Phase 1 只记录 `chat`，不维护参与者摘要缓存。

### 5.2 messages.content.meta.actor

权威的人物归因应该落在消息级。

建议结构：

```json
{
    "role": "user",
    "content": {
        "type": "text",
        "text": "请帮我看下这个告警"
    },
    "meta": {
        "sentFrom": "feishu",
        "actor": {
            "channel": "feishu",
            "identityId": "ident_456",
            "personId": "person_123",
            "resolution": "admin_verified",
            "displayName": "张三",
            "email": "zhangsan@example.com",
            "externalId": "ou_xxx",
            "accountType": "human"
        }
    }
}
```

这样做的好处：

- 兼容当前 `SyncEngine.sendMessage()` 的 `payload.meta` 机制。
- 不需要重构消息表。
- 群聊时每条消息都能知道“是谁说的”，而不是把整个 session 强绑到某一个人。

## 6. 自动匹配策略

### 6.1 匹配输入

统一成一个解析输入：

```ts
type IdentityObservation = {
    namespace: string
    orgId?: string | null
    channel: 'keycloak' | 'feishu' | 'wecom' | 'custom-im' | 'telegram' | 'cli'
    providerTenantId?: string | null
    externalId: string
    secondaryId?: string | null
    canonicalEmail?: string | null
    displayName?: string | null
    employeeCode?: string | null
    accountType?: 'human' | 'shared' | 'service' | 'bot' | 'unknown'
    assurance: 'high' | 'medium' | 'low'
    attributes?: Record<string, unknown>
}
```

### 6.2 自动绑定条件

只有满足以下条件，才允许 `auto_verified`：

1. identity 自身 `accountType=human`
2. `assurance` 至少为 `medium`
3. 存在稳定证据之一：
   - employee_code 精确匹配
   - 企业邮箱精确匹配，且 org 内唯一
   - 已有相同 `(channel, tenant, external_id)` 的活跃 link
4. 没有冲突：
   - 该 identity 未绑定到另一个 active person
   - 该 person 未有另一个相同 channel 的冲突 primary identity
   - 最近没有管理员明确 reject/suppress

建议评分：

- 相同 `(channel, tenant, external_id)` 命中已有 link：1.00
- employee_code 精确一致：0.98
- org 内唯一企业邮箱精确一致：0.95
- 企业邮箱 + 姓名同时一致：0.90
- 只有企业邮箱：0.75
- 只有姓名/昵称：0.20

阈值建议：

- `>= 0.95`: 自动绑定
- `0.65 ~ 0.95`: 建 candidate，待管理员确认
- `< 0.65`: 仅 upsert identity，不建议候选

### 6.3 否决规则

出现以下任一情况，直接禁止自动绑定，转管理员确认：

- `accountType=shared | service | bot`
- 同一 identity 命中过多个 person
- 同一邮箱在 org 内被多个 active person 占用
- 渠道 webhook 未通过签名校验
- 只有 display name，没有稳定 external id
- 自定义 IM 只传“发送者昵称”，没有平台签发 user id

## 7. 管理员确认与纠错机制

### 7.1 决策动作

完整形态下，管理员对 candidate 可以做：

1. `confirm_existing_person`
2. `create_person_and_confirm`
3. `mark_shared_account`
4. `mark_service_account`
5. `reject`
6. `detach_existing_link`
7. `merge_persons`

### 7.2 决策原则

- “绑定到已有 person” 应该是最常见路径。
- “创建新 person” 适合第一次出现的新员工或外部协作方。
- “标记 shared/service” 用于共号、机器人号、公告号。
- “detach” 不删除历史，只关闭 link，并写 audit。
- “merge_persons” 用于两个 person 被误建成两个人的情况，保留旧 person 但标记 merged。

Phase 1 只实现：

- `confirm_existing_person`
- `create_person_and_confirm`
- `mark_shared`
- `reject`

### 7.3 防抖与抑制

管理员 reject 后：

- 对同一 `identityId + candidatePersonId` 建 suppress 记录
- 在 `suppress_until` 之前，不再重复推送 review

## 8. 风险场景处理

### 8.1 Impersonation

原则：任何可以被“改昵称伪装”的字段，都不能单独触发自动绑定。

防护：

1. 高置信绑定必须依赖平台稳定 ID。
2. 自定义 IM / 企业微信 webhook 必须做签名校验和 tenant 校验。
3. 当 identity 的邮箱、employee_code、tenant 发生异常跳变时：
   - identity 标记为 `status=conflict`
   - 自动匹配停止
   - 生成 review candidate

### 8.2 误绑

处理：

1. 所有 link 都有 `source`、`confidence`、`evidence`。
2. 完整形态里管理员可 detach。
3. detach 后保留历史消息中的 `personId`，但未来消息不再沿用。
4. 对被 reject 的 pairing 做 suppress，防止 matcher 震荡。

### 8.3 多人共号

建模：

- `person_identities.account_type='shared'`
- 可以挂多个 `shared-access` link
- 这类 identity 永不自动绑定到唯一 person

session 行为：

- session 级 `mode=multi-actor`
- 每条消息优先使用平台给出的真实操作者 ID
- 如果平台只能给共号 ID，且无法知道实际操作者：
  - `meta.actor.personId = null`
  - `resolution = 'shared'`
  - 可选地要求管理员或 bot 卡片让用户显式“认领我是张三”

### 8.4 改名

改名不应导致重绑。

做法：

- 只更新 `person_identities.display_name`
- 可选保留 `attributes.nameHistory`
- 真正稳定的是 `external_id` / `sub` / `userid`

### 8.5 离职 / 停用

做法：

- `persons.status='departed'`
- `person_identities.status='departed' | 'disabled'`
- active link 设 `valid_to`
- 历史 session/message 不改写
- 若邮箱被新员工复用，必须人工确认，不允许靠 email 自动继承

### 8.6 设备更换

当前系统里的 `clientId` / `deviceType` 只属于在线态和推送订阅，不属于身份图谱。

原则：

- 设备更换不影响 person 解析
- 不把 `push_subscriptions.client_id`、SSE `clientId`、在线用户列表当成 identity 绑定证据

## 9. 第一阶段最小闭环

第一阶段目标不是“把所有平台和后台都改完”，而是做出一个能真实跑通的最小闭环：

1. Keycloak / yoho-remote Web 登录能写入权威 identity。
2. Feishu BrainBridge 能把发言人解析成 `meta.actor`。
3. 新建 session 能带上最小 `identityContext`。
4. 管理员能看到 candidate 并做确认/拒绝。
5. Web 端能通过 SSE 感知 candidate 变化。

第一阶段明确不做：

- 独立 audit 表
- `merge_persons` / `detach` / 批量修复
- WeCom / custom IM 真实接入
- 改造 `server/src/im/types.ts` 做过度泛化
- 新增一堆 identity 专用 SyncEvent
- 重写现有 email 授权体系
- 专门的 `GET /api/sessions/:id/actors`

### 9.1 File-level 改造清单

#### 必须做

- `server/src/store/types.ts`
  - 新增最小类型：`StoredPerson`、`StoredPersonIdentity`、`StoredPersonIdentityLink`、`StoredPersonIdentityCandidate`
  - 新增运行时返回类型：`ResolvedActorContext`
- `server/src/store/interface.ts`
  - 新增最小 store 接口：
    - upsert / get `person_identities`
    - create / get / search `persons`
    - create / update / get `person_identity_links`
    - create / list / decide `person_identity_candidates`
    - `resolveActorByIdentityObservation(...)`
- `server/src/store/postgres.ts`
  - 新增 4 张表：`persons`、`person_identities`、`person_identity_links`、`person_identity_candidates`
  - 实现上面的最小 store 方法
  - 保持现有 `sessions` / `messages` 表结构不变
- `server/src/web/middleware/auth.ts`
  - 在 Keycloak token 验证成功后，upsert `keycloak` identity
  - 调 resolver 得到 `personId` / `resolvedActor`
  - 把 `personId` / `resolvedActor` 写入 `WebAppEnv`
- `server/src/web/routes/sessions.ts`
  - 在 Web 新建 session 时，把 `metadata.identityContext.defaultActor` 写进去
  - `createdBy=email` 继续保留
- `server/src/web/routes/machines.ts`
  - 和 `sessions.ts` 一样，对 machine spawn 路径补 `identityContext.defaultActor`
- `server/src/web/routes/messages.ts`
  - 调 `engine.sendMessage()` 时注入 `meta.actor`
  - 前端 body 不需要传 actor，服务端从 auth context 注入
- `server/src/im/BrainBridge.ts`
  - 基于现有 `senderId + senderEmail + senderName` 做 Feishu actor 解析
  - P2P session 创建时写最小 `identityContext.defaultActor`
  - 每条发往 session 的 IM 消息都带 `meta.actor`
- `server/src/web/routes/identity.ts`（新增）
  - 提供最小管理员确认 API
  - 在 candidate 状态变化后发 SSE
- `server/src/web/server.ts`
  - 注册 `createIdentityRoutes(...)`
- `server/src/sync/syncEngine.ts`
  - 只新增一个最小 event type：`identity-candidate-updated`
  - session identityContext 变化继续沿用已有 `session-updated`

#### 可以延后

- `server/src/im/types.ts`
  - Phase 1 不改成通用 `identityHints` 协议，先让 Feishu 用现有字段跑通
- `web/src/types/api.ts` 与专门的管理员页面
  - API 先落地，前端工作台可以第二步做
- `server/src/web/routes/guards.ts`
  - 继续按 email 授权，暂不按 person 改
- `server/src/sync/syncEngine.ts`
  - 不做 `session-identity-context-updated` / `identity-person-updated`
- `server/src/im/wecom/*`、`server/src/im/custom/*`
  - 保留接口位置，但 Phase 1 不实现

### 9.2 Session Metadata 最小形状

Phase 1 只保留这几个字段：

```json
{
    "identityContext": {
        "version": 1,
        "mode": "single-actor",
        "defaultActor": {
            "identityId": "ident_123",
            "personId": "person_123",
            "channel": "keycloak",
            "resolution": "auto_verified",
            "displayName": "张三",
            "email": "zhangsan@example.com"
        },
        "chat": {
            "platform": "feishu",
            "chatId": "oc_xxx",
            "chatType": "p2p"
        }
    }
}
```

Phase 1 不做：

- `participants` 摘要
- 参与者缓存
- 历史 actor 汇总

### 9.3 session 如何拿到 resolved person

第一阶段只走两个简单规则：

1. 单人入口：
   - session 创建时写 `metadata.identityContext.defaultActor`
   - 适用于 Web/PWA、Feishu 单聊
2. 多人入口：
   - session 不强绑唯一 person
   - 每条消息都写 `meta.actor`
   - agent 侧看消息级 actor，而不是看 session 主人

结论：

- Phase 1 的权威归因来源是 `messages.content.meta.actor`
- `sessions.metadata.identityContext.defaultActor` 只是默认值，不是历史事实表

## 10. 管理员确认流的最小 API

第一阶段只需要 3 个接口就够了。

### 10.1 列候选

```http
GET /api/identity/candidates?orgId=org_123&status=open
```

返回值最小字段：

```json
{
    "candidates": [
        {
            "id": "cand_123",
            "identityId": "ident_123",
            "channel": "feishu",
            "displayName": "张三",
            "canonicalEmail": "zhangsan@example.com",
            "candidatePersonId": "person_123",
            "candidatePersonName": "张三",
            "score": 0.82,
            "status": "open",
            "evidence": ["email_exact", "name_exact"]
        }
    ]
}
```

### 10.2 搜 person

```http
GET /api/identity/persons?orgId=org_123&q=zhang
```

用途：

- 管理员在确认时选择已有 person
- 不做复杂过滤，只支持最小搜索

### 10.3 做决策

```http
POST /api/identity/candidates/:candidateId/decision
```

body：

```json
{
    "action": "confirm_existing_person",
    "personId": "person_123",
    "reason": "飞书邮箱与 Keycloak 邮箱一致"
}
```

`action` 最小允许值：

- `confirm_existing_person`
- `create_person_and_confirm`
- `mark_shared`
- `reject`

`create_person_and_confirm` body 示例：

```json
{
    "action": "create_person_and_confirm",
    "createPerson": {
        "canonicalName": "张三",
        "primaryEmail": "zhangsan@example.com"
    },
    "reason": "新员工，系统中还没有 person"
}
```

`mark_shared` body 示例：

```json
{
    "action": "mark_shared",
    "reason": "客服共号，不绑定到唯一自然人"
}
```

## 11. 最小 SSE / Sync Event 设计

Phase 1 只新增一个事件类型：

```ts
type SyncEventType =
    | ...
    | 'identity-candidate-updated'
```

事件 shape：

```json
{
    "type": "identity-candidate-updated",
    "namespace": "default",
    "data": {
        "orgId": "org_123",
        "candidateId": "cand_123",
        "identityId": "ident_123",
        "status": "open",
        "score": 0.82
    }
}
```

用途：

- 管理员列表页收到后直接 refetch `GET /api/identity/candidates`

Phase 1 不新增：

- `identity-person-updated`
- `session-identity-context-updated`

原因：

- candidate 工作台只需要知道“队列变了”
- session metadata 仍然通过已有 `session-updated` 刷新

## 12. 哪些字段留在 yoho-remote 权威图谱，哪些只同步到 yoho-memory

### 必须留在 yoho-remote 权威图谱

凡是会影响解析、归因、确认、审计、权限演进的字段，都必须在 PostgreSQL 权威图谱里：

- `personId`
- `namespace` / `orgId`
- `channel`
- `providerTenantId`
- `externalId`
- `secondaryId`
- `canonicalEmail`
- `employeeCode`
- `accountType`
- `assurance`
- `status`
- `link.state`
- `link.confidence`
- `link.source`
- `candidate.status`
- `candidate.score`
- `candidate.evidence`
- `sessions.metadata.identityContext`
- `messages.content.meta.actor`

原则：

- 只要一个字段会被程序逻辑读取，就不能只放 yoho-memory。

### 只同步到 yoho-memory

yoho-memory 只放“提示词增强”和“自由文本画像”，不放权威绑定：

- 自然语言用户画像摘要
- 非正式昵称说明
- 协作风格 / 偏好
- 项目熟悉度
- 历史对话总结
- 对人的非结构化备注
- 不足以作为匹配依据的模糊线索

### 双写规则

- 当前 display name / 企业邮箱 / 员工号：权威在 PostgreSQL
- 如果需要给 agent 提示，可从 PostgreSQL 派生同步到 yoho-memory
- 不允许反向从 yoho-memory 回写绑定关系

## 13. Phase 1 Workflow

### 13.1 Web/PWA 登录并发消息

1. `auth.ts` 验证 Keycloak token
2. upsert `keycloak` identity
3. resolve 成 `personId/resolvedActor`
4. `POST /api/sessions` 时写 `metadata.identityContext.defaultActor`
5. `POST /api/sessions/:id/messages` 时写 `meta.actor`

### 13.2 Feishu 单聊

1. BrainBridge 收到消息
2. 用 `senderId + senderEmail + senderName` upsert `feishu` identity
3. 若命中唯一高置信 person，则自动带上 `personId`
4. 若不够高置信，则写 candidate
5. 发往 session 的消息带 `meta.actor`

### 13.3 管理员确认

1. 候选进入 `person_identity_candidates`
2. SSE 发 `identity-candidate-updated`
3. 管理员调用 `POST /api/identity/candidates/:id/decision`
4. 系统更新 link / candidate
5. 之后的新消息自动带 personId

## 14. Phase 1 排序

### 必须先做

1. `store/types/interface/postgres` 最小表和方法
2. `auth middleware` 的 Keycloak upsert + resolve
3. `messages.ts` 的 `meta.actor` 注入
4. `sessions.ts` / `machines.ts` 的 `identityContext.defaultActor`
5. `BrainBridge.ts` 的 Feishu actor 解析
6. `identity.ts` 最小管理员 API
7. `identity-candidate-updated` SSE

### 可以第二批做

1. `persons` 搜索优化
2. 管理员前端页面
3. shared account 的更细粒度策略
4. old session 的回填脚本
5. WeCom / custom IM 适配器
6. email 授权向 person 演进

## 15. 收敛后的结论

Phase 1 最小闭环的核心不是“把 identity graph 做全”，而是：

1. 先让 Keycloak 与 Feishu 都能产出统一的 `ResolvedActorContext`
2. 先把这个结果写进 `sessions.metadata.identityContext` 和 `messages.meta.actor`
3. 先给管理员一个最小 candidate queue + decision API
4. 只增加一个 SSE 事件，其他地方尽量复用现有 `session-updated`
5. 明确把权威绑定留在 PostgreSQL，把自由文本画像留给 yoho-memory

这样做可以把第一期控制在很小的改造面里，同时保留后续接企业微信、自定义 IM、以及把授权从 email 迁移到 person 的空间。
