# yoho-remote-server

Telegram bot + HTTP API + realtime updates for yoho-remote.

## What it does

- Telegram bot for notifications and the Mini App entrypoint.
- HTTP API for sessions, messages, permissions, machines, and files.
- Server-Sent Events stream for live updates in the web app.
- Socket.IO channel for CLI connections.
- Serves the web app from `web/dist` or embedded assets in the single binary.
- Persists state in PostgreSQL.

## Configuration

See `src/configuration.ts` for all options.

### Required

- `CLI_API_TOKEN` - Shared secret used by CLI and daemon connections.
- `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`/`PG_DATABASE`/`PG_BOSS_SCHEMA` - PostgreSQL connection settings and pg-boss schema. These must now be set explicitly; the server no longer falls back to localhost/postgres/yoho_remote/pgboss.
- `KEYCLOAK_URL`/`KEYCLOAK_REALM`/`KEYCLOAK_CLIENT_ID`/`KEYCLOAK_CLIENT_SECRET` - Browser/PWA SSO settings.

### Optional (Telegram)

- `TELEGRAM_BOT_TOKEN` - Token from @BotFather.
- `WEBAPP_URL` - Public HTTPS URL for Telegram Mini App access. Also used to derive default CORS origins for the web app.

### Optional (Feishu/Lark Speech-to-Text)

- `FEISHU_APP_ID` - Feishu/Lark app ID (speech-to-text).
- `FEISHU_APP_SECRET` - Feishu/Lark app secret (speech-to-text).
- `FEISHU_BASE_URL` - Feishu/Lark OpenAPI base URL (default: https://open.feishu.cn).

### Optional

- `WEBAPP_PORT` - HTTP port (default: 3006).
- `CORS_ORIGINS` - Comma-separated origins, or `*`.
- `YOHO_REMOTE_HOME` - Data directory (default: ~/.yoho-remote).
- `KEYCLOAK_INTERNAL_URL` - Internal Keycloak URL for JWKS/token exchange.
- `ADMIN_ORG_ID` - Organization ID that can manage licenses and is exempt from license checks.
- `WEB_URL` - Public web origin used in invitation emails.
- `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM` - Email invitation settings.

## Running

Binary (single executable):

```bash
export TELEGRAM_BOT_TOKEN="..."
export CLI_API_TOKEN="shared-secret"
export WEBAPP_URL="https://your-domain.example"
export PG_HOST="127.0.0.1"
export PG_PORT="5432"
export PG_USER="yoho_remote"
export PG_PASSWORD="..."
export PG_DATABASE="yoho_remote"
export PG_BOSS_SCHEMA="pgboss"
export KEYCLOAK_URL="https://sso.example.com"
export KEYCLOAK_REALM="yoho"
export KEYCLOAK_CLIENT_ID="yoho-remote"
export KEYCLOAK_CLIENT_SECRET="..."

hapi server
```

If you only need web + CLI, you can omit TELEGRAM_BOT_TOKEN.
To enable Telegram, set TELEGRAM_BOT_TOKEN and WEBAPP_URL, start the server, open `/app`
in the bot chat, and bind the Mini App with `CLI_API_TOKEN:<namespace>` when prompted.

From source:

```bash
bun install
bun run dev:server
```

## HTTP API

See `src/web/routes/` for all endpoints.

### Authentication (`src/web/routes/keycloak-auth.ts`)

- `POST /api/auth/keycloak` - Get Keycloak login URL.
- `POST /api/auth/keycloak/callback` - Exchange authorization code for tokens.
- `POST /api/auth/keycloak/refresh` - Refresh Keycloak access token.
- `POST /api/auth/keycloak/logout` - Get Keycloak logout URL.

### Sessions (`src/web/routes/sessions.ts`)

- `GET /api/sessions` - List all sessions.
- `GET /api/sessions/:id` - Get session details.
- `POST /api/sessions` - Spawn a new session on a machine.
- `POST /api/sessions/:id/abort` - Abort session.
- `POST /api/sessions/:id/switch` - Switch session mode (remote/local).
- `POST /api/sessions/:id/permission-mode` - Set permission mode.
- `POST /api/sessions/:id/model` - Set model preference.

### Messages (`src/web/routes/messages.ts`)

- `GET /api/sessions/:id/messages` - Get messages (paginated).
- `POST /api/sessions/:id/messages` - Send message.

### Permissions (`src/web/routes/permissions.ts`)

- `POST /api/sessions/:id/permissions/:requestId/approve` - Approve permission.
- `POST /api/sessions/:id/permissions/:requestId/deny` - Deny permission.

### Machines (`src/web/routes/machines.ts`)

- `GET /api/machines` - List online machines.
- `POST /api/machines/:id/spawn` - Spawn new session on machine.

### Git/Files (`src/web/routes/git.ts`)

- `GET /api/sessions/:id/git-status` - Git status.
- `GET /api/sessions/:id/git-diff-numstat` - Diff summary.
- `GET /api/sessions/:id/git-diff-file` - File-specific diff.
- `GET /api/sessions/:id/file` - Read file content.
- `GET /api/sessions/:id/files` - File search with ripgrep.

### Events (`src/web/routes/events.ts`)

- `GET /api/events` - SSE stream for live updates.

### CLI (`src/web/routes/cli.ts`)

- `POST /cli/sessions` - Create/load session.
- `GET /cli/sessions/:id` - Get session by ID.
- `POST /cli/machines` - Create/load machine.
- `GET /cli/machines/:id` - Get machine by ID.

### Speech-to-Text (`src/web/routes/speech.ts`)

- `POST /api/speech-to-text/stream` - Stream audio chunks to Feishu/Lark ASR.

## Socket.IO

See `src/socket/handlers/cli.ts` for event handlers.

Namespace: `/cli`

### Client events (CLI to server)

- `message` - Send message to session.
- `update-metadata` - Update session metadata.
- `update-state` - Update agent state.
- `session-alive` - Keep session active.
- `session-end` - Mark session ended.
- `machine-alive` - Keep machine online.
- `rpc-register` - Register RPC handler.
- `rpc-unregister` - Unregister RPC handler.

### Server events (server to clients)

- `update` - Broadcast session/message updates.
- `rpc-request` - Incoming RPC call.

See `src/socket/rpcRegistry.ts` for RPC routing.

Namespace: `/events`

### Server events (server to clients)

- `event` - Broadcast SyncEvent updates for the authenticated namespace.

## Telegram Bot

See `src/telegram/bot.ts` for bot implementation.

### Commands

- `/start` - Welcome message with Mini App link.
- `/app` - Open Mini App.

### Features

- Permission request notifications with approve/deny buttons.
- Session ready notifications.
- Deep links to Mini App sessions.

See `src/telegram/callbacks.ts` for button handlers.

## Core Logic

See `src/sync/syncEngine.ts` for the main session/message manager:

- In-memory session cache with versioning.
- Message pagination and retrieval.
- Permission approval/denial.
- RPC method routing via Socket.IO.
- Event publishing to SSE and Telegram.
- Git operations and file search.
- Activity tracking and timeouts.

## Storage

See `src/store/index.ts` for PostgreSQL persistence:

- Sessions with metadata and agent state.
- Messages with pagination support.
- Machines with daemon state.
- Todo extraction from messages.
- Users table for Telegram bindings (includes namespace).

## Cleanup offline sessions

Use this Node script to list or delete offline sessions shown in the web UI (it talks to the running server API):

```bash
node server/scripts/cleanup-offline-sessions.js
```

Options:
- `--delete` actually deletes; default is dry-run.
- `--force` passes `force=1` to remove SyncEngine in-memory sessions even if the DB row is gone.
- `--min-idle-minutes=N` filters by idle time.
- `--namespace=NAME` targets a specific namespace when using a base token.

Examples:

```bash
node server/scripts/cleanup-offline-sessions.js --min-idle-minutes=60
node server/scripts/cleanup-offline-sessions.js --delete --force --yes
```

The script uses `CLI_API_TOKEN` (or `~/.yoho-remote/settings.json`) to authenticate and defaults to `http://localhost:3006`.

## Source structure

- `src/web/` - HTTP server and routes.
- `src/socket/` - Socket.IO setup and handlers.
- `src/telegram/` - Telegram bot.
- `src/sync/` - Core session/message logic.
- `src/store/` - PostgreSQL persistence.
- `src/sse/` - Server-Sent Events.

## Security model

Access is controlled by:
- Browser/PWA: Keycloak access tokens.
- CLI/daemon: `CLI_API_TOKEN`.

Transport security depends on HTTPS in front of the server.

## Build for deployment

From the repo root:

```bash
bun run build:server
bun run build:web
```

The server build output is `server/dist/index.js`, and the web assets are in `web/dist`.

## Networking notes

- Telegram Mini Apps require HTTPS and a public URL. If the server has no public IP, use Cloudflare Tunnel or Tailscale and set `WEBAPP_URL` to the HTTPS endpoint.
- If the web app is hosted on a different origin, set `CORS_ORIGINS` (or `WEBAPP_URL`) to include that static host origin.

## Standalone web hosting

The web UI can be hosted separately from the server (for example on GitHub Pages or Cloudflare Pages):

1. Build and deploy `web/dist` from the repo root.
2. Set `CORS_ORIGINS` (or `WEBAPP_URL`) to the static host origin.
3. Open the static site, click the Server button on the login screen, and enter the yoho-remote server origin.

Leaving the server override empty preserves the default same-origin behavior when the server serves the web assets directly.
