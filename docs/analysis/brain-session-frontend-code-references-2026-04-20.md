# Brain Session 前端代码引用与关键行号

## 文件索引

### web/src/components/SessionList.tsx (724 行)

#### 关键函数与行号

| 函数名 | 行号 | 功能 |
|-------|------|------|
| `filterSessions` | 42-64 | 按 archive/owner filter 过滤 session |
| `getSourceTag` | 114-134 | 返回 source 标签（🧠 Brain/子任务） |
| `SessionItem` 组件 | 236-460 | 单个 session 项的 UI |
| `getBrainSelfLabel` | 156-181 | Brain self system 状态标签 |
| `loadExpandedBrainSessionIds` | 21-31 | 从 localStorage 加载展开状态 |
| `saveExpandedBrainSessionIds` | 33-39 | 保存到 localStorage |
| `SessionList` 主组件 | 462-723 | 完整列表组件 |
| 过滤和分组 | 507-523 | buildSessionListEntries + expandedIds |
| 过滤按钮逻辑 | 569-639 | Archive/Owner 过滤 UI |
| 列表项渲染 | 652-719 | 列表项及 child session 渲染 |

#### 关键变量

```tsx
line 14: import { buildSessionListEntries, getCollapsedBrainChildCount } from '@/lib/session-list-brain'
line 19: const EXPANDED_BRAIN_SESSION_IDS_STORAGE_KEY = 'yr:expandedBrainSessionIds'
line 52: const isBrainSession = session.metadata?.source === 'brain' || session.metadata?.source === 'brain-child'
line 121-125: source === 'brain' ? '🧠 Brain' : source === 'brain-child' ? '🧠 子任务'
line 156-181: getBrainSelfLabel() - self system 状态
line 264: const isBrainSession = s.metadata?.source === 'brain'
line 271-272: statusSummary 来源（来自 entry.statusSummary 或 session 直接属性）
line 337-340: childCount 和"子任务"标签
line 408-421: 展开/收起 brain children 按钮
line 684: childCount={entry.children.length}
line 687: statusSummary={entry.statusSummary}
line 689-715: 展开时的 child 渲染
```

---

### web/src/lib/session-list-brain.ts (245 行)

#### 核心分组算法

| 行号 | 内容 | 说明 |
|-----|------|------|
| 37-43 | `isBrainSession(session)` / `isBrainChildSession(session)` | 源类型判断 |
| 87-99 | `buildBrainGroupStatusSummary(session, children)` | 状态汇总 |
| 143-161 | 分组逻辑 - 识别 parent 和 children | **mainSessionId 关键部分** |
| 150-161 | child 关联 parent 的核心代码 | `metadata?.mainSessionId` 提取 |
| 164-192 | 构建最终 entries 列表 | 分组、排序、状态计算 |
| 234-244 | `getCollapsedBrainChildCount()` | 统计收起的 child 数 |

#### 关键代码片段

```ts
line 41: function isBrainChildSession(session: SessionSummary): boolean {
             return session.metadata?.source === 'brain-child'
         }

line 153: const parentId = session.metadata?.mainSessionId  // ← 关键字段

line 154: if (!parentId || !visibleBrainParents.has(parentId)) return

line 177-188: 构建 brain-group entry（包含 children 和 statusSummary）

line 94: active: allSessions.some(item => item.active)
line 95: thinking: pendingRequestsCount === 0 && allSessions.some(item => item.thinking)
```

---

### web/src/lib/sessionActivity.ts (43 行)

#### Archive 与 Lifecycle 判断

| 行号 | 函数 | 逻辑 |
|-----|------|------|
| 11-13 | `isArchivedSession()` | 检查 `lifecycleState === 'archived'` |
| 15-24 | `matchesArchiveFilter()` | active/archive 过滤逻辑 |
| 34-42 | `isIdleBrainChildSession()` | brain-child 空闲判断 |

#### 关键代码

```ts
line 12: return session.metadata?.lifecycleState === 'archived'

line 19-23: if (archiveFilter === 'archive') {
               return archived || !session.active
            }
            return !archived && session.active

line 38-41: return isBrainChildSession(session)
            && session.active
            && session.pendingRequestsCount === 0
            && !isThinking
```

---

### web/src/hooks/useSSE.ts (332 行)

#### Session 更新事件处理

| 行号范围 | 事件类型 | 处理方式 |
|---------|--------|--------|
| 118-128 | message-received | 消息插入 |
| 130-134 | messages-cleared | 消息清空 |
| 136-271 | session-added/updated/removed | **主要逻辑** |
| 145-168 | session-added | 新增 session |
| 169-264 | session-updated | 更新 session（三路径） |
| 274-276 | machine-updated | 机器更新 |
| 278-280 | file-ready | 文件就绪 |

#### 关键代码块

**Session-Updated 三路径**:
```ts
line 169-264:
  if (event.type === 'session-updated') {
    const isFullSessionUpdate = isFullSessionPayload(rawData, event.sessionId)
    const hasStatusUpdate = hasSessionStatusFields(statusData)
    const isSidOnlyUpdate = isSidOnlySessionRefreshHint(rawData)
    
    if (isFullSessionUpdate) { ... 路径 A}          // 193-215
    else if (hasStatusUpdate && statusData) { ... 路径 B}  // 215-248
    else if (isSidOnlyUpdate) { ... 路径 C}         // 249-255
  }
```

**路径 A 完整更新**:
```ts
line 193-215:
  const nextSession = toSessionFromSsePayload(rawData)
  const nextSummary = toSessionSummaryFromSsePayload(rawData)
  queryClient.setQueryData(...)
  queryClient.setQueriesData(...)
  void queryClient.invalidateQueries(...)  // 后台刷新
```

**路径 B 状态更新**:
```ts
line 220-240: 更新 session 详情缓存
line 243-248: 更新 sessions 列表缓存
```

**路径 C sid-only 更新**:
```ts
line 252-255:
  invalidateSessionCachesForSidOnlyUpdate(queryClient, event.sessionId)
```

---

### web/src/hooks/useSSE.utils.ts (349 行)

#### 数据转换与 Metadata 映射

| 行号范围 | 函数 | 功能 |
|---------|------|------|
| 8-13 | `getBrainChildMainSessionId()` | 提取 mainSessionId |
| 87-99 | `buildBrainGroupStatusSummary()` | 状态汇总 |
| 172-195 | `toSessionFromSsePayload()` | 完整 Session 转换 |
| 197-236 | `toSessionSummaryMetadata()` | **Metadata 映射** |
| 238-270 | `toSessionSummaryFromSsePayload()` | SessionSummary 转换 |
| 272-298 | `upsertSessionSummary()` | 插入或更新列表项 |
| 300-348 | `applySessionSummaryStatusUpdate()` | 状态部分更新 |

#### 关键 Metadata 映射

```ts
line 206: ...(getBrainChildMainSessionId(metadata) !== undefined && { mainSessionId: ... })

line 215: ...(typeof metadata.source === 'string' && { source: metadata.source })

line 216-219: // lifecycleState 映射
  ...(typeof metadata.lifecycleState === 'string' && { lifecycleState: metadata.lifecycleState })
  ...(typeof metadata.lifecycleStateSince === 'number' && { lifecycleStateSince: metadata.lifecycleStateSince })
  ...(typeof metadata.archivedBy === 'string' && { archivedBy: metadata.archivedBy })
  ...(typeof metadata.archiveReason === 'string' && { archiveReason: metadata.archiveReason })

// 注意：replacement 字段不存在
```

#### 状态更新支持字段

```ts
line 300-323: applySessionSummaryStatusUpdate() 支持的字段
  active, activeAt, lastMessageAt, thinking, modelMode, 
  modelReasoningEffort, fastMode, activeMonitorCount, terminationReason
  
  不支持: mainSessionId, lifecycleState, archivedBy, archiveReason
```

---

### web/src/components/BrainChildActions.tsx (241 行)

#### Brain Child 页面操作栏

| 行号 | 功能 |
|-----|------|
| 24-76 | `useTailDialog()` hook - 最近片段加载 |
| 128-211 | `BrainChildPageActionBar` - 操作栏组件 |
| 175-181 | "返回主 Brain" 按钮 - 导航到 mainSessionId |
| 189-196 | "停止当前任务" 按钮 - canStop 控制 |
| 197-204 | "恢复 session" 按钮 - canResume 控制 |

#### 关键代码

```ts
line 131: mainSessionId: string | null  // ← 来自 props

line 176-181:
  disabled={!props.mainSessionId}
  onClick={() => {
    if (!props.mainSessionId) return
    navigate({ to: '/sessions/$sessionId', params: { sessionId: props.mainSessionId } })
  }}

line 209: canStop: session.active && session.thinking
line 210: canResume: !session.active
```

---

### web/src/lib/brainChildActions.ts (247 行)

#### Brain Child 状态推导

| 行号 | 函数 | 用途 |
|-----|------|------|
| 200-212 | `deriveBrainChildPageActionState()` | 推导按钮状态 |
| 12-28 | `getBrainChildPageInactiveHint()` | 非运行时提示 |
| 214-246 | `extractBrainChildTailPreview()` | 提取最近片段 |

#### 关键代码

```ts
line 203-205:
  const mainSessionId = typeof session.metadata?.mainSessionId === 'string' && session.metadata.mainSessionId.trim().length > 0
    ? session.metadata.mainSessionId
    : null
```

---

### web/src/lib/brainReadyState.ts (152 行)

#### Brain 初始化状态追踪

| 行号 | 函数 | 用途 |
|-----|------|------|
| 3-4 | 常量定义 | storage key 和 init prompt prefix |
| 65-73 | `markBrainSessionPendingReady()` | 标记新建 brain |
| 96-112 | `deriveBrainCreationReadyPhase()` | 推导就绪阶段 |

#### 使用场景

```ts
// 创建时
line 254 (NewBrainSession.tsx):
  markBrainSessionPendingReady(result.sessionId)

// 状态推导
line 102: if (args.source !== 'brain' || !args.marker) return null
line 105: if (!args.active) return 'created'
line 107: if (args.thinking) return 'initializing'
line 111: return 'ready'
```

---

### web/src/types/api.ts

#### SessionMetadataSummary 定义

```ts
line 123-147:
  export type SessionSummaryMetadata = {
    mainSessionId?: string                    // ← Child 关键字段
    source?: string                           // brain / brain-child
    lifecycleState?: string                   // archived
    lifecycleStateSince?: number
    archivedBy?: string
    archiveReason?: string
    
    // self system 字段
    selfSystemEnabled?: boolean
    selfProfileId?: string
    selfProfileName?: string
    selfProfileResolved?: boolean
    selfMemoryProvider?: 'yoho-memory' | 'none'
    selfMemoryAttached?: boolean
    selfMemoryStatus?: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error'
  }
```

**注意**: 
- ✅ `mainSessionId` 存在
- ✅ `lifecycleState`, `archivedBy`, `archiveReason` 存在
- ❌ `replacement` **不存在**

---

## SSE 事件载荷示例

### Session-Updated (完整更新)

```json
{
  "type": "session-updated",
  "sessionId": "abc123",
  "data": {
    "id": "abc123",
    "createdAt": 1713607200000,
    "updatedAt": 1713607300000,
    "active": true,
    "thinking": false,
    "metadata": {
      "source": "brain",
      "mainSessionId": null,
      "lifecycleState": null,
      "archivedBy": null,
      "archiveReason": null,
      "path": "/tmp/brain-1",
      "name": "Brain Session",
      "summary": { "text": "Working on task" }
    },
    "agentState": { "requests": {} }
  }
}
```

### Session-Updated (状态更新)

```json
{
  "type": "session-updated",
  "sessionId": "child456",
  "data": {
    "active": false,
    "thinking": false,
    "lastMessageAt": 1713607400000
  }
}
```

### Session-Updated (Metadata 更新)

```json
{
  "type": "session-updated",
  "sessionId": "brain789",
  "data": {
    "sid": "brain789"
  }
}
```

---

## 调试工具与日志

### 开发环境日志

**文件**: useSSE.ts:114-191

```ts
if (import.meta.env.DEV) {
  console.log('[sse] event', event.type, sessionId)
  console.log('[sse] session-updated event', {
    sessionId,
    hasData,
    isFullSessionUpdate,
    isSidOnlyUpdate,
    modelMode: statusData?.modelMode,
    ...
  })
}
```

### 启用方式

```bash
# 浏览器控制台查看 SSE 事件流
# Filter: [sse]
```

---

## 关键字段交叉引用

### mainSessionId 出现位置

| 文件 | 行号 | 上下文 |
|------|------|-------|
| session-list-brain.ts | 153 | 分组时提取 |
| sessionActivity.ts | - | （不使用） |
| useSSE.utils.ts | 8-13 | 提取函数 |
| useSSE.utils.ts | 206 | Metadata 映射 |
| BrainChildActions.tsx | 131 | props 接收 |
| brainChildActions.ts | 203-205 | 提取并清理 |
| types/api.ts | 25, 127 | 类型定义 |

### lifecycleState 出现位置

| 文件 | 行号 | 用途 |
|------|------|------|
| sessionActivity.ts | 12 | 判断 archived |
| useSSE.utils.ts | 216 | Metadata 映射 |
| session-list-brain.ts | - | （不直接使用） |
| SessionList.tsx | - | 通过 filter 间接使用 |
| types/api.ts | 40, 143 | 类型定义 |

### replacement 出现位置

| 文件 | 行号 | 状态 |
|------|------|------|
| 所有文件 | - | ❌ **根本不存在** |

---

## 总结

### 代码行数统计

```
SessionList.tsx:           724 行
session-list-brain.ts:     245 行
useSSE.ts:                 332 行
useSSE.utils.ts:           349 行
BrainChildActions.tsx:     241 行
brainChildActions.ts:      247 行
brainReadyState.ts:        152 行
sessionActivity.ts:         43 行
types/api.ts:            ~500 行（完整文件）
───────────────────────────────────
总计（核心文件）:        2,333 行
```

### 最重要的 5 个代码位置

1. **session-list-brain.ts:153** - mainSessionId 分组核心
2. **useSSE.ts:169-264** - SSE 三路径更新处理
3. **useSSE.utils.ts:206** - mainSessionId metadata 映射
4. **sessionActivity.ts:12** - lifecycleState archived 判断
5. **SessionList.tsx:52** - Brain session 类型判断

