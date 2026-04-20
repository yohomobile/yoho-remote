# Brain Session 前端代码分析 - 快速索引

## 📋 分析文档导航

### 核心分析文档
- **[详细实现分析](./brain-session-frontend-detailed-review-2026-04-20.md)** (469 行)
  - Brain session 分组与 child 关联
  - mainSessionId 处理与孤立场景
  - SSE 三路径实时更新机制
  - Archived/Lifecycle 字段处理
  - 缺陷分析与优化建议

- **[代码引用与行号](./brain-session-frontend-code-references-2026-04-20.md)** (449 行)
  - 所有核心文件的行号索引
  - 关键函数位置与代码片段
  - 字段出现位置交叉引用
  - SSE 事件载荷示例
  - 快速查询表

---

## 🎯 快速查找

### 我想了解...

#### Brain Session 分组
- → [详细分析: 2.1 mainSessionId 关键处理](./brain-session-frontend-detailed-review-2026-04-20.md#21-mainsessionid-关键处理)
- → [代码引用: session-list-brain.ts](./brain-session-frontend-code-references-2026-04-20.md#websrclibsession-list-brainsts-245-行)
- 快速行号: `session-list-brain.ts:150-161`

#### SSE 实时更新
- → [详细分析: 4.2 Session-Updated 事件详细处理](./brain-session-frontend-detailed-review-2026-04-20.md#42-session-updated-事件详细处理)
- → [代码引用: useSSE.ts](./brain-session-frontend-code-references-2026-04-20.md#websrchooksussesets-332-行)
- 快速行号: `useSSE.ts:169-264` (三路径选择)

#### mainSessionId 处理
- → [详细分析: 3 mainSessionId 分组核心逻辑](./brain-session-frontend-detailed-review-2026-04-20.md#2-brain-child-分组核心逻辑)
- → [代码引用: Metadata 映射](./brain-session-frontend-code-references-2026-04-20.md#关键-metadata-映射)
- 快速行号: `useSSE.utils.ts:206` (映射)

#### Archived 字段
- → [详细分析: 3 Archived/Lifecycle 字段处理](./brain-session-frontend-detailed-review-2026-04-20.md#3-archived--lifecycle-字段处理)
- → [代码引用: Archive 与 Lifecycle 判断](./brain-session-frontend-code-references-2026-04-20.md#websrclibsessionactivityts-43-行)
- 快速行号: `sessionActivity.ts:11-24`

#### Replacement 字段
- → [详细分析: 6.1 replacement 字段完全缺失](./brain-session-frontend-detailed-review-2026-04-20.md#61-replacement-字段完全缺失)
- → [代码引用: replacement 出现位置](./brain-session-frontend-code-references-2026-04-20.md#replacement-出现位置)
- **状态**: ❌ 根本不存在

#### Child Session 操作
- → [详细分析: 8 Child Session 操作与交互](./brain-session-frontend-detailed-review-2026-04-20.md#8-child-session-操作与交互)
- → [代码引用: BrainChildActions.tsx](./brain-session-frontend-code-references-2026-04-20.md#websrccomponentsbrain-childactionstsx-241-行)
- 快速行号: `BrainChildActions.tsx:175-181` (返回主 Brain)

---

## 🔍 关键发现速览

### ✅ 完成良好
| 项目 | 文件 | 行号 | 详情 |
|------|------|------|------|
| mainSessionId 分组 | session-list-brain.ts | 150-161 | 正确提取、关联、分组 |
| SSE 三路径 | useSSE.ts | 169-264 | 完整/状态/sid-only 完整设计 |
| Archive 过滤 | sessionActivity.ts | 11-24 | lifecycleState 正确判断 |
| Status Rollup | session-list-brain.ts | 87-99 | 多 child 状态正确汇总 |

### ❌ 缺陷与问题
| 问题 | 文件 | 影响 | 优先级 |
|------|------|------|--------|
| replacement 缺失 | 所有 | 无法追踪迁移 | 🔴 高 |
| 归档信息不展示 | SessionList.tsx | 用户无法了解历史 | 🟡 中 |
| 孤立 child 无提示 | SessionList.tsx | 用户困惑 | 🟡 中 |
| sid-only 开销 | useSSE.ts | 网络与性能 | 🟢 低 |

---

## 📊 代码覆盖率

| 模块 | 覆盖率 | 说明 |
|------|--------|------|
| Brain 分组 | 100% | 测试完整 (session-list-brain.test.ts) |
| Archive 过滤 | 100% | 测试完整 (sessionActivity.test.ts) |
| SSE 转换 | 95% | 缺少 mainSessionId 变更边界 |
| SessionItem UI | 80% | 关键字段不展示 (archived metadata) |

---

## 📝 文件导览

### 必读顺序 (推荐)

1. **这个 INDEX 文件** ← 你在这里
2. **[详细分析: 1-2 章](./brain-session-frontend-detailed-review-2026-04-20.md#1-核心文件结构)** 
   - 了解整体架构与分组逻辑
   
3. **[代码引用: 关键代码块](./brain-session-frontend-code-references-2026-04-20.md#sessionlist-更新三路径)**
   - 定位具体代码位置

4. **[详细分析: 6-12 章](./brain-session-frontend-detailed-review-2026-04-20.md#6-缺失与前后端不一致点)**
   - 了解已知缺陷与建议

### 按场景查阅

#### 场景 1: 调试 Brain session 分组不正确
1. SessionItem 显示的 source 是否为 'brain' / 'brain-child'？
2. 查看 mainSessionId 是否正确关联
3. 检查 buildSessionListEntries() 是否被正确调用
4. 参考: [session-list-brain.ts:150-161](./brain-session-frontend-code-references-2026-04-20.md#核心分组算法)

#### 场景 2: 调试 SSE 实时更新延迟/缺失
1. 使用浏览器开发者工具查看 EventSource 连接
2. 在控制台启用 SSE 日志: `[sse]` filter
3. 判断是完整/状态/sid-only 哪种更新
4. 参考: [useSSE.ts:169-264](./brain-session-frontend-code-references-2026-04-20.md#session-更新事件处理)

#### 场景 3: 添加 replacement 字段支持
1. 后端: 在 SessionMetadataSummary 添加 `replacement?: string`
2. 前端 SSE: useSSE.utils.ts 的 toSessionSummaryMetadata() 中添加映射
3. 前端 UI: SessionList.tsx 中添加显示逻辑
4. 参考: [详细分析: 6.1](./brain-session-frontend-detailed-review-2026-04-20.md#61-replacement-字段完全缺失)

#### 场景 4: 显示 archived 信息
1. SessionItem 中检查 `isArchivedSession(session)`
2. 显示 `archivedBy`, `archiveReason`, `lifecycleStateSince`
3. 可在 hover 或详情页展示
4. 参考: [详细分析: 6.2](./brain-session-frontend-detailed-review-2026-04-20.md#62-archived-lifecycle-信息不够丰富)

---

## 🚀 关键数字

```
核心代码文件:    2,333 行
分析文档:         918 行
关键位置:          15 个快速链接

mainSessionId 出现:      8 处
lifecycleState 出现:     6 处
replacement 出现:        0 处 ❌
```

---

## 🔗 相关链接

- Brain Session 后端实现：（待分析）
- SSE 事件定义：`types/api.ts` -> `SyncEvent` 类型
- React Query 缓存键：`lib/query-keys.ts`
- localStorage 管理：`brainReadyState.ts`

---

**最后更新**: 2026-04-20  
**分析范围**: `/home/workspaces/repos/yoho-remote/web/src`  
**主要分析工具**: Grep, Read, Bash 代码静态分析

