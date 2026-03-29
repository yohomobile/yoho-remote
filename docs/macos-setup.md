# macOS Daemon Setup

## Problem: WebSocket Connection Failing

When yoho-remote daemon connects through Cloudflare proxy (`https://remote.yohomobile.dev`), WebSocket connection fails with 401 errors.

**Solution:** Use internal network URL to bypass Cloudflare.

## Configuration

For macmini (or any macOS machine on the same internal network as the yoho-remote server):

```bash
# Internal network URL (replace with your server's internal IP)
export YOHO_REMOTE_URL="http://192.168.0.32:3006"

# Full PATH including /usr/local/bin
export PATH="/usr/local/bin:/Users/guang/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Explicit path to claude executable (if not in standard PATH)
export YR_CLAUDE_PATH="/usr/local/bin/claude"
```

## Daemon Control Script

The `yoho-remote-daemon.sh` script provides convenient daemon management:

```bash
cd ~/softwares/yoho-remote
./yoho-remote-daemon.sh start    # Start daemon
./yoho-remote-daemon.sh stop     # Stop daemon
./yoho-remote-daemon.sh restart  # Restart daemon
./yoho-remote-daemon.sh status   # Show status
./yoho-remote-daemon.sh logs     # Show recent logs
```

## Script Template

```bash
#!/bin/zsh
# yoho-remote Daemon Control Script for macOS

export CLI_API_TOKEN="your-token-here"
export YOHO_REMOTE_URL="http://192.168.0.32:3006"
export PATH="/usr/local/bin:/Users/guang/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export YR_CLAUDE_PATH="/usr/local/bin/claude"

YR_DIR="/Users/guang/softwares/yoho-remote"
DAEMON_BIN="${YR_DIR}/cli/dist-exe/bun-darwin-arm64/yoho-remote-daemon"

# Start daemon with environment
nohup env PATH="$PATH" CLI_API_TOKEN="$CLI_API_TOKEN" \
     YOHO_REMOTE_URL="$YOHO_REMOTE_URL" YR_CLAUDE_PATH="$YR_CLAUDE_PATH" \
     "$DAEMON_BIN" > ~/.yoho-remote/logs/daemon.stdout.log 2>&1 &
```

## Auto-Start (Optional)

To auto-start daemon on login, create a LaunchAgent:

```bash
~/Library/LaunchAgents/com.yoho-remote.daemon.plist
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yoho-remote.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/guang/softwares/yoho-remote/yoho-remote-daemon.sh</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/guang/.yoho-remote/logs/launchagent.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/guang/.yoho-remote/logs/launchagent.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/Users/guang/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>YR_CLAUDE_PATH</key>
        <string>/usr/local/bin/claude</string>
    </dict>
</dict>
</plist>
```

Load with:
```bash
launchctl load ~/Library/LaunchAgents/com.yoho-remote.daemon.plist
```
