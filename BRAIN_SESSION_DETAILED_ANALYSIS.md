# Yoho Remote Brain Session 服务端详细分析

## 1. Session 类型的完整字段列表

### 1.1 StoredSession (数据库层级)

存储在数据库中的 Session 类型定义在 `server/src/store/types.ts`:

```typescript
export type StoredSession = {
    id: string                           // Session ID (UUID)
    tag: string | null                   // 可选的标签
    namespace: string                    // 用户命名空间（默认为 'default' 或 CLI 自定义）
    machineId: string | null             // 关联的机器 ID
    createdAt: number                    // 创建时间戳（毫秒）
    updatedAt: number                    // 最后更新时间戳（毫秒）
    createdBy: string | null             // 创建者 email（Keycloak 用户）
    orgId: string | null                 // 所属组织 ID
    metadata: unknown | null             // 会话元数据 (JSON)
    metadataVersion: number              // metadata 的版本号（乐观锁）
    agentState: unknown | null           // Agent 状态（请求、完成的任务等）
    agentStateVersion: number            // agentState 的版本号（乐观锁）
    todos: unknown | null                // Todo 列表数组
    todosUpdatedAt: number | null        // Todos 最后更新时间
    active: boolean                      // Session 是否活跃（true=在线，false=离线/已归档）
    activeAt: number | null              // 最后活跃的时间戳
    thinking: boolean                    // Agent 是否正在思考
    thinkingAt: number | null            // 开始思考的时间戳
    seq: number                          // 全局递增序列号
    advisorTaskId: string | null         // Advisor 任务 ID
    creatorChatId: string | null         // 创建者的聊天 ID（Feishu）
    advisorMode: boolean                 // 是否启用 Advisor 模式
    advisorPromptInjected: boolean       // Advisor 提示词是否已注入
    rolePromptSent: boolean              // Role 提示词是否已发送
    permissionMode: string | null        // 权限模式（bypassPermissions|read-only|safe-yolo|yolo）
    modelMode: string | null             // 模型模式（default|sonnet|opus|opus-4-7|等）
    modelReasoningEffort: string | null  // 推理努力（low|medium|high|xhigh）
    fastMode: boolean | null             // 是否启用快速模式
    terminationReason: string | null     // 终止原因（license-expired|license-suspended 等）
    lastMessageAt: number | null         // 最后消息时间戳
    activeMonitors: unknown | null       // 活跃的监控器列表
}
```

### 1.2 Session (内存层级)

在 `server/src/sync/syncEngine.ts` 中定义的运行时 Session：

```typescript
export interface Session {
    id: string                              // Session ID
    namespace: string                       // 命名空间
    seq: number                             // 序列号
    createdAt: number                       // 创建时间（毫秒）
    updatedAt: number                       // 更新时间（毫秒）
    lastMessageAt: number | null            // 最后消息时间
    active: boolean                         // 是否活跃
    activeAt: number                        // 最后活跃时间（不为 null，至少为 createdAt）
    createdBy?: string                      // 创建者 email（可选）
    metadata: Metadata | null               // 元数据对象（有详细的 zod schema）
    metadataVersion: number                 // metadata 版本号
    agentState: AgentState | null           // Agent 状态对象
    agentStateVersion: number               // agentState 版本号
    thinking: boolean                       // 是否正在思考
    thinkingAt: number                      // 开始思考时的时间戳
    todos?: TodoItem[]                      // Todo 项目数组
    permissionMode?: SessionPermissionMode  // 权限模式
    modelMode?: 'default' | 'sonnet' | 'opus' | 'opus-4-7' | 'glm-5.1' | 'gpt-5.4' | ...
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean                      // 快速模式
    activeMonitors: SessionActiveMonitor[]  // 活跃监控器列表（数组，不是 null）
    abortedAt?: number                      // 最后一次中止请求时的时间戳
    terminationReason?: string              // 终止原因
    resumingUntil?: number                  // Resume 保护有效的时间戳
}
```

### 1.3 Metadata 详细结构

```typescript
{
    path: string                                          // 工作目录路径（必需）
    host: string                                          // 主机名（必需）
    version?: string                                      // 版本号
    name?: string                                         // 会话名称
    source?: string                                       // 来源（brain|brain-child|external-api|manual|webapp 等）
    os?: string                                           // 操作系统
    summary?: { text: string; updatedAt: number }        // 会话摘要
    machineId?: string                                    // 机器 ID
    tools?: string[]                                      // 可用工具列表
    flavor?: string | null                                // 代理类型（claude|codex 等）
    runtimeAgent?: string                                 // 运行时代理
    runtimeModel?: string                                 // 运行时模型
    runtimeModelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    worktree?: {                                          // Git worktree 信息
        basePath: string
        branch: string
        name: string
        worktreePath?: string
        createdAt?: number
    }
    brainChildInitCompleted?: boolean                    // Brain child 初始化是否完成
    // ... 其他字段通过 .passthrough() 允许额外的字段
}
```

---

## 2. SSE session-updated 事件推送的完整 payload 结构

### 2.1 SyncEvent 接口

```typescript
export interface SyncEvent {
    type: 'session-updated' | 'session-added' | ...
    namespace?: string                     // 命名空间
    sessionId?: string                     // 会话 ID
    machineId?: string                     // 机器 ID
    data?: unknown                         // 事件数据
    notifyRecipientClientIds?: string[]    // 任务完成通知的接收者列表
    // ... 其他字段
}
```

### 2.2 session-updated 的 data payload 结构

通过 `buildSessionPayload()` 构建：

```typescript
{
    id: string
    namespace: string
    seq: number
    createdAt: number
    updatedAt: number
    lastMessageAt: number | null
    active: boolean
    activeAt: number
    createdBy?: string
    metadata: Metadata | null                    // 完整的 Metadata 对象
    metadataVersion: number
    agentState: AgentState | null               // 完整的 AgentState 对象
    agentStateVersion: number
    thinking: boolean
    todos?: TodoItem[]
    permissionMode?: SessionPermissionMode
    modelMode?: 'default' | 'sonnet' | 'opus' | ...
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
    terminationReason?: string
}
```

**特殊注意**：
- `metadata.mainSessionId` 会被自动添加到 payload 中（如果是 brain-child）
- `activeMonitors` 通过单独的 `emitSessionActiveMonitors()` 发送

### 2.3 推送时机

1. **活跃监控器变化** - `emitSessionActiveMonitors()`
2. **任务完成** - `emitTaskCompleteEvent()` (带 notifyRecipientClientIds)
3. **消息接收** - 更新 lastMessageAt
4. **权限变更** - 权限审批后
5. **思考状态变更** - thinking: true → false
6. **元数据更新** - metadata patch
7. **不活跃超时** - 空闲时标记为 active=false

---

## 3. archived/replacement/mainSessionId 字段

### 3.1 archived 表现

- 没有显式 `archived` 字段
- 通过 `active: false` 表示（数据库）
- 通过 `metadata.lifecycleState: 'archived'` 表示生命周期

**相关字段**：
```typescript
metadata.lifecycleState: 'archived' | 'running'
metadata.lifecycleStateSince: number
metadata.archivedBy: string  // 'cli'|'user' 等
metadata.archiveReason?: string
```

**保护机制**：
- 当 `archivedBy !== 'cli'` 时，session 受保护
- 防止 CLI 覆盖用户手动归档的 session

### 3.2 mainSessionId

- 在 `metadata.mainSessionId` 中存储
- 仅对 `source === 'brain-child'` 有效
- 指向父 Brain Session ID

**验证规则**：
```typescript
if (source === 'brain-child' && !mainSessionId) {
    return error  // brain-child sessions require mainSessionId
}
```

---

## 4. Session status 的可能值

虽然没有显式 `status` 字段，但通过多个字段组合表示：

```
active: true|false              // 在线|离线
thinking: false|true            // 空闲|思考中
lifecycleState: 'running'|'archived'
terminationReason: null|string  // null|'license-expired'|'inactivity'|...
```

**完整状态机**：
```
Creation → active=true, thinking=false
    ↓
User Interaction → Message sent
    ↓
thinking: true (Agent thinking)
    ↓
thinking: false (Task complete)
    ↓
[终止条件] → active=false + terminationReason
```

---

## 5. GET /api/sessions 返回字段完整性

### SessionSummary 包含的字段：

```typescript
{
    id: string                                    ✓
    createdAt: number                             ✓
    active: boolean                               ✓
    activeAt: number                              ✓
    updatedAt: number                             ✓
    lastMessageAt: number | null                  ✓
    createdBy?: string                            ✓
    ownerEmail?: string                           ✓ (共享 session)
    metadata: SessionSummaryMetadata | null       ✓
    {
        path: string                              ✓
        mainSessionId?: string                    ✓ (brain-child)
        source?: string                           ✓
        metadata.privacyMode?: boolean            ✓
        ... 其他字段
    }
    todoProgress: { completed: number; total: number } | null  ✓
    pendingRequestsCount: number                  ✓
    thinking: boolean                             ✓
    modelMode?: string                            ✓
    modelReasoningEffort?: string                 ✓
    fastMode?: boolean                            ✓
    activeMonitorCount?: number                   ✓
    viewers?: SessionViewer[]                     ✓ (当前查看者)
    terminationReason?: string                    ✓
}
```

**结论**：✓ **字段足以满足前端需求**

---

## 6. 关键实现细节

### 6.1 Brain Session 创建流程

1. **POST /api/brain/sessions** 创建 Brain session
2. 异步等待 session 上线 (waitForSessionOnline)
3. 发送初始化提示 (sendInitPrompt)
4. Brain session 可开始接收 child session 请求

### 6.2 Brain Child 创建流程

1. Brain 通过 spawnSession 创建 child session
2. metadata 包含 `source: 'brain-child'` 和 `mainSessionId`
3. Child session 加入 brain-child-init 队列
4. 接收 InitPrompt 后标记 `brainChildInitCompleted: true`
5. 执行完成发送回调给 Brain session

### 6.3 列表接口数据合并

- 从数据库获取 StoredSession
- 从内存 (SyncEngine) 获取活跃 session
- 合并数据：active 状态、thinking、pendingRequests 等
- 从 SSEManager 获取 viewers 信息
- 返回 SessionSummary 数组

---

## 关键数据流向

```
CLI spawnSession
    ↓
Server SyncEngine (内存 Session)
    ↓
持久化到 DB (StoredSession)
    ↓
SSE 广播 (SyncEvent with session-updated)
    ↓
前端接收 (SessionSummary + SSE 事件)
```
