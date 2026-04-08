#!/bin/bash
set -e

cd "$(dirname "$0")"

# ==================== Configuration ====================
NCU_SSH="guang@192.168.122.1"
NCU_REPO="/home/guang/softwares/yoho-remote"
NCU_EXE_DIR="$NCU_REPO/cli/dist-exe"
NCU_SUDO_PASS="guang"

DAEMON_TARGETS=(
    "ubuntu@192.168.122.101|guang-instance"
    "ubuntu@192.168.122.102|bruce-instance"
)
MACMINI_SSH="guang@192.168.0.236"
MACMINI_DAEMON_ENV="CLI_API_TOKEN=rDhnX0JCPIki0s6t1kNsHJkSLCvpAEt3wNCb_dkEyOc YOHO_REMOTE_URL=https://remote.yohomobile.dev YOHO_MACHINE_NAME=macmini-daemon YOHO_MACHINE_IP=192.168.0.236"

INSTALL_DIR="/opt/yoho-remote"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

SELF_HOSTNAME=$(hostname)
SELF_DEPLOY_TARGET=""

# ==================== Helpers ====================
is_ncu() { [[ "$SELF_HOSTNAME" == "ncu" ]]; }

ncu_exec() {
    if is_ncu; then
        bash -c "$1"
    else
        ssh $SSH_OPTS "$NCU_SSH" "$1"
    fi
}

log()  { echo ""; echo "=== $1"; }
ok()   { echo "  ✓ $1"; }
warn() { echo "  ⚠ $1"; }
fail() { echo "  ✗ $1"; }

# 获取当前进程的所有祖先 PID（daemon → yoho-remote → claude → bash）
# 用于 kill 时排除自己的进程链，避免误杀当前会话
get_ancestor_pids() {
    local pid=$$
    local ancestors=""
    while [ "$pid" -gt 1 ] 2>/dev/null; do
        ancestors="$ancestors $pid"
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || break
    done
    echo "$ancestors"
}
SELF_ANCESTORS=$(get_ancestor_pids)

# 安全 kill：找到目标进程，排除当前进程链，逐个发送信号
# 用法: safe_kill <process_name> <signal> <sudo_cmd>
# 返回: 输出被 kill 的 PID 列表
safe_kill() {
    local proc_name="$1"
    local signal="${2:--TERM}"
    local sudo_cmd="$3"
    local pids
    pids=$(pgrep -x "$proc_name" 2>/dev/null || true)
    [ -z "$pids" ] && return 0
    for pid in $pids; do
        # 跳过自己的祖先进程
        if echo " $SELF_ANCESTORS " | grep -q " $pid "; then
            echo "  · Skipping PID $pid (current process ancestor)"
            continue
        fi
        $sudo_cmd kill "$signal" "$pid" 2>/dev/null || true
        echo "  · Sent $signal to PID $pid"
    done
}

# 通用的进程强杀流程
# 用法: force_kill_process <process_name> <sudo_cmd>
# 处理：SIGTERM → 等3秒 → SIGKILL → 等2秒 → 逐 PID 强杀 → 确认
force_kill_process() {
    local proc_name="$1"
    local sudo_cmd="$2"
    # 1. SIGTERM（优雅关闭）
    safe_kill "$proc_name" "-TERM" "$sudo_cmd"
    sleep 3
    # 2. 检查存活 → SIGKILL
    local remaining
    remaining=$(pgrep -x "$proc_name" 2>/dev/null || true)
    # 排除祖先
    for a in $SELF_ANCESTORS; do remaining=$(echo "$remaining" | grep -v "^${a}$"); done
    if [ -n "$remaining" ]; then
        echo "  ⚠ $proc_name did not exit after SIGTERM, sending SIGKILL..."
        safe_kill "$proc_name" "-9" "$sudo_cmd"
        sleep 2
    fi
    # 3. 最终确认（排除祖先后）
    remaining=$(pgrep -x "$proc_name" 2>/dev/null || true)
    for a in $SELF_ANCESTORS; do remaining=$(echo "$remaining" | grep -v "^${a}$"); done
    if [ -n "$remaining" ]; then
        echo "  ✗ WARNING: $proc_name still alive (PIDs: $remaining)"
    else
        echo "  ✓ $proc_name fully stopped"
    fi
}


# ==================== Parse arguments ====================
# 所有合法的 daemon 目标名
ALL_DAEMON_TARGET_NAMES="ncu guang-instance bruce-instance macmini"

MODE="${1:-}"
shift 2>/dev/null || true
DAEMON_FILTER=("$@")  # 剩余参数作为 daemon 目标过滤器

if [[ -z "$MODE" || ! "$MODE" =~ ^(server|daemon|all)$ ]]; then
    cat << 'USAGE'
Usage: deploy.sh <server|daemon|all> [target...]

  server              Build & deploy server + CLI to ncu only
  daemon              Build & deploy daemon + CLI to all machines
  daemon <target...>  Build & deploy daemon only to specified targets
  all                 Deploy both server and daemon

Daemon targets:
  ncu             ncu 本机 (systemd)
  guang-instance  VM (systemd)
  bruce-instance  VM (systemd)
  macmini         macOS (darwin-arm64)

Examples:
  deploy.sh daemon                        # 部署到全部 4 台
  deploy.sh daemon guang-instance         # 只部署到 guang-instance
  deploy.sh daemon ncu macmini            # 部署到 ncu 和 macmini
USAGE
    exit 1
fi

# 验证 daemon 目标名是否合法
for t in "${DAEMON_FILTER[@]}"; do
    if ! echo " $ALL_DAEMON_TARGET_NAMES " | grep -q " $t "; then
        echo "ERROR: Unknown daemon target '$t'"
        echo "Valid targets: $ALL_DAEMON_TARGET_NAMES"
        exit 1
    fi
done

DEPLOY_SERVER=false
DEPLOY_DAEMON=false
[[ "$MODE" == "server" || "$MODE" == "all" ]] && DEPLOY_SERVER=true
[[ "$MODE" == "daemon" || "$MODE" == "all" ]] && DEPLOY_DAEMON=true

# 判断某个 daemon 目标是否需要部署
should_deploy_daemon() {
    local target_name="$1"
    [[ "$DEPLOY_DAEMON" != "true" ]] && return 1
    # 无过滤器 → 部署全部
    [[ ${#DAEMON_FILTER[@]} -eq 0 ]] && return 0
    # 有过滤器 → 检查是否在列表中
    for t in "${DAEMON_FILTER[@]}"; do
        [[ "$t" == "$target_name" ]] && return 0
    done
    return 1
}

# 是否需要构建 macmini 的 darwin-arm64 二进制
NEED_DARWIN_BUILD=false
if should_deploy_daemon macmini; then
    NEED_DARWIN_BUILD=true
fi

# 显示信息
DEPLOY_INFO="$MODE"
if [[ ${#DAEMON_FILTER[@]} -gt 0 ]]; then
    DEPLOY_INFO="$MODE → ${DAEMON_FILTER[*]}"
fi

echo ""
echo "========================================="
echo "  Yoho Remote Deploy — $DEPLOY_INFO"
echo "  Running on: $SELF_HOSTNAME"
echo "========================================="

# ==================== Step 1: Commit ====================
log "Committing changes..."
git add -A
git commit -m "deploy" --allow-empty || true

# ==================== Step 2: Sync code to ncu & merge into dev-release ====================
CURRENT_BRANCH=$(git branch --show-current)
DEPLOY_BRANCH="dev-release"

if is_ncu; then
    # 在 ncu 上直接运行：合并到 dev-release
    log "Merging $CURRENT_BRANCH into $DEPLOY_BRANCH on ncu..."
    git checkout "$DEPLOY_BRANCH" 2>/dev/null || git checkout -b "$DEPLOY_BRANCH"
    git merge "$CURRENT_BRANCH" --no-edit
    ok "Merged $CURRENT_BRANCH into $DEPLOY_BRANCH"
    git push || warn "git push failed (non-fatal)"
else
    log "Syncing $CURRENT_BRANCH to ncu and merging into $DEPLOY_BRANCH..."

    git remote add ncu "ssh://$NCU_SSH$NCU_REPO" 2>/dev/null || git remote set-url ncu "ssh://$NCU_SSH$NCU_REPO"

    # 先让 ncu 切到 dev-release，避免 push worktree 分支时被拒绝
    ncu_exec "cd $NCU_REPO && git checkout $DEPLOY_BRANCH 2>/dev/null || git checkout -b $DEPLOY_BRANCH"

    # 推送 worktree 分支到 ncu
    git push ncu "$CURRENT_BRANCH" --force

    # ncu 上合并 worktree 分支到 dev-release
    ncu_exec "cd $NCU_REPO && git merge $CURRENT_BRANCH --no-edit"
    ok "ncu: $CURRENT_BRANCH merged into $DEPLOY_BRANCH"
fi

# ==================== Step 3: Version ====================
VERSION="v$(TZ='Asia/Shanghai' date '+%Y.%m.%d.%H%M')"
log "Updating version to $VERSION..."
ncu_exec "cd $NCU_REPO/cli && node -e \"
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
\" && echo 'Version set to $VERSION'"

# ==================== Step 4: Build on ncu ====================
BUN="\$HOME/.bun/bin/bun"

if [[ "$DEPLOY_SERVER" == "true" ]]; then
    log "Building web assets..."
    ncu_exec "cd $NCU_REPO && $BUN run build:web && (cd server && $BUN run generate:embedded-web-assets)"

    log "Building server (linux-x64)..."
    ncu_exec "cd $NCU_REPO/cli && $BUN run build:exe:server"
fi

log "Building CLI (linux-x64)..."
ncu_exec "cd $NCU_REPO/cli && $BUN run build:exe:cli"

if [[ "$DEPLOY_DAEMON" == "true" ]]; then
    # 只要有任一 linux 目标就构建 linux-x64 daemon
    if should_deploy_daemon ncu || should_deploy_daemon guang-instance || should_deploy_daemon bruce-instance; then
        log "Building daemon (linux-x64)..."
        ncu_exec "cd $NCU_REPO/cli && $BUN run build:exe:daemon"
    fi

    if [[ "$NEED_DARWIN_BUILD" == "true" ]]; then
        log "Building daemon + CLI (darwin-arm64) for macmini..."
        ncu_exec "cd $NCU_REPO/cli && $BUN run scripts/build-executable.ts --name yoho-remote-daemon --target bun-darwin-arm64 && $BUN run scripts/build-executable.ts --name yoho-remote --target bun-darwin-arm64"
    fi
fi

# ==================== Step 5: Verify builds ====================
log "Verifying builds..."
VERIFY_FILES="bun-linux-x64/yoho-remote"
if [[ "$DEPLOY_SERVER" == "true" ]]; then
    VERIFY_FILES="$VERIFY_FILES bun-linux-x64/yoho-remote-server"
fi
if [[ "$DEPLOY_DAEMON" == "true" ]]; then
    if should_deploy_daemon ncu || should_deploy_daemon guang-instance || should_deploy_daemon bruce-instance; then
        VERIFY_FILES="$VERIFY_FILES bun-linux-x64/yoho-remote-daemon"
    fi
    if [[ "$NEED_DARWIN_BUILD" == "true" ]]; then
        VERIFY_FILES="$VERIFY_FILES bun-darwin-arm64/yoho-remote-daemon bun-darwin-arm64/yoho-remote"
    fi
fi

ncu_exec "cd $NCU_EXE_DIR && NOW=\$(date +%s) && ALL_OK=true && for f in $VERIFY_FILES; do if [ ! -f \"\$f\" ]; then echo \"  ✗ \$f not found\"; ALL_OK=false; elif [ \$(( NOW - \$(stat -c %Y \"\$f\") )) -gt 120 ]; then echo \"  ✗ \$f is stale\"; ALL_OK=false; else echo \"  ✓ \$f\"; fi; done && \$ALL_OK"

# ==================== Step 6: Deploy ====================

# --- 6a: Deploy server to ncu ---
if [[ "$DEPLOY_SERVER" == "true" ]]; then
    log "Deploying server to ncu..."

    # Ensure systemd EnvironmentFile is configured
    ncu_exec "
        SERVICE_FILE=/etc/systemd/system/yoho-remote-server.service
        ENV_FILE=$NCU_REPO/.env
        if ! echo $NCU_SUDO_PASS | sudo -S grep -q 'EnvironmentFile=' \$SERVICE_FILE 2>/dev/null; then
            echo $NCU_SUDO_PASS | sudo -S sed -i \"/^ExecStart=/i EnvironmentFile=\$ENV_FILE\" \$SERVICE_FILE
            echo $NCU_SUDO_PASS | sudo -S systemctl daemon-reload
            echo '  ✓ Added EnvironmentFile to server service'
        fi
    "

    # Stop server (处理假死/僵尸)
    ncu_exec "echo $NCU_SUDO_PASS | sudo -S systemctl stop yoho-remote-server.service 2>/dev/null || true"
    sleep 2
    if is_ncu; then
        force_kill_process yoho-remote-server "echo $NCU_SUDO_PASS | sudo -S"
    else
        ncu_exec "P=yoho-remote-server; S='echo $NCU_SUDO_PASS | sudo -S'; \$S pkill -x \$P 2>/dev/null; sleep 3; if pgrep -x \$P >/dev/null 2>&1; then echo '  ⚠ SIGTERM failed, SIGKILL...'; \$S pkill -9 -x \$P 2>/dev/null; sleep 2; fi; R=\$(pgrep -x \$P 2>/dev/null||true); if [ -n \"\$R\" ]; then for p in \$R; do \$S kill -9 \$p 2>/dev/null||true; done; sleep 1; fi; pgrep -x \$P >/dev/null 2>&1 && echo '  ✗ WARNING: still alive' || echo '  ✓ Fully stopped'"
    fi
    # Start server
    ncu_exec "echo $NCU_SUDO_PASS | sudo -S systemctl start yoho-remote-server.service"
    sleep 2
    ncu_exec "systemctl is-active --quiet yoho-remote-server.service && echo '  ✓ Server restarted' || echo '  ✗ Server failed to start'"
fi

# --- 6b: Deploy daemon ---
if [[ "$DEPLOY_DAEMON" == "true" ]]; then

    # 6b-1: Deploy to linux VMs (via ncu as relay)
    for entry in "${DAEMON_TARGETS[@]}"; do
        SSH_TARGET="${entry%%|*}"
        TARGET_NAME="${entry##*|}"

        # 检查是否在部署目标列表中
        if ! should_deploy_daemon "$TARGET_NAME"; then
            continue
        fi

        log "Deploying daemon to $TARGET_NAME ($SSH_TARGET)..."

        # If this is the machine we're running on, defer to last
        if [[ "$TARGET_NAME" == "$SELF_HOSTNAME" ]]; then
            SELF_DEPLOY_TARGET="$SSH_TARGET"
            ok "Self detected — will deploy last"
            continue
        fi

        # Check connectivity
        if ! ncu_exec "ssh $SSH_OPTS -o BatchMode=yes $SSH_TARGET 'true'" 2>/dev/null; then
            warn "$TARGET_NAME is unreachable — skipping"
            continue
        fi

        # Stop old daemon (处理假死/僵尸 — 远程机器，无需排除本机进程)
        ncu_exec "ssh $SSH_OPTS $SSH_TARGET 'sudo systemctl stop yoho-remote-daemon.service 2>/dev/null || true'"
        sleep 2
        ncu_exec "ssh $SSH_OPTS $SSH_TARGET 'P=yoho-remote-daemon; sudo pkill -x \$P 2>/dev/null; sleep 3; if pgrep -x \$P >/dev/null 2>&1; then echo \"  ⚠ SIGTERM failed, SIGKILL...\"; sudo pkill -9 -x \$P 2>/dev/null; sleep 2; fi; R=\$(pgrep -x \$P 2>/dev/null||true); if [ -n \"\$R\" ]; then for p in \$R; do sudo kill -9 \$p 2>/dev/null||true; done; sleep 1; fi; pgrep -x \$P >/dev/null 2>&1 && echo \"  ✗ WARNING: still alive\" || echo \"  ✓ Fully stopped\"'"

        # Copy new binaries
        ncu_exec "scp $SSH_OPTS $NCU_EXE_DIR/bun-linux-x64/yoho-remote-daemon $SSH_TARGET:$INSTALL_DIR/ && scp $SSH_OPTS $NCU_EXE_DIR/bun-linux-x64/yoho-remote $SSH_TARGET:$INSTALL_DIR/"

        # Start daemon
        ncu_exec "ssh $SSH_OPTS $SSH_TARGET 'sudo systemctl start yoho-remote-daemon.service'"
        sleep 3
        ACTIVE=$(ncu_exec "ssh $SSH_OPTS $SSH_TARGET 'systemctl is-active yoho-remote-daemon.service 2>/dev/null || echo inactive'")
        if [[ "$ACTIVE" == "active" ]]; then
            ok "$TARGET_NAME daemon restarted"
        else
            fail "$TARGET_NAME daemon failed to start"
        fi
    done

    # 6b-2: Deploy to macmini
    if should_deploy_daemon macmini; then
        log "Deploying daemon to macmini..."
        if ncu_exec "ssh $SSH_OPTS -o BatchMode=yes $MACMINI_SSH 'true'" 2>/dev/null; then
            # Stop old daemon (处理假死/僵尸 — macOS，无 sudo)
            ncu_exec "ssh $SSH_OPTS $MACMINI_SSH 'P=yoho-remote-daemon; pkill -x \$P 2>/dev/null; sleep 3; if pgrep -x \$P >/dev/null 2>&1; then echo \"  ⚠ SIGTERM failed, SIGKILL...\"; pkill -9 -x \$P 2>/dev/null; sleep 2; fi; R=\$(pgrep -x \$P 2>/dev/null||true); if [ -n \"\$R\" ]; then for p in \$R; do kill -9 \$p 2>/dev/null||true; done; sleep 1; fi; pgrep -x \$P >/dev/null 2>&1 && echo \"  ✗ WARNING: still alive\" || echo \"  ✓ Fully stopped\"'"

            # Copy new binaries
            ncu_exec "scp $SSH_OPTS $NCU_EXE_DIR/bun-darwin-arm64/yoho-remote-daemon $MACMINI_SSH:$INSTALL_DIR/ && scp $SSH_OPTS $NCU_EXE_DIR/bun-darwin-arm64/yoho-remote $MACMINI_SSH:$INSTALL_DIR/"

            # macOS 要求重新 ad-hoc 签名（SCP 后签名失效，LaunchAgent 会 SIGKILL 未签名二进制）
            ncu_exec "ssh $SSH_OPTS $MACMINI_SSH 'codesign --force --sign - $INSTALL_DIR/yoho-remote-daemon && codesign --force --sign - $INSTALL_DIR/yoho-remote'"

            # 通过 LaunchAgent 重启（macOS 不能用 nohup via SSH）
            ncu_exec "ssh $SSH_OPTS $MACMINI_SSH 'launchctl stop com.hapi.daemon 2>/dev/null; launchctl start com.hapi.daemon'"
            sleep 4
            ALIVE=$(ncu_exec "ssh $SSH_OPTS $MACMINI_SSH 'pgrep -x yoho-remote-daemon >/dev/null && echo yes || echo no'")
            if [[ "$ALIVE" == *"yes"* ]]; then
                ok "macmini daemon restarted"
            else
                fail "macmini daemon failed to start — check /tmp/yoho-remote-daemon.log"
            fi
        else
            warn "macmini is unreachable — skipping"
        fi
    fi

    # 6b-3: Deploy daemon to ncu (从 VM 远程操作时，无需排除本机进程)
    if should_deploy_daemon ncu && ! is_ncu; then
        log "Restarting daemon on ncu..."
        # Stop (处理假死/僵尸)
        ncu_exec "echo $NCU_SUDO_PASS | sudo -S systemctl stop yoho-remote-daemon.service 2>/dev/null || true"
        sleep 2
        ncu_exec "P=yoho-remote-daemon; S='echo $NCU_SUDO_PASS | sudo -S'; \$S pkill -x \$P 2>/dev/null; sleep 3; if pgrep -x \$P >/dev/null 2>&1; then echo '  ⚠ SIGTERM failed, SIGKILL...'; \$S pkill -9 -x \$P 2>/dev/null; sleep 2; fi; R=\$(pgrep -x \$P 2>/dev/null||true); if [ -n \"\$R\" ]; then for p in \$R; do \$S kill -9 \$p 2>/dev/null||true; done; sleep 1; fi; pgrep -x \$P >/dev/null 2>&1 && echo '  ✗ WARNING: still alive' || echo '  ✓ Fully stopped'"
        # Start
        ncu_exec "echo $NCU_SUDO_PASS | sudo -S systemctl start yoho-remote-daemon.service"
        sleep 3
        ACTIVE=$(ncu_exec "systemctl is-active yoho-remote-daemon.service 2>/dev/null || echo inactive")
        if [[ "$ACTIVE" == "active" ]]; then
            ok "ncu daemon restarted"
        else
            fail "ncu daemon failed to start"
        fi
    fi

    # 6b-4: Deploy self (LAST — this will kill current session)
    if [[ -n "$SELF_DEPLOY_TARGET" ]]; then
        log "Deploying daemon to self ($SELF_HOSTNAME) — session will restart..."

        # 从 ncu 拉取新二进制到本机（ncu 无法反向 SSH 到 VM，所以从本机主动拉取）
        scp $SSH_OPTS "$NCU_SSH:$NCU_EXE_DIR/bun-linux-x64/yoho-remote-daemon" "$INSTALL_DIR/" && scp $SSH_OPTS "$NCU_SSH:$NCU_EXE_DIR/bun-linux-x64/yoho-remote" "$INSTALL_DIR/"
        ok "Binaries updated"

        # Restart via systemd-run to survive daemon shutdown
        # 传入当前进程链的 PID，restart 脚本在独立 cgroup 中运行时排除这些 PID
        RESTART_SCRIPT=$(mktemp /tmp/yr-restart-XXXXXX.sh)
        cat > "$RESTART_SCRIPT" << RESTART_EOF
#!/bin/bash
exec > /tmp/yr-restart.log 2>&1
PROC=yoho-remote-daemon
SKIP_PIDS="$SELF_ANCESTORS"

echo "\$(date): Stopping daemon..."
sudo systemctl stop yoho-remote-daemon.service 2>/dev/null || true
sleep 2

# SIGTERM（排除当前会话的进程链）
echo "\$(date): Sending SIGTERM..."
for pid in \$(pgrep -x "\$PROC" 2>/dev/null || true); do
    if echo " \$SKIP_PIDS " | grep -q " \$pid "; then
        echo "\$(date): Skipping PID \$pid (deploy session ancestor)"
        continue
    fi
    sudo kill -TERM "\$pid" 2>/dev/null || true
    echo "\$(date): Sent SIGTERM to PID \$pid"
done
sleep 3

# 假死 → SIGKILL（同样排除当前进程链）
for pid in \$(pgrep -x "\$PROC" 2>/dev/null || true); do
    if echo " \$SKIP_PIDS " | grep -q " \$pid "; then continue; fi
    echo "\$(date): WARNING — PID \$pid did not exit, sending SIGKILL..."
    sudo kill -9 "\$pid" 2>/dev/null || true
done
sleep 2

# 最终确认（排除后）
REMAIN=""
for pid in \$(pgrep -x "\$PROC" 2>/dev/null || true); do
    echo " \$SKIP_PIDS " | grep -q " \$pid " || REMAIN="\$REMAIN \$pid"
done
if [ -n "\$REMAIN" ]; then
    echo "\$(date): CRITICAL — still alive: \$REMAIN"
else
    echo "\$(date): ✓ \$PROC fully stopped"
fi

# Start
echo "\$(date): Starting daemon..."
sudo systemctl start yoho-remote-daemon.service
sleep 3
if systemctl is-active --quiet yoho-remote-daemon.service; then
    echo "\$(date): ✓ Daemon restarted successfully"
else
    echo "\$(date): ERROR — daemon failed to start"
    sudo journalctl -u yoho-remote-daemon.service -n 20 --no-pager
fi
rm -f "\$0"
RESTART_EOF
        chmod +x "$RESTART_SCRIPT"

        sudo systemctl reset-failed yr-daemon-restart.service 2>/dev/null || true
        sudo systemd-run --unit=yr-daemon-restart bash "$RESTART_SCRIPT"
        ok "Restart dispatched (log: /tmp/yr-restart.log)"
    fi

    # 6b-5: If running on ncu, restart ncu daemon last (will kill session)
    if is_ncu; then
        log "Restarting daemon on ncu (self) — session will restart..."

        RESTART_SCRIPT=$(mktemp /tmp/yr-restart-XXXXXX.sh)
        cat > "$RESTART_SCRIPT" << RESTART_EOF
#!/bin/bash
exec > /tmp/yr-restart.log 2>&1
SUDO_PASS="guang"
PROC=yoho-remote-daemon
SKIP_PIDS="$SELF_ANCESTORS"
S() { echo "\$SUDO_PASS" | sudo -S "\$@"; }

echo "\$(date): Stopping ncu daemon..."
S systemctl stop yoho-remote-daemon.service 2>/dev/null || true
sleep 2

# SIGTERM（排除当前会话的进程链）
echo "\$(date): Sending SIGTERM..."
for pid in \$(pgrep -x "\$PROC" 2>/dev/null || true); do
    if echo " \$SKIP_PIDS " | grep -q " \$pid "; then
        echo "\$(date): Skipping PID \$pid (deploy session ancestor)"
        continue
    fi
    S kill -TERM "\$pid" 2>/dev/null || true
    echo "\$(date): Sent SIGTERM to PID \$pid"
done
sleep 3

# 假死 → SIGKILL（同样排除）
for pid in \$(pgrep -x "\$PROC" 2>/dev/null || true); do
    if echo " \$SKIP_PIDS " | grep -q " \$pid "; then continue; fi
    echo "\$(date): WARNING — PID \$pid did not exit, sending SIGKILL..."
    S kill -9 "\$pid" 2>/dev/null || true
done
sleep 2

# 最终确认（排除后）
REMAIN=""
for pid in \$(pgrep -x "\$PROC" 2>/dev/null || true); do
    echo " \$SKIP_PIDS " | grep -q " \$pid " || REMAIN="\$REMAIN \$pid"
done
if [ -n "\$REMAIN" ]; then
    echo "\$(date): CRITICAL — still alive: \$REMAIN"
else
    echo "\$(date): ✓ \$PROC fully stopped"
fi

# Start
echo "\$(date): Starting ncu daemon..."
S systemctl start yoho-remote-daemon.service
sleep 3
if systemctl is-active --quiet yoho-remote-daemon.service; then
    echo "\$(date): ✓ Daemon restarted successfully"
else
    echo "\$(date): ERROR — daemon failed to start"
    S journalctl -u yoho-remote-daemon.service -n 20 --no-pager
fi
rm -f "\$0"
RESTART_EOF
        chmod +x "$RESTART_SCRIPT"

        echo "$NCU_SUDO_PASS" | sudo -S systemctl reset-failed yr-daemon-restart.service 2>/dev/null || true
        echo "$NCU_SUDO_PASS" | sudo -S systemd-run --unit=yr-daemon-restart bash "$RESTART_SCRIPT"
        ok "Restart dispatched (log: /tmp/yr-restart.log)"
    fi
fi

echo ""
echo "========================================="
echo "  Deploy completed — mode: $MODE"
echo "========================================="
