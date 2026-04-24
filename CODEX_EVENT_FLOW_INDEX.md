# Codex Session 事件流 — 快速索引

## 🎯 按用途查找

### 我想了解 Codex 如何输出事件

→ 查看 `cli/src/codex/codexExecLauncher.ts:50-159` 的 `ExecEvent` 和 `ExecItem` 类型定义

**关键**:
- `thread.started` → Codex 会话开始
- `item.started` / `item.completed` → 任务执行（消息、工具调用、文件变更等）
- `turn.completed` → 轮次结束，包含 token 统计

---

### 我想了解 Codex 事件如何转换为消息

→ 查看 `cli/src/codex/utils/codexEventConverter.ts` (完整实现)

**关键函数**: `convertCodexEvent()` (line 127)

**转换示例**:
```
ExecItem (type: 'agent_message')
  ↓
CodexMessage { type: 'message', message: "..." }
  ↓
DecryptedMessage { role: 'assistant', content: [...] }
```

---

### 我想了解 Codex 和 Claude 的区别

→ 查看本文档中的 [Claude vs Codex 事件流异同](#claude-vs-codex-事件流异同) 章节

**快速对比**:

| 特性 | Claude | Codex |
|-----|--------|-------|
| 权限模式 | bypassPermissions | default/read-only/safe-yolo/yolo |
| Session ID | claudeSessionId | codexSessionId |
| 启动 | `claude` 命令 | `codex exec --json` 子进程 |
| Resume | `--resume <sessionId>` | `exec resume <thread_id>` |

---

### 我想了解服务端如何处理事件

→ 查看 `server/src/sync/syncEngine.ts:304-320` 的 `SyncEvent` 接口

**关键点**:
- SyncEvent 是统一抽象，支持 Claude 和 Codex
- `message` 字段始终是 Claude 格式 (DecryptedMessage)
- flavor 信息在 `Session.metadata.flavor` 中

---

### 我想查询特定 flavor 的 session

→ 使用 `/cli/sessions/search?flavor=codex` 或 `flavor=claude`

**API 位置**: `server/src/web/routes/cli.ts:120-122`

```typescript
const sessionSearchQuerySchema = z.object({
    ...
    flavor: z.enum(['claude', 'codex']).optional(),
    ...
})
```

---

### 我想了解权限模式在哪里被验证

→ 查看 `server/src/web/routes/sessionConfigPolicy.ts`

**关键函数**: `validatePermissionModeForSessionFlavor()`

**核心逻辑**:
- Claude 必须用 'bypassPermissions'
- Codex 必须用 { 'default', 'read-only', 'safe-yolo', 'yolo' } 之一

---

## 📂 按文件查找

### `cli/src/codex/`

| 文件 | 行号 | 内容 |
|-----|------|------|
| codexExecLauncher.ts | 50-159 | ExecEvent/ExecItem 类型 |
| codexExecLauncher.ts | 200+ | 事件处理循环 |
| utils/codexEventConverter.ts | 5-51 | CodexMessage 类型 |
| utils/codexEventConverter.ts | 127-283 | convertCodexEvent() |
| codexRemoteLauncher.ts | 320-365 | 事件分发 |
| session.ts | 103 | sendSessionEvent RPC |

### `cli/src/api/`

| 文件 | 行号 | 内容 |
|-----|------|------|
| types.ts | 16-22 | 权限模式定义 |
| types.ts | 24-70 | Metadata 类型 |

### `server/src/sync/`

| 文件 | 行号 | 内容 |
|-----|------|------|
| syncEngine.ts | 115-144 | Session 接口 |
| syncEngine.ts | 201-207 | DecryptedMessage |
| syncEngine.ts | 237-249 | SyncEventType |
| syncEngine.ts | 304-320 | SyncEvent 接口 |

### `server/src/socket/`

| 文件 | 行号 | 内容 |
|-----|------|------|
| handlers/cli.ts | 19-100 | 消息/Meta 类型 |
| handlers/cli.ts | 200+ | 事件处理 |

### `server/src/web/routes/`

| 文件 | 行号 | 内容 |
|-----|------|------|
| cli.ts | 120-122 | 搜索 flavor 参数 |
| sessions.ts | 58-84 | SessionSummaryMetadata |
| sessions.ts | 121-175 | toSessionSummary() |

---

## 🔄 事件流数据变换

### Codex 消息流示例

```
ExecEvent (stdout)
  ↓
handleExecEvent() in codexExecLauncher
  ↓
CodexMessage (通过 session.sendSessionEvent)
  ↓
Socket.IO 消息 (到服务端)
  ↓
Server: SyncEngine.sendMessage()
  ↓
DecryptedMessage (Claude 格式)
  ↓
SyncEvent 发布
  ↓
SSEManager / BrainBridge / Web API
```

### Codex 工具调用示例

```
ExecMcpToolCallItem
  ↓
1. item.started → CodexMessage { type: 'tool-call' }
2. item.completed → CodexMessage { type: 'tool-call-result' }
  ↓
Server: 转换为 Claude 格式
  → tool_use { id, name, input }
  → tool_result { tool_use_id, content }
```

---

## 🏗️ 关键设计

### 为什么有统一的 SyncEvent?

- **多源**: Claude + Codex 两种会话类型
- **多订阅**: SSE、Web、Brain 都需要事件
- **格式统一**: 所有消息最终以 Claude 格式存储

### Flavor 的作用

- **识别会话类型**: Codex vs Claude
- **权限模式绑定**: Codex 有 4 种权限模式，Claude 只有 1 种
- **Native ID 存储**: `codexSessionId` (thread_id) vs `claudeSessionId`

### 元数据的作用

- **Session 恢复**: codexSessionId 用于 `codex exec resume`
- **工具链集成**: runtimeAgent, runtimeModel 等配置
- **Brain 系统**: mainSessionId, brainPreferences

---

## ❓ 常见问题

**Q: Codex session 如何在服务端识别?**  
A: `Session.metadata.flavor === 'codex'` 且有 `codexSessionId` 字段

**Q: Codex 权限模式支持几种?**  
A: 4 种 - 'default', 'read-only', 'safe-yolo', 'yolo'

**Q: thread_id 和 sessionId 的关系?**  
A: `codexSessionId === thread_id` (存在 metadata 中)

**Q: ExecEvent 包含哪些重要字段?**  
A: type (thread.started/item.*/turn.* 等), thread_id, item (ExecItem)

**Q: CodexMessage 有哪些类型?**  
A: message, reasoning, reasoning-delta, token_count, tool-call, tool-call-result

**Q: SyncEvent 发布给谁?**  
A: SSEManager, BrainBridge, 以及 Web API 路由

---

## 📖 详细文档

完整的分析报告: `CODEX_SESSION_EVENT_FLOW_ANALYSIS.md`
