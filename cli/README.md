# yoho-remote CLI

Run Claude Code, Codex, or Gemini sessions from your terminal and control them remotely through the yoho-remote server.

## What it does

- Starts Claude Code sessions and registers them with yoho-remote-server.
- Starts Codex mode for OpenAI-based sessions.
- Starts Gemini mode via ACP (Anthropic Code Plugins).
- Provides an MCP stdio bridge for external tools.
- Manages a background daemon for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow

1. Start the server and set env vars (see ../server/README.md).
2. Set the same CLI_API_TOKEN on this machine or run `hapi auth login`.
3. Run `hapi` to start a session.
4. Use the web app or Telegram Mini App to monitor and control.

## Commands

### Session commands

- `hapi` - Start a Claude Code session (passes through Claude CLI flags). See `src/index.ts`.
- `hapi codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `hapi gemini` - Start Gemini mode via ACP. See `src/agent/runners/runAgentSession.ts`.
  Note: Gemini runs in remote mode only; it waits for messages from the server UI/Telegram.

### Authentication

- `hapi auth status` - Show authentication configuration and token source.
- `hapi auth login` - Interactively enter and save CLI_API_TOKEN.
- `hapi auth logout` - Clear saved credentials.

See `src/commands/auth.ts`.

### Daemon management

- `hapi daemon start` - Start daemon as detached process.
- `hapi daemon stop` - Stop daemon gracefully.
- `hapi daemon status` - Show daemon diagnostics.
- `hapi daemon list` - List active sessions managed by daemon.
- `hapi daemon stop-session <sessionId>` - Terminate specific session.
- `hapi daemon logs` - Print path to latest daemon log file.
- `hapi daemon install` - Install daemon as system service (Linux systemd or macOS LaunchDaemon).
- `hapi daemon uninstall` - Remove daemon system service.

See `src/daemon/run.ts`.

### Diagnostics

- `hapi doctor` - Show full diagnostics (version, daemon status, logs, processes).
- `hapi doctor clean` - Kill runaway yoho-remote processes.

See `src/ui/doctor.ts`.

### Other

- `hapi mcp` - Start MCP stdio bridge. See `src/codex/yohoRemoteMcpStdioBridge.ts`.
- `hapi server` - Start the bundled server (single binary workflow).

## Configuration

See `src/configuration.ts` for all options.

### Required

- `CLI_API_TOKEN` - Shared secret; must match the server. Can be set via env or `~/.yoho-remote/settings.json` (env wins).
- `YOHO_REMOTE_URL` - Server base URL (default: http://localhost:3006).

### Optional

- `YOHO_REMOTE_HOME` - Config/data directory (default: ~/.yoho-remote).
- `YR_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `YR_CLAUDE_PATH` - Path to a specific `claude` executable.
- `YR_HTTP_MCP_URL` - Default MCP target for `hapi mcp`.
- `YR_LANGFUSE_PUBLIC_KEY`/`LANGFUSE_PUBLIC_KEY` - Langfuse public key (enables OTLP tracing from Claude hooks).
- `YR_LANGFUSE_SECRET_KEY`/`LANGFUSE_SECRET_KEY` - Langfuse secret key.
- `YR_LANGFUSE_BASE_URL`/`LANGFUSE_BASE_URL` - Langfuse base URL (default: https://cloud.langfuse.com).
- `YR_LANGFUSE_HOST`/`LANGFUSE_HOST` - Alias for base URL.
- `YR_LANGFUSE_OTEL_ENDPOINT`/`LANGFUSE_OTEL_ENDPOINT` - Override OTLP endpoint (default: /api/public/otel/v1/traces).
- `YR_MCP_EVENT_LOG` - Enable MCP event logging (true/1/yes, default: true).
- `YR_MCP_EVENT_LOG_SAMPLE`/`YR_MCP_EVENT_LOG_SAMPLE_RATE` - Sampling rate for MCP event logs (0..1, default: 1).

### Daemon

- `YR_DAEMON_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 60000).
- `YR_DAEMON_HTTP_TIMEOUT` - HTTP timeout for daemon control in ms (default: 10000).

## Storage

Data is stored in `~/.yoho-remote/` (or `$YOHO_REMOTE_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `daemon.state.json` - Daemon state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Bun for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

## Source structure

- `src/api/` - Bot communication (Socket.IO + REST).
- `src/claude/` - Claude Code integration.
- `src/codex/` - Codex mode integration.
- `src/agent/` - Multi-agent support (Gemini via ACP).
- `src/daemon/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Related docs

- `../server/README.md`
- `../web/README.md`
