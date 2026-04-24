#!/bin/bash
set -e

cd "$(dirname "$0")"

# ==================== Configuration ====================
NCU_SSH="guang@101.100.174.21"
NCU_REPO="/home/workspaces/repos/yoho-remote"
NCU_EXE_DIR="$NCU_REPO/cli/dist-exe"
NCU_SUDO_PASS="guang"

INSTALL_DIR="/opt/yoho-remote"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"
LOCAL_REINSTALL_DAEMON_SCRIPT="$(pwd)/scripts/reinstall-daemon-systemd.sh"

SELF_HOSTNAME=$(hostname)
SELF_USER=$(id -un)

# ==================== Helpers ====================
is_ncu() { [[ "$SELF_HOSTNAME" == "ncu" ]]; }

resolve_ncu_ssh() {
    if is_ncu; then
        return 0
    fi

    local candidates=(
        "guang@192.168.122.1"
        "guang@101.100.174.21"
        "guang@192.168.0.32"
    )

    for candidate in "${candidates[@]}"; do
        if ssh $SSH_OPTS -o BatchMode=yes "$candidate" "true" >/dev/null 2>&1; then
            NCU_SSH="$candidate"
            return 0
        fi
    done

    echo "ERROR: Unable to reach ncu via any configured SSH endpoint" >&2
    exit 1
}

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
ALL_DAEMON_TARGET_NAMES="ncu"

MODE="${1:-}"
DAEMON_FILTER=()
shift 1 2>/dev/null || true

case "$MODE" in
    "")
        # 兼容旧用法：无参数时默认仅部署 server
        MODE="server"
        ;;
    --daemon)
        MODE="daemon"
        ;;
    --server)
        MODE="server"
        ;;
    --all)
        MODE="all"
        ;;
    server|daemon|all)
        ;;
    *)
        echo "ERROR: Unknown mode '$MODE'"
        exit 1
        ;;
esac
shift 0
DAEMON_FILTER=("$@")  # 剩余参数作为 daemon 目标过滤器

if [[ -z "$MODE" || ! "$MODE" =~ ^(server|daemon|all)$ ]]; then
    cat << 'USAGE'
Usage: deploy.sh [server|daemon|all|--server|--daemon|--all]

  无参数等价于 server

  server              Build & deploy server + CLI to ncu only
  daemon              Build & deploy daemon + CLI to ncu
  all                 Deploy both server and daemon

Daemon targets:
  ncu             ncu 本机 (systemd)

Examples:
  deploy.sh daemon
  deploy.sh daemon ncu
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

# ==================== Self-detach ====================
# 如果在 ncu 上部署 daemon，deploy.sh 自己和当前 claude session 都在
# yoho-remote-daemon.service 的 cgroup 里。daemon 重启时 KillMode=control-group
# 会把整个 cgroup 的进程 SIGKILL —— 包括 deploy.sh 本身。
# 解决：在执行真正的工作前，把自己 re-exec 到一个独立的 transient systemd unit，
# 脱离 daemon cgroup，让 daemon 重启不再波及我们。
maybe_self_detach() {
    [[ -n "${YR_DEPLOY_DETACHED:-}" ]] && return 0
    is_ncu || return 0
    [[ "$DEPLOY_DAEMON" == "true" ]] || return 0
    should_deploy_daemon ncu || return 0

    local orig_args=("$MODE")
    [[ ${#DAEMON_FILTER[@]} -gt 0 ]] && orig_args+=("${DAEMON_FILTER[@]}")

    local uid
    uid=$(id -u)
    local xdg="${XDG_RUNTIME_DIR:-/run/user/$uid}"

    # 确保 user systemd 可用（需要 linger，不然 SSH 下线后就没了）
    if [[ ! -d "$xdg/systemd" ]]; then
        echo "  ⚠ user systemd 不可用 ($xdg/systemd 缺失)，尝试 enable-linger..."
        echo "$NCU_SUDO_PASS" | sudo -S loginctl enable-linger "$SELF_USER" >/dev/null 2>&1 || true
        sleep 1
    fi
    if [[ ! -d "$xdg/systemd" ]]; then
        echo "  ✗ 无法启用 user systemd，请手动执行: sudo loginctl enable-linger $SELF_USER" >&2
        echo "    或先 SSH 登录一次触发 user manager 启动。" >&2
        exit 1
    fi

    echo ""
    echo "  → Re-executing under isolated systemd unit (unit=yr-deploy-$$) to escape daemon cgroup"
    # systemd-run does NOT inherit the caller's environment; pass vars explicitly via --setenv.
    exec systemd-run --user --pipe --collect --wait \
        --unit="yr-deploy-$$" \
        --working-directory="$(pwd)" \
        --setenv=YR_DEPLOY_DETACHED=1 \
        --setenv=XDG_RUNTIME_DIR="$xdg" \
        bash "$0" "${orig_args[@]}"
}

maybe_self_detach

resolve_ncu_ssh
echo "  NCU SSH: $NCU_SSH"

# ==================== Step 1: Commit ====================
log "Committing changes..."
git add -A
git commit -m "deploy" --allow-empty || true

# ==================== Step 2: Sync code to ncu & merge into dev-release ====================
CURRENT_BRANCH=$(git branch --show-current)
DEPLOY_BRANCH="dev-release"
SOURCE_REPO=$(pwd)

if is_ncu; then
    # 在 ncu 上直接运行：合并到 dev-release
    log "Merging $CURRENT_BRANCH into $DEPLOY_BRANCH on ncu..."
    git checkout "$DEPLOY_BRANCH" 2>/dev/null || git checkout -b "$DEPLOY_BRANCH"
    git merge "$CURRENT_BRANCH" --no-edit
    ok "Merged $CURRENT_BRANCH into $DEPLOY_BRANCH"
    git push || warn "git push failed (non-fatal)"
else
    log "Syncing $CURRENT_BRANCH to ncu and merging into $DEPLOY_BRANCH..."
    if [[ "$CURRENT_BRANCH" == "$DEPLOY_BRANCH" ]]; then
        ncu_exec "cd $NCU_REPO && (git checkout $DEPLOY_BRANCH 2>/dev/null || git checkout -b $DEPLOY_BRANCH) && if ! git diff --quiet -- cli/package.json; then git stash push -m deploy-cli-version cli/package.json >/dev/null; fi && (git remote add workspace-sync $SOURCE_REPO 2>/dev/null || git remote set-url workspace-sync $SOURCE_REPO) && git fetch workspace-sync $CURRENT_BRANCH && git merge FETCH_HEAD --no-edit"
        ok "ncu: synced $CURRENT_BRANCH from shared workspace into $DEPLOY_BRANCH"
    else
        git remote add ncu "ssh://$NCU_SSH$NCU_REPO" 2>/dev/null || git remote set-url ncu "ssh://$NCU_SSH$NCU_REPO"

        # 先让 ncu 切到 dev-release，避免 push worktree 分支时被拒绝
        ncu_exec "cd $NCU_REPO && git checkout $DEPLOY_BRANCH 2>/dev/null || git checkout -b $DEPLOY_BRANCH"

        # 推送 worktree 分支到 ncu
        git push ncu "$CURRENT_BRANCH" --force

        # ncu 上合并 worktree 分支到 dev-release
        ncu_exec "cd $NCU_REPO && git merge $CURRENT_BRANCH --no-edit"
        ok "ncu: $CURRENT_BRANCH merged into $DEPLOY_BRANCH"
    fi
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
    if should_deploy_daemon ncu; then
        log "Building daemon (linux-x64)..."
        ncu_exec "cd $NCU_REPO/cli && $BUN run build:exe:daemon"
    fi

fi

# ==================== Step 5: Verify builds ====================
log "Verifying builds..."
VERIFY_FILES="bun-linux-x64/yoho-remote"
if [[ "$DEPLOY_SERVER" == "true" ]]; then
    VERIFY_FILES="$VERIFY_FILES bun-linux-x64/yoho-remote-server"
fi
if [[ "$DEPLOY_DAEMON" == "true" ]]; then
    if should_deploy_daemon ncu; then
        VERIFY_FILES="$VERIFY_FILES bun-linux-x64/yoho-remote-daemon"
    fi
fi

ncu_exec "cd $NCU_EXE_DIR && NOW=\$(date +%s) && ALL_OK=true && for f in $VERIFY_FILES; do if [ ! -f \"\$f\" ]; then echo \"  ✗ \$f not found\"; ALL_OK=false; elif [ \$(( NOW - \$(stat -c %Y \"\$f\") )) -gt 120 ]; then echo \"  ✗ \$f is stale\"; ALL_OK=false; else echo \"  ✓ \$f\"; fi; done && \$ALL_OK"

# ==================== Step 6: Deploy ====================

# --- 6a: Deploy daemon ---
if [[ "$DEPLOY_DAEMON" == "true" ]]; then

    # 6a-1: Deploy daemon to ncu
    if should_deploy_daemon ncu && ! is_ncu; then
        log "Reinstalling daemon on ncu..."
        ncu_exec "echo $NCU_SUDO_PASS | sudo -SE bash $NCU_REPO/scripts/reinstall-daemon-systemd.sh $NCU_EXE_DIR/bun-linux-x64/yoho-remote"
        ok "ncu daemon unit reinstalled and restarted"
    fi

    # 6a-3: 本机 daemon 重启移到 Step 6c（server 部署之后），避免与 server 部署竞争
fi

# --- 6b: Deploy server to ncu ---
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

# --- 6c: Restart ncu daemon on self (LAST step) ---
# 此时脚本已在独立 transient systemd unit 里（见 maybe_self_detach），
# daemon 重启的 cgroup SIGKILL 不会波及本脚本，可以同步调用。
# 注意：当前 claude session 进程仍在 daemon cgroup 里，daemon 重启仍会杀它；
# session 能否 auto-resume 取决于 daemon 侧的 session 持久化能力，不在 deploy.sh 职责范围。
if is_ncu && [[ "$DEPLOY_DAEMON" == "true" ]] && should_deploy_daemon ncu; then
    log "Restarting daemon on ncu (self, last step)..."
    echo "$NCU_SUDO_PASS" | sudo -SE \
        DAEMON_SERVICE_USER="$SELF_USER" \
        bash "$LOCAL_REINSTALL_DAEMON_SCRIPT" "$NCU_EXE_DIR/bun-linux-x64/yoho-remote"
    ok "ncu daemon reinstalled and restarted"
fi

echo ""
echo "========================================="
echo "  Deploy completed — mode: $MODE"
echo "========================================="
