# Installation

Install the Yoho Remote CLI and set up the server.

## Prerequisites

- Claude Code, OpenAI Codex CLI, or Google Gemini CLI installed

## Install the CLI

```bash
npm install -g @twsxtd/hapi
```

Or with Homebrew:

```bash
brew install tiann/tap/hapi
```

## Other install options

<details>
<summary>npx (no install)</summary>

```bash
npx @twsxtd/hapi
```
</details>

<details>
<summary>Prebuilt binary</summary>

Download the latest release from [GitHub Releases](https://github.com/tiann/yoho-remote/releases).

```bash
xattr -d com.apple.quarantine ./hapi
chmod +x ./hapi
sudo mv ./hapi /usr/local/bin/
```
</details>

<details>
<summary>Docker (server only)</summary>

```bash
docker pull ghcr.io/tiann/yoho-remote-server:latest

docker run -d \
  --name yoho-remote-server \
  -p 3006:3006 \
  -v ~/.yoho-remote:/root/.yoho-remote \
  -e CLI_API_TOKEN=your-secret-token \
  ghcr.io/tiann/yoho-remote-server:latest
```
</details>

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/tiann/yoho-remote.git
cd yoho-remote
bun install
bun run build:single-exe

./cli/dist/hapi
```
</details>

## Server setup

Start the server:

```bash
hapi server
```

The server listens on `http://localhost:3006` by default.

On first run, Yoho Remote:

1. Creates `~/.yoho-remote/`
2. Generates a secure access token
3. Prints the token and saves it to `~/.yoho-remote/settings.json`

Browser and PWA access use Keycloak SSO. `CLI_API_TOKEN` is still required for CLI and daemon connections.

<details>
<summary>Config files</summary>

```
~/.yoho-remote/
├── settings.json      # Main configuration
├── daemon.state.json  # Daemon process state
└── logs/              # Log files
```
</details>

<details>
<summary>Environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CLI_API_TOKEN` | Auto-generated | Shared secret for CLI and daemon authentication |
| `YOHO_REMOTE_URL` | `http://localhost:3006` | Server URL for CLI and daemon |
| `WEBAPP_PORT` | `3006` | HTTP server port |
| `WEBAPP_URL` | - | Public HTTPS URL for the web app / Telegram Mini App |
| `WEB_URL` | - | Public web origin used in invitation emails |
| `YOHO_REMOTE_HOME` | `~/.yoho-remote` | Config directory path |
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | - | PostgreSQL connection settings |
| `PG_SSL` | `false` | Enable PostgreSQL SSL |
| `CORS_ORIGINS` | - | Allowed browser origins |
| `KEYCLOAK_URL` | `https://auth.yohomobile.dev` | Public Keycloak base URL |
| `KEYCLOAK_INTERNAL_URL` | `KEYCLOAK_URL` | Internal Keycloak base URL for server-to-server requests |
| `KEYCLOAK_REALM` | `yoho` | Keycloak realm |
| `KEYCLOAK_CLIENT_ID` | `yoho-remote` | Keycloak client ID |
| `KEYCLOAK_CLIENT_SECRET` | - | Keycloak client secret |
| `ADMIN_ORG_ID` | - | License-exempt admin organization ID |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | - | Invitation email settings |
| `FEISHU_APP_ID` | - | Feishu/Lark app ID (speech-to-text) |
| `FEISHU_APP_SECRET` | - | Feishu/Lark app secret (speech-to-text) |
| `FEISHU_BASE_URL` | `https://open.feishu.cn` | Feishu/Lark OpenAPI base URL |
</details>

## CLI setup

If the server is not on localhost, set these before running `hapi`:

```bash
export YOHO_REMOTE_URL="http://your-server:3006"
export CLI_API_TOKEN="your-token-here"
```

Or use interactive login:

```bash
hapi auth login
```

Authentication commands:

```bash
hapi auth status
hapi auth login
hapi auth logout
```

Each machine gets a unique ID stored in `~/.yoho-remote/settings.json`. This allows:

- Multiple machines to connect to one server
- Remote session spawning on specific machines
- Machine health monitoring

## Operations

### Remote access

Cloudflare Tunnel (recommended):

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

```bash
export WEBAPP_URL="https://your-tunnel.trycloudflare.com"
```

Tailscale:

https://tailscale.com/download

```bash
sudo tailscale up
```

Access via your Tailscale IP:

```
http://100.x.x.x:3006
```

ngrok:

```bash
ngrok http 3006
```

### Telegram setup

Enable Telegram notifications and Mini App access:

1. Message [@BotFather](https://t.me/BotFather) and create a bot
2. Set the bot token and public URL
3. Start the server and bind your account

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export WEBAPP_URL="https://your-public-url"

hapi server
```

Then message your bot with `/start`, open the app, and sign in through the configured Keycloak SSO.

### Daemon setup

Run a background service for remote session spawning:

```bash
hapi daemon start
hapi daemon install
hapi daemon status
hapi daemon logs
hapi daemon stop
hapi daemon uninstall
```

With the daemon running:

- Your machine appears in the "Machines" list
- You can spawn sessions remotely from the web app
- Sessions persist even when the terminal is closed

On Linux, `hapi daemon install` creates a systemd service and persists the current daemon environment to `~/.yoho-remote/daemon.systemd.env`.

### Security notes

- Keep tokens secret and rotate if needed
- Use HTTPS for public access
- Restrict CORS origins in production

<details>
<summary>Firewall example (ufw)</summary>

```bash
ufw allow from 192.168.1.0/24 to any port 3006
```
</details>
