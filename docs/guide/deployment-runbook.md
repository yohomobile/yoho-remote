# 部署前 Checklist / Runbook

这份 runbook 面向 **上线前执行**，目标是把 yoho-remote 的发布动作收敛成一套可重复、可回滚、可观测的步骤。

适用范围：

- `server/`：Web / API / Socket.IO / SSE / Keycloak SSO / 队列 publisher
- `worker/`：`summarize-turn` 队列消费、DeepSeek 摘要写入
- `memory`：独立 memory 服务 / 迁移（若本次发布包含；不在本仓库内实现）
- `cli/` daemon：外部机器会话托管与心跳上报

不在本 runbook 范围内：

- 业务逻辑变更评审
- 数据库大版本迁移
- Keycloak / PostgreSQL 自身的部署手册

## 1. 发布阻断项

以下项在发布前必须全部满足；任意一项不满足，都不要继续上线：

- [ ] `bun install` 已完成，依赖锁文件没有意外漂移
- [ ] `bun run typecheck` 通过
- [ ] `bun run test` 通过（注意：根目录 `bun run test` 只覆盖 `cli/server`，不能单独证明 `worker/memory` 新链路已测通）
- [ ] `bun run build` 通过
- [ ] `worker` 已执行 `bun run smoke:fake-deepseek` 或等价定向验证
- [ ] `memory` 已执行定向验证 / 迁移校验 / 健康检查（若本次发布包含 `memory` 变更）
- [ ] 中心节点的 `/etc/yoho-remote/server.env`、`/etc/yoho-remote/worker.env`，以及每台 daemon 机器的 `~/.yoho-remote/daemon.systemd.env`（或由 `hapi daemon install` 生成）已准备好，且密钥已二次核对
- [ ] `PG_BOSS_SCHEMA` 已在 `server / worker / smoke` 配置中逐项核对一致
- [ ] `pg_search` 扩展存在
- [ ] `session_summaries_bm25_idx` 已存在
- [ ] fake smoke 已成功
- [ ] 如已配置 `DEEPSEEK_API_KEY`，真实 DeepSeek 预检已成功
- [ ] PostgreSQL 可连通，目标库可读写
- [ ] Keycloak 可连通，client/realm 配置已确认
- [ ] 如需邮件邀请，`SMTP_*` 已配置并可用
- [ ] 如需 Web Push，`WEB_PUSH_VAPID_*` 已配置
- [ ] 如需 Feishu / Gemini，对应可选变量已配置
- [ ] 当前线上二进制与 env 文件已备份，可在 10 分钟内回滚

推荐先在仓库根目录执行一次：

```bash
bun install
bun run typecheck
bun run test
bun run build
```

说明：

- 根目录 `bun run test` 当前只执行 `test:cli` 和 `test:server`
- `worker` 发布门禁至少要补 `bun run smoke:fake-deepseek`
- `memory` 若有变更，必须补它自己的定向验证；不能只拿根目录测试代替
- 检索链路上线前还要额外确认 `pg_search` 扩展和 `session_summaries_bm25_idx` 已到位

如果你采用外部部署二进制模式，再额外构建：

```bash
cd cli
bun run build:exe:server
bun run build:exe:daemon
cd ../worker
bun run build:exe
```

## 2. 必备环境变量

### 2.1 server 必备

以下变量建议全部显式写入 `/etc/yoho-remote/server.env`，不要依赖默认值或首次启动自动生成：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `CLI_API_TOKEN` | 是 | CLI / daemon 与 server 的共享鉴权密钥；生产环境必须固定，不要让服务自行生成 |
| `WEBAPP_PORT` | 是 | server 监听端口，默认 3006 |
| `WEBAPP_URL` | 是 | 外部访问 URL，也作为 Web / PWA / 部分跳转基准 |
| `CORS_ORIGINS` | 是 | 浏览器允许访问的 origin；通常与 `WEBAPP_URL` 同源 |
| `PG_HOST` | 是 | PostgreSQL 主机 |
| `PG_PORT` | 是 | PostgreSQL 端口 |
| `PG_USER` | 是 | PostgreSQL 用户 |
| `PG_PASSWORD` | 是 | PostgreSQL 密码 |
| `PG_DATABASE` | 是 | PostgreSQL 数据库名 |
| `PG_SSL` | 是 | PostgreSQL SSL 开关，`true` / `false` |
| `PG_BOSS_SCHEMA` | 是 | pg-boss schema；必须显式填写，避免悄悄落到默认 schema |
| `KEYCLOAK_URL` | 是 | 对外可访问的 Keycloak 地址 |
| `KEYCLOAK_INTERNAL_URL` | 是 | server 内部访问 Keycloak 的地址；同源可直接复用 `KEYCLOAK_URL` |
| `KEYCLOAK_REALM` | 是 | Keycloak realm |
| `KEYCLOAK_CLIENT_ID` | 是 | Keycloak client id |
| `KEYCLOAK_CLIENT_SECRET` | 是 | Keycloak client secret；缺失会导致 code exchange / refresh 失败 |

条件必需：

| 变量 | 何时必需 | 说明 |
| --- | --- | --- |
| `ADMIN_ORG_ID` | 已完成 admin org bootstrap 后 | 用于 License Admin；首次部署可暂缺，bootstrap 完成后必须回填 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | 需要邮件邀请时 | server 没有这些变量时会禁用邮件能力 |
| `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` / `WEB_PUSH_VAPID_SUBJECT` | 需要 Web Push 时 | 缺失时 server 会记录 `Web Push: disabled` |

可选但建议单独确认：

- `WEBAPP_URL`
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_BASE_URL`
- `FEISHU_BOT_APP_ID` / `FEISHU_BOT_APP_SECRET`
- `GEMINI_API_KEY`
- `YOHO_REMOTE_HOME`

示例：

```bash
CLI_API_TOKEN=replace-with-a-strong-secret
WEBAPP_PORT=3006
WEBAPP_URL=https://remote.example.com
CORS_ORIGINS=https://remote.example.com

PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=yoho_remote
PG_PASSWORD=replace-me
PG_DATABASE=yoho_remote
PG_SSL=false
PG_BOSS_SCHEMA=pgboss

KEYCLOAK_URL=https://sso.example.com
KEYCLOAK_INTERNAL_URL=https://sso.example.com
KEYCLOAK_REALM=yoho
KEYCLOAK_CLIENT_ID=yoho-remote
KEYCLOAK_CLIENT_SECRET=replace-me
```

### 2.2 worker 必备

`worker` 不直接依赖 server HTTP，但它依赖 PostgreSQL 和 DeepSeek；没有它，`summarize-turn` 只能入队，不能被消费。

`worker` 不能作为首发组件。`session_summaries.session_id` 外键依赖 `sessions(id)`，且 `sessions.thinking` / `sessions.thinking_at` 迁移在 server store 初始化里执行；如果先发 `worker`，会把依赖顺序倒置。

上线初期只跑 **1 个 worker 实例**，并固定 `WORKER_CONCURRENCY=1`。不要在首轮放量时同时增加实例数和并发数。

建议写入 `/etc/yoho-remote/worker.env`：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` / `PG_SSL` | 是 | 与 server 指向同一个业务库 |
| `PG_BOSS_SCHEMA` | 是 | 与 server 保持一致；缺失时 worker 直接拒绝启动；这是最敏感检查项之一 |
| `DEEPSEEK_API_KEY` | 是 | worker 启动必需 |

可选：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 可指向代理或兼容网关 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 当前代码仅接受该值 |
| `DEEPSEEK_TIMEOUT_MS` | `60000` | DeepSeek 超时 |
| `WORKER_CONCURRENCY` | `1` | 单机并发消费数 |
| `WORKER_HEALTH_HOST` / `WORKER_HEALTH_PORT` | `127.0.0.1` / 未启用 | 配置端口后暴露 `/healthz`、`/readyz`、`/stats` |
| `SUMMARIZATION_RUN_RETENTION_DAYS` | `30` | `summarization_runs` 清理窗口 |
| `YOHO_MEMORY_URL` | `http://127.0.0.1:3100` | worker 摘要写入 yoho-memory 的 HTTP 地址 |
| `YOHO_MEMORY_HTTP_AUTH_TOKEN` | 空 | yoho-memory HTTP token；启用写入时必须与 memory 服务一致 |
| `YOHO_MEMORY_INTEGRATION_ENABLED` | `true` | 总开关；关闭后 worker 不构造 memory client |
| `YOHO_MEMORY_WRITE_L1` / `YOHO_MEMORY_WRITE_L2` / `YOHO_MEMORY_WRITE_L3` | `true` | 分层控制 L1/L2/L3 摘要是否写入 memory inbox |
| `YOHO_SKILL_SAVE_FROM_L2` / `YOHO_SKILL_SAVE_FROM_L3` | `true` | 控制是否从有价值的 L2/L3 摘要生成 manual candidate skill |
| `YOHO_MEMORY_REQUEST_TIMEOUT_MS` | `5000` | worker 调 yoho-memory 的单次 HTTP 超时 |

示例：

```bash
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=yoho_remote
PG_PASSWORD=replace-me
PG_DATABASE=yoho_remote
PG_SSL=false
PG_BOSS_SCHEMA=pgboss

DEEPSEEK_API_KEY=replace-me
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=60000
WORKER_CONCURRENCY=1
SUMMARIZATION_RUN_RETENTION_DAYS=30

YOHO_MEMORY_URL=http://127.0.0.1:3100
YOHO_MEMORY_HTTP_AUTH_TOKEN=replace-me
YOHO_MEMORY_INTEGRATION_ENABLED=true
```

### 2.3 daemon 必备

每台外部 worker 机器上的 daemon 至少需要：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `CLI_API_TOKEN` | 是 | 必须与 server 完全一致 |
| `YOHO_REMOTE_URL` | 是 | 指向 server 外部地址 |

常见可选：

- `YOHO_REMOTE_HOME`
- `YR_DAEMON_HEARTBEAT_INTERVAL`
- `YR_DAEMON_HTTP_TIMEOUT`

env 来源说明：

- 推荐直接执行 `hapi daemon install`，它会把当前 daemon 环境固化到 `~/.yoho-remote/daemon.systemd.env`
- 如果你手工维护 systemd unit，也要沿用同一个 env 文件路径，不要再假定 `/etc/yoho-remote/daemon.env`

示例：

```bash
CLI_API_TOKEN=replace-with-the-same-secret
YOHO_REMOTE_URL=https://remote.example.com
```

### 2.4 memory 说明

`memory` 作为独立组件处理。它的环境变量、迁移细节和健康检查以它自身仓库 / 服务说明为准，这份 runbook 不重复枚举，但发布顺序和回滚顺序都必须把它当成单独步骤。

## 3. 启动顺序

### 3.0 首次部署时先把资产落到位

中心节点（server + worker）：

```bash
sudo install -d -m 0755 /opt/yoho-remote /etc/yoho-remote /var/lib/yoho-remote
sudo install -m 0755 cli/dist-exe/<target>/yoho-remote-server /opt/yoho-remote/yoho-remote-server
sudo install -m 0755 worker/dist-exe/yoho-remote-worker /opt/yoho-remote/yoho-remote-worker
sudo install -m 0644 yoho-remote-server.service /etc/systemd/system/yoho-remote-server.service
sudo install -m 0644 yoho-remote-worker.service /etc/systemd/system/yoho-remote-worker.service
sudo install -m 0600 yoho-remote-server.env.example /etc/yoho-remote/server.env
sudo install -m 0600 yoho-remote-worker.env.example /etc/yoho-remote/worker.env
```

把 `/etc/yoho-remote/server.env` 和 `/etc/yoho-remote/worker.env` 填成真实值后，再执行下面的启动顺序。

每台 daemon 机器：

```bash
export CLI_API_TOKEN=replace-with-the-same-secret
export YOHO_REMOTE_URL=https://remote.example.com
hapi auth login
sudo hapi daemon install
```

- 后续如果 daemon 的 systemd 模板、依赖顺序或 kill 语义发生变化，继续使用 `sudo hapi daemon install` 做升级；不要只做 `systemctl restart`，因为后者不会重写 unit。

上线时按下面顺序执行，不要并行胡乱拉起。**推荐发布顺序明确写成：`server -> worker -> memory -> daemon`。**

1. **先确认基础依赖**
   - PostgreSQL 可连通
   - Keycloak 可连通
   - 目标 env 文件已放到位
2. **启动 `yoho-remote-server`**
   - 原因：server 是 Web/API 入口，也是 `summarize-turn` publisher 所在进程
   - 成功标志：日志出现 `YR Server is ready!`
3. **如是首次部署或 admin org 发生变化，执行 admin org bootstrap**
   - 先通过 Web 完成第一次管理员登录和组织创建
   - 再执行：

```bash
cd server
bun run bootstrap:admin-org -- --slug platform-admin --env-file /etc/yoho-remote/server.env
```

   - 然后重启 `yoho-remote-server`
4. **启动 `worker`**
   - 原因：只有 server ready 后，队列 publisher 和 API smoke 才有意义；同时 `worker` 不能首发，因为 `session_summaries` 外键依赖 `sessions`，而 `sessions.thinking` / `sessions.thinking_at` 迁移在 server store 初始化里执行
   - 上线初期策略：先只拉起 1 个 worker 实例，并保持 `WORKER_CONCURRENCY=1`
   - 成功标志：日志出现 `[Worker] Started. queue=summarize-turn`
5. **启动 / 迁移 `memory`**
   - 原因：`memory` 是独立发布单元，必须在 `server`、`worker` 稳定后再处理
   - 如果本次没有 `memory` 代码或迁移变更，也至少完成它的健康确认后再进入 `daemon`
6. **最后启动每台 daemon**
   - 原因：daemon 依赖 server URL 和 `CLI_API_TOKEN`；server 未 ready 时只会产生无效重连噪音
   - 先在每台机器执行 `hapi auth status` 自检，再启动 systemd / launchd

如果使用 systemd，中心节点建议最少按这个顺序：

```bash
sudo systemctl daemon-reload
sudo systemctl restart yoho-remote-server
sudo systemctl restart yoho-remote-worker
sudo systemctl restart <memory-service-unit>
```

daemon 运行在外部机器上时，server、worker、memory 在中心节点 ready 后，再逐台重启 daemon：

```bash
sudo systemctl restart yoho-remote-daemon
```

## 4. Smoke 命令

门禁说明：

- 根目录 `bun run test` 不能单独证明 `worker/memory` 新链路已经测通
- `worker` 至少补现有 `bun run smoke:fake-deepseek`
- `memory` 若有变更，必须补它自己的定向验证 / 现有 smoke / 健康检查

### 4.1 基础可用性 smoke

先验证 server 对外和鉴权都正常：

```bash
curl -fsS "${WEBAPP_URL}/api/version"
curl -fsS "${WEBAPP_URL}/" >/dev/null
curl -fsS \
  -H "Authorization: Bearer ${CLI_API_TOKEN}:default" \
  "${WEBAPP_URL}/cli/machines"
```

判定标准：

- `/api/version` 返回 JSON
- `/` 返回 200，而不是 `Mini App is not built`
- `/cli/machines` 返回 200，而不是 401/503

在 daemon 机器上再执行：

```bash
hapi auth status
hapi daemon status
```

判定标准：

- `CLI_API_TOKEN` 来源正确
- `YOHO_REMOTE_URL` 指向新环境
- daemon 状态正常，没有版本错配或孤儿进程

### 4.2 summarize-turn 闭环 smoke

这个 smoke **不依赖真实 DeepSeek**，适合部署前或部署后快速证明 `publisher -> pg-boss -> worker -> DB` 链路通畅：

```bash
PG_HOST=127.0.0.1 \
PG_PORT=5432 \
PG_USER=yoho_remote \
PG_PASSWORD=replace-me \
PG_DATABASE=yoho_remote \
PG_SSL=false \
PG_BOSS_SCHEMA=pgboss_smoke \
SMOKE_ALLOW_DB_WRITE=true \
bun run smoke:fake-deepseek
```

成功标志：

- 输出 `[smoke] success`
- 输出 `run.status=success`
- 输出 `summary.seq=...`
- 输出 `fake DeepSeek handled at least one completion request`

这个命令会临时拉起 fake DeepSeek 和 worker 子进程，并验证：

- `summarization_runs` 最新一条为 `success`
- `session_summaries` 已写入对应 L1 摘要
- 未设置 `SMOKE_ALLOW_DB_WRITE=true` 时，脚本会在连接 PostgreSQL 前直接拒绝执行
- 若目标库或 queue schema 名称看起来像默认 / production（例如 `PG_BOSS_SCHEMA=pgboss`），还需要额外显式设置 `SMOKE_ALLOW_UNSAFE_DB_TARGET=true`

### 4.3 worker / memory 定向验证要求

- `worker`：发布前至少执行一次 `bun run smoke:fake-deepseek`
- `memory`：如果本次包含 `memory` 变更，必须执行它当前已有的定向 smoke、迁移校验或健康检查
- `worker -> memory`：确认 `/etc/yoho-remote/worker.env` 中的 `YOHO_MEMORY_URL` 和 `YOHO_MEMORY_HTTP_AUTH_TOKEN` 与 yoho-memory 服务一致；摘要写入失败只打 warn，不会阻塞 worker 主流程
- 没有 `worker/memory` 定向验证结果，不要进入 `daemon` 发布步骤

### 4.4 真实 DeepSeek 抽检

`fake-deepseek` smoke 只能证明链路，不能证明真实模型质量。上线后至少抽检 1 条真实摘要：

1. 在 UI 或现有会话里制造一段足够长的 turn
2. 观察 worker 日志是否出现 DeepSeek 调用错误
3. 在数据库中确认有新摘要写入

示例 SQL：

```sql
SELECT status, error, created_at
FROM summarization_runs
ORDER BY created_at DESC
LIMIT 20;

SELECT session_id, level, seq_start, seq_end, created_at
FROM session_summaries
ORDER BY created_at DESC
LIMIT 20;
```

### 4.5 发布前前置检查

下面这些项属于发布前前置检查，缺一项都不要放量：

数据库 / 检索前置检查：

```sql
SELECT extname
FROM pg_extension
WHERE extname = 'pg_search';

SELECT schemaname, indexname
FROM pg_indexes
WHERE indexname = 'session_summaries_bm25_idx';
```

期望结果：

- `pg_search` 扩展存在
- `session_summaries_bm25_idx` 至少返回 1 行

fake smoke：

```bash
PG_HOST=127.0.0.1 \
PG_PORT=5432 \
PG_USER=yoho_remote \
PG_PASSWORD=replace-me \
PG_DATABASE=yoho_remote \
PG_BOSS_SCHEMA=pgboss_smoke \
PG_SSL=false \
SMOKE_ALLOW_DB_WRITE=true \
SMOKE_WORKER_CONCURRENCY=1 \
bun run smoke:fake-deepseek
```

真实 DeepSeek 预检：

如果已经配置 `DEEPSEEK_API_KEY`，发布前再跑一次 real 模式 smoke 预检：

```bash
PG_HOST=127.0.0.1 \
PG_PORT=5432 \
PG_USER=yoho_remote \
PG_PASSWORD=replace-me \
PG_DATABASE=yoho_remote \
PG_BOSS_SCHEMA=pgboss_smoke_real \
PG_SSL=false \
SMOKE_ALLOW_DB_WRITE=true \
SMOKE_DEEPSEEK_MODE=real \
SMOKE_WORKER_CONCURRENCY=1 \
DEEPSEEK_API_KEY=replace-me \
bun run smoke:fake-deepseek
```

期望结果：

- fake smoke 成功
- 如已配置 key，real 模式 smoke 也成功

## 5. 观测项 / 告警项

worker 配置 `WORKER_HEALTH_PORT` 后会暴露独立 HTTP health endpoint；上线观测仍建议同时看 **systemd、日志、DB、smoke**。

`PG_BOSS_SCHEMA` 一致性是上线前后都要盯的敏感项之一；`server`、`worker`、smoke 使用的 schema 一旦不一致，最容易出现“publisher 正常、consumer 无消费”这一类隐蔽故障。

### 5.0 查询入口与容量护栏

- `session_search` 默认只开放 `query/search` 模式，不要把 `recent` 浏览作为默认入口
- 遇到 `session-history` 类问题，操作规范上优先 `session_search(query)`，不要默认走 `recall`
- `recent` 模式当前在真实 `1924 sessions` 规模下约 `10.2s`，只适合受控场景，不适合广泛放量
- 如果必须启用 `recent`，应限制到运维排障、人工值守、低频入口，不要把它挂到面向所有用户的默认路径

### 5.1 必看观测项

服务状态：

```bash
systemctl status yoho-remote-server
systemctl status yoho-remote-worker
systemctl status yoho-remote-daemon
```

关键日志：

```bash
journalctl -u yoho-remote-server -n 200 --no-pager
journalctl -u yoho-remote-worker -n 200 --no-pager
journalctl -u yoho-remote-daemon -n 200 --no-pager
```

worker health：

```bash
curl -fsS http://127.0.0.1:3102/readyz
curl -fsS http://127.0.0.1:3102/stats
```

应重点搜索：

```bash
journalctl -u yoho-remote-server -n 500 --no-pager | rg "YR Server is ready|summarize-turn queue disabled|Web Push: disabled|Email: disabled|KEYCLOAK|Error|Fatal"
journalctl -u yoho-remote-worker -n 500 --no-pager | rg "\\[Worker\\] Started|Fatal startup error|DeepSeek|error_transient|error_permanent"
journalctl -u yoho-remote-daemon -n 500 --no-pager | rg "machine|heartbeat|error|version mismatch"
```

数据库观测：

```sql
SELECT status, COUNT(*) AS cnt
FROM summarization_runs
WHERE created_at > (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT - 15 * 60 * 1000
GROUP BY status
ORDER BY status;

SELECT session_id, status, error, created_at
FROM summarization_runs
WHERE status <> 'success'
ORDER BY created_at DESC
LIMIT 20;

SELECT session_id, level, seq_start, seq_end, created_at
FROM session_summaries
ORDER BY created_at DESC
LIMIT 20;
```

### 5.2 最低告警建议

以下任一条件成立，都应该视为上线告警：

- `yoho-remote-server` 进程不在，或 `/api/version` 连续失败 3 次
- `/cli/machines` 返回 401 或 503
- `yoho-remote-worker` 未启动，或启动后 5 分钟内没有出现 `[Worker] Started.`
- `summarization_runs` 在最近 15 分钟出现 `error_transient` / `error_permanent` 持续增长
- worker 日志持续出现 `DeepSeek 429`、超时、`DeepSeek 5xx`、`Fatal startup error`
- server 日志出现 `summarize-turn queue disabled`
- `server / worker / smoke` 的 `PG_BOSS_SCHEMA` 不一致，或生产环境值发生意外漂移
- daemon 机器从 `/cli/machines` 列表中整体消失，或 `hapi daemon status` 显示版本错配
- Keycloak 登录、refresh、callback 持续报错

## 6. 回滚动作

回滚目标是两件事：

- 先止损，停止继续放大错误
- 再恢复上一版 server / worker / memory / daemon 二进制和 env

### 6.1 部署前必须做的备份

上线前先备份当前二进制和 env：

```bash
TS="$(date +%Y%m%d%H%M%S)"
sudo mkdir -p /opt/yoho-remote/backup/"${TS}"
sudo cp /opt/yoho-remote/yoho-remote-server /opt/yoho-remote/backup/"${TS}"/
sudo cp /opt/yoho-remote/yoho-remote-worker /opt/yoho-remote/backup/"${TS}"/
sudo cp /etc/yoho-remote/server.env /opt/yoho-remote/backup/"${TS}"/
sudo cp /etc/yoho-remote/worker.env /opt/yoho-remote/backup/"${TS}"/
```

每台 daemon 机器也各自备份 daemon 二进制和 env：

```bash
TS="$(date +%Y%m%d%H%M%S)"
DAEMON_USER=yoho
DAEMON_HOME="$(getent passwd "${DAEMON_USER}" | cut -d: -f6)/.yoho-remote"
sudo mkdir -p /opt/yoho-remote/backup/"${TS}"
sudo cp /opt/yoho-remote/yoho-remote-daemon /opt/yoho-remote/backup/"${TS}"/
sudo test -f "${DAEMON_HOME}/daemon.systemd.env" && sudo cp "${DAEMON_HOME}/daemon.systemd.env" /opt/yoho-remote/backup/"${TS}"/
```

### 6.2 server / worker / memory 联动回滚

当问题集中在登录、API、摘要任务异常或联动迁移异常时，按下面顺序回滚：

- 先停 `worker` 止损
- 再回滚 `server`
- `memory` 最后回滚
- 对“只增不减”的表、列、索引、schema 对象，不做常规删除；默认优先回退服务版本与配置，而不是执行 `DROP` / `DELETE`

```bash
sudo systemctl stop yoho-remote-worker
sudo systemctl stop yoho-remote-server
```

先恢复上一版 `server` 产物与 env：

```bash
sudo cp /opt/yoho-remote/backup/<TS>/yoho-remote-server /opt/yoho-remote/yoho-remote-server
sudo cp /opt/yoho-remote/backup/<TS>/server.env /etc/yoho-remote/server.env
sudo systemctl start yoho-remote-server
```

如需恢复 `worker`，同时恢复 worker 二进制和 `worker.env`，并等待 `server` 稳定后启动 `worker`：

```bash
sudo cp /opt/yoho-remote/backup/<TS>/yoho-remote-worker /opt/yoho-remote/yoho-remote-worker
sudo cp /opt/yoho-remote/backup/<TS>/worker.env /etc/yoho-remote/worker.env
sudo systemctl start yoho-remote-worker
```

如果本次包含 `memory` 变更，最后再按它自己的回滚步骤恢复 `memory`。

在 `server`、`worker`、`memory` 都稳定后，再到每台 daemon 机器恢复 daemon：

```bash
DAEMON_USER=yoho
DAEMON_HOME="$(getent passwd "${DAEMON_USER}" | cut -d: -f6)/.yoho-remote"
sudo cp /opt/yoho-remote/backup/<TS>/yoho-remote-daemon /opt/yoho-remote/yoho-remote-daemon
sudo test -f /opt/yoho-remote/backup/<TS>/daemon.systemd.env && sudo cp /opt/yoho-remote/backup/<TS>/daemon.systemd.env "${DAEMON_HOME}/daemon.systemd.env"
sudo systemctl start yoho-remote-daemon
```

回滚后立刻重新执行第 4 节 smoke 和 `memory` 定向验证。

### 6.3 仅 worker 出问题时的止损

如果 Web / CLI 正常，但摘要链路异常，不要第一时间全站回滚，可以先止损：

```bash
sudo systemctl stop yoho-remote-worker
```

这样会让 `summarize-turn` 暂停消费，但不影响主站登录和 session 控制。等 worker 修复后再单独恢复：

```bash
sudo systemctl start yoho-remote-worker
```

### 6.4 admin org / env 配错时

如果这次发布修改了 `ADMIN_ORG_ID`、Keycloak、`SMTP_*`、`CLI_API_TOKEN` 或 `memory` 自身配置，回滚时必须恢复对应 env；只回滚二进制不够。

## 7. 当前已知风险

上线前请明确接受以下风险，不要把 smoke 成功误判为“没有风险”：

1. **ParadeDB 不是当前上线阻断项。**
   当前 `worker` 的运行依赖仍是 PostgreSQL 基础表和索引，ParadeDB 不是必备前置；现阶段即使不启用 ParadeDB，也不应阻塞这次发布。

2. **真实 DeepSeek 质量仍需人工抽检。**
   `bun run smoke:fake-deepseek` 只能证明链路可用，不能代表真实模型输出质量。每次发布后都至少抽检 1 条真实摘要结果。

3. **worker health endpoint 需要显式配置并纳入探针。**
   `WORKER_HEALTH_PORT` 未配置时仍只能通过日志、DB 写入和 smoke 联合判断；生产发布建议开启 `/readyz` 和 `/stats`。

4. **`PG_BOSS_SCHEMA` 一致性错误很隐蔽。**
   它是最敏感的检查项之一；值一旦漂移，最常见症状不是服务直接挂掉，而是任务看起来已入队、实际没人消费。

5. **worker 存在 `429` / 超时重试放大风险。**
   `429`、`408`、`500/502/503/504` 和网络超时当前都属于瞬时错误范畴；如果上线初期同时放大 worker 实例数、并发数和流量，最容易把重试压力叠加出来。首轮发布建议只跑 1 个 worker 实例，`WORKER_CONCURRENCY=1`，并配合灰度和限流逐步放量。

6. **如果 `CLI_API_TOKEN` 发生漂移，daemon 会整体失联。**
   server/daemon 任一侧 token 与 env 不一致，`/cli/*` 和 daemon 心跳都会失败；因此 token 变更必须视为高风险操作。

## 8. 一次完整上线的最小执行序列

下面这组命令可以作为值班同学的最小执行参考：

```bash
# 1) 本地构建校验
cd /path/to/yoho-remote
bun install
bun run typecheck
bun run test
bun run build
cd worker
bun run build:exe
cd ../cli
bun run build:exe:server
bun run build:exe:daemon
cd ..

# 注意：根目录 bun run test 只覆盖 cli/server；
# worker 至少补 bun run smoke:fake-deepseek；
# memory 若有变更，补它自己的定向验证
# 上线初期只跑 1 个 worker 实例，WORKER_CONCURRENCY=1

# 2) 中心节点备份线上产物
TS="$(date +%Y%m%d%H%M%S)"
sudo mkdir -p /opt/yoho-remote/backup/"${TS}"
sudo cp /opt/yoho-remote/yoho-remote-server /opt/yoho-remote/backup/"${TS}"/
sudo cp /opt/yoho-remote/yoho-remote-worker /opt/yoho-remote/backup/"${TS}"/
sudo cp /etc/yoho-remote/server.env /opt/yoho-remote/backup/"${TS}"/
sudo cp /etc/yoho-remote/worker.env /opt/yoho-remote/backup/"${TS}"/

# 3) 中心节点发布并重启
sudo systemctl restart yoho-remote-server
sudo systemctl restart yoho-remote-worker

# 4) 如有 memory，按它自己的步骤发布
sudo systemctl restart <memory-service-unit>

# 5) 每台 daemon 机器单独发布或重启
sudo systemctl restart yoho-remote-daemon

# 6) 基础 smoke
curl -fsS "${WEBAPP_URL}/api/version"
curl -fsS -H "Authorization: Bearer ${CLI_API_TOKEN}:default" "${WEBAPP_URL}/cli/machines"

# 7) worker 摘要链路 smoke
PG_HOST=127.0.0.1 \
PG_PORT=5432 \
PG_USER=yoho_remote \
PG_PASSWORD=replace-me \
PG_DATABASE=yoho_remote \
PG_SSL=false \
PG_BOSS_SCHEMA=pgboss_smoke \
SMOKE_ALLOW_DB_WRITE=true \
SMOKE_WORKER_CONCURRENCY=1 \
bun run smoke:fake-deepseek

# 8) memory 定向验证
# 按 memory 自身既有 smoke / 健康检查 / 迁移校验执行

# 9) 日志抽样
journalctl -u yoho-remote-server -n 100 --no-pager
journalctl -u yoho-remote-worker -n 100 --no-pager
```

如果第 6、7 或 8 步失败，不要继续扩大发布范围，直接进入第 6 节回滚。
