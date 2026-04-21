# Yoho Remote E2E

P0 E2E smoke 使用 Playwright，放在独立 `e2e/` workspace。CI 主跑器只依赖 Playwright；`agent-browser` / `dogfood` 仍适合人工 QA 和证据采集，不作为 CI runner。

## 本地运行

从仓库根目录运行：

```bash
bun install
bun run e2e:smoke
```

如果 CI/本机没有 Playwright Chromium 浏览器缓存，先运行：

```bash
bunx playwright install chromium
```

也可以只在 workspace 内运行：

```bash
cd e2e
bun run smoke
```

默认 smoke 会启动两个长驻进程，并由 Playwright 在结束时清理：

- `web` Vite dev server：默认 `http://127.0.0.1:46100`
- `e2e` mock API / fake Keycloak / fake CLI Socket.IO：默认 `http://127.0.0.1:46101`

可覆盖的环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `E2E_RUN_ID` | `e2e-<timestamp>` | 本轮测试隔离 ID |
| `E2E_WEB_PORT` | `46100` | Vite 前端端口 |
| `E2E_MOCK_API_PORT` | `46101` | mock API 端口 |
| `E2E_CLI_API_TOKEN` | `e2e-cli-token` | fake CLI Socket.IO token |
| `E2E_ARTIFACTS_DIR` | `e2e/artifacts/<runId>` | run env/报告输出 |
| `E2E_DB_SCHEMA` | `e2e_<runId>` | 预留给真实 server/worker smoke 的 schema 隔离 |
| `E2E_REUSE_EXISTING_SERVER` | 未启用 | 设为 `1` 或 `true` 时才复用已有端口服务 |

Playwright artifacts 输出：

- `e2e/playwright-report/`
- `e2e/test-results/`
- `e2e/artifacts/`

`e2e/package.json` 通过 `bun run src/runPlaywright.ts` 启动 `@playwright/test/cli`。如果依赖未安装，会明确失败；不会回退到系统/Python `playwright` 命令。

`playwright.config.ts` 会在解析配置最开始固定 `E2E_RUN_ID`。同一轮的 config、webServer env、global setup/teardown、fixtures 和 tests 都读取这一个值，避免不同进程在毫秒级生成不同 runId。

## 当前 P0 覆盖

- fake Keycloak 登录闭环：`/login` -> fake auth endpoint -> `/auth/callback` -> token storage -> `/sessions`
- session 列表和详情页渲染
- 发送消息后通过 SSE 推送 `message-received` / `session-updated`，前端实时刷新
- CLI Socket.IO `/cli` namespace token 鉴权，覆盖有效/无效 token
- 下载状态展示：初始下载文件 + 发送消息后 `file-ready` 推送新增文件
- fake Keycloak JWKS/JWT contract：issuer、`azp`、JWKS 验签与当前 server 校验需求对齐
- worker fake DeepSeek smoke：复用 `server/src/smoke/fakeDeepseekSmoke.ts`；只有提供 Postgres 环境时才执行，否则 Playwright 标记 skip

## fake/mock 边界

`e2e/src/mocks/runMockApi.ts` 是 P0 轻量 harness，不替代 server 集成测试：

- fake Keycloak 实现了 auth redirect、token、refresh、logout、JWKS，JWT 使用 RS256 签名，可供当前 server 通过 `KEYCLOAK_URL` / `KEYCLOAK_INTERNAL_URL` 接入。
- mock API 只实现 web P0 路径需要的端点，不覆盖完整 server 权限、组织、license、spawn 行为。
- fake CLI Socket.IO 只覆盖 token 解析和 namespace 鉴权，不模拟完整 CLI RPC。
- DB/schema 目前写入 run env 规划；真实 server/worker full E2E 应使用 `E2E_DB_SCHEMA` 派生 `PG_BOSS_SCHEMA`，并在 teardown 中清理测试 schema。
- mock API 进程和 Vite 进程由 Playwright `webServer` 管控；global teardown 记录 run 完成状态，进程清理由 Playwright 完成。

## P0 Gaps

以下链路尚未伪装成已覆盖：

- 工具调用审批：下一步从 `server/src/web/routes/permissions.ts` 和 `web/src/components/AssistantChat/messages/SystemMessage.tsx` 切入，mock `agentState.requests` 并覆盖 approve/deny UI。
- session abort/stop：下一步从 `web/src/api/client.ts` 的 `abortSession`、`server/src/web/routes/messages.ts` / `sessions.ts` 的 abort/stop 路径切入，mock API 需要维护 active/thinking 状态变更。
- Brain callback / 子任务：下一步复用 `web/src/chat/brainChildCallback.test.ts` 的消息形态，给 mock API 增加 brain/brain-child session 组与 callback 消息。

这些 gap 不阻塞当前 P0 smoke 骨架，但应进入后续 P0+ 或 full E2E。

## CI 入口建议

当前分支的 `bun.lock` 尚未同步 `e2e` workspace 和 `@playwright/test` 依赖时，先在有网络的开发环境运行普通安装并提交更新后的 lockfile：

```bash
bun install
```

只有当 `bun.lock` 已包含 `e2e` workspace 和 Playwright 依赖后，CI/团队环境才应使用 frozen lockfile：

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun run typecheck:e2e
bun run e2e:smoke
```

Full E2E 后续再扩展为真实 server + Postgres schema + worker 的组合：

```bash
bun run e2e:full
```
