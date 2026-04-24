# Yoho Remote 自动迭代功能 - AI 实现提示词

将此提示词复制给新的 AI 会话，让它按设计文档实现功能。

---

## 提示词开始

你是一个专业的 TypeScript/Node.js 开发者，现在需要为 Yoho Remote 项目实现"常驻 AI 自动迭代"功能。

### 项目背景

Yoho Remote 是一个 AI 开发助手远程控制系统，包含：
- **server**: Bun + Hono 后端，PostgreSQL 数据库
- **webapp**: React 前端
- **cli**: 命令行工具

当前已有常驻 AI Advisor 系统（`server/src/agent/` 目录），能监控开发会话并产生建议，但**不能自动执行操作**。

### 需求概述

实现一个自动迭代功能，让 AI Advisor 可以在用户授权后自动执行代码操作。

**核心需求**：
1. **设置开关**：通过 Web UI 控制自动迭代开关，并在统一通知入口处理确认
2. **跨项目**：支持监控和迭代多个项目
3. **按操作分策略**：不同操作类型有不同的自动执行策略
4. **安全审计**：完整日志、回滚能力、通知机制

### 设计文档位置

完整设计文档：`/home/guang/softwares/yoho-remote/docs/design/auto-iteration-feature.md`

请先阅读该文档了解完整设计。

### 关键文件位置

**现有文件（需要修改）**：
- `server/src/store/index.ts` - 数据库 Store
- `server/src/agent/advisorService.ts` - Advisor 核心服务
- `server/src/agent/advisorPrompt.ts` - Advisor 提示词
- `server/src/web/routes/settings.ts` - 设置 API

**新增文件**：
```
server/src/agent/autoIteration/
├── index.ts            # 模块导出
├── types.ts            # 类型定义
├── config.ts           # 默认策略配置
├── policyEngine.ts     # 策略匹配引擎
├── executionEngine.ts  # 执行引擎
├── approvalFlow.ts     # 审批流程
├── auditLogger.ts      # 审计日志
└── service.ts          # AutoIterationService 核心

webapp/src/pages/AutoIterationSettings.tsx  # 设置页面
```

### 数据库表结构

需要在 `store/index.ts` 的 `initSchema()` 中新增：

```sql
-- 自动迭代配置
CREATE TABLE IF NOT EXISTS auto_iteration_config (
    namespace TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    policy_json TEXT,
    allowed_projects TEXT DEFAULT '[]',
    notification_level TEXT DEFAULT 'all',
    keep_logs_days INTEGER DEFAULT 30,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_at INTEGER DEFAULT (unixepoch() * 1000),
    updated_by TEXT
);

-- 执行日志
CREATE TABLE IF NOT EXISTS auto_iteration_logs (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    source_suggestion_id TEXT,
    source_session_id TEXT,
    project_path TEXT,
    action_type TEXT NOT NULL,
    action_detail TEXT,
    reason TEXT,
    execution_status TEXT DEFAULT 'pending',
    approval_method TEXT,
    approved_by TEXT,
    approved_at INTEGER,
    result_json TEXT,
    error_message TEXT,
    rollback_available INTEGER DEFAULT 0,
    rollback_data TEXT,
    rolled_back INTEGER DEFAULT 0,
    rolled_back_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    executed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_namespace ON auto_iteration_logs(namespace);
CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_status ON auto_iteration_logs(execution_status);
CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_created ON auto_iteration_logs(created_at);
```

### 核心类型定义

```typescript
// server/src/agent/autoIteration/types.ts

export type ActionType =
    | 'format_code' | 'fix_lint' | 'add_comments' | 'run_tests'
    | 'fix_type_errors' | 'update_deps' | 'refactor' | 'optimize'
    | 'edit_config' | 'create_file' | 'delete_file'
    | 'git_commit' | 'git_push' | 'deploy' | 'custom'

export type ExecutionPolicy =
    | 'auto_execute'          // 自动执行
    | 'notify_then_execute'   // 通知后30秒自动执行
    | 'require_confirm'       // 需要确认
    | 'always_manual'         // 永远手动
    | 'disabled'              // 禁用

export type ExecutionStatus =
    | 'pending' | 'approved' | 'executing'
    | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'

export type ApprovalMethod = 'auto' | 'manual' | 'timeout'
export type NotificationLevel = 'all' | 'errors_only' | 'none'

export interface ActionRequest {
    type: 'action_request'
    id: string
    actionType: ActionType
    targetSessionId?: string
    targetProject?: string
    steps: ActionStep[]
    reason: string
    expectedOutcome: string
    riskLevel: 'low' | 'medium' | 'high'
    reversible: boolean
    dependsOn?: string[]
    sourceSessionId?: string
    confidence: number
}

export interface ActionStep {
    type: 'command' | 'edit' | 'create' | 'delete' | 'message'
    command?: string
    filePath?: string
    oldContent?: string
    newContent?: string
    content?: string
    message?: string
    description: string
}

export interface AutoIterationConfig {
    namespace: string
    enabled: boolean
    policy: Record<ActionType, ExecutionPolicy>
    allowedProjects: string[]
    notificationLevel: NotificationLevel
    keepLogsDays: number
    updatedAt: number
    updatedBy?: string
}

export interface AutoIterationLog {
    id: string
    namespace: string
    sourceSuggestionId?: string
    sourceSessionId?: string
    projectPath?: string
    actionType: ActionType
    actionDetail: ActionStep[]
    reason?: string
    executionStatus: ExecutionStatus
    approvalMethod?: ApprovalMethod
    approvedBy?: string
    approvedAt?: number
    resultJson?: unknown
    errorMessage?: string
    rollbackAvailable: boolean
    rollbackData?: unknown
    rolledBack: boolean
    rolledBackAt?: number
    createdAt: number
    executedAt?: number
}
```

### 默认策略

```typescript
// server/src/agent/autoIteration/config.ts

export const DEFAULT_POLICY: Record<ActionType, ExecutionPolicy> = {
    // 低风险：自动执行
    format_code: 'auto_execute',
    fix_lint: 'auto_execute',
    add_comments: 'auto_execute',
    run_tests: 'auto_execute',

    // 中等风险：通知后执行
    fix_type_errors: 'notify_then_execute',
    update_deps: 'notify_then_execute',

    // 高风险：需要确认
    refactor: 'require_confirm',
    optimize: 'require_confirm',
    edit_config: 'require_confirm',
    create_file: 'require_confirm',

    // 危险操作：永远手动
    delete_file: 'always_manual',
    git_commit: 'always_manual',
    git_push: 'always_manual',
    deploy: 'always_manual',
    custom: 'require_confirm'
}
```

### Advisor Prompt 扩展

需要在 `advisorPrompt.ts` 的 `advisorInstructions` 中添加：

```typescript
### 执行请求（Action Request）- 自动迭代

当你认为有些操作可以自动执行时，使用此格式：

\`\`\`
[[HAPI_ADVISOR]]{"type":"action_request","id":"act_<timestamp>_<random>","actionType":"format_code|fix_lint|add_comments|run_tests|fix_type_errors|update_deps|refactor|optimize|edit_config|create_file|delete_file|git_commit|git_push|deploy|custom","targetProject":"目标项目路径","steps":[{"type":"command|edit|create|delete|message","command":"命令","filePath":"路径","oldContent":"原内容","newContent":"新内容","content":"内容","message":"消息","description":"描述"}],"reason":"原因","expectedOutcome":"预期结果","riskLevel":"low|medium|high","reversible":true|false,"confidence":0.0-1.0}
\`\`\`

**actionType 选择指南**：
- format_code/fix_lint/run_tests: 低风险，通常自动执行
- fix_type_errors/update_deps: 中等风险
- refactor/optimize/edit_config: 高风险，需确认
- delete_file/git_push/deploy: 危险，需手动确认

**何时使用**：发现明确问题且知道如何修复、可自动化的重复任务
**何时不用**：不确定修复正确性、需用户决策、涉及敏感数据
```

### Web API 路由

在 `settings.ts` 中新增：

```typescript
// GET /settings/auto-iteration - 获取配置
// PUT /settings/auto-iteration - 更新配置
// GET /settings/auto-iteration/logs - 获取日志
// POST /settings/auto-iteration/logs/:id/approve - 批准
// POST /settings/auto-iteration/logs/:id/reject - 拒绝
// POST /settings/auto-iteration/logs/:id/rollback - 回滚
```

### Web 端快捷操作

```
PUT  /settings/auto-iteration                 - 更新开关/策略
GET  /settings/auto-iteration/logs            - 查看日志
POST /settings/auto-iteration/logs/:id/approve - 批准
POST /settings/auto-iteration/logs/:id/reject  - 拒绝
POST /settings/auto-iteration/logs/:id/rollback - 回滚
```

### 实现顺序

按以下顺序实现：

1. **types.ts** - 类型定义
2. **Store 扩展** - 数据库表和方法
3. **config.ts** - 默认策略
4. **policyEngine.ts** - 策略匹配
5. **auditLogger.ts** - 日志记录
6. **approvalFlow.ts** - 审批流程
7. **executionEngine.ts** - 执行引擎
8. **service.ts** - 核心服务整合
9. **advisorPrompt.ts 修改** - 扩展提示词
10. **advisorService.ts 修改** - 解析 action_request
11. **settings.ts 修改** - Web API
12. **Web UI** - 设置页面与快捷操作

### 代码风格

- 使用 TypeScript 严格模式
- 遵循现有代码风格（查看 `advisorService.ts` 作为参考）
- 使用 Bun 运行时 API
- 错误处理要完善
- 添加适当的日志（使用 console.log 带 `[AutoIteration]` 前缀）

### 测试要点

实现完成后验证：
1. 数据库表正确创建
2. 配置 CRUD 正常工作
3. 审批/拒绝接口响应正确
4. Web API 返回正确数据
5. 策略匹配逻辑正确
6. 审批流程（自动/通知/确认）正常

### 开始实现

请先阅读设计文档 `/home/guang/softwares/yoho-remote/docs/design/auto-iteration-feature.md`，然后按实现顺序逐步编写代码。

每完成一个文件，说明修改点和原因。

---

## 提示词结束
