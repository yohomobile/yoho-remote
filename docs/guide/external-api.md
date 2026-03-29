# 外部接入：REST 创建 Session + Socket.IO 事件

本文档说明如何通过 REST API 创建 session，并通过 Socket.IO 获取 AI 运行过程的实时事件。

## 适用场景

- 外部系统需要创建并管理 Yoho Remote session
- 外部系统希望实时消费 AI 输出、状态变化、typing 等事件

## 认证流程（JWT）

所有 `/api/*` 接口使用 JWT。先用 `CLI_API_TOKEN` 换取 JWT。

```bash
curl -sS http://localhost:3006/api/auth \
    -H 'Content-Type: application/json' \
    -d '{"accessToken":"<CLI_API_TOKEN[:namespace]>"}'
```

响应示例（截断）：

```json
{
    "token": "<JWT>",
    "user": {
        "id": 1,
        "email": "user@example.com"
    }
}
```

后续请求统一在 `Authorization` 中传递：

```
Authorization: Bearer <JWT>
```

## 获取可用机器

`machineId` 为必填，可以通过以下接口获取在线机器：

```bash
curl -sS http://localhost:3006/api/machines \
    -H "Authorization: Bearer <JWT>"
```

响应示例：

```json
{
    "machines": [
        { "id": "e16b3653-ad9f-46a7-89fd-48a3d576cccb", "active": true }
    ]
}
```

## 创建 Session（REST）

接口：

```
POST /api/sessions
```

请求体字段：

- `machineId`（必填）要运行 session 的机器 ID
- `directory`（必填）项目路径
- `agent`（可选）`claude | codex | gemini | glm | minimax | grok | openrouter | aider-cli`
- `yolo`（可选）是否启用自动权限模式
- `sessionType`（可选）`simple | worktree`
- `worktreeName`（可选）worktree 名称
- `claudeAgent`（可选）Claude agent 标识
- `openrouterModel`（可选）OpenRouter 模型名
- `permissionMode`（可选）`default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo`
- `modelMode`（可选）`default | sonnet | opus | gpt-5.2-codex | gpt-5.1-codex-max | gpt-5.1-codex-mini | gpt-5.2`
- `modelReasoningEffort`（可选）`low | medium | high | xhigh`
- `source`（可选）来源标识，默认 `external-api`，会写入 session 元数据，并附加到 Claude hook 载荷中

请求示例：

```bash
curl -sS http://localhost:3006/api/sessions \
    -H "Authorization: Bearer <JWT>" \
    -H 'Content-Type: application/json' \
    -d '{
        "machineId": "e16b3653-ad9f-46a7-89fd-48a3d576cccb",
        "directory": "/home/guang/softwares/yoho-remote",
        "agent": "codex",
        "source": "external-api"
    }'
```

成功响应：

```json
{
    "type": "success",
    "sessionId": "baffc2d4-fdd2-4565-971f-8a36e1b243a4",
    "logs": []
}
```

失败响应：

```json
{
    "type": "error",
    "message": "Machine is offline",
    "logs": []
}
```

## 实时事件（Socket.IO）

使用 Socket.IO 连接 `/events` 命名空间。服务端会**按 namespace 全量广播**事件，不做订阅过滤，客户端按需自行筛选 `sessionId` / `machineId` / `type`。

### 连接示例（Node.js）

```ts
import { io } from 'socket.io-client'

const socket = io('http://localhost:3006/events', {
    auth: { token: '<JWT>' }
})

socket.on('event', (evt) => {
    console.log(evt)
})
```

### 事件结构（SyncEvent）

常见字段（视事件类型而定）：

- `type`：事件类型
- `namespace`：当前 namespace
- `sessionId` / `machineId` / `groupId`
- `message`：消息事件载荷
- `typing`：输入状态载荷
- `data`：状态更新载荷
- `users`：在线用户变更载荷
- `alert` / `idleSuggestion` / `groupMessage`：高级事件载荷

常见 `type`：

- `session-added` / `session-updated` / `session-removed`
- `message-received` / `messages-cleared`
- `machine-updated`
- `typing-changed`
- `online-users-changed`
- `advisor-alert` / `advisor-idle-suggestion`
- `group-message`

示例事件：

```json
{
    "type": "typing-changed",
    "namespace": "default",
    "sessionId": "baffc2d4-fdd2-4565-971f-8a36e1b243a4",
    "typing": {
        "email": "user@example.com",
        "clientId": "client-1",
        "text": "hello",
        "updatedAt": 1736071250123
    }
}
```

## 注意事项

- `machineId` 必须在线；否则创建会失败。
- `/events` 不做订阅过滤，请在客户端自行过滤需要的事件。
- namespace 由 `CLI_API_TOKEN[:namespace]` 决定，不同 namespace 之间隔离。
- 当设置 `source` 时，Claude Code 的 SessionStart hook 载荷会包含 `hapi_source` 字段（API 字段名保持不变）；若原载荷没有 `source` 字段，也会自动补上。
