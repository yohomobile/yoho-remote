# K1 Phase 3 · Actor-Aware Brain 实施进度

> 最后更新：2026-04-24（Batch 3 D/C/F 后端完成）

## 总览：6 个子能力 A–F 状态

| 子能力 | 含义 | 后端 | 前端 | 状态 |
| --- | --- | --- | --- | --- |
| **A · Identity Graph** | 多渠道 actor 归并到 Person；candidate / merge / unmerge / detach / audit | ✅ 完整 | ⚠️ 仅 Candidate Review（Phase 2 遗留待补：Persons + Audit + Drawer + 消息气泡 Popover + 会话参与者，见独立 plan） | 主线可用 |
| **B · Team Memory 审批** | 团队共享知识候选 → 审批 → memoryRef | ✅ 完整 | ✅ `/self-system` 新增 TeamMemoryReviewPanel | 完成 |
| **C · Conflict Scan** | 同一 person/identity 的冲突记忆检测 | ✅ pg-boss worker `'17 * * * *'` cron | — | **Batch 3 完成** |
| **D · Eval 回归** | 离线评估脚本/CLI | ✅ MVP + 历史对比 + JSON 报告 + CI hook（mock runner，真实 Brain 接入留待后续） | — | **Batch 3 完成** |
| **E · Session Affect** | 会话级 concise/detailed/default 模式切换 | ✅ backend + BrainBridge 注入 + HTTP endpoint | ❌ UI 被主动裁剪（见下文裁剪理由） | 完成（UI 主动不做） |
| **F · Observation → Plan 自动晋升** | 观察假设确认后自动落 communicationPlan | ✅ confirm 自动 upsert plan + `autoPromoted` 响应 | ✅ ObservationReviewPanel（仍允许手填 planId，自动结果通过 toast 展示） | **Batch 3 完成** |

---

## Batch 1：Session Affect 后端（已完成）

### 后端改动

- `server/src/brain/sessionAffect.ts`：`buildSessionAffect` / `resolveSessionAffectContext` / `extractSessionAffectFromMetadata` / `appendSessionAffectPrompt`
- `server/src/im/BrainBridge.ts`：在 session 初始化阶段 resolve → inject prompt → `syncEngine.patchSessionMetadata` 写回
- `server/src/web/routes/session-affect.ts`：`GET / PUT / DELETE /api/sessions/:id/affect`
  - 权限：operator bypass / session org member / session creator
  - Zod 校验 mode + source + note + ttlMs(<= MAX_TTL_MS)
- `server/src/web/routes/session-affect.test.ts`：**11/11 通过**（未授权 / 404 / 403 / GET none / PUT concise / PUT invalid / PUT default status / DELETE / operator bypass / TTL 过期 / creator access）
- `server/src/web/server.ts`：挂载 `createSessionAffectRoutes`

### 为什么主动不做 UI 切换器

| 质疑维度 | 结论 |
| --- | --- |
| 用户能否用更便宜的方式达到同样效果？ | 能。直接说"简短点"即可，无需 UI toggle。 |
| 和已有能力是否重叠？ | 重叠。`communicationPlan` 已承担长期风格偏好；短期诉求由当前轮次消息覆盖。 |
| 硬边界是否削弱价值？ | 是。Phase 3 的 hard boundary 决定了 mode 只能 hint，不能强制切换人格；ROI 低。 |
| 驱动力是 need 还是 design？ | Design-driven。缺乏用户明确诉求；先留 backend 骨架，不做 UI。 |

**结论**：保留 backend/HTTP 能力（任何客户端可直接 PUT），UI toggle 不做。

---

## Batch 2：Identity / TeamMemory / Observation 管理 UI（已完成）

### 前端改动

- `web/src/lib/query-keys.ts`：新增 `teamMemoryCandidates` / `teamMemoryCandidateAudits` / `observationCandidates` / `observationCandidateAudits`
- `web/src/types/api.ts`：新增
  - `StoredTeamMemoryCandidate` / `StoredTeamMemoryAudit` / `TeamMemoryCandidateStatus` / `TeamMemoryCandidateDecision`（discriminated union：approve/reject/supersede/expire，approve/supersede 可附 `memoryRef`）
  - `StoredObservationCandidate` / `StoredObservationAudit` / `ObservationCandidateStatus` / `ObservationSignal` / `ObservationDecision`（confirm 可附 `promotedCommunicationPlanId`）
- `web/src/api/client.ts`：新增 10 个方法
  - TeamMemory：`getTeamMemoryCandidates / getTeamMemoryCandidate / proposeTeamMemoryCandidate / decideTeamMemoryCandidate / getTeamMemoryCandidateAudits`
  - Observation：`getObservationCandidates / getObservationCandidate / decideObservationCandidate / getObservationCandidateAudits`
- `web/src/components/TeamMemoryReviewPanel.tsx`：Content（presentation）+ Panel（container），状态过滤 + 批准/替换旧版/驳回/过期 + memoryRef 输入 + reason
- `web/src/components/TeamMemoryReviewPanel.test.tsx`：4/4 通过
- `web/src/components/ObservationReviewPanel.tsx`：同模式，含 confidence% / signals list / suggestedPatch JSON / promotedCommunicationPlanId 输入
- `web/src/components/ObservationReviewPanel.test.tsx`：4/4 通过
- `web/src/routes/self-system.tsx`：在 `canManageOrgProfiles && currentOrgId` 守卫内挂载两个 Panel

### 面板测试汇总

- TeamMemoryReviewPanel：4/4
- ObservationReviewPanel：4/4
- IdentityReviewPanel（既有）：3/3
- **合计 11/11 通过**

---

## Batch 3：D + C + F 已完成

### Phase 3D · Eval Harness（完成）
- `server/src/eval/fixtures/golden-set.v1.json` — 8 项覆盖 6 维度
- `server/src/eval/history.ts` + `fixtures.test.ts` + `history.test.ts`
- `server/scripts/eval-brain.ts` — CLI: `--baseline`, `--history-dir`, `--keep`, `--fail-on-regression`, JSON 报告
- `.github/workflows/eval-brain.yml` — paths-filtered，artifact 上传 `server/eval-history/`
- `package.json` 暴露 `eval:brain` / `eval:brain:ci`
- 当前 runner 为 `mock`，真实 Brain runner 接入留作 follow-up

### Phase 3C · Conflict Scan Worker（完成）
- `worker/src/handlers/conflictScan.ts` — `CONFLICT_DETECTOR_VERSION='conflict-scan-v1'`
- 扫描 `observation_candidates`（subject_key=`obs:<personId>:<hypothesisKey>`）+ `team_memory_candidates`（subject_key=`mem:<memoryRef>`）
- 写 `memory_conflict_candidates` + `memory_conflict_audits`，重复运行幂等
- `worker/src/index.ts` 注册 `boss.schedule(CONFLICT_SCAN_QUEUE, '17 * * * *')`
- `server/src/store/memory-conflict-ddl.ts` 抽出 DDL 常量供测试复用
- `worker/tests/integration/conflictScan.test.ts` 5/5 通过

### Phase 3F · Observation 自动晋升（完成）
- `server/src/web/routes/observation-promote.ts` — `extractCommunicationPlanPreferences` 严格白名单 + `tryAutoPromoteObservation`（best-effort，错误返回 null）
- `server/src/web/routes/observation.ts` — confirm 无手动 id 时自动 upsert，响应增 `autoPromoted: boolean`
- `observation.test.ts` 17/17 含 4 个新增覆盖（成功 / 无字段 / 无 personId / reject 不触发）
- 前端 `ObservationReviewPanel` 透出 `autoPromoted` 反馈

## 剩余工作

### Phase 2 遗留前端（独立 plan，见 `/home/guang/.claude/plans/enumerated-launching-moore.md`）
- PR 1：Person Detail API + client 补齐（**进行中**）
- PR 2：`/self-system` 的 Persons + Audit + Drawer
- PR 3：消息气泡 Attribution Popover
- PR 4：会话列表参与者 Badge + 按发言人筛选

### 边角 follow-up（非阻塞）
- Eval harness 接真实 Brain runner（当前 mock）

---

## 关键文件索引

### 新增
| 文件 | 作用 |
| --- | --- |
| `server/src/brain/sessionAffect.ts` | SessionAffect 业务逻辑 |
| `server/src/web/routes/session-affect.ts` | HTTP endpoint |
| `server/src/web/routes/session-affect.test.ts` | 11 个集成测试 |
| `web/src/components/TeamMemoryReviewPanel.tsx` | TeamMemory 审批 UI |
| `web/src/components/TeamMemoryReviewPanel.test.tsx` | 4 个 presentation 测试 |
| `web/src/components/ObservationReviewPanel.tsx` | Observation 审批 UI |
| `web/src/components/ObservationReviewPanel.test.tsx` | 4 个 presentation 测试 |

### 修改
| 文件 | 改动 |
| --- | --- |
| `server/src/im/BrainBridge.ts` | resolve + inject sessionAffect，写回 metadata |
| `server/src/web/server.ts` | 挂载 session-affect 路由 |
| `web/src/lib/query-keys.ts` | 4 个新 query key |
| `web/src/types/api.ts` | TeamMemory + Observation 类型 |
| `web/src/api/client.ts` | 10 个新方法 |
| `web/src/routes/self-system.tsx` | 挂载两个 Panel |

---

## 决策记录（重要）

1. **SessionAffect UI 主动不做** — 2026-04-24。理由：重叠 communicationPlan、硬边界削弱价值、design-driven。后端保留。
2. **Phase 2 Identity Graph 前端拆成独立 4 PR plan** — 已存 `/home/guang/.claude/plans/enumerated-launching-moore.md`。
3. **Observation confirm 先手填 planId（已撤销）** — 2026-04-24 改为后端自动 upsert + 前端透出 `autoPromoted`，手填仍作为 override 路径保留。
4. **Conflict Scan cron 选 `'17 * * * *'`** — 2026-04-24。避免 :00 整点全网调度叠加。
5. **Eval harness 用 mock runner 起步** — 2026-04-24。固定 corpus 走通 baseline/diff/history pipeline，再接真实 Brain。
