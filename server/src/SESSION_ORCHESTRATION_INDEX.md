# Session Orchestration - 快速索引

## 📍 文件位置速查表

| 需求 | 文件 | 行号 | 关键函数 |
|------|------|------|---------|
| **Spawn Session** | `server/src/web/routes/machines.ts` | 124-262 | `app.post('/machines/:id/spawn')` |
| **Spawn 核心** | `server/src/sync/syncEngine.ts` | 3862-3976 | `async spawnSession(...)` |
| **发送消息** | `server/src/sync/syncEngine.ts` | 3489-3570 | `async sendMessage(...)` |
| **创建 Brain** | `server/src/web/routes/sessions.ts` | 1011-1216 | `app.post('/brain/sessions')` |
| **Projects 表** | `server/src/store/postgres.ts` | 306-322, 1926-2054 | `listProjects()`, `addProject()`, `getProject()`, `updateProject()`, `removeProject()` |
| **AI Tasks DDL** | `server/src/store/ai-tasks-ddl.ts` | 全文 | `AI_TASK_SCHEDULES_DDL`, `AI_TASK_RUNS_DDL` |
| **AI Tasks CRUD** | 未实现 | - | 需要添加到 `postgres.ts` |
| **Brain 配置** | `server/src/brain/brainSessionPreferences.ts` | - | `buildBrainSessionPreferences()` |
| **等待 Online** | `server/src/web/routes/machines.ts` | 66-104 | `waitForSessionOnline(...)` |
| **初始化 Prompt** | `server/src/web/routes/machines.ts` | 41-64 | `sendInitPrompt(...)` |

---

## 🔑 核心接口概览

### 1. SyncEngine 核心 API

```typescript
// 生成 session
spawnSession(machineId, directory, agent?, yolo?, options?)
  → Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }>

// 发送消息
sendMessage(sessionId, { text, localId?, sentFrom?, meta? })
  → Promise<{ status: 'sent' | 'queued'; ... }>

// 查询 session
getSession(sessionId) → Session | undefined
getSessionsByNamespace(namespace) → Session[]
getSessionMessages(sessionId) → DecryptedMessage[]
getActiveSessions() → Session[]

// 检查路径
checkPathsExist(machineId, paths) → Promise<Record<string, boolean>>
```

### 2. HTTP 路由 API

| Method | Path | 功能 | 文件 | 行号 |
|--------|------|------|------|------|
| POST | `/machines/:id/spawn` | 创建普通 Session | machines.ts | 124 |
| POST | `/machines/:id/paths/exists` | 检查路径存在性 | machines.ts | 264 |
| PUT | `/machines/:id/supported-agents` | 设置支持的 agent | machines.ts | 301 |
| POST | `/sessions` | 创建普通 session | sessions.ts | 897 |
| POST | `/brain/sessions` | 创建 Brain session | sessions.ts | 1011 |
| POST | `/sessions/:id/permission-mode` | 更改权限模式 | sessions.ts | 1842 |
| POST | `/sessions/:id/model` | 切换模型 | sessions.ts | 1881 |
| POST | `/sessions/:id/fast-mode` | 启用 fast mode | sessions.ts | 1947 |
| POST | `/sessions/:id/subscribe` | SSE 订阅 | sessions.ts | 2062 |
| GET | `/sessions` | 列表 sessions | sessions.ts | 1218 |

### 3. 数据库表

| 表 | 状态 | 用途 | 关键字段 |
|----|----|------|---------|
| `projects` | ✅ 已实现 | 项目管理 | id, path, machine_id, org_id |
| `ai_task_schedules` | 📝 DDL 只 | 定时任务 | id, cron_expr, machine_id, enabled |
| `ai_task_runs` | 📝 DDL 只 | 任务运行记录 | id, schedule_id, session_id, status |

---

## 🚀 常见操作快速实现

### 操作1: 创建 Session

```typescript
// HTTP 请求
POST /machines/{machineId}/spawn
{
  "directory": "/path/to/project",
  "agent": "claude",
  "sessionType": "worktree",
  "worktreeName": "my-worktree"
}

// 返回
{ type: 'success', sessionId: 'sess-xxx' }

// 内部调用
engine.spawnSession(machineId, directory, agent, yolo, { sessionType, ... })
```

### 操作2: 发送消息

```typescript
// 方式 A: 通过 SyncEngine（内部使用）
engine.sendMessage(sessionId, {
  text: "Hello",
  sentFrom: "webapp",
  localId: "msg-123"
})

// 方式 B: 通过 Socket.IO（WebApp 使用）
// 见 socket/handlers/cli.ts
```

### 操作3: 查询 Project（用于 directory 校验）

```typescript
// 列表
await store.listProjects({ machineId, orgId })

// 单个
await store.getProject(projectId)

// 创建
await store.addProject(name, path, description, machineId, orgId)

// 更新
await store.updateProject(projectId, { name, path, ... })

// 删除
await store.removeProject(projectId)
```

### 操作4: 查询 Session 状态

```typescript
const session = engine.getSession(sessionId)

if (!session) {
  // Session not found
}

if (session.active) {
  // Session online
  console.log('Thinking:', session.thinking)
  console.log('Pending requests:', session.agentState?.requests)
}

const messages = engine.getSessionMessages(sessionId)
```

### 操作5: 创建 Brain Session

```typescript
// HTTP 请求
POST /brain/sessions
{
  "agent": "claude",
  "claudeModel": "opus-4-7",
  "childClaudeModels": ["sonnet"],
  "machineId": "machine-xyz"
}

// 内部：自动选择兼容 machine，spawn 到 brain-workspace
// 设置 brainTokenSourceIds，发送初始化 prompt
```

---

## ⚡ 关键实现细节

### Spawn 流程时间线

```
T+0ms   → HTTP POST /machines/:id/spawn
T+50ms  → engine.spawnSession() called
T+100ms → machineRpc('spawn-yoho-remote-session') sent
T+200ms → CLI receives RPC, starts session
T+500ms → Session connects back via Socket.IO
T+510ms → HTTP response sent (sessionId only)
          ↓ Async background tasks start
T+550ms → waitForSessionOnline() completes
T+600ms → waitForSocketInRoom() completes
T+650ms → setSessionCreatedBy() stored
T+700ms → sendInitPrompt() sent
```

**关键**: HTTP 响应不等待初始化完成！

### Message Buffering (Brain-child)

```
Brain → Child Session Message
  ↓
If child.initCompleted?
  ├─ Yes → Send immediately
  └─ No → Buffer in brainChildPendingMessages
           Release on init completion
```

### Uniqueness Constraint (Projects)

```
UNIQUE(path, machine_id, org_id)

Valid:
✅ path="/a", machine="m1", org="o1"
✅ path="/a", machine="m1", org=null
✅ path="/a", machine=null, org="o1"

Invalid:
❌ Duplicate (path, machine, org) tuple
```

---

## 🔍 问题排查指南

### "Session not coming online"
- Check: `waitForSessionOnline()` 返回 false
- 原因: Session 60s 内未将 `active` 设为 true
- 查看: 机器 RPC 日志，网络连接

### "Message queued in brain-child-init"
- 状态: `{ status: 'queued', queue: 'brain-child-init', queueDepth: N }`
- 原因: 子 session 还未完成初始化 prompt
- 等待: session.metadata.brainChildInitCompleted 被设置

### "Project uniqueness conflict"
- `addProject()` 返回 null
- 原因: (path, machine_id, org_id) 组合已存在
- 检查: 更新现有项目而非创建新的

### "AI Task Schedules 找不到接口"
- ✅ DDL 已定义在 `ai-tasks-ddl.ts`
- ❌ CRUD 操作未实现
- 需要: 在 `postgres.ts` 中添加实现

---

## 📚 完整文档位置

| 文档 | 位置 | 内容 |
|------|------|------|
| 架构指南 | `SESSION_ORCHESTRATION_GUIDE.md` | 完整 API 和工作流 |
| 代码片段 | `SESSION_ORCHESTRATION_CODE_SNIPPETS.md` | 实际代码示例 |
| 本文 | `SESSION_ORCHESTRATION_INDEX.md` | 快速查找表 |

---

## ✅ 需要验证的地方

- [ ] Socket.IO 消息发送的具体实现（看 `socket/handlers/cli.ts`）
- [ ] Session stop 的完整实现
- [ ] AI Task Schedules CRUD 实现
- [ ] Brain-child init 完成标记的具体机制
- [ ] 项目目录校验在哪里调用（spawn 时检查 directory 有效性）

---

## 🎯 核心概念速查

| 概念 | 定义 | 存储位置 |
|------|------|---------|
| **Session** | 编辑和 AI agent 交互的上下文 | memory (SyncEngine) + DB |
| **namespace** | 用户隔离，CLI users 用自定义值，Web users 用 'default' | session metadata |
| **source** | Session 来源标记（如 'external-api', 'brain', 'webapp'） | session.metadata.source |
| **Brain** | 特殊 session，可以 spawn 子 sessions | machine ~/.yoho-remote/brain-workspace |
| **Brain-child** | 由 Brain 管理的子 session | session.metadata.source = 'brain-child' |
| **worktree** | Git worktree，session-level 隔离的工作环境 | session.metadata.worktree |
| **permissionMode** | 权限检查模式（yolo/query/prompt/deny） | session.permissionMode |
| **modelMode** | AI 模型选择（sonnet/opus/opus-4-7 等） | session.modelMode |

---

## 🔗 相关代码导航

```
server/src/
├─ sync/
│  └─ syncEngine.ts              # 核心编排
├─ web/routes/
│  ├─ machines.ts                # Spawn 路由
│  └─ sessions.ts                # Session 管理路由
├─ store/
│  ├─ postgres.ts                # CRUD 实现
│  └─ ai-tasks-ddl.ts            # 任务表 DDL
├─ brain/
│  ├─ brainSessionPreferences.ts # Brain 配置
│  └─ brainChildRuntimeSupport.ts # 子 session 能力
├─ socket/
│  ├─ rpcRegistry.ts             # RPC 路由
│  └─ handlers/cli.ts            # Socket 事件处理
└─ web/prompts/
   └─ initPrompt.ts              # 初始化 prompt 生成
```

