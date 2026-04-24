# Codex Session 事件流处理机制 — 完整排查报告

**生成时间**: 2026-04-20  
**仓库**: yoho-remote  
**范围**: CLI (Codex) 和 Server 的事件流处理、元数据、消息转换

---

## 目录

1. [事件流概览](#事件流概览)
2. [Codex 原始事件定义](#codex-原始事件定义)
3. [事件转换流程](#事件转换流程)
4. [服务端事件抽象](#服务端事件抽象)
5. [Claude vs Codex 事件流异同](#claude-vs-codex-事件流异同)
6. [关键文件速查表](#关键文件速查表)

---

## 事件流概览

### 高层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ CLI (Codex Session)                                                 │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ codexExecLauncher.ts                                         │   │
│ │ - 启动 `codex exec --json` 子进程                             │   │
│ │ - 从 stdout 读取 JSONL 事件流                                 │   │
│ │ - 解析 ExecEvent (JSON 行格式)                               │   │
│ └──────────────────────────────────────────────────────────────┘   │
│         ↓ (通过 Socket.IO)                                          │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ codexSession.ts (ApiSessionClient)                           │   │
│ │ - 通过 sendSessionEvent() 发送消息到服务端                     │   │
│ │ - 携带 flavor='codex', codexSessionId 等元数据                │   │
│ └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Server (yoho-remote-server)                                         │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ socket/handlers/cli.ts                                       │   │
│ │ - 接收 Socket.IO 消息 (session-alive, sendMessage 等)        │   │
│ │ - 验证访问权限、许可证                                       │   │
│ │ - 调用 SyncEngine.sendMessage()                              │   │
│ └──────────────────────────────────────────────────────────────┘   │
│         ↓                                                            │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ sync/syncEngine.ts (SyncEngine)                              │   │
│ │ - 统一会话管理（Claude + Codex）                             │   │
│ │ - 生成 SyncEvent (统一事件抽象)                               │   │
│ │ - 发布事件给订阅者（Web, SSE, Brain 等）                      │   │
│ └──────────────────────────────────────────────────────────────┘   │
│         ↓                                                            │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 事件订阅者:                                                  │   │
│ │ - SSEManager (→ 前端 /stream/sessions/:id)                  │   │
│ │ - BrainBridge (→ Yoho Memory/AI Profile 系统)               │   │
│ │ - 外部通知通道 (→ 飞书/浏览器通知)                           │   │
│ │ - Web API 路由 (→ REST 响应)                                │   │
│ └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Codex 原始事件定义

### 1. Codex Exec --json 输出事件类型

**来源**: cli/src/codex/codexExecLauncher.ts:50-159

Codex 通过 `codex exec --json` 输出 JSONL 格式事件流。每行是一个 JSON 对象，表示一个 ExecEvent。

```typescript
type ExecEvent =
    | { type: 'thread.started'; thread_id: string }
    | { type: 'turn.started' }
    | { type: 'turn.failed'; error?: { message?: string } }
    | { type: 'item.started'; item: ExecItem }
    | { type: 'item.updated'; item: ExecItem }
    | { type: 'item.completed'; item: ExecItem }
    | { type: 'turn.completed'; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }
    | { type: 'error'; message?: string }
    | { type: string; [key: string]: unknown };
```

#### ExecItem 的多种类型

```typescript
type ExecItem =
    | ExecAgentMessageItem          // 代理文本消息
    | ExecMcpToolCallItem           // MCP 工具调用
    | ExecCommandExecutionItem      // shell 命令执行
    | ExecFileChangeItem            // 文件变更
    | ExecReasoningItem             // 推理过程
    | ExecTodoListItem              // 待办清单
    | ExecWebSearchItem             // 网页搜索
    | ExecCollabToolCallItem        // 多代理协作
    | ExecErrorItem                 // 错误
    | ExecItemBase;

interface ExecAgentMessageItem extends ExecItemBase {
    type: 'agent_message';
    text: string;
}

interface ExecMcpToolCallItem extends ExecItemBase {
    type: 'mcp_tool_call';
    server: string;          // MCP server 名称
    tool: string;            // tool 名称
    arguments: unknown;
    result?: unknown;
    error?: { message?: string } | null;
}

interface ExecFileChangeItem extends ExecItemBase {
    type: 'file_change';
    changes: ExecFileChange[];  // { path, kind: 'add'|'delete'|'update' }
}
```

### 2. 关键元数据字段

- **thread_id**: Codex 的会话线程 ID (类似 Claude 的 sessionId，用于 resume)
- **item-based**: 所有工作都表示为 `item.*` 事件的三部曲: started → updated (可选) → completed
- **usage**: `turn.completed` 中携带 token 统计

---

## 事件转换流程

### 1. Codex 事件 → CodexMessage (CLI 端)

**来源**: cli/src/codex/utils/codexEventConverter.ts

在 CLI 端，原始 Codex exec 事件流被转换为统一的 CodexMessage 格式：

```typescript
export type CodexMessage = 
    | { type: 'message'; message: string; id: string }          // agent 文本
    | { type: 'reasoning'; message: string; id: string }        // 推理
    | { type: 'reasoning-delta'; delta: string }                // 推理增量
    | { type: 'token_count'; info: Record<string, unknown>; id: string }
    | { type: 'tool-call'; name: string; callId: string; input: unknown; id: string }
    | { type: 'tool-call-result'; callId: string; output: unknown; id: string };

export function convertCodexEvent(rawEvent: unknown): CodexConversionResult | null {
    const parsed = CodexSessionEventSchema.safeParse(rawEvent);
    // ... 转换逻辑
}
```

#### 转换规则

| 原始事件类型 | 转换后 CodexMessage | 代码行 |
|------------|-------------------|------|
| event_msg: agent_message | { type: 'message', ... } | 183-195 |
| event_msg: agent_reasoning | { type: 'reasoning', ... } | 197-209 |
| event_msg: agent_reasoning_delta | { type: 'reasoning-delta', ... } | 211-222 |
| response_item: function_call | { type: 'tool-call', ... } | 247-262 |
| response_item: function_call_output | { type: 'tool-call-result', ... } | 264-277 |
| session_meta | { sessionId, modelInfo } | 137-151 |

---

## 服务端事件抽象

### 1. 统一事件类型: SyncEventType

**来源**: server/src/sync/syncEngine.ts:237-249

```typescript
export type SyncEventType =
    | 'session-added'            // 新会话
    | 'session-updated'          // 会话更新
    | 'session-removed'          // 会话移除
    | 'message-received'         // 消息接收
    | 'messages-cleared'         // 消息清空
    | 'machine-updated'          // 机器更新
    | 'connection-changed'       // 连接状态变化
    | 'online-users-changed'     // 在线用户变化
    | 'typing-changed'           // 输入状态变化
    | 'group-message'            // 组消息
    | 'file-ready';              // 文件准备就绪
```

### 2. 统一事件接口: SyncEvent

**来源**: server/src/sync/syncEngine.ts:304-318

```typescript
export interface SyncEvent {
    type: SyncEventType;
    namespace?: string;                      // 用户命名空间
    sessionId?: string;                      // 会话 ID
    machineId?: string;                      // 机器 ID
    groupId?: string;                        // 组 ID
    data?: unknown;                          // 额外数据
    message?: DecryptedMessage;              // 消息内容
    users?: OnlineUser[];                    // 在线用户列表
    typing?: TypingUser;                     // 输入用户
    groupMessage?: GroupMessageData;         // 组消息
    fileInfo?: { id: string; ... };
    notifyRecipientClientIds?: string[];     // 通知接收者
}

export interface DecryptedMessage {
    id: string;
    seq: number;
    localId: string | null;
    content: unknown;            // 遵循 Claude 消息格式
    createdAt: number;
}
```

### 3. Session 对象中的 Flavor 和元数据

**来源**: cli/src/api/types.ts:24-70

```typescript
export type Metadata = {
    path: string;
    host: string;
    
    // 关键: Flavor 和原生 ID
    flavor?: string;                    // 'claude' | 'codex'
    claudeSessionId?: string;           // Claude session ID
    codexSessionId?: string;            // Codex thread ID
    
    // 运行时配置
    runtimeAgent?: string;
    runtimeModel?: string;
    runtimeModelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    
    // Brain 系统
    mainSessionId?: string;             // Brain 主会话 ID
    brainPreferences?: Record<string, unknown>;
    
    // 其他
    machineId?: string;
    yolo?: boolean;
    tokenSourceType?: 'claude' | 'codex';
};
```

---

## Claude vs Codex 事件流异同

### 相同点

| 方面 | 说明 |
|------|------|
| **最终消息格式** | 都转换为 Claude 格式存储 (role + content[]) |
| **SyncEvent** | 都使用统一的 SyncEvent 在服务端发布 |
| **权限系统** | 都有权限请求/决策流程 (AgentState) |
| **工具调用** | 都支持 tool_use / tool_result 转换 |
| **Meta 存储** | Session.metadata 中都有 flavor 和对应的 ID |
| **SSE 广播** | 都通过 SSEManager 推送给前端 |

### 差异点

| 方面 | Claude | Codex |
|------|--------|-------|
| **原始事件** | SDK 事件流 | JSONL ExecEvent 行 |
| **会话 ID** | claudeSessionId | codexSessionId (thread_id) |
| **权限模式** | bypassPermissions | default/read-only/safe-yolo/yolo |
| **启动方式** | claude 命令或 SDK | codex exec --json 子进程 |
| **工具来源** | SDK tool_use | ExecMcpToolCallItem |
| **Resume** | claude --resume <sessionId> | codex exec resume <thread_id> |
| **事件处理** | claudeRemoteLauncher | codexExecLauncher |
| **转换器** | SDK 事件直接映射 | codexEventConverter JSONL 解析 |

---

## 关键文件速查表

### CLI 端 (codex 相关)

| 文件路径 | 行号 | 核心内容 |
|---------|------|--------|
| cli/src/codex/codexExecLauncher.ts | 50-159 | ExecEvent, ExecItem 类型定义 |
| cli/src/codex/codexExecLauncher.ts | 161-200 | codexExecLauncher 函数（启动子进程）|
| cli/src/codex/utils/codexEventConverter.ts | 5-51 | CodexMessage, CodexConversionResult 定义 |
| cli/src/codex/utils/codexEventConverter.ts | 127-283 | convertCodexEvent() 转换函数 |
| cli/src/codex/codexRemoteLauncher.ts | 320-365 | 事件处理和分发 |
| cli/src/api/types.ts | 16-70 | Metadata, 权限模式定义 |

### 服务端 (事件抽象)

| 文件路径 | 行号 | 核心内容 |
|---------|------|--------|
| server/src/sync/syncEngine.ts | 115-144 | Session 接口 |
| server/src/sync/syncEngine.ts | 201-207 | DecryptedMessage 定义 |
| server/src/sync/syncEngine.ts | 237-249 | SyncEventType 枚举 |
| server/src/sync/syncEngine.ts | 304-318 | SyncEvent 接口 |
| server/src/socket/handlers/cli.ts | 19-100 | CLI Socket 处理器 |
| server/src/web/routes/cli.ts | 120-122 | flavor 过滤查询 |
| server/src/web/routes/sessions.ts | 58-84 | SessionSummaryMetadata |

---

## 总结

**Codex session 事件流是分层的转换系统**：

1. **原始层** (Codex): ExecEvent JSONL 流 (thread_id)
2. **转换层** (CLI): ExecEvent → CodexMessage → Socket.IO
3. **统一层** (Server): DecryptedMessage (Claude 格式) + SyncEvent
4. **发布层** (Server): SSE, Brain, Web API, notifications

**关键设计**：
- 统一的 SyncEvent 抽象使 Claude 和 Codex 对上层透明
- Flavor 和权限模式绑定
- 乐观并发控制保证一致性
- 完整元数据支持 session 恢复
