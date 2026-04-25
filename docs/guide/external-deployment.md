# External Deployment

This guide covers the split deployment model:

- `yoho-remote-server` runs on your public server, for example `https://remote.ccqiao.com`
- `yoho-remote-daemon` runs on one or more external worker machines
- Browser/PWA access uses Keycloak SSO
- CLI/daemon access still uses `CLI_API_TOKEN`

Before any production rollout, execute the pre-deploy checklist in [Deployment Runbook](./deployment-runbook.md).

## Build artifacts

From the repo root:

```bash
bun install
bun run build
cd cli
bun run build:exe:server
bun run build:exe:daemon
cd ../worker
bun run build:exe
```

This produces:

- `cli/dist-exe/.../yoho-remote`
- `cli/dist-exe/.../yoho-remote-server`
- `cli/dist-exe/.../yoho-remote-daemon`
- `worker/dist-exe/yoho-remote-worker`
- `server/dist/index.js`
- `web/dist/`

## Server environment

Example `server.env`:

```bash
CLI_API_TOKEN=replace-with-a-strong-secret
WEBAPP_PORT=3006
WEBAPP_URL=https://remote.ccqiao.com
CORS_ORIGINS=https://remote.ccqiao.com
WEB_URL=https://remote.ccqiao.com

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

SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=mailer@example.com
SMTP_PASSWORD=replace-me
SMTP_FROM=Yoho Remote <mailer@example.com>
```

Notes:

- `CLI_API_TOKEN` is used by CLI and daemon, not by browser login.
- Browser/PWA login uses Keycloak SSO.
- `WEB_URL` is used in invitation emails.
- `SMTP_*` is optional but required for email invitations.
- `PG_*` 与 `PG_BOSS_SCHEMA` 必须显式提供；server/worker 不再回落到本地默认 PostgreSQL 配置。

## Worker environment

Example `worker.env`:

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

Notes:

- `DEEPSEEK_API_KEY` is required; without it the worker exits during startup.
- `PG_BOSS_SCHEMA` must match `server.env` exactly.
- `YOHO_MEMORY_HTTP_AUTH_TOKEN` must match the yoho-memory HTTP server token when summary-to-memory integration is enabled.

## Server systemd

Use the template in repo root as a starting point:

- `yoho-remote-server.service`
- `yoho-remote-worker.service`
- `yoho-remote-daemon.service`
- `yoho-remote-server.env.example`
- `yoho-remote-worker.env.example`
- `yoho-remote-daemon.systemd.env.example`

Recommended layout:

- server/worker binaries in `/opt/yoho-remote/`
- server/worker env files in `/etc/yoho-remote/`
- runtime state in `/var/lib/yoho-remote/`
- daemon env file in `~/.yoho-remote/daemon.systemd.env`

Recommended central-node install commands:

```bash
sudo install -d -m 0755 /opt/yoho-remote /etc/yoho-remote /var/lib/yoho-remote
sudo install -m 0755 cli/dist-exe/<target>/yoho-remote-server /opt/yoho-remote/yoho-remote-server
sudo install -m 0755 worker/dist-exe/yoho-remote-worker /opt/yoho-remote/yoho-remote-worker
sudo install -m 0644 yoho-remote-server.service /etc/systemd/system/yoho-remote-server.service
sudo install -m 0644 yoho-remote-worker.service /etc/systemd/system/yoho-remote-worker.service
sudo install -m 0600 yoho-remote-server.env.example /etc/yoho-remote/server.env
sudo install -m 0600 yoho-remote-worker.env.example /etc/yoho-remote/worker.env
```

Then edit `/etc/yoho-remote/server.env` and `/etc/yoho-remote/worker.env` with real secrets before starting the services.

## Daemon machines

### Linux user-systemd prerequisite (one-time, per machine)

The daemon launches every session inside its own transient `systemd-run --user
--scope` cgroup so that `systemctl restart yoho-remote-daemon` does not SIGKILL
live sessions via `KillMode=control-group`. The per-user systemd manager must
therefore be reachable. Run this once on each daemon machine before the first
deploy:

```bash
sudo loginctl enable-linger $USER
# wait 1-3 seconds for /run/user/$(id -u)/systemd/private to appear
systemd-run --user --scope --collect --quiet --unit=preflight-$$ -- true && echo OK
```

`deploy.sh daemon|all` and `scripts/reinstall-daemon-systemd.sh` both refuse
to install the daemon if this preflight fails — they will not silently fall
back to the parent cgroup. See `docs/guide/deployment-runbook.md` § 2.3.1
for the full diagnose checklist.

### Daemon install

On each worker machine:

```bash
export CLI_API_TOKEN=replace-with-the-same-secret
export YOHO_REMOTE_URL=https://remote.ccqiao.com
hapi auth login
sudo hapi daemon install
```

On Linux, `hapi daemon install` writes:

- systemd unit: `/etc/systemd/system/yoho-remote-daemon.service`
- env file: `~/.yoho-remote/daemon.systemd.env`

Re-running `sudo hapi daemon install` is the supported upgrade path for daemon systemd changes: it rewrites the managed unit, refreshes the persisted daemon environment, and restarts the service when either one changes.

If you manage the daemon service manually instead of `hapi daemon install`, keep the same env file path and update the repo-root `yoho-remote-daemon.service` template to the actual service user home directory.

Check status:

```bash
systemctl status yoho-remote-daemon.service
journalctl -u yoho-remote-daemon.service -f
```

## Admin org bootstrap

1. Start the server with Keycloak and PostgreSQL configured.
2. Sign in through the web UI with the first admin user.
3. Create an organization in Settings, for example `platform-admin`.
4. Resolve and persist that org as the admin org:

```bash
cd server
bun run bootstrap:admin-org -- --slug platform-admin --env-file /etc/yoho-remote/server.env
```

5. Restart `yoho-remote-server`.
6. Sign back in and open Settings for the admin org.
7. Use the new **License Admin** panel to issue licenses for customer organizations.

The admin org itself is license-exempt once `ADMIN_ORG_ID` is configured.
