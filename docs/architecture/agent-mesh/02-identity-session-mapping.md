# 02 · 统一身份 & 会话映射

## 2.1 为什么要独立分层

现状里，「谁发的这条消息」和「这个 chat 对应哪个 Brain session」两件事被揉在 `BrainBridge` 中：
- `chatIdToSessionId` / `sessionToChatId` 是进程内 Map，重启靠 `store.getActiveFeishuChatSessions` 水合。
- 发送者的身份仅用 `senderName + senderEmail`，进一步查 Keycloak（`keycloakLookup.ts`）只在 init prompt 里用一次。
- 多群群聊里「本轮哪些 sender 参与了」靠 `lastSenderIds` 本地 Set 管理，没有持久身份概念。

向多渠道 + 多 **hosted runtime** 扩展时,这种耦合会放大三个问题(M4 / H2 是外部 peer,**不在** 下面讨论范围内 —— 它们永远不打开 remote session,见 09.1.1):
1. **同一个人在不同 IM 上出现**(飞书 open_id 与钉钉 userId 其实是同一个人)→ 画像无法合并,K1 自我系统会重复抽取。
2. **同一条 chat 在 hosted runtime 之间切换**(例如未来新增第二个 hosted runtime)→ 现有 `chatIdToSessionId` 只能绑一个 runtime 的 session。**注意**:这里说的切换仅限于 hosted runtime 之间;把 chat 路由给 M4 / H2 不是合法选项,见 03 章 banner 与 09.1.1。
3. **hosted runtime 间的身份一致性**:不同 hosted runtime 仍需共享 canonical **personSlug** 作为 lingua franca;M4 / H2 自家 user profile 存在其内部,remote 不与之共享身份表。

## 2.2 核心数据模型

```
                   ┌──────────────────────────┐
                   │      personSlug          │   ← canonical，住在 yoho-memory team/members/
                   │  (yoho-memory owns it)   │
                   └──────────┬───────────────┘
                              │ 1..n
            ┌─────────────────┼───────────────────┐
            │                 │                   │
 ┌──────────▼───────┐  ┌──────▼──────┐   ┌────────▼─────────┐
 │ platform_identity│  │  keycloak   │   │  runtime_user    │
 │ (platform,userId)│  │  (uuid)     │   │  (runtimeType,   │
 │                  │  │             │   │   runtimeUserId) │
 └──────────────────┘  └─────────────┘   └──────────────────┘
```

### 实体

- `personSlug`：**唯一稳定 ID**，形如 `guang-yang` / `bruce-li`。由 yoho-memory `identity-bridge` skill 生成并持有。yoho-remote 侧只 **消费**，不 **生成**。
- `platform_identities`（新表，yoho-remote 侧）：
  ```sql
  platform_identities(
    id, platform, channel_id, platform_user_id,
    person_slug, email, display_name,
    first_seen_at, last_seen_at, confidence,
    UNIQUE (platform, channel_id, platform_user_id)
  )
  ```
  缓存「(platform, platform_user_id) → personSlug」的映射，由 `IdentityResolver` 写入。
- `im_chat_sessions`（沿用 01 的表）：承载 `(platform, channel_id, chat_id) ↔ (runtimeType, runtimeSessionId)`。
- `im_chat_members`（新表，仅群聊用）：
  ```sql
  im_chat_members(
    chat_session_id FK, person_slug, platform_user_id,
    role,            -- 'owner' / 'admin' / 'member'
    permissions      -- JSON，如 {canAbort: true, canTakeover: false}
  )
  ```
  支撑群聊里的 `canAbort` 判断（目前 `BrainBridge` 用 `lastSenderIds` 集合近似）。

## 2.3 IdentityResolver 工作流

```
inbound IMMessage
     │
     ▼
IdentityResolver.resolve(platform, channelId, userId, email?, displayName)
     │
     ├─[1]─> platform_identities 查 cache → hit: 返回 personSlug
     │                                      miss: 继续
     │
     ├─[2]─> keycloakLookup(email) → keycloakId
     │         └─> platform_identities 按 email 查已知 personSlug
     │
     ├─[3]─> yoho-memory call:
     │        POST /skills/identity-bridge/run
     │        body: { resolvedIdentity: {name, email, openId, keycloakId} }
     │        返回: { personSlug, identityFacts[], writeDecision }
     │
     ├─[4]─> 写入 platform_identities（UPSERT）
     │
     └─[5]─> return ResolvedIdentity { personSlug, displayName, email, keycloakId,
                                       platformIdentity: {platform, channelId, platformUserId} }
```

`IdentityResolver` 的返回结构是下游所有层的共享入参，不再传「`senderId / senderEmail / senderName` 三元散字段」。

### 降级策略

| 场景 | 行为 |
| --- | --- |
| yoho-memory 不可达 | 走 `platform_identities` 本地 cache；找不到就生成临时 `personSlug: anon-<sha8(userId)>`，标 `confidence=low`。 |
| 超时（>500ms） | 不阻塞 inbound，异步补齐；本轮用临时 slug。 |
| 用户首次出现 | 异步写入 `memories/candidate/`（yoho-memory 自己处理），不写 team/members。 |

## 2.4 会话映射（(platform, chatId) ↔ runtimeSession）

### 查询路径

```
MessageBridge.dispatch(ingress):
    const session = await ChatSessionStore.getOrCreate({
        platform, channelId, chatId, chatType, namespace
    })
    // session.state ∈ { 'idle', 'busy', 'manual', 'aborting' }
    // session.runtimeType ∈ { 'brain', 'openclaw', 'hermes' } | null (首次)
    // session.runtimeSessionId ∈ string | null
```

- 首次消息：`runtimeType` / `runtimeSessionId` 为 null，交给 `ChatRouter` 决策后再 `attachRuntime`。
- 切换 runtime：`ChatSessionStore.detachRuntime(chatSessionId)` + `attachRuntime(...)`。旧 runtime session 不复用（因为 runtime 各自有独立 session 语义），而是生成新的。
- 运行时信息修正：当 Brain runtime 上 `SyncEngine.sessionClosed` 时，`ChatStateMachine` 把 `state` 重置 `idle` 并 `runtimeSessionId=null`，下次消息重新建。

### 多租户

- `namespace` 来自 channel 配置（01 章），不是消息本身。
- 所有查询强制 `WHERE namespace = ?`。
- 身份（personSlug）**全局唯一**，namespace 只隔离 chat 层；一个人可以在多个 namespace 出现。

## 2.5 现状迁移：从 BrainBridge 抽取

| 现有逻辑 | 抽到哪里 |
| --- | --- |
| `chatIdToSessionId` / `sessionToChatId` in-memory map | `ChatSessionStore` 查询封装 + 进程级 LRU |
| `store.updateFeishuChatState(chatId, state)` | `ChatSessionStore.patchState(chatSessionId, patch)` |
| `store.getActiveFeishuChatSessions()` | `ChatSessionStore.listActiveByPlatform('feishu')` |
| `lastSenderIds` 近期说话者集合 | `im_chat_members` + 本轮 `turnSenders[]` 放 `session.metadata.currentTurn.senders` |
| `chatStates` (incoming, debounceTimer, busy, ...) | `ChatStateMachine`（见 `05-concurrency-and-race.md`） |

## 2.6 与 K1 自我系统的衔接

`selfSystem.ts` 目前按 namespace 查 `brain_config.extra.selfSystem` + `ai_profiles[defaultProfileId]`，结果拼到 init prompt。新架构里有两点变化：

1. **K1 = Brain-local runtime 的 persona**，不跨 runtime 注入。M4 自己有 `system-prompt` sections，H4 自己有 `USER.md`。RuntimeAdapter 层不要去重写 M4/H4 的 persona。
2. 每条消息（不仅首条）可以在 `appendSystemPrompt` 里注入 **本轮上下文**：当前 `personSlug` 的 user profile 片段、沟通策略（`conversation-style-profile` skill 产出）。这是既有 `selfSystem` + 未来 `per-turn profile injection` 的结合点。

```
IdentityResolver → personSlug
         │
         ▼
per-turn context builder (调 yoho-memory recall + conversation-style-profile)
         │
         ▼
BrainRuntimeAdapter.sendMessage({
    text,
    appendSystemPrompt: [selfSystemPrompt, perTurnContextPrompt].join('\n\n')
})
```

## 2.7 推荐 vs 不推荐

| 选择点 | 推荐 | 不推荐 | 理由 |
| --- | --- | --- | --- |
| personSlug 归属 | yoho-memory 生成 + yoho-remote 只缓存 | yoho-remote 自己生成 | 避免两边各有一份 canonical |
| 身份表位置 | yoho-remote DB `platform_identities` | 直接存 yoho-memory | yoho-remote 才有平台 schema + chat 上下文 |
| cache miss 处理 | 同步查一次 + 超时降级到临时 slug | 阻塞等待到返回 | 入站吞吐不受 yoho-memory 抖动影响 |
| 多 runtime 会话共用 | 一 chat = 一 runtime session | 全局并联多 runtime | 多轮上下文会被撕裂，流式编辑无法收敛 |
| 群聊成员 | 用 `im_chat_members` 显式维护 | 每次从 Adapter 拉 | API 有频控，reactive 维护 + webhook 增量更便宜 |
