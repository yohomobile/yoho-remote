# Session Orchestration 架构指南

## 核心入口概览

### 1. SyncEngine（核心编排引擎）
**文件**: `server/src/sync/syncEngine.ts`

#### 关键方法签名
```typescript
// Session 生命周期管理
async spawnSession(
    machineId: string,
    directory: string,
    agent: string = 'claude',
    yolo?: boolean,
    options?: {
        sessionId?: string
        resumeSessionId?: string
        sessionType?: 'simple' | 'worktree'
        worktreeName?: string
        tokenSourceId?: string
        tokenSourceName?: string
        tokenSourceType?: 'claude' | 'codex'
        tokenSourceBaseUrl?: string
        tokenSourceApiKey?: string
        claudeSettingsType?: 'litellm' | 'claude'
        claudeAgent?: string
        codexModel?: string
        permissionMode?: Session['permissionMode']
        modelMode?: Session['modelMode']
        modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
        source?: string
        mainSessionId?: string
        caller?: string
        brainPreferences?: Record<string, unknown>
        reuseExistingWorktree?: boolean
    }
): Promise<{ type: 'success'; sessionId: string; logs?: unknown[] } | { type: 'error'; message: string; logs?: unknown[] }>

// 消息发送
async sendMessage(
    sessionId: string,
    payload: {
        text: string
        localId?: string | null
        sentFrom?: string
        meta?: Record<string, unknown>
    }
): Promise<SendMessageOutcome>

// Session 查询
getSession(sessionId: string): Session | undefined
getSessionsByNamespace(namespace: string): Session[]
getSessionMessages(sessionId: string): DecryptedMessage[]
getActiveSessions(): Session[]

// 路径检查
async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>>
```

#### 内部使用的 RPC 调用
- `spawnSession` 内部调用 `machineRpc('spawn-yoho-remote-session', {...})`
- 返回 `{ type: 'success' | 'error', sessionId?: string, errorMessage?: string, logs?: unknown[] }`

---

## 2. HTTP 路由层

### A. Machines 路由（spawn 入口）
**文件**: `server/src/web/routes/machines.ts` (L124)

#### POST `/machines/:id/spawn`
**请求体**:
```typescript
{
    directory: string                          // 必需
    agent?: 'claude' | 'codex' | ...          // 可选，默认 'claude'
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    tokenSourceId?: string
    claudeSettingsType?: 'litellm' | 'claude'
    claudeAgent?: string
    claudeModel?: 'sonnet' | 'opus' | 'opus-4-7'
    codexModel?: string
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    source?: string                            // 来源标记
}
```

**工作流**:
1. 校验请求体 (spawnBodySchema)
2. License 检查: `getLicenseService().canCreateSession(orgIdForLicense)`
3. 解析 token source: `resolveTokenSourceForAgent(store, orgId, tokenSourceId, agent)`
4. 调用 `engine.spawnSession(machineId, directory, agent, yolo, {...options})`
5. **异步后处理** (不阻塞响应):
   - 等待 session online: `waitForSessionOnline(engine, sessionId, 60_000)`
   - 等待 socket 加入房间: `engine.waitForSocketInRoom(sessionId, 5000)`
   - 设置 createdBy: `store.setSessionCreatedBy(sessionId, email, namespace)`
   - 设置 orgId: `store.setSessionOrgId(sessionId, orgId, namespace)`
   - 发送初始化 prompt: `sendInitPrompt(engine, sessionId, role, userName, machineId)`

#### Helper 函数

**sendInitPrompt** (L41-64):
```typescript
async function sendInitPrompt(
    engine: SyncEngine,
    sessionId: string,
    role: UserRole,
    userName?: string | null,
    machineId?: string
): Promise<void>
```
- 从 session metadata 获取 projectRoot
- 调用 `buildInitPrompt(role, { projectRoot, userName, worktree })`
- 通过 `engine.sendMessage(sessionId, { text: prompt, sentFrom: 'webapp' })` 发送

**waitForSessionOnline** (L66-104):
- 轮询 session 状态直到 `session.active === true`
- 最多等待 `timeoutMs` 毫秒

---

### B. Sessions 路由（管理入口）
**文件**: `server/src/web/routes/sessions.ts` (L897+)

#### 关键路由

##### POST `/sessions` (L897)
创建普通 session（调用 `engine.spawnSession`）

##### POST `/brain/sessions` (L1011)
创建 Brain session（特殊编排）

**工作流**:
1. 校验请求体 (createBrainSessionSchema)
2. 获取 Brain 配置: `store.getBrainConfig(namespace)`
3. 提取子模型默认值: `extractBrainChildModelDefaults(brainConfig?.extra)`
4. 解析 token sources (claude 和 codex 可分别指定)
5. 获取兼容的在线 machine: `engine.getOnlineMachinesByNamespace(namespace, orgId)`
6. **迭代 machine 列表**，调用 `engine.spawnSession` with:
   - `source: 'brain'`
   - `permissionMode: resolveBrainSpawnPermissionMode(agent)`
   - `brainPreferences: buildBrainSessionPreferences({...})`
7. 设置 brainTokenSourceIds (元数据): `engine.patchSessionMetadata(sessionId, { brainTokenSourceIds })`

##### 其他关键路由

- POST `/sessions/:id/permission-mode` (L1842) - 更新权限模式
- POST `/sessions/:id/model` (L1881) - 切换 AI 模型
- POST `/sessions/:id/fast-mode` (L1947) - 启用/禁用 fast mode
- POST `/sessions/:id/subscribe` (L2062) - SSE 订阅（实时更新）
- GET `/sessions` (L1218) - 列表 sessions

#### Session 摘要数据结构
```typescript
type SessionSummary = {
    id: string
    createdAt: number
    active: boolean
    activeAt: number
    updatedAt: number
    lastMessageAt: number | null
    createdBy?: string
    ownerEmail?: string
    metadata: SessionSummaryMetadata | null  // 项目路径、worktree 等
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    thinking: boolean
    modelMode?: Session['modelMode']
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
    activeMonitorCount?: number
    viewers?: SessionViewer[]
    terminationReason?: string
}
```

---

## 3. Projects 表架构

**文件**: `server/src/store/postgres.ts` (L306-322)

### DDL
```sql
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    description TEXT,
    machine_id TEXT,
    workspace_group_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    UNIQUE(path, machine_id, org_id)  -- 多列唯一约束
);

CREATE INDEX idx_projects_machine_id ON projects(machine_id);
CREATE INDEX idx_projects_workspace_group_id ON projects(workspace_group_id);
CREATE INDEX idx_projects_org_id ON projects(org_id);
```

### CRUD 操作

#### 查询
```typescript
// 列表（可过滤）
async listProjects(filters?: {
    name?: string
    machineId?: string
    orgId?: string
}): Promise<StoredProject[]>

// 单条
async getProject(id: string): Promise<StoredProject | null>
```

#### 创建
```typescript
async addProject(
    name: string,
    path: string,
    description?: string,
    machineId?: string | null,
    orgId?: string | null
): Promise<StoredProject | null>
```
- 检查唯一性冲突: `(path, machine_id, org_id)` 组合必须唯一
- 返回 null 如果冲突

#### 更新
```typescript
async updateProject(
    id: string,
    fields: {
        name?: string
        path?: string
        description?: string | null
        machineId?: string | null
        orgId?: string | null
    }
): Promise<StoredProject | null>
```
- 检查更新后的唯一性
- 返回更新后的记录

#### 删除
```typescript
async removeProject(id: string): Promise<boolean>
```

---

## 4. AI Task Schedules 表架构

**文件**: `server/src/store/ai-tasks-ddl.ts`

⚠️ **DDL 已定义但 CRUD 操作未实现** ⚠️

### DDL (ai_task_schedules)
```sql
CREATE TABLE IF NOT EXISTS ai_task_schedules (
    id                    TEXT PRIMARY KEY,
    namespace             TEXT NOT NULL,
    machine_id            TEXT NOT NULL,
    label                 TEXT,
    cron_expr             TEXT NOT NULL,
    payload_prompt        TEXT NOT NULL,
    directory             TEXT NOT NULL,
    agent                 TEXT NOT NULL DEFAULT 'claude',
    mode                  TEXT,
    model                 TEXT,
    recurring             BOOLEAN NOT NULL DEFAULT TRUE,
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            BIGINT NOT NULL,
    created_by_session_id TEXT,
    last_fire_at          BIGINT,
    next_fire_at          BIGINT,
    last_run_status       TEXT,
    consecutive_failures  INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_ats_machine_enabled ON ai_task_schedules(machine_id, enabled);
CREATE INDEX idx_ats_namespace_enabled ON ai_task_schedules(namespace, enabled);
```

### DDL (ai_task_runs)
```sql
CREATE TABLE IF NOT EXISTS ai_task_runs (
    id            TEXT PRIMARY KEY,
    schedule_id   TEXT REFERENCES ai_task_schedules(id) ON DELETE SET NULL,
    session_id    TEXT,
    subsession_id TEXT,
    machine_id    TEXT NOT NULL,
    namespace     TEXT NOT NULL,
    status        TEXT NOT NULL,
    started_at    BIGINT NOT NULL,
    finished_at   BIGINT,
    error         TEXT,
    metadata      JSONB
);

CREATE INDEX idx_atr_schedule ON ai_task_runs(schedule_id, started_at DESC);
CREATE INDEX idx_atr_namespace ON ai_task_runs(namespace, started_at DESC);
CREATE INDEX idx_atr_status ON ai_task_runs(status) WHERE status NOT IN ('succeeded', 'failed', 'timeout');
```

### 需要实现的 CRUD 接口

**IStore 中应添加**:
```typescript
// 创建计划任务
async createAiTaskSchedule(input: {
    namespace: string
    machineId: string
    label?: string
    cronExpr: string
    payloadPrompt: string
    directory: string
    agent?: string
    mode?: string
    model?: string
    recurring?: boolean
    enabled?: boolean
    createdBySessionId?: string
}): Promise<AiTaskSchedule>

// 查询计划任务
async getAiTaskSchedule(id: string): Promise<AiTaskSchedule | null>
async listAiTaskSchedules(filters: {
    machineId?: string
    namespace?: string
    enabled?: boolean
}): Promise<AiTaskSchedule[]>

// 更新计划任务
async updateAiTaskSchedule(id: string, fields: {
    label?: string
    enabled?: boolean
    nextFireAt?: number
    lastFireAt?: number
    lastRunStatus?: string
    consecutiveFailures?: number
}): Promise<AiTaskSchedule | null>

// 删除计划任务
async deleteAiTaskSchedule(id: string): Promise<boolean>

// 记录任务运行
async createAiTaskRun(input: {
    scheduleId?: string
    sessionId?: string
    subsessionId?: string
    machineId: string
    namespace: string
    status: string
    startedAt: number
    finishedAt?: number
    error?: string
    metadata?: Record<string, unknown>
}): Promise<AiTaskRun>

// 查询任务运行记录
async getAiTaskRuns(filters: {
    scheduleId?: string
    namespace?: string
    status?: string
    limit?: number
}): Promise<AiTaskRun[]>
```

---

## 5. Brain MCP 相关后端函数

**文件**: `server/src/web/routes/sessions.ts` + `server/src/brain/` 目录

### Brain Session 管理函数

**创建 Brain Session** (L1011):
```typescript
// 内部调用 engine.spawnSession 且 source='brain'
// 自动选择兼容的 machine，支持跨 machine 子 session
```

**相关辅助函数** (来自 `brain/brainSessionPreferences.ts`):
```typescript
extractBrainSessionPreferencesFromMetadata(metadata): BrainSessionPreferences
buildBrainSessionPreferences(options): Record<string, unknown>
extractBrainChildModelDefaults(extra): ChildModelDefaults
resolveBrainSpawnPermissionMode(agent): SessionPermissionMode
```

**相关辅助函数** (来自 `brain/brainChildRuntimeSupport.ts`):
```typescript
resolveBrainChildRuntimeAvailability(config): RuntimeAvailability
filterBrainChildModelsByRuntimeAvailability(config): EffectiveChildModels
```

**Brain 初始化 Prompt** (来自 `web/prompts/initPrompt.ts`):
```typescript
buildBrainInitPrompt(role, context): Promise<string>
```

### 关键概念

1. **brainTokenSourceIds**: 
   - Server 端维护的 per-agent token source ID 映射
   - 存储在 session.metadata.brainTokenSourceIds
   - 用于 Brain spawn 子 session 时选择 token source

2. **Brain Preferences**:
   - 子 session 的配置（允许的模型列表等）
   - 存储在 session.metadata.brainPreferences
   - 由 buildBrainSessionPreferences 生成

3. **Child Model Runtime Availability**:
   - 基于 token source 配置决定子 session 支持哪些模型
   - 由 resolveBrainChildRuntimeAvailability 计算

---

## 6. 快速参考：常见操作

### 创建 Session
```typescript
const result = await engine.spawnSession(
    machineId,
    '/path/to/project',
    'claude',
    false,
    {
        source: 'external-api',
        modelMode: 'opus',
        sessionType: 'worktree',
        worktreeName: 'my-worktree'
    }
)
// result: { type: 'success' | 'error', sessionId?: string, message?: string }
```

### 发送消息
```typescript
const outcome = await engine.sendMessage(sessionId, {
    text: 'Hello, Claude!',
    sentFrom: 'webapp',
    localId: 'msg-123'  // 用于去重
})
// outcome: { status: 'sent' | 'queued', ... }
```

### 查询 Session 状态
```typescript
const session = engine.getSession(sessionId)
if (session?.active) {
    console.log('Session is online')
    console.log('Thinking:', session.thinking)
    console.log('Pending requests:', session.agentState?.requests)
}
```

### 查询项目（用于 directory 校验）
```typescript
// 创建项目
const project = await store.addProject(
    'my-project',
    '/home/user/my-project',
    'description',
    machineId,
    orgId
)

// 列表项目
const projects = await store.listProjects({ machineId, orgId })

// 查单个
const p = await store.getProject(projectId)

// 更新
await store.updateProject(projectId, { name: 'new-name' })

// 删除
await store.removeProject(projectId)
```

---

## 7. 关键数据流

### Spawn Flow
```
HTTP POST /machines/:id/spawn
  ↓
machines.ts: POST handler validates & calls engine.spawnSession()
  ↓
SyncEngine.spawnSession() →  machineRpc('spawn-yoho-remote-session', ...)
  ↓
CLI receives RPC, spawns session locally
  ↓
Session connects back via Socket.IO
  ↓
Server emits 'session-added' event
  ↓
waitForSessionOnline() resolves
  ↓
sendInitPrompt() queues initial message
  ↓
HTTP 200 OK (with sessionId)
```

### Message Flow
```
WebApp sends message via Socket.IO
  ↓
Server receives, calls engine.sendMessage()
  ↓
Message enqueued/sent to Brain or CLI
  ↓
CLI/Brain processes, returns response
  ↓
Server broadcasts response via Socket.IO
  ↓
WebApp receives update
```

---

## 8. 文件位置总览

| 功能 | 文件 | 行号 |
|------|------|------|
| Session 核心编排 | `server/src/sync/syncEngine.ts` | 3489, 3862+ |
| Spawn 路由 | `server/src/web/routes/machines.ts` | 124+ |
| Session 管理路由 | `server/src/web/routes/sessions.ts` | 897+, 1011+ |
| Projects CRUD | `server/src/store/postgres.ts` | 306-322, 1926+ |
| AI Task Schedules DDL | `server/src/store/ai-tasks-ddl.ts` | 全文 |
| Brain 配置 | `server/src/brain/brainSessionPreferences.ts` | - |
| Socket.IO 事件处理 | `server/src/socket/handlers/cli.ts` | - |
| RPC 注册 | `server/src/socket/rpcRegistry.ts` | - |
| 初始化 Prompt | `server/src/web/prompts/initPrompt.ts` | - |
