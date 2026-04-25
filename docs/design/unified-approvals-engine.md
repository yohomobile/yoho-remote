# Unified Approvals Engine — ADR + 开发者指南

> 最后更新：2026-04-25（PR 10）
> 状态：✅ 核心代码已落地，数据迁移脚本就绪，待生产执行

## 1. 背景

K1 Phase 3（Actor-Aware Brain）在 3B / 3C / 3F 引入了 4 条并行的审批链：

| 旧域 | 候选表 | 审计表 | 路由 | 前端 Panel |
| --- | --- | --- | --- | --- |
| Identity Graph | `person_identity_candidates` | `person_identity_audits` | `/api/identity/candidates/*` | IdentityReviewPanel |
| Team Memory | `team_memory_candidates` | `team_memory_audits` | `/api/team-memory/*` | TeamMemoryReviewPanel |
| Observation Hypothesis | `observation_candidates` | `observation_audits` | `/api/observations/*` | ObservationReviewPanel |
| Memory Conflict | `memory_conflict_candidates` | `memory_conflict_audits` | `/api/memory-conflicts/*` | 未实现（Worker-only） |

四条链共享的字段有 ~70%（`namespace/org_id/status/decided_by/decided_at/decision_reason/created_at/updated_at`），而各自新增的只是少数 domain-specific payload 字段。继续按域加第 5、第 6 条审批项时，每次都要：
1. 建 `*_candidates` + `*_audits` 两张表
2. 在 `store/interface.ts + postgres.ts` 加 ~8 个 CRUD 方法
3. 建新 HTTP 路由 + 权限守卫
4. 写前端 Panel（90% 代码是四条链互抄的 boilerplate）

再叠加进已经被裁掉的 Control Plane `approval_requests / approval_decisions / capability_grants` 半成品（详见 §6），审批代码路径数量已经接近 5 套。本 ADR 合并为**单一审批引擎**，核心层 + 域插件。

## 2. 决策

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  HTTP: /api/approvals/*  (server/src/web/routes/approvals.ts)│
│     ↓ 从 registry 查 domain                                  │
│  executeDecide (server/src/approvals/executor.ts)            │
│     ↓                                                        │
│  IStore.decideApproval (txn 边界)                            │
│     ↓ 在 txn 内回调                                          │
│  domain.permission / domain.nextStatus / domain.effects      │
│     ↓                                                        │
│  approvals (master) + approval_payload_<domain> + audits     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据库 schema

**主表 `approvals`** — 跨域共享字段：
```sql
id TEXT PK,
namespace TEXT, org_id TEXT (FK),
domain TEXT,                        -- 'identity' | 'team_memory' | 'observation' | 'memory_conflict'
subject_kind TEXT, subject_key TEXT,
status TEXT DEFAULT 'pending',      -- 'pending' | 'approved' | 'rejected' | 'expired' | 'dismissed'
decided_by TEXT, decided_at BIGINT, decision_reason TEXT,
expires_at BIGINT, created_at BIGINT, updated_at BIGINT,
UNIQUE (namespace, org_id, domain, subject_key)
```

**审计表 `approval_audits`** — 跨域共享：
- `payload_snapshot JSONB` — 决策时刻的 payload 完整快照
- `actor_role TEXT` — 'admin' / 'subject' / 'operator' / 'system'，用于后续审计分析

**各域 payload 表** — `approval_payload_identity` / `_team_memory` / `_observation` / `_memory_conflict`：
- `approval_id TEXT PK REFERENCES approvals(id) ON DELETE CASCADE`
- 各域自有字段（例如 observation 的 `hypothesis_key`/`signals`/`suggested_patch`）

**DDL 文件**：`server/src/store/approvals-ddl.ts`

### 2.3 Domain Plugin 协议

每个域实现 `ApprovalDomain<TPayload, TAction>`（见 `server/src/approvals/types.ts`）：

```ts
{
  name: 'observation',
  subjectKind: 'person_hypothesis',
  payloadTable: 'approval_payload_observation',
  actionSchema: z.discriminatedUnion('action', [...]),  // 或任何 zod 兼容 validator

  subjectKey(payload): string,              // 供 upsert 去重用

  nextStatus(current, action): MasterStatus | null,     // null = 非法 transition

  permission({ actorEmail, isOperator, orgRole, record, payload }): ActorRole | null,

  effects?({ query, record, payload, action, ... }): Promise<{ payloadPatch?, effectsMeta? }>,
}
```

**约束**：
- `permission` 返回 `null` 时 executor 抛 `ApprovalForbiddenError`，routes 映射到 403
- `nextStatus` 返回 `null` → `ApprovalInvalidTransitionError` → 409
- `effects` 在 decide 同一 txn 内执行；抛错被 executor catch，不阻断主决策，通过 `effectsError` 返回
- `effects` 通过 `query` 参数跑 SQL；可直接 upsert 关联表（如 observation auto-promote communication_plan）

### 2.4 权限策略

| Domain | admin | subject | operator |
| --- | --- | --- | --- |
| identity | ✅ | ❌ | ✅ (bypass) |
| team_memory | ✅ | ❌ | ✅ (bypass) |
| observation | ✅ | ✅（match email）| ✅ (bypass) |
| memory_conflict | ✅ | ❌ | ✅ (bypass) |

### 2.5 状态机语义归一

旧域的 status 词汇不统一（identity: open/confirmed/rejected/superseded/expired；team_memory: pending/approved/rejected/superseded/expired；observation: pending/confirmed/rejected/dismissed/expired；memory_conflict: open/resolved/dismissed/reopened）。

统一映射到 `ApprovalMasterStatus` 的 5 态：
- `pending` — 待决策
- `approved` — 通过（包括 supersede / confirm / resolve 等语义）
- `rejected` — 拒绝
- `dismissed` — 忽略（不改变世界，不是拒绝）
- `expired` — 过期

域特有的 "sub-action"（e.g. observation 的 confirm vs. supersede）落到 `approval_audits.action` 字段，主表 status 保持 5 态粒度，便于跨域查询。

## 3. 扩展：加一个新审批域需要做什么

1. 建 `server/src/approvals/domains/<new_domain>.ts` 实现 `ApprovalDomain`
2. 在 `server/src/store/approvals-ddl.ts` 加 `APPROVAL_PAYLOAD_<NEW>_DDL` 常量 + 追加到 `APPROVALS_ALL_DDL`
3. 在 `server/src/approvals/setup.ts` 加 `registry.register(newDomain)`
4. 前端：在 `web/src/components/ApprovalReviewPanel.tsx` 的 `DOMAIN_OPTIONS` + `ACTIONS_BY_DOMAIN` 加一项
5. 写 domain 单测（参考 `server/src/approvals/executor.test.ts`）

**不需要改**：store CRUD（通用）、HTTP 路由（通用）、audit 持久化（通用）、executor（通用）。

## 4. 数据迁移

`server/scripts/migrate-approvals.ts`：一次性脚本，把 4 张旧候选表数据搬到 approvals + payload 表。

- 默认 dry-run，`--commit` 才真正写
- 每条记录的 `approval_id` 固定为 `mig_<domain>_<legacy_id>`，脚本可重复执行
- `ON CONFLICT DO NOTHING` 保证幂等
- 旧表**不删除**，脚本跑完后由后续运维操作 DROP

```bash
DATABASE_URL=... bun run server/scripts/migrate-approvals.ts          # dry-run
DATABASE_URL=... bun run server/scripts/migrate-approvals.ts --commit # 实际写入
```

**执行前 checklist**：
- [ ] 新 approvals + payload 表已在目标库创建（由 `initSchema` 自动）
- [ ] 已备份 4 张旧表（snapshot）
- [ ] 先在 pre-prod 跑 dry-run 对一下 seen/inserted/skipped
- [ ] commit 后验证 `/api/approvals` 能列出迁移后的记录

## 5. 代码组织

```
server/src/
├── approvals/
│   ├── types.ts                    # ApprovalRecord/Audit/Domain/ActorRole/TxnQuery + 4 错误类
│   ├── registry.ts                 # ApprovalDomainRegistry
│   ├── executor.ts                 # executeDecide 编排
│   ├── setup.ts                    # buildApprovalDomainRegistry（注册所有 domain）
│   ├── executor.test.ts            # 8 个场景
│   └── domains/
│       ├── identity.ts             # identity 合并候选
│       ├── team-memory.ts          # 团队共享记忆
│       ├── observation.ts          # 观察假设 + auto-promote plan effects
│       └── memory-conflict.ts      # 记忆冲突（含 reopen 反向 transition）
├── store/
│   ├── approvals-ddl.ts            # 6 张表 DDL
│   ├── interface.ts                # IStore.{listApprovals, decideApproval, ...} 6 方法
│   ├── postgres.ts                 # 实现 + 列名白名单防注入
│   └── postgres-approvals.test.ts  # 13 个 store 测试
└── web/routes/
    └── approvals.ts                # 4 个 HTTP 端点

web/src/
├── types/api.ts                    # ApprovalRecord/Audit/DecisionResponse
├── api/client.ts                   # getApprovals/getApproval/decideApproval/getApprovalAudits
├── lib/query-keys.ts               # approvals/approvalDetail/approvalAudits
└── components/ApprovalReviewPanel.tsx  # 通用 Panel

server/scripts/migrate-approvals.ts  # 一次性数据迁移
docs/design/unified-approvals-engine.md  # 本文档
```

## 6. 追溯 / 历史遗留清理

本次统一顺带清掉的 4 套遗留：

1. **Control Plane scaffold**（单 commit `900eeb70` 落下的半成品）—
   删除了 `server/src/control-plane/`、`web/routes/control-plane.ts`、DDL 里的
   `approval_requests / approval_decisions / capability_grants / audit_events` 4 张表、对应的 17 个 store 方法。
2. **4 条旧路由**：`/api/team-memory`, `/api/observations`, `/api/memory-conflicts`, `/api/identity/candidates`
3. **3 个旧 Panel**：IdentityReviewPanel / TeamMemoryReviewPanel / ObservationReviewPanel
4. **observation auto-promote 独立 txn**（`observation-promote.ts::tryAutoPromoteObservation`）→ 合并进 `observationDomain.effects`，与决策同 txn 原子化

## 7. 未完成的 follow-up

- [ ] 生产执行数据迁移脚本
- [ ] 旧 `*_candidates / *_audits` 8 张表的 DROP 迁移（要在迁移脚本验证通过后）
- [ ] 旧 store 方法（`listObservationCandidates` 等）的代码删除 — 路由已下线但接口方法仍存在，死代码需清理
- [ ] Worker `conflictScan.ts` 改写为直接写 `approvals` 而非 `memory_conflict_candidates`
- [ ] 前端 per-domain 自定义渲染器（目前统一是 JSON）—
      根据 `approval.domain` 动态选择 renderer 组件
- [ ] approvals 路由集成测试（参考已删除的 `observation.test.ts` 17 个用例）
- [ ] eval harness 接真实 Brain runner（Phase 3D 遗留）

## 8. 关键决策记录

| # | 决策 | 日期 | 理由 |
| --- | --- | --- | --- |
| 1 | 主表 + 4 张 payload 子表，而非单一 JSONB blob | 2026-04-25 | 保留 typed 列便于索引/查询；各域演进不互相污染 |
| 2 | payload 表 `approval_id PK + FK CASCADE` | 2026-04-25 | 1:1 不需要独立 id；删主表自动回收 |
| 3 | effects 在 decide 同一 txn 内执行 | 2026-04-25 | 避免 observation auto-promote 跨 txn 的孤儿数据问题 |
| 4 | effects 抛错被 catch，不阻断主决策 | 2026-04-25 | 保持与旧 `tryAutoPromoteObservation` best-effort 行为一致 |
| 5 | actionSchema 做成 `ApprovalActionValidator<T>` 结构类型而非强依赖 zod | 2026-04-25 | `approvals/types.ts` 保持零外部依赖；domain 仍可传 `z.discriminatedUnion(...)` |
| 6 | 统一 5 态 master status；domain 子状态落到 audit.action | 2026-04-25 | 跨域看板能用单一 status 过滤；不丢失域特有语义 |
| 7 | 标识符白名单 `/^[a-z_][a-z_0-9]*$/` 防 SQL 注入 | 2026-04-25 | payload_table 和动态 payload 列名都受控；拒绝 `evil; DROP TABLE` |
| 8 | 旧表保留不删，仅停挂路由 | 2026-04-25 | 数据迁移风险最小化；灰度期可随时回滚 |
