# External Consumer 接入指南

面向 OpenClaw(Hermes 同理) 的接入工程师。

这份文档只讲一件事:**把 OpenClaw / Hermes 当成 `yoho-remote` 的 external capability consumer 来接**,而不是把它们装进 `yoho-remote` 当 runtime。

## 先说结论

- 推荐路径是 **P1 MCP server** 或 **P2 external consumer SDK**。
- 只有宿主强绑定、必须做最薄的一层事件翻译时,才考虑 **P3 host-specific thin plugin**。
- **P4 portable skill/schema package** 只适合分发能力定义、schema、manifest,不适合承载执行主权。
- **不要试图开 remote session**。不要碰 `/v1/sessions`。不要传 `runtimeType`。不要把 OpenClaw/Hermes 伪装成 hosted runtime。

## 四类允许形态

| 优先级 | 形态 | 你该做什么 | 你不该做什么 |
| --- | --- | --- | --- |
| P1 | MCP server | 把 `yoho-remote` 暴露的 capability 作为 MCP tools 调用 | 不要让 MCP tool 直接写宿主内部状态 |
| P2 | external consumer SDK | 在 OpenClaw/Hermes 宿主里调用 SDK,SDK 再去打 capability API | 不要让 SDK 变成“偷偷开 session 的捷径” |
| P3 | host-specific thin plugin | 只做宿主事件翻译、请求组装、SDK 适配 | 不要把业务状态、队列、审批逻辑塞进 plugin |
| P4 | portable skill/schema package | 分发 skill 定义、schema、manifest、policy hint | 不要把可执行逻辑藏进 skill 包 |

优先级规则很简单:

1. 能用 P1,就不要自己发明别的 transport。
2. 能用 P2,就不要把逻辑塞进 plugin。
3. P3 只做薄封装。
4. P4 只做声明,不做主权。

## 认证、配置、调用

### 认证

- 每个 external consumer 必须有自己的 app token 或 OAuth 凭证。
- 凭证按 `externalSystem × namespace` 绑定 scope。
- 不要共用 hosted bundle 的 channel 凭证。
- 不要把 secret 写进 skill 包、manifest、日志或测试 fixture。

### 配置

你只应该读取这些配置:

- namespace scope
- capability allowlist
- policy profile
- 限流配额
- sandbox 标识

你不应该读取这些东西:

- remote session state
- hosted runtime 内部队列
- channel 凭证本体
- 其他租户的 profile / memory / audit 原文

### 调用范式

每次调用都应该长这样:

1. 构造一个显式 capability request。
2. 带上 `externalSystem`、`namespace`、`capability`、`payload`。
3. 让 `yoho-remote` 先过 PolicyGate。
4. 如果允许，继续执行。
5. 如果需要审批，返回 pending，不执行副作用。
6. 如果审批通过，再带 `approvalToken` 重放同一动作。

## approval pending / ticket / approvalToken

这是必须遵守的语义，不是建议。

- `require_approval` 不是“稍后会自动成功”，而是“现在停住”。
- `ticketId` 是这次动作的审批凭证。
- `approvalToken` 只绑定这一条动作快照。
- `approvalToken` 一次有效，过期、撤销、或 action 发生漂移，都必须失败。
- 在 ticket 还是 pending 的时候，**不要执行任何副作用**。

建议你把 pending 流程理解成:

```text
request -> PolicyGate -> pending(ticketId)
         -> human approval
         -> replay with approvalToken
         -> execute
```

如果你看到“先执行，再补审批”，那就是错的。

## 本地 sandbox

本地联调只允许进 sandbox。

- 用 sandbox app token。
- 用 sandbox namespace。
- 用 sandbox capability server。
- 用 mock fixture 或 recording replay。

sandbox 允许你验证:

- auth 是否正确
- PolicyGate 是否拦截
- Approval Ticket 是否生成
- approvalToken 是否能重放
- rate limit 是否生效

sandbox 不允许你验证:

- 生产凭证
- 生产 namespace 的数据
- 真实出站副作用

## 常见错误

- `401 Unauthorized`：token 不对、scope 不对、或者环境错了。
- `403 Forbidden`：PolicyGate 直接拒绝。
- `202 Accepted` / `pending_approval`：你触发了审批流，但还没拿到批准。
- `409 Conflict`：approvalToken 过期、撤销、或和动作快照不匹配。
- `429 Too Many Requests`：超出外部 consumer 速率限制。
- `503 Service Unavailable`：capability provider 不可用，按 fail closed 处理。

## 明确禁做项

以下事情不要做，做了就是接错了:

- 不要碰 `/v1/sessions`
- 不要传 `runtimeType=openclaw` 或 `runtimeType=hermes`
- 不要尝试让 `yoho-remote` 替 OpenClaw/Hermes 开 remote session
- 不要把 external consumer 做成 `RuntimeAdapter`
- 不要把审批绕成 shadow / pilot / debug session
- 不要绕过 PolicyGate 直接调用业务 handler
- 不要让 skill 包携带 secret、token、凭证引用

## 最后一句

`yoho-remote` 给 OpenClaw / Hermes 的不是“住进来跑”的位置，而是“按契约来拿能力”的入口。  
你要做的是接入件，不是宿主。
