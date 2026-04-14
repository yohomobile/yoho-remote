# External Deployment

This guide covers the split deployment model:

- `yoho-remote-server` runs on your public server, for example `https://remote.ccqiao.com`
- `yoho-remote-daemon` runs on one or more external worker machines
- Browser/PWA access uses Keycloak SSO
- CLI/daemon access still uses `CLI_API_TOKEN`

## Build artifacts

From the repo root:

```bash
bun install
bun run build
cd cli
bun run build:exe:server
bun run build:exe:daemon
```

This produces:

- `cli/dist-exe/.../yoho-remote`
- `cli/dist-exe/.../yoho-remote-server`
- `cli/dist-exe/.../yoho-remote-daemon`
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

## Server systemd

Use the template in repo root as a starting point:

- `yoho-remote-server.service`
- `yoho-remote-daemon.service`

Recommended layout:

- binaries in `/opt/yoho-remote/`
- env files in `/etc/yoho-remote/`
- runtime state in `/var/lib/yoho-remote/`

## Daemon machines

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
