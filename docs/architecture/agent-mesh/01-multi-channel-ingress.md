# 01 · 多 IM 接入层（Multi-channel Ingress）

## 1.1 现状基线

- `server/src/im/types.ts` 已经把 `IMAdapter` 抽象得很干净（`start/stop/sendText/sendReply/addReaction/resolveSenderInfo/fetchChatName/buildSessionTitle/buildInitPrompt/editMessage/recallMessage/...`），不需要重做。
- `server/src/im/feishu/FeishuAdapter.ts` 是目前唯一实装，做 WebSocket 连接、媒体上传、卡片交互、消息去重（60s 窗口）、卡片动作去重（2s）。
- 阻塞点：**DB schema 和 `BrainBridge` 里强耦合 Feishu**——表名 `feishuChatSessions`、方法 `store.updateFeishuChatState/getActiveFeishuChatSessions`、字段语义基于 Feishu `open_id`。这是新增 IM 的真正成本。

## 1.2 设计原则

1. **Adapter = I/O only**。平台协议细节（卡片 JSON、消息类型、webhook 签名）在 adapter 内消化，不外泄。
2. **一个 Adapter ↔ 一个 Channel 实例**。同一平台的多个 bot（例如一个 DingTalk 租户两个机器人）等同于两个 adapter 实例，各自独立启动。
3. **Adapter 不持有会话状态**。它不关心「这个 chat 现在是否 busy」「上一条 assistant 消息 seq 是多少」，这些由 `MessageBridge` + `ChatStateMachine` 管理。
4. **消息归一化在 Adapter 内完成**。外层看到的永远是 `IMMessage`（已 strip 平台 at-token、已抽出 `mentions[]`、已下载媒体到 `server-uploads/`）。

## 1.3 Channel 目录结构

```
server/src/im/channels/
├── feishu/
│   ├── FeishuAdapter.ts           # 主适配器
│   ├── cardBuilder.ts             # 卡片构造
│   ├── formatter.ts               # post 富文本 ↔ plain text
│   ├── actionExtractor.ts
│   ├── docFetcher.ts              # 云文档内容抽取（<feishu-doc> 注入）
│   ├── fileExtractor.ts
│   ├── tts.ts
│   └── transport/
│       ├── WebSocketTransport.ts  # 长连接模式
│       └── WebhookTransport.ts    # 备用：回调模式
├── dingtalk/
│   ├── DingTalkAdapter.ts
│   ├── cardBuilder.ts             # 钉钉 ActionCard / FeedCard
│   ├── formatter.ts               # markdown
│   └── transport/
│       ├── StreamTransport.ts     # 钉钉 Stream API（推荐）
│       └── WebhookTransport.ts    # 回调 + outgoing callback 签名校验
├── wecom/                         # 企业微信
└── slack/                         # 未来扩展
```

## 1.4 IMAdapter 契约（保留并补强）

现有 `IMAdapter`（`server/src/im/types.ts:66-131`）已覆盖大部分方法。**建议补充**以下可选成员，给新平台让路：

```typescript
interface IMAdapter {
    readonly platform: string
    readonly channelId: string               // [新增] 同平台多实例区分（app_id / robot_code）
    readonly capabilities: IMCapabilities    // [新增] 声明平台支持的特性

    start(bridge: IMBridgeCallbacks): Promise<void>
    stop(): Promise<void>

    // ... 现有方法保留 ...

    // [新增] 批量发送，DingTalk / WeCom 有限频要合并发
    sendReplies?(chatId: string, replies: IMReply[]): Promise<void>

    // [新增] 拉取 chat 成员（群聊路由 + identity 群组桥接用）
    listChatMembers?(chatId: string): Promise<Array<{ userId: string; name: string; email: string | null }>>
}

interface IMCapabilities {
    supportsStreaming: boolean       // Feishu post 可编辑 = true；DingTalk markdown 可编辑 = true
    supportsCard: boolean
    supportsReaction: boolean
    supportsReply: boolean           // 引用回复
    supportsRecall: boolean
    supportsEphemeral: boolean
    maxTextBytes: number             // 4000 / 5000 / 8000 因平台而异
    qpsLimit: number                 // 单 bot QPS 限制
}
```

> 这些字段由 `MessageBridge` 和 `OutboundFormatter` 读取，用来选择「能不能流式编辑 / 要不要拆分消息 / 支不支持卡片」。

## 1.5 新接入一个 IM 的标准流程

1. 新建 `channels/<platform>/<Platform>Adapter.ts`，实现 `IMAdapter`。
2. 注册 transport（优先长连接 / Stream API，退而用 Webhook）。
3. 实现 5 个必需 hook：`start/stop/sendText/sendReply/addReaction`。
4. 声明 `capabilities` 和 `qpsLimit`。
5. 把归一化逻辑（at-token 还原、云文档 enrich、mention 解析）写在 adapter 内部。
6. 在启动入口注册：
   ```typescript
   // server/src/im/index.ts
   registerChannel(new DingTalkAdapter({ robotCode, appKey, appSecret }))
   ```
7. **不需要动** bridge / identity / routing / runtime 层。

## 1.6 DingTalk 接入细节（示例）

| 关注点 | 处理 |
| --- | --- |
| 连接 | 优先 Stream API (`wss://api.dingtalk.com/v1.0/gateway/connections/open`)，比 Webhook 少一次公网暴露。 |
| 签名 | Webhook 模式必须校验 `timestamp + canonicalString` 的 HMAC-SHA256，在 `transport/WebhookTransport.ts` 内。 |
| 消息类型 | `text` / `markdown` / `actionCard` / `feedCard` / `link`，归一化到 `IMMessage.text`（markdown 去 meta）。 |
| @机器人识别 | 钉钉的 `isInAtList` 字段 + `atUsers[].dingtalkId` → `mentions`。 |
| 群 vs 单聊 | `conversationType` `1`=单聊，`2`=群聊 → `chatType` `'p2p' | 'group'`。 |
| 流式编辑 | DingTalk markdown 消息支持更新，但需要 `messageId` 返回；在 `sendPostAndGetId` 等价实现里包装。 |
| Reaction | DingTalk 原生不支持 emoji reaction，`capabilities.supportsReaction = false`，上层静默降级。 |
| 幂等 | `msgId` + 60s 窗口（同 Feishu）。 |

## 1.7 DB schema：从 `feishuChatSessions` 到 `im_chat_sessions`

**当前（Feishu 专有）**：

```sql
feishu_chat_sessions(chat_id PK, session_id, state_json, last_delivered_seq, ...)
```

**未来（平台通用）**：

```sql
im_chat_sessions(
  id                PK,
  platform          TEXT NOT NULL,         -- 'feishu' / 'dingtalk' / ...
  channel_id        TEXT NOT NULL,         -- bot 实例 ID（同平台多 bot 区分）
  chat_id           TEXT NOT NULL,         -- 平台原生 chat 标识
  chat_type         TEXT NOT NULL,         -- 'p2p' / 'group'
  runtime_type      TEXT NOT NULL,         -- 'brain' / 'openclaw' / 'hermes'
  runtime_session   TEXT,                  -- 现有 session_id；brain 即 yoho-remote session UUID
  state             TEXT NOT NULL DEFAULT 'idle',  -- idle / busy / manual / aborting
  last_delivered_seq INTEGER DEFAULT 0,
  last_user_message_id TEXT,
  busy_since_at     INTEGER,
  agent_messages    JSONB DEFAULT '[]',
  metadata          JSONB DEFAULT '{}',
  namespace         TEXT NOT NULL,
  org_id            TEXT,
  updated_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (platform, channel_id, chat_id)
)
```

迁移策略（**推荐**）：
1. 新建 `im_chat_sessions`，带 `platform='feishu'` 默认。
2. 双写一段时间：`BrainBridge` 读写旧表的地方同时写新表。
3. 切读：bridge 层先从新表读，找不到 fallback 旧表。
4. 回收：confirm 数据一致后，把旧表 rename 为 `feishu_chat_sessions_archive_YYYYMM`。

不推荐：**「直接 rename 旧表 + 加列」**——破坏滚动部署，server/cli 旧版本跑不起来。

## 1.8 渠道级配置（namespace 隔离）

每个 channel 实例的配置应全部来自 `brain_config.extra.channels[platform][channelId]`，而不是环境变量硬编码。

```json
{
  "namespace": "default",
  "channels": {
    "feishu": {
      "cli_a90e6e0477789cd3": {
        "appId": "cli_a90e6e0477789cd3",
        "appSecretRef": "vault://feishu/openclaw",
        "defaultRuntime": "brain",
        "routingPolicy": "brain-default"
      }
    },
    "dingtalk": {
      "robot-yoho": {
        "robotCode": "...",
        "appKeyRef": "vault://dingtalk/yoho",
        "defaultRuntime": "brain"
      }
    }
  }
}
```

- 凭证仍走 `yoho-credentials`，不在 DB 明文存。
- `defaultRuntime` 可被 `ChatRouter` 按 chat 覆盖。
- 多租户支持要求 `channels[platform][channelId]` 的 `namespace` 映射明确：一条入站消息的 namespace 来自 **channel 实例**，不是消息内容。

## 1.9 推荐 vs 不推荐

| 选择点 | 推荐 | 不推荐 | 理由 |
| --- | --- | --- | --- |
| 新 IM 扩展位置 | `channels/<platform>/<Platform>Adapter.ts` | 塞进 `BrainBridge.ts` 加 `if (platform === 'dingtalk')` | 避免 bridge 变成 N 平台的大开关 |
| Adapter 持有 state | 否（全部 store 到 DB + state machine） | 在 Adapter 里 `Map<chatId, busy>` | 多进程部署时内存态不一致，崩溃丢状态 |
| 传输协议 | Stream/长连接优先 | 只做 Webhook | Webhook 需要公网入口 + 签名 + 重试，长连接更稳 |
| 消息归一化时机 | Adapter 内完成 | Bridge 内完成 | Bridge 层要「平台无关」，否则为多平台加特例 |
| schema 迁移 | 新表双写 | 直接 rename | 平滑升级、可回滚 |
