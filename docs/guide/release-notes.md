# Release Notes

## 2026-04-24 — orgId 迁移（破坏性变更）

本次升级把多租户隔离从 `namespace` 字符串改成 `orgId`（组织 ID）。
**服务端、worker、CLI、Web 必须同步升级并跑 DB migration**，否则部分接口会
400 / 401 / 403。

> 如果你在 `2026-04-24` 之前的版本上自建部署，请完整阅读本节再动手升级。

---

### 一、破坏性变更一览

#### 1. `CLI_API_TOKEN` 不再支持 `:namespace` 后缀

旧写法：

```bash
CLI_API_TOKEN="your-base-token:alice"
```

新写法：

```bash
CLI_API_TOKEN="your-base-token"
YOHO_ORG_ID="2280991b-4c9c-44c8-ba1c-82b213551284"   # 必填
```

Server 侧 `parseAccessToken` 已经改成：token 里包含 `:` 直接判非法，
不会再像旧版本那样"自动 strip 后缀并打 warning"。客户端继续传 `base:alice`
会 401。

#### 2. CLI 新增必填环境变量 `YOHO_ORG_ID`

- `hapi` 启动时会把 `YOHO_ORG_ID` 注入到所有 HTTP 请求的 `x-org-id` header 和
  Socket.IO auth.orgId 字段。
- 没配会在第一次需要发请求时抛 `YOHO_ORG_ID is required`（从 `2026-04-24`
  起改为懒加载 —— CLI 进程可以先起，只是真正要发请求时才会 fail）。
- 可以在 Web 端登录后，从 `设置 → 组织` 或 `/orgs/*` 路由拿到你的 orgId。

#### 3. HTTP 接口：Session/Machine 多了 `orgId` 字段 + 请求要求 `x-org-id`

- `GET /cli/sessions/:id`、`GET /cli/machines/:id` 等响应多了 `orgId: string | null`。
- `x-org-id` header 缺失或与资源 orgId 不一致 → `403`。
- 早期 client 旧版本读不到 `orgId` 字段不会崩，但 web 端会把它作为隔离边界，
  老客户端访问跨 org 的资源会 403。

#### 4. Worker-MCP 4 个路由现在按 org/machine 过滤

- `/api/internal/worker/*` 路由（schedule、find-or-create、send、status、stop）
  从 2026-04-24 起，所有查询 / mutation 都会按 `orgId + machineId` 过滤；
  `WORKER_INTERNAL_TOKEN` 没配 / 不对 → `401`。
- 如果你有自己接 worker 的脚本，需要在内部调用时带上 `orgId`。

#### 5. DB schema：多张表加了 `org_id`，UNIQUE 索引收紧

新增 / 收紧的约束：

| 表 | 列 | 索引 |
|----|-----|-----|
| `sessions` | `org_id TEXT` | `WHERE org_id IS NOT NULL` |
| `machines` | `org_id TEXT` | `WHERE org_id IS NOT NULL` |
| `ai_profiles` | `org_id TEXT` | `UNIQUE (org_id, role) WHERE org_id IS NOT NULL` |
| `brain_config` | `org_id TEXT` | `UNIQUE (org_id) WHERE org_id IS NOT NULL` |
| `user_self_system_settings`（新表）| `PRIMARY KEY (org_id, user_email)` | — |
| `ai_task_schedules` | `namespace` 列从历史 namespace 改为写 orgId | — |

旧数据 `org_id IS NULL` 必须在部署前 backfill，否则：
- 新版本所有读路径都是 `WHERE org_id = $1` —— 老数据会"看不见"；
- UNIQUE 索引里同 role / 同 brain_config 允许多行 `org_id IS NULL`，一旦有人
  把其中一行改成非 NULL，索引就会要求剩下的也收敛，否则 upsert 冲突。

#### 6. BrainBridge 不再写 `namespace='default'`

`BrainBridge`（Feishu 适配层）以前会把无归属消息写到 `namespace='default'`。
现在：
- 创建新 session 前必须解析出确定的 orgId（`resolveRequiredOrgId`）；
- 解析失败会直接拒绝建 session，而不是静默写 `default`。

如果你线上有依赖 `namespace='default'` 的历史 Feishu chat，升级后**新消息
不会再进 default bucket**，请先把历史数据 backfill 到目标 org。

#### 7. Orchestrator 链路：brain/brain-child + orchestrator/orchestrator-child

CLI 内部把硬编码的 `sessionSource === 'brain'` 改成了
`isSessionOrchestrationParentSource(source)` 等 helper，现在支持
`brain` / `brain-child` 和 `orchestrator` / `orchestrator-child` 两套父子
source。自定义 CLI 插件里如果直接判等于字符串 `'brain'`，需要改走 helper。

---

### 二、升级步骤（推荐顺序）

> 以下步骤在 self-host 部署上验证过。生产环境请先在 staging 走一遍。

#### Step 1 — 停掉老 worker / daemon

```bash
# 每台跑 hapi daemon 的机器
hapi daemon stop

# worker 侧（systemd / pm2 等）
sudo systemctl stop yoho-worker
```

CLI 进程保持连着问题不大，但**不要在 migration 期间让旧 CLI 发写请求**。

#### Step 2 — 在 DB 上跑 backfill migration

```bash
# 强烈建议先快照
psql -h <host> -U guang -d yoho_remote -c "
  CREATE TABLE sessions_backup_20260424    AS TABLE sessions;
  CREATE TABLE ai_profiles_backup_20260424 AS TABLE ai_profiles;
  CREATE TABLE brain_config_backup_20260424 AS TABLE brain_config;
"

# 跑 migration（脚本里已经是单事务 BEGIN/COMMIT，失败不会半套）
psql -h <host> -U guang -d yoho_remote \
  -f scripts/migrations/2026-04-24-org-id-backfill.sql
```

这份 migration 的行为：
- 删掉 114 行无主历史 sessions（created_by / machine_id / metadata email 全空）；
- 每个 `ai_profiles.role` 只保留最新一条迁到 Yoho org，其余删除；
- `brain_config` 的单行 `namespace='default'` 迁到 Yoho org；
- 给 `ai_profiles` 和 `brain_config` 建 partial UNIQUE 索引；
- 创建 `user_self_system_settings` 表；
- 最后打印剩余 NULL 数量作为健康检查。

> 如果你的数据分布和 2026-04-24 的线上不一样（比如多个实际在用的 namespace），
> 请**不要直接跑这份脚本**，需要先改里面的 `to_keep` 选法和目标 orgId。

#### Step 3 — 升级 server、worker

```bash
git pull
cd server && bun install && bun run build
cd ../worker && bun install && bun run build
```

server 侧需要配置：

```bash
CLI_API_TOKEN="your-base-token"   # 不要带 :namespace 后缀
WORKER_INTERNAL_TOKEN="..."        # worker 调内部路由必填，和 worker 侧保持一致
```

worker 侧需要配置：

```bash
yohoRemoteInternalUrl=http://server:port
workerInternalToken=...             # 必须和 server 端 WORKER_INTERNAL_TOKEN 一致
aiTaskTimeoutMs=1800000             # 默认 30min
```

#### Step 4 — 升级 CLI（每台机）

```bash
npm i -g @yoho/hapi@latest
# 或者 curl ... | sh 按 installation.md

# 配置（推荐写到 ~/.bashrc / ~/.zshrc）
export CLI_API_TOKEN="your-base-token"
export YOHO_ORG_ID="2280991b-4c9c-44c8-ba1c-82b213551284"

hapi daemon start
```

#### Step 5 — 重启 server / worker，回归

```bash
sudo systemctl restart yoho-server
sudo systemctl restart yoho-worker
```

登录 Web UI，确认：
- Session 列表能正常看到你自己的历史 session；
- Machine 列表里 `orgId` 不为空；
- AI Profile 还在；
- Brain / Brain-child 派生能正常拉起。

---

### 三、排错

#### `YOHO_ORG_ID is required`

没设 `YOHO_ORG_ID`。从 `2026-04-24` 起 CLI 进程起得来（懒加载），但一发请求
就会报这个错。

#### `403 Organization access denied`

`x-org-id` header 和 session 自身的 `org_id` 不一致。检查：
- `echo $YOHO_ORG_ID` 是否是你当前 org；
- web 端 `设置 → 组织` 里是不是 switch 到另一个 org；
- 这条 session 的 `org_id` 是不是 backfill 到了你预期以外的 org。

#### `401 CLI_API_TOKEN contains ":"`

还在用老 `:namespace` 后缀。改成纯 base token + `YOHO_ORG_ID`。

#### `UNIQUE constraint "idx_ai_profiles_org_role_unique"`

backfill 之后手动又往 `ai_profiles` 里插了相同 `(org_id, role)`。
partial UNIQUE 索引只约束 `org_id IS NOT NULL` 行，检查新插的那行 role
是不是和已有的冲突。

#### Brain 消息不落库 / Feishu 回不来

`BrainBridge.resolveRequiredOrgId` 解析失败会拒绝建 session，日志里会打：

```
[BrainBridge] Cannot create Brain session without a unique org (<reason>)
```

一般是 Feishu 消息的 `sender.email` 没在任何 org 里，或同时属于多个 org。
去 Web 端把该用户加到确定的 org 里即可。

---

### 四、回滚

本迁移是**破坏性**清理（删了 114 行 sessions + 部分 ai_profiles），
回滚前必须有 Step 2 里建的 `*_backup_20260424` 快照表。

```sql
BEGIN;
TRUNCATE ai_profiles;  INSERT INTO ai_profiles  SELECT * FROM ai_profiles_backup_20260424;
TRUNCATE brain_config; INSERT INTO brain_config SELECT * FROM brain_config_backup_20260424;
-- sessions 谨慎：新系统可能已经写入新 session 行，按 id 差集恢复
INSERT INTO sessions SELECT * FROM sessions_backup_20260424
  WHERE id NOT IN (SELECT id FROM sessions);
COMMIT;
```

然后把 server/worker/CLI 回退到 `2026-04-23` 前的 tag。

> 注意：回滚后新 UNIQUE 索引仍在。如果要彻底恢复旧行为，需要
> `DROP INDEX idx_ai_profiles_org_role_unique` 和 `idx_brain_config_org_id_unique`。
