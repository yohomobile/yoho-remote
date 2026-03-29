# yoho-remote CLI Daemon: Control Flow and Lifecycle

The daemon is a persistent background process that manages yoho-remote sessions, enables remote control from the mobile app, and handles auto-updates when the CLI version changes.

## 1. Daemon Lifecycle

### Starting the Daemon

Command: `hapi daemon start`

Control Flow:
1. `src/index.ts` receives `daemon start` command
2. Spawns detached process via `spawnYohoRemoteCLI(['daemon', 'start-sync'], { detached: true })`
3. New process calls `startDaemon()` from `src/daemon/run.ts`
4. `startDaemon()` performs startup:
   - Sets up shutdown promise and handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
   - Version check: `isDaemonRunningCurrentlyInstalledVersion()` compares CLI binary mtime
   - If version mismatch: calls `stopDaemon()` to kill old daemon before proceeding
   - If same version running: exits with "Daemon already running"
   - Lock acquisition: `acquireDaemonLock()` creates exclusive lock file to prevent multiple daemons
   - Direct-connect setup: `authAndSetupMachineIfNeeded()` ensures `CLI_API_TOKEN` is set and `machineId` exists
   - State persistence: writes PID, version, HTTP port, mtime to daemon.state.json
   - HTTP server: starts Fastify on random port for local CLI control (list, stop, spawn)
   - WebSocket: establishes persistent connection to backend via `ApiMachineClient`
   - RPC registration: exposes `spawn-yoho-remote-session`, `stop-session`, `stop-daemon` handlers
   - Heartbeat loop: every 60s (or `YR_DAEMON_HEARTBEAT_INTERVAL`) checks for version updates, prunes dead sessions, verifies PID ownership
5. Awaits shutdown promise which resolves when:
   - OS signal received (SIGINT/SIGTERM) - source: `os-signal`
   - HTTP `/stop` endpoint called - source: `yoho-remote-cli`
   - RPC `stop-daemon` invoked - source: `yoho-remote-app`
   - Uncaught exception occurs - source: `exception`
6. On shutdown, `cleanupAndShutdown()` performs:
   - Clears heartbeat interval
   - Updates daemon state to "shutting-down" on backend with shutdown source
   - Disconnects WebSocket
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
   - Exits process

### Version Detection & Auto-Update

The daemon detects when CLI binary changes (e.g., after `npm upgrade hapi`):
1. At startup, records `startedWithCliMtimeMs` (file modification time of CLI binary)
2. Heartbeat compares current CLI mtime with recorded mtime via `getInstalledCliMtimeMs()`
3. If mtime changed:
   - Clears heartbeat interval
   - Spawns new daemon via `spawnYohoRemoteCLI(['daemon', 'start'])`
   - Waits 10 seconds to be killed by new daemon
4. New daemon starts, sees old daemon running with different mtime
5. New daemon calls `stopDaemon()` which tries HTTP `/stop`, falls back to SIGKILL
6. New daemon takes over

### Heartbeat System

Every 60 seconds (configurable via `YR_DAEMON_HEARTBEAT_INTERVAL`):
1. **Guard**: Skips if previous heartbeat still running (prevents concurrent heartbeats)
2. **Session Pruning**: Checks each tracked PID with `isProcessAlive(pid)`, removes dead sessions
3. **Version Check**: Compares CLI binary mtime, triggers self-restart if changed
4. **PID Ownership**: Verifies daemon still owns state file, self-terminates if another daemon took over
5. **State Update**: Writes `lastHeartbeat` timestamp to daemon.state.json

### Stopping the Daemon

Command: `hapi daemon stop`

Control Flow:
1. `stopDaemon()` in `controlClient.ts` reads daemon.state.json
2. Attempts graceful shutdown via HTTP POST to `/stop`
3. Daemon receives request, triggers shutdown with source `yoho-remote-cli`
4. `cleanupAndShutdown()` executes:
   - Updates backend status to "shutting-down"
   - Closes WebSocket connection
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
5. If HTTP fails, falls back to `killProcess(pid, true)` (uses `taskkill /T /F` on Windows)

## 2. Multi-Agent Support

The daemon supports spawning sessions with different AI agents:

| Agent | Command | Token Environment |
|-------|---------|-------------------|
| `claude` (default) | `hapi claude` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | `hapi codex` | `CODEX_HOME` (temp directory with `auth.json`) |
| `gemini` | `hapi gemini` | - |

### Token Authentication

When spawning a session with a token:
- **Claude**: Sets `CLAUDE_CODE_OAUTH_TOKEN` environment variable
- **Codex**: Creates temp directory at `os.tmpdir()/yr-codex-*`, writes token to `auth.json`, sets `CODEX_HOME`

## 3. Session Management

### Daemon-Spawned Sessions (Remote)

Initiated by mobile app via backend RPC:
1. Backend forwards RPC `spawn-yoho-remote-session` to daemon via WebSocket
2. `ApiMachineClient` invokes `spawnSession()` handler
3. `spawnSession()`:
   - Validates/creates directory (with approval flow)
   - Configures agent-specific token environment
   - Spawns detached yoho-remote process with `--hapi-starting-mode remote --started-by daemon`
   - Adds to `pidToTrackedSession` map
   - Sets up 15-second awaiter for session webhook
4. New yoho-remote process:
   - Creates session with backend, receives `yohoRemoteSessionId`
   - Calls `notifyDaemonSessionStarted()` to POST to daemon's `/session-started`
5. Daemon updates tracking with `yohoRemoteSessionId`, resolves awaiter
6. RPC returns session info to mobile app

### Terminal-Spawned Sessions

User runs `hapi` directly:
1. CLI auto-starts daemon if configured
2. yoho-remote process calls `notifyDaemonSessionStarted()`
3. Daemon receives webhook, creates `TrackedSession` with `startedBy: 'hapi directly - likely by user from terminal'`
4. Session tracked for health monitoring

### Directory Creation Approval

When spawning a session, directory handling:
1. Check if directory exists with `fs.access()`
2. If missing and `approvedNewDirectoryCreation = false`: returns `requestToApproveDirectoryCreation` (HTTP 409)
3. If missing and approved: creates directory with `fs.mkdir({ recursive: true })`
4. Error handling for directory creation:
   - `EACCES`: Permission denied
   - `ENOTDIR`: File exists at path
   - `ENOSPC`: Disk full
   - `EROFS`: Read-only filesystem

### Session Termination

Via RPC `stop-session` or HTTP `/stop-session`:
1. `stopSession()` finds session by `yohoRemoteSessionId` or `PID-{pid}` format
2. Sends termination request via `killProcessByChildProcess()` or `killProcess()` (Windows uses `taskkill /T`)
3. `on('exit')` handler removes from tracking map

## 4. HTTP Control Server (Fastify)

Local HTTP server using Fastify with `fastify-type-provider-zod` for type-safe request/response validation.

**Host:** 127.0.0.1 (localhost only)
**Port:** Dynamic (system-assigned)

### Endpoints

#### POST `/session-started`
Session webhook - reports itself after creation.

**Request:**
```json
{ "sessionId": "string", "metadata": { ... } }
```
**Response (200):**
```json
{ "status": "ok" }
```

#### POST `/list`
Returns all tracked sessions.

**Response (200):**
```json
{
  "children": [
    { "startedBy": "daemon", "yohoRemoteSessionId": "uuid", "pid": 12345 }
  ]
}
```

#### POST `/stop-session`
Terminates a specific session.

**Request:**
```json
{ "sessionId": "string" }
```
**Response (200):**
```json
{ "success": true }
```

#### POST `/spawn-session`
Creates a new session.

**Request:**
```json
{ "directory": "/path/to/dir", "sessionId": "optional-uuid" }
```
**Response (200) - Success:**
```json
{
  "success": true,
  "sessionId": "uuid",
  "approvedNewDirectoryCreation": true
}
```
**Response (409) - Requires Approval:**
```json
{
  "success": false,
  "requiresUserApproval": true,
  "actionRequired": "CREATE_DIRECTORY",
  "directory": "/path/to/dir"
}
```
**Response (500) - Error:**
```json
{ "success": false, "error": "Error message" }
```

#### POST `/stop`
Graceful daemon shutdown.

**Response (200):**
```json
{ "status": "stopping" }
```

## 5. State Persistence

### daemon.state.json
```json
{
  "pid": 12345,
  "httpPort": 50097,
  "startTime": "8/24/2025, 6:46:22 PM",
  "startedWithCliVersion": "v2026.01.02.1338",
  "startedWithCliMtimeMs": 1724531182000,
  "lastHeartbeat": "8/24/2025, 6:47:22 PM",
  "daemonLogPath": "/path/to/daemon.log"
}
```

### Lock File
- Created with O_EXCL flag for atomic acquisition
- Contains PID for debugging
- Prevents multiple daemon instances
- Cleaned up on graceful shutdown

## 6. WebSocket Communication

`ApiMachineClient` handles bidirectional communication:

**Daemon to Server:**
- `machine-alive` - 20-second heartbeat
- `machine-update-metadata` - static machine info changes
- `machine-update-state` - daemon status changes

**Server to Daemon:**
- `rpc-request` with methods:
  - `spawn-yoho-remote-session` - spawn new session
  - `stop-session` - stop session by ID
  - `stop-daemon` - request shutdown

All data is plain JSON over TLS; authentication is `CLI_API_TOKEN` (no end-to-end encryption).

## 7. Process Discovery and Cleanup

### Doctor Command

`hapi doctor` uses `ps aux | grep` to find all yoho-remote processes:
- Production: matches `hapi` binary, `happy-coder`
- Development: matches `src/index.ts` (run via `bun`)
- Categorizes by command args: daemon, daemon-spawned, user-session, doctor

### Clean Runaway Processes

`hapi doctor clean`:
1. `findRunawayYohoRemoteProcesses()` filters for likely orphans
2. `killRunawayYohoRemoteProcesses()`:
   - Sends SIGTERM
   - Waits 1 second
   - Sends SIGKILL if still alive

## 8. Integration Testing

### Test Environment
- Requires `.env.integration-test`
- Uses local yoho-remote-server (http://localhost:3006)
- Separate `~/.yoho-remote-dev-test` home directory

### Key Test Scenarios
- Session listing, spawning, stopping
- External session webhook tracking
- Graceful SIGTERM/SIGKILL shutdown
- Multiple daemon prevention
- Version mismatch detection
- Directory creation approval flow
- Concurrent session stress tests

---

# Machine Sync Architecture - Separated Metadata & Daemon State

> Direct-connect note: the "server" is `yoho-remote-server`, payloads are plain JSON (no base64/encryption),
> and authentication uses `CLI_API_TOKEN` (REST `Authorization: Bearer ...` + Socket.IO `handshake.auth.token`).

## Data Structure (Similar to Session's metadata + agentState)

```typescript
// Static machine information (rarely changes)
interface MachineMetadata {
  host: string;              // hostname
  platform: string;          // darwin, linux, win32
  yohoRemoteCliVersion: string;
  homeDir: string;
  yohoRemoteHomeDir: string;
  yohoRemoteLibDir: string;       // runtime path
}

// Dynamic daemon state (frequently updated)
interface DaemonState {
  status: 'running' | 'shutting-down' | 'offline';
  pid?: number;
  httpPort?: number;
  startedAt?: number;
  shutdownRequestedAt?: number;
  shutdownSource?: 'yoho-remote-app' | 'yoho-remote-cli' | 'os-signal' | 'exception';
}
```

## 1. CLI Startup Phase

Checks if machine ID exists in settings:
- If not: creates ID locally only (so sessions can reference it)
- Does NOT create machine on server - that's daemon's job
- CLI doesn't manage machine details - all API & schema live in daemon subpackage

## 2. Daemon Startup - Initial Registration

### REST Request: `POST /cli/machines`
```json
{
  "id": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "yohoRemoteCliVersion": "v2026.01.02.1338",
    "homeDir": "/Users/john",
    "yohoRemoteHomeDir": "/Users/john/.yoho-remote",
    "yohoRemoteLibDir": "/usr/local/lib/node_modules/hapi"
  },
  "daemonState": {
    "status": "running",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567
  }
}
```

### Server Response:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "yohoRemoteCliVersion": "..." },
    "metadataVersion": 1,
    "daemonState": { "status": "running", "pid": 12345 },
    "daemonStateVersion": 1,
    "active": true,
    "activeAt": 1703001234567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001234567
  }
}
```

## 3. WebSocket Connection & Real-time Updates

### Connection Handshake:
```javascript
io(`${botUrl}/cli`, {
  auth: {
    token: "CLI_API_TOKEN",
    clientType: "machine-scoped",
    machineId: "machine-uuid-123"
  },
  path: "/socket.io/",
  transports: ["websocket"]
})
```

### Heartbeat (every 20s):
```json
// Client -> Server
socket.emit('machine-alive', {
  "machineId": "machine-uuid-123",
  "time": 1703001234567
})
```

## 4. Daemon State Updates (via WebSocket)

### When daemon status changes:
```json
// Client -> Server
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123",
  "daemonState": {
    "status": "shutting-down",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567,
    "shutdownRequestedAt": 1703001244567,
    "shutdownSource": "yoho-remote-app"
  },
  "expectedVersion": 1
}, callback)

// Server -> Client (callback)
// Success:
{
  "result": "success",
  "version": 2,
  "daemonState": { "status": "shutting-down" }
}

// Version mismatch:
{
  "result": "version-mismatch",
  "version": 3,
  "daemonState": { "status": "running" }
}
```

### Machine metadata update (rare):
```json
// Client -> Server
socket.emit('machine-update-metadata', {
  "machineId": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "yohoRemoteCliVersion": "v2026.01.02.1340",
    "homeDir": "/Users/john",
    "yohoRemoteHomeDir": "/Users/john/.yoho-remote"
  },
  "expectedVersion": 1
}, callback)
```

## 5. Mini App RPC Calls (via yoho-remote-server)

The Telegram Mini App calls REST endpoints on `yoho-remote-server` (for example `POST /api/machines/:id/spawn`).
`yoho-remote-server` then relays those requests to the daemon via Socket.IO `rpc-request` on the `/cli` namespace.

RPC method naming (machine-scoped) uses a `${machineId}:` prefix, for example:
- `${machineId}:spawn-yoho-remote-session`

## 6. Server Broadcasts to Clients

### When daemon state changes:
```json
// Server -> Mobile/Web clients
socket.emit('update', {
  "id": "update-id-xyz",
  "seq": 456,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "daemonState": {
      "value": { "status": "shutting-down" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

### When metadata changes:
```json
socket.emit('update', {
  "id": "update-id-abc",
  "seq": 457,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "metadata": {
      "value": { "host": "MacBook-Pro.local" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

## 7. GET Machine Status (REST)

### Request: `GET /cli/machines/machine-uuid-123`
```http
Authorization: Bearer <CLI_API_TOKEN>
```

### Response:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "yohoRemoteCliVersion": "..." },
    "metadataVersion": 2,
    "daemonState": { "status": "running", "pid": 12345 },
    "daemonStateVersion": 3,
    "active": true,
    "activeAt": 1703001244567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001244567
  }
}
```

## Key Design Decisions

1. **Separation of Concerns**:
   - `metadata`: Static machine info (host, platform, versions)
   - `daemonState`: Dynamic runtime state (status, pid, ports)

2. **Independent Versioning**:
   - `metadataVersion`: For machine metadata updates
   - `daemonStateVersion`: For daemon state updates
   - Allows concurrent updates without conflicts

3. **Security**: No end-to-end encryption (TLS only); CLI auth is a shared secret `CLI_API_TOKEN`

4. **Update Events**: Server broadcasts use same pattern as sessions:
   - `t: 'update-machine'` with optional metadata and/or daemonState fields
   - Clients only receive updates for fields that changed

5. **RPC Pattern**: Machine-scoped RPC methods prefixed with machineId (like sessions)

---

# Improvements

- daemon.state.json file is getting hard removed when daemon exits or is stopped. We should keep it around and have 'state' field and 'stateReason' field that will explain why the daemon is in that state
- If the file is not found - we assume the daemon was never started or was cleaned out by the user or doctor
- If the file is found and corrupted - we should try to upgrade it to the latest version? or simply remove it if we have write access

- posts helpers for daemon do not return typed results
- I don't like that daemonPost returns either response from daemon or { error: ... }. We should have consistent envelope type

- we loose track of children processes when daemon exits / restarts - we should write them to the same state file? At least the pids should be there for doctor & cleanup

- the daemon control server binds to `127.0.0.1` on a random port; if we ever expose it beyond localhost, require an explicit auth token/header

---

# Split Deployment Architecture

For server deployments, yoho-remote uses a split executable architecture that allows updating the server/frontend without restarting the daemon (and thus keeping sessions online).

## Executables

| Executable | Purpose | Systemd Service |
|------------|---------|-----------------|
| `yoho-remote-server` | Web frontend + REST API | `yoho-remote-server.service` |
| `yoho-remote-daemon` | Session management, WebSocket to server | `yoho-remote-daemon.service` |
| `hapi` | Main CLI, used by daemon to spawn sessions | (not a service) |

## Build Commands

```bash
# In cli/ directory:
bun run build:exe:server    # Build yoho-remote-server (with embedded web assets)
bun run build:exe:daemon    # Build yoho-remote-daemon
bun run build:exe           # Build hapi (main CLI)
```

## Version Detection

In split deployment mode, version detection uses `yoho-remote-daemon`'s mtime exclusively:

- `getInstalledCliMtimeMs()` checks if `yoho-remote-daemon` exists alongside the current executable
- If found, returns `yoho-remote-daemon`'s mtime (not the current executable's mtime)
- This ensures consistent version detection whether called from `hapi` or `yoho-remote-daemon`

## Session Spawning

When `yoho-remote-daemon` needs to spawn a session:

1. `spawnYohoRemoteCLI()` detects it's running as `yoho-remote-daemon` (standalone mode)
2. Uses the `hapi` executable in the same directory instead of `process.execPath`
3. Spawns: `hapi claude --hapi-starting-mode remote --started-by daemon`

## Deployment Script

```bash
./deploy.sh           # Build server + CLI, restart server only (sessions stay online)
./deploy.sh --daemon  # Build all + restart daemon (sessions will disconnect)
```

### What Gets Built

| Command | Builds | Restarts | Sessions |
|---------|--------|----------|----------|
| `./deploy.sh` | `yoho-remote-server`, `hapi` | server only | Stay online |
| `./deploy.sh --daemon` | `yoho-remote-server`, `hapi`, `yoho-remote-daemon` | server + daemon | Disconnect |

### When to Use `--daemon`

Only use `--daemon` when:
- Changed daemon-specific code (`src/daemon/*.ts`)
- Changed version detection logic
- Changed session spawning logic
- Need to force-restart all sessions

For frontend/API changes, the default `./deploy.sh` is sufficient.

## Systemd Service Configuration

```ini
# /etc/systemd/system/yoho-remote-server.service
[Service]
ExecStart=/path/to/cli/dist-exe/bun-linux-x64/yoho-remote-server

# /etc/systemd/system/yoho-remote-daemon.service
[Service]
ExecStart=/path/to/cli/dist-exe/bun-linux-x64/yoho-remote-daemon
Restart=always
RestartSec=10
```

## Key Files Modified for Split Deployment

1. **`cli/src/bootstrap-server.ts`** - Standalone server entry point
2. **`cli/src/bootstrap-daemon.ts`** - Standalone daemon entry point
3. **`cli/scripts/build-executable.ts`** - Supports `--name` parameter for different executables
4. **`cli/src/daemon/controlClient.ts`** - `getInstalledCliMtimeMs()` checks `yoho-remote-daemon` mtime
5. **`cli/src/utils/spawnYohoRemoteCLI.ts`** - Detects standalone mode, uses correct executable
6. **`deploy.sh`** - Selective build and restart logic
