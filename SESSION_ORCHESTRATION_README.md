# Session Orchestration 架构文档

本目录包含 yoho-remote 服务端 session 编排系统的完整分析文档。

## 📖 文档导航

### 1. **SESSION_ORCHESTRATION_INDEX.md** ⭐ 推荐首先阅读
   - 快速查找表、API 速查、核心概念
   - 5 分钟快速了解系统

### 2. **SESSION_ORCHESTRATION_GUIDE.md** 
   - 完整架构分析
   - 详细 API 签名和工作流
   - 数据表和关键函数说明

### 3. **SESSION_ORCHESTRATION_CODE_SNIPPETS.md**
   - 实际代码示例
   - 复制即用的代码片段
   - 完整调用示例

---

## 🎯 快速概览

### 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| **SyncEngine** | `sync/syncEngine.ts` | 核心编排引擎，管理 session 生命周期 |
| **Spawn 路由** | `web/routes/machines.ts:124` | HTTP 入口，创建 session |
| **Session 管理** | `web/routes/sessions.ts:897+` | 全生命周期管理 |
| **Brain MCP** | `web/routes/sessions.ts:1011` | AI agent 间编排 |
| **数据持久化** | `store/postgres.ts` | 项目表、session 元数据存储 |

### 关键 API

```typescript
// 创建 session
engine.spawnSession(machineId, directory, agent?, yolo?, options?)
  → { type: 'success' | 'error', sessionId?: string }

// 发送消息
engine.sendMessage(sessionId, { text, sentFrom?, ... })
  → { status: 'sent' | 'queued', ... }

// 查询 session
engine.getSession(sessionId) → Session | undefined
engine.getSessionsByNamespace(namespace) → Session[]

// 项目管理
store.addProject(name, path, description?, machineId?, orgId?)
store.listProjects(filters?)
store.updateProject(id, fields)
store.removeProject(id)
```

---

## 🔍 常见问题速查

### Q: 如何创建 Session?
**A:** 见 INDEX.md 中的"操作1: 创建 Session"

### Q: 如何发送消息？
**A:** 见 INDEX.md 中的"操作2: 发送消息"

### Q: Projects 表的约束是什么？
**A:** `UNIQUE(path, machine_id, org_id)` - 见 GUIDE.md §4

### Q: AI Task Schedules 在哪里？
**A:** DDL 在 `ai-tasks-ddl.ts`，但 CRUD 未实现 - 见 GUIDE.md §4

### Q: Brain session 如何工作？
**A:** 见 CODE_SNIPPETS.md §3 + GUIDE.md §5

### Q: Session 初始化流程是什么？
**A:** 见 CODE_SNIPPETS.md §1 + 时间线图表

---

## 📍 文件定位速查

| 需求 | 查看位置 |
|------|---------|
| 找到 Spawn 入口 | `web/routes/machines.ts:124` |
| 找到 Brain session 创建 | `web/routes/sessions.ts:1011` |
| 找到消息发送逻辑 | `sync/syncEngine.ts:3489` |
| 找到 Projects CRUD | `store/postgres.ts:1926` |
| 找到 AI Tasks DDL | `store/ai-tasks-ddl.ts` |
| 找到等待 online 逻辑 | `web/routes/machines.ts:66` |
| 找到初始化 prompt | `web/routes/machines.ts:41` |

---

## ✨ 关键发现总结

### ✅ 已实现的功能
1. **Session Spawn** - 完整的 spawn 流程，支持 worktree 和普通 session
2. **Message Send** - 通过 SyncEngine，支持 deduplication 和 buffering
3. **Brain MCP** - 特殊的 Brain session，支持子 session 管理
4. **Projects 管理** - 完整的 CRUD，支持 org_id 和 machine_id 隔离
5. **Session 查询** - 支持多维度查询（namespace、org、status 等）

### ⚠️ 待实现的功能
1. **AI Task Schedules** - DDL 已定义，但 CRUD 操作未实现
2. **Session Stop** - 没有找到明确的停止 session 的接口
3. **消息发送路由** - HTTP 层面没有直接的消息路由，依赖 Socket.IO

### 🔍 需要验证的地方
1. Socket.IO 层的消息处理具体实现（`socket/handlers/cli.ts`）
2. Brain-child init 完成标记的具体机制
3. 项目 directory 校验的调用位置
4. Permission mode 和权限检查的具体实现

---

## 🚀 典型工作流

### 创建 Session 的完整流程

```
1. HTTP POST /machines/{id}/spawn
   ├─ 验证请求体
   ├─ License 检查
   ├─ 解析 token source
   └─ 调用 engine.spawnSession()

2. SyncEngine.spawnSession()
   ├─ 验证 machine 支持的 agent
   ├─ 通过 RPC 发送 'spawn-yoho-remote-session'
   └─ 返回 { type: 'success' | 'error', sessionId }

3. 异步后处理（不阻塞）
   ├─ 等待 session 上线（60s timeout）
   ├─ 等待 Socket.IO 连接（5s timeout）
   ├─ 存储 createdBy 和 orgId
   ├─ 发送初始化 prompt
   └─ 完成

4. HTTP 200 返回 sessionId
```

**关键点**: 初始化是异步的，HTTP 响应不等待初始化完成！

---

## 💡 最佳实践

1. **Session 创建**
   - 始终检查返回的 `type` 字段
   - 不要在 spawn 后立即假设 session online
   - 用 `getSession(sessionId)?.active` 检查状态

2. **消息发送**
   - 使用 `localId` 实现消息去重
   - Brain-child 消息可能被缓冲，检查返回状态
   - `sentFrom: 'webapp'` 标记 WebApp 来源消息

3. **Project 管理**
   - 创建时检查唯一性返回值（null = 冲突）
   - 更新时需要重新检查约束
   - 删除前验证没有活跃 session 引用

4. **Brain Session**
   - 选择支持所请求 agent 的 machine
   - 分别为 claude 和 codex 配置 token source
   - 使用 `brainTokenSourceIds` 管理子 session 能力

---

## 🔧 开发指南

### 要添加新的 Session 操作？

1. **添加 HTTP 路由**
   - 在 `web/routes/sessions.ts` 或 `machines.ts` 添加 `app.post()`
   - 使用 `requireSyncEngine()` 获取 engine

2. **添加 SyncEngine 方法**
   - 在 `sync/syncEngine.ts` 添加新方法
   - 通过 `machineRpc()` 或 `sessionRpc()` 与 CLI 通信

3. **更新 DB 存储**
   - 修改 `store/postgres.ts` 的 CRUD 方法
   - 确保新字段有 migration

### 要实现 AI Task Schedules？

```typescript
// 1. 添加接口到 IStore
interface IStore {
    createAiTaskSchedule(input: { ... }): Promise<AiTaskSchedule>
    getAiTaskSchedule(id: string): Promise<AiTaskSchedule | null>
    listAiTaskSchedules(filters: { ... }): Promise<AiTaskSchedule[]>
    updateAiTaskSchedule(id: string, fields: { ... }): Promise<AiTaskSchedule | null>
    deleteAiTaskSchedule(id: string): Promise<boolean>
    createAiTaskRun(input: { ... }): Promise<AiTaskRun>
    getAiTaskRuns(filters: { ... }): Promise<AiTaskRun[]>
}

// 2. 在 postgres.ts 中实现 CRUD
// DDL 已存在于 ai-tasks-ddl.ts，直接写 query

// 3. 添加 HTTP 路由
app.post('/ai-tasks', async (c) => { ... })
app.get('/ai-tasks', async (c) => { ... })
app.post('/ai-tasks/:id/run', async (c) => { ... })
```

---

## 📊 系统依赖关系图

```
HTTP Request
    ↓
┌─────────────────────────────────────┐
│ machines.ts / sessions.ts (Routes)  │
└──────────────────┬──────────────────┘
                   ↓
         ┌─────────────────────┐
         │   SyncEngine        │
         │  (Orchestration)    │
         └────────┬───────┬────┘
                  ↓       ↓
          ┌───────────┐  ┌──────────┐
          │ MachineRPC│  │ PostgreSQL│
          └─────┬─────┘  │  Store   │
                ↓        └──────────┘
            ┌──────┐
            │ CLI  │
            │ (RPC)│
            └──────┘
```

---

## 📝 更新日志

| 日期 | 内容 |
|------|------|
| 2026-04-20 | 初次完整分析，生成三份文档 |

---

## 🤝 贡献

如果发现文档不完整或有误，请更新相应的文档文件：
- INDEX - 快速查找
- GUIDE - 完整细节
- CODE_SNIPPETS - 实际代码

保持三份文档的一致性。

---

**最后更新**: 2026-04-20  
**文档位置**: `server/src/SESSION_ORCHESTRATION_*.md`
