# 06 · 观测性 & 权限 & 租户隔离

## 6.1 可观测性

### 日志上下文字段（每条日志都应带）

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| `traceparent` | W3C Trace Context，Channel 入站生成；透传到 runtime | 端到端追踪 |
| `platform` / `channelId` | Channel 配置 | 定位渠道 |
| `chatSessionId` | `im_chat_sessions.id` | 关联 chat 层行为 |
| `runtimeType` / `runtimeSessionId` | Routing 决策 / runtime handle | 关联 runtime 层行为 |
| `personSlug` | IdentityResolver | 关联用户画像 |
| `turnId` | MessageBridge flush 生成 | 关联一轮交互内所有事件 |
| `namespace` / `orgId` | Channel 配置 | 租户过滤 |

### 指标（Prometheus 命名约定）

```
im_inbound_total{platform, chatType, addressed}
im_inbound_duplicate_total{platform}
im_outbound_total{platform, capability}
im_outbound_fail_total{platform, reason}

im_chat_state_transition_total{from, to, reason}
im_chat_active{state}                       # gauge

im_runtime_request_total{runtime, op}       # op = create|send|abort|close
im_runtime_request_duration_seconds{runtime, op}
im_runtime_error_total{runtime, retryable}
im_runtime_busy_duration_seconds{runtime}   # 单轮 busy 时长

im_abort_total{reason, outcome}             # outcome = confirmed|timeout
im_takeover_total{action}                   # action = start|release

im_stream_edit_count{platform, runtime}     # per turn histogram
im_stream_dropped_deltas_total{runtime}

identity_resolver_latency_seconds
identity_resolver_fallback_total{reason}    # reason = timeout|no-match|anon
```

### 追踪（OpenTelemetry Span）

一条 inbound 对应一个 root span：

```
im.inbound                              (root, 打 IMMessage 元数据)
├─ im.identity.resolve
├─ im.chat.loadOrCreate
├─ im.chat.route
├─ im.debounce.buffer                   (event, 不是独立 span)
├─ im.turn.flush                        (child)
│  ├─ im.runtime.createSession          (optional)
│  ├─ im.runtime.sendMessage
│  ├─ im.runtime.subscribe              (long-running)
│  └─ im.turn.finalize
│     ├─ im.outbound.format
│     └─ im.outbound.send
└─ im.chat.patchState
```

runtime 层应当把 traceparent 作为 metadata 透传：
- Brain：放到 `SyncEngine.sendMessage` 的 metadata。
- M4：作为 OpenClaw HTTP 请求的 `traceparent` header。
- H4：作为 Hermes CLI 的 env 变量 / platform hint。

## 6.2 审计

所有跨系统写操作入审计：

```sql
im_chat_audit(
  id, chat_session_id, platform, chat_id,
  actor_type,        -- 'user' / 'runtime' / 'admin' / 'system'
  actor_slug,        -- personSlug or runtimeType
  action,            -- 'abort' / 'takeover' / 'release' / 'switch-runtime' / 'message-drop' / ...
  payload            JSONB,
  created_at
)
```

高优先审计事件：
- 任何 abort（成功/超时）
- takeover / release
- runtime 切换
- state 非常规转换（如强制 `busy → idle`）
- 权限拒绝（非授权用户尝试 abort）

## 6.3 权限模型

### 三层权限

1. **Channel 级**：谁能连接、发消息到这个 channel。由平台侧管控（加群、加好友）。
2. **Namespace 级**：哪些 runtime 可用、哪些 persona 可用、哪些指令前缀生效。由 `brain_config.extra` 配置。
3. **Chat/Person 级**：
   - `can_abort`：能打断当前轮的人。
   - `can_takeover`：能切到 manual 的人。
   - `can_switch_runtime`：能用 `/m4` `/h4` 前缀的人。
   - 群聊中：owner/admin 总是有，普通成员需本轮是 turnSender 才能 abort。

### 权限落点

```sql
chat_permissions(
  chat_session_id, person_slug,
  role,              -- 'owner' / 'admin' / 'member'
  overrides JSONB    -- 细粒度 override
)
```

## 6.4 多租户隔离

### 隔离维度

| 维度 | 隔离级别 |
| --- | --- |
| 渠道凭证 | per channel 实例（vault:// 引用） |
| 数据库行 | per namespace（全表加 `namespace` 列 + 查询必带） |
| yoho-memory 上下文头 | per request（`x-yoho-namespace` 来自 channel 配置） |
| Runtime session | runtime 侧 namespace 透传；Brain spawn 的 `YR_NAMESPACE` 环境变量 |
| 日志 / 指标 | label 带 namespace；告警按 namespace 聚合 |
| Keycloak | 每个 namespace 一个 realm 或一个 group scope |

### 反模式（绝对不要）

- 跨 namespace 共享 `platform_identities`：同一人在不同 namespace 下应是独立映射，避免画像泄漏。
  - **例外**：`person_slug` 可以是全局的（yoho-memory 全局 canonical），但 **namespace → personSlug** 的映射是 per-namespace 独立。
- 全局 runtime 共享：Brain 的 CLI 进程若被多 namespace 复用，namespace 切换成本高且危险。每个 namespace 独立 CLI 实例更安全。
- 凭证放环境变量：用 `yoho-credentials` vault，按 namespace 命名。

## 6.5 安全红线

1. **Inbound 必须先鉴权**：Feishu 签名、DingTalk HMAC、Slack request signing。签名失败直接 401，不写 `im_inbound_log`（避免放大攻击）。
2. **Outbound meta-action 限权**：`[recall:]` / `[pin:]` / `[urgent:]` 这类会影响 IM 全局状态的 action，runtime 必须声明「这一轮被授权做此事」；默认关闭，`brain_config` 白名单开启。
3. **Runtime 不能直接调 IM SDK**：runtime 输出的 meta-action 由 bridge 层转成 adapter 调用，runtime 侧没有 IM 凭证。
4. **Credential 走 vault**：M4 gateway token、H4 可能的 API key、Feishu/DingTalk 应用密钥一律 `yoho-credentials`。DB 明文禁止。

## 6.6 容量 & 成本

| 指标 | 预估基线 | 行动阈值 |
| --- | --- | --- |
| 单 chat QPS | < 10/min | 超阈值触发背压（5.10） |
| 并发 busy chat | < 100（per namespace） | 超阈值拒新 flush，提示"稍后" |
| runtime 调用 latency P95 | Brain < 5s 首 token；M4 < 3s；H4 < 10s | 超阈值告警 |
| LLM token 消耗 | per namespace 月度 quota | 超阈值暂停 runtime |

## 6.7 运维 runbook（最小集）

1. 某 chat 卡 busy > 10min → `busyWatchdog` 自动恢复；如果失败，查 `im_chat_audit` 的 `abort-timeout`，人工 `state → idle`。
2. 某 runtime circuit breaker 开 → 看 `im_runtime_error_total{runtime}` + `healthCheck` 日志；确认故障域（M4 gateway down、H4 进程 OOM）。
3. identity resolver 降级持续 > 5min → yoho-memory 大概率不可达，查 yoho-memory HTTP 服务；缓存会继续工作但候选画像不更新。
4. 重复 inbound 告警 → 多半是 channel 侧没签名校验，或者 channel 侧 retry 风暴。

## 6.8 推荐 vs 不推荐

| 选择点 | 推荐 | 不推荐 | 理由 |
| --- | --- | --- | --- |
| traceparent 生成 | Channel 入站即生成 | 到 runtime 层才生成 | 前置层的延迟也要能追到 |
| 审计粒度 | 状态转换 + 安全事件 | 每条消息都写 audit | 量级吃不消；inbound/outbound 已经有 log 表 |
| 租户隔离 | namespace 列硬隔离 + namespace token | 应用层 if-else 判断 | 忘加 where 就是数据泄漏 |
| 凭证 | vault 引用 | DB 明文 / env var | 审计、轮转、revoke 成本差异巨大 |
| 限流位置 | per chat + per runtime 两层 | 只做 global | 单 chat 抖动不应影响整 namespace |
| 告警 | 按 namespace + platform 分组 | 全局聚合 | 一个租户炸不应淹没其他租户 |
