# Brain Session 前端实现详细分析

## 执行日期
2026-04-20

## 概览
本文档详细分析 yoho-remote web 端对 Brain session 的前端实现，重点关注：
1. Session 列表展示与分组逻辑
2. child group / brain-child session 分组
3. SSE 事件处理与实时更新
4. 后端字段读取和展示
5. 状态更新与缓存管理

---

## 1. 核心文件结构

### 1.1 主要文件清单

| 文件路径 | 功能 |
|---------|------|
| **SessionList.tsx** | Session 列表主组件，负责列表展示、分组、过滤 |
| **session-list-brain.ts** | Brain session 分组逻辑，mainSessionId 处理 |
| **useSSE.ts** | SSE 事件处理，实时更新缓存 |
| **useSSE.utils.ts** | SSE 载荷转换，metadata 字段映射 |
| **sessionActivity.ts** | Session 活跃状态判断，archived 字段处理 |
| **brainReadyState.ts** | Brain session 初始化状态追踪 |
| **NewBrainSession.tsx** | Brain session 创建表单 |
| **BrainChildActions.tsx** | Brain child session 操作栏 |
| **types/api.ts** | API 类型定义 |

### 1.2 关键数据流

SessionList → buildSessionListEntries() → [Brain Parent + Children 分组]
                                        → [按 mainSessionId 分配 child]
                                        → [计算 statusSummary 汇总]
                                        → SessionItem 展示

---

## 2. Brain Child 分组核心逻辑

### 2.1 mainSessionId 关键处理

**文件**: `session-list-brain.ts:150-161`

分组的核心是 `metadata.mainSessionId`：

```ts
const childrenByParent = new Map<string, SessionSummary[]>()
visibleSessions.forEach(session => {
    if (!isBrainChildSession(session)) return
    const parentId = session.metadata?.mainSessionId  // ← 关键字段！
    if (!parentId || !visibleBrainParents.has(parentId)) return
    const bucket = childrenByParent.get(parentId)
    if (bucket) {
        bucket.push(session)
        return
    }
    childrenByParent.set(parentId, [session])
})
```

**重要规则**:
- Child 只有当 parent 在 visibleBrainParents 中才会被分组
- 孤立的 child（parent 不存在或被过滤）保留为顶级项
- mainSessionId 为 null 或空的 child 被忽略

### 2.2 状态汇总 (statusSummary)

```ts
function buildBrainGroupStatusSummary(
    session: SessionSummary,
    children: SessionSummary[]
): BrainGroupStatusSummary {
    const allSessions = [session, ...children]
    return {
        active: allSessions.some(item => item.active),           // 任一 active = true
        thinking: pendingRequestsCount === 0 && allSessions.some(item => item.thinking),
        pendingRequestsCount: 累加所有 item 的 pendingRequestsCount,
        timestamp: 所有 item 的最新 lastMessageAt/updatedAt
    }
}
```

**UI 使用**:
- `statusSummary.active` → 指示灯颜色（绿/灰）
- `statusSummary.thinking` → 脉冲蓝灯
- `statusSummary.pendingRequestsCount` → 橙灯 + 数字
- `statusSummary.timestamp` → 右侧时间显示

---

## 3. Archived / Lifecycle 字段处理

### 3.1 字段定义与读取

**API 类型** (`types/api.ts:40-43, 143-146`):
```ts
lifecycleState?: string
lifecycleStateSince?: number
archivedBy?: string
archiveReason?: string
```

### 3.2 Archive 过滤逻辑

**文件**: `sessionActivity.ts:11-24`

```ts
export function isArchivedSession(session: SessionWithArchiveState): boolean {
    return session.metadata?.lifecycleState === 'archived'  // ← 关键字段
}

export function matchesArchiveFilter(
    session: SessionWithArchiveState,
    archiveFilter: ArchiveFilter
): boolean {
    const archived = isArchivedSession(session)
    if (archiveFilter === 'archive') {
        return archived || !session.active  // 已归档 OR 不活跃
    }
    return !archived && session.active      // 未归档 AND 活跃
}
```

**当前情况**:
- ✅ `lifecycleState` 被读取用于过滤
- ✅ `archivedBy`, `archiveReason` 被 SSE 处理程序写入但前端**不展示**
- ❌ 没有 UI 展示 archived 的时间、人、原因

### 3.3 replacement 字段

**状态**: ❌ **根本缺失**

- 后端 API 类型定义中不存在 `replacement` 字段
- 前端无法读取或展示
- Session 迁移/重启后无法追踪新旧 ID 关系

---

## 4. SSE 事件处理与缓存更新

### 4.1 三种更新路径

#### Path A: 完整会话更新 (isFullSessionPayload)

```ts
if (event.type === 'session-updated' && isFullSessionUpdate) {
    const nextSession = toSessionFromSsePayload(rawData)
    const nextSummary = toSessionSummaryFromSsePayload(rawData)
    
    // 立即更新缓存
    queryClient.setQueryData(queryKeys.session(sid), { session: nextSession })
    queryClient.setQueriesData(queryKeys.sessions, prev => upsertSessionSummary(prev, nextSummary))
    
    // 后台刷新衍生字段
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
}
```

**metadata 映射** (useSSE.utils.ts:197-236):
- ✅ `mainSessionId` 通过 `getBrainChildMainSessionId()` 提取
- ✅ `lifecycleState`, `archivedBy`, `archiveReason` 被条件映射
- ❌ `replacement` 无处理（因为不存在）

#### Path B: 状态部分更新 (hasStatusUpdate)

```ts
if (event.type === 'session-updated' && hasStatusUpdate) {
    // 更新支持的字段
    active, thinking, lastMessageAt, modelMode, fastMode, 
    terminationReason, activeMonitors, ...
    
    // 更新 session 详情和列表缓存
    // 快速，不触发重新分组
}
```

**重要限制**: 
- ❌ 不包含 `mainSessionId` (metadata 字段)
- ❌ 不包含 `lifecycleState` / `archivedBy` (metadata 字段)
- 原因: metadata 变更需要完整数据才能正确重新分组

#### Path C: 仅 sessionId 更新 (isSidOnlyUpdate)

```ts
if (event.type === 'session-updated' && isSidOnlyUpdate) {
    // rawData = { sid: string } 只有 sessionId 没有具体数据
    
    // 完整失效，触发网络请求
    invalidateQueries(queryKeys.sessions)
    invalidateQueries(queryKeys.session(sid))
}
```

**设计意图**: 
- 当只有 sessionId 时无法增量更新
- 触发完整重新获取确保 mainSessionId/lifecycleState 等变更不遗漏

### 4.2 实时更新流程

```
SSE session-updated event
  ↓
检测载荷类型（完整/状态/sid-only）
  ↓
[完整] toSessionSummaryFromSsePayload() 
       → 映射 mainSessionId, lifecycleState 等
       → 立即更新列表，触发重新分组
  ↓
[状态] applySessionSummaryStatusUpdate()
       → 更新 active/thinking/modelMode 等
       → 快速，无重新分组
  ↓
[sid-only] invalidateQueries()
          → 触发网络请求重新获取完整数据
```

---

## 5. SessionItem UI 展示

### 5.1 关键字段展示位置

| 字段 | 来源 | 展示位置 |
|------|------|---------|
| `name` / `summary.text` / path | metadata | 主标题 |
| `source` (brain/brain-child) | metadata.source | 🧠 标签 |
| `active` | statusSummary.active 或 session.active | 指示灯（绿/灰） |
| `thinking` | statusSummary.thinking 或 session.thinking | 脉冲蓝灯 |
| `pendingRequestsCount` | statusSummary.pendingRequestsCount | 橙灯 + 数字 |
| `mainSessionId` | metadata.mainSessionId | **不显示**（仅用于分组） |
| `lifecycleState` | metadata.lifecycleState | **不显示**（仅用于过滤） |
| `archivedBy` | metadata.archivedBy | **不显示** |
| `archiveReason` | metadata.archiveReason | **不显示** |
| `createdBy` | session.createdBy | 副标题 "share by @..." |

### 5.2 缺失的展示

- ❌ Archived 时间（lifecycleStateSince）
- ❌ 归档人（archivedBy）
- ❌ 归档原因（archiveReason）
- ❌ Replacement 指向

---

## 6. Brain Child Session 交互

### 6.1 BrainChildPageActionBar

**文件**: BrainChildActions.tsx:128-211

```tsx
<ActionButton
    disabled={!props.mainSessionId}
    onClick={() => {
        if (!props.mainSessionId) return
        void navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: props.mainSessionId }
        })
    }}
>
    返回主 Brain
</ActionButton>
```

**依赖**:
- `session.metadata.mainSessionId` 来自 parent brain session id
- 若 mainSessionId 为 null，按钮禁用（但无错误提示）

### 6.2 可停止/可恢复判断

```ts
canStop: session.active && session.thinking,
canResume: !session.active,
```

---

## 7. SSE Utils 中的 mainSessionId 处理

### 7.1 提取函数

**文件**: useSSE.utils.ts:8-13

```ts
function getBrainChildMainSessionId(metadata: Session['metadata']): string | undefined {
    if (!metadata || metadata.source !== 'brain-child' || typeof metadata.mainSessionId !== 'string') {
        return undefined
    }
    return metadata.mainSessionId
}
```

**特点**:
- 仅对 `source === 'brain-child'` 的 session 提取
- 返回 undefined 时，条件映射会跳过该字段
- SessionSummary metadata 中的 mainSessionId 保证正确

### 7.2 完整更新时的 mainSessionId 映射

**文件**: useSSE.utils.ts:197-236

```ts
function toSessionSummaryMetadata(
    metadata: Session['metadata']
): SessionSummary['metadata'] {
    return {
        ...(getBrainChildMainSessionId(metadata) !== undefined && { 
            mainSessionId: getBrainChildMainSessionId(metadata) 
        }),
        ...,
    }
}
```

**设计**:
- 条件映射确保 mainSessionId 只在确实存在时才被包含
- SessionSummary 中的 mainSessionId 与 Session 中的值一致

---

## 8. 过滤与所有权管理

### 8.1 所有权过滤

**文件**: SessionList.tsx:42-64

```ts
const isBrainSession = session.metadata?.source === 'brain' || session.metadata?.source === 'brain-child'
if (ownerFilter === 'mine') {
    if (session.ownerEmail) return false
    if (isBrainSession) return false
} else if (ownerFilter === 'brain') {
    if (!isBrainSession) return false
}
```

**三种模式**:
- `'mine'`: ownerEmail 为空 + 非 Brain session
- `'brain'`: source === 'brain' 或 'brain-child'
- `'others'`: ownerEmail 非空

---

## 9. 关键问题与缺陷

### 9.1 mainSessionId 孤立时的处理

**当前**: 孤立 child 作为顶级项展示，但无任何提示

```tsx
// SessionList 中显示孤立 child，但：
// - "返回主 Brain" 按钮禁用
// - 无警告信息
// - 用户无法知道为何无法导航
```

**建议**: 
```tsx
{session.metadata?.source === 'brain-child' && 
 session.metadata?.mainSessionId && 
 !parentFound && (
    <span className="text-red-600">⚠️ 主 Brain 缺失</span>
)}
```

### 9.2 Archived 信息不展示

**问题**: metadata 中有 `lifecycleStateSince`, `archivedBy`, `archiveReason` 但完全不显示

**建议**:
```tsx
{isArchivedSession(session) && (
    <div className="text-[11px] text-slate-500">
        Archived by {session.metadata?.archivedBy} 
        on {new Date(session.metadata?.lifecycleStateSince).toLocaleDateString()}
        {session.metadata?.archiveReason && ` · ${session.metadata.archiveReason}`}
    </div>
)}
```

### 9.3 replacement 字段完全缺失

**现状**: 
- ❌ 后端 API 类型定义不包含该字段
- ❌ 无法读取、无法传输、无法展示

**影响**: Brain session 重启后无法追踪新旧 ID 映射

---

## 10. 性能与优化

### 10.1 localStorage marker 过期管理

**文件**: brainReadyState.ts

```ts
const STORAGE_KEY = 'yr:brainReadyMarkers'

// 缺失：清理过期 marker 的逻辑
// 长期运行会累积大量历史 marker
```

**建议**: 定期清理超过 7 天的 marker

### 10.2 多个 child 时的重新分组性能

**当前**: 每次 session-updated 都可能触发 buildSessionListEntries()，大量 child 时会重排

**优化点**:
- 使用稳定的 key （session.id） 减少重排
- 考虑虚拟滚动（如果 child 数量超过 100）

### 10.3 sid-only 更新的网络开销

**问题**: sid-only 更新导致完整 invalidateQueries，可能连续多个请求

**优化**: SSE 载荷中包含 `updatedFields` 字段，前端判断是否需要重新获取

---

## 11. 测试覆盖率

### 11.1 已覆盖

- ✅ Brain 分组与状态汇总（session-list-brain.test.ts）
- ✅ Archive 过滤（sessionActivity.test.ts）
- ✅ SSE 载荷转换（useSSE.utils.test.ts）

### 11.2 缺失

- ❌ mainSessionId 变更时的重新分组
- ❌ Parent archived 时 child 的行为
- ❌ 孤立 child 的边界处理
- ❌ replacement 字段的处理（待实现）

---

## 12. 总结

### 现状评估

✅ **完成良好**:
1. Brain session 与 child 的分组逻辑正确
2. SSE 三路径更新设计合理
3. Archive/lifecycle 过滤功能有效
4. mainSessionId 的提取和映射完整

⚠️ **不足**:
1. `replacement` 字段根本缺失（后端未提供）
2. Archived 元数据未展示
3. mainSessionId 孤立时缺少提示
4. localStorage marker 缺乏过期清理

❌ **潜在问题**:
1. 大量 child 时列表重排性能
2. sid-only 更新导致不必要网络请求
3. 无法追踪 session 迁移/重启前后关系

### 优先级建议

1. **立即**: 后端提供 `replacement` 字段
2. **近期**: 显示归档信息、孤立提示
3. **长期**: SSE 载荷优化、性能监控

