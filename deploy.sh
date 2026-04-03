#!/bin/bash
set -e

cd "$(dirname "$0")"

export PATH="$HOME/.bun/bin:$PATH"

SERVER_EXE="cli/dist-exe/bun-linux-x64/yoho-remote-server"
DAEMON_EXE="cli/dist-exe/bun-linux-x64/yoho-remote-daemon"

# 解析参数
BUILD_DAEMON=false
MACMINO_ONLY=false
for arg in "$@"; do
    case $arg in
        --daemon)
            BUILD_DAEMON=true
            ;;
        --macmini)
            MACMINO_ONLY=true
            ;;
    esac
done

# 如果是 --macmini 模式，跳过本地构建，只部署到 macmini
if [[ "$MACMINO_ONLY" == "true" ]]; then
    echo "=== Deploying to macmini only (skipping local builds)..."

    # 同步 daemon 到 macmini
    echo "=== Syncing source files to macmini..."
    sshpass -p 'guang' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password guang@192.168.0.236 'mkdir -p ~/softwares/yoho-remote'

    # 同步源文件到 macmini
    rsync -avz -e 'sshpass -p guang ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password' \
        --exclude='node_modules' --exclude='dist' --exclude='dist-exe' \
        --exclude='.git' --exclude='test-fixtures' --exclude='.cache' \
        cli/src/ \
        guang@192.168.0.236:~/softwares/yoho-remote/cli/src/ 2>/dev/null || true

    rsync -avz -e 'sshpass -p guang ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password' \
        --exclude='node_modules' --exclude='dist' --exclude='dist-exe' \
        --exclude='.git' --exclude='.cache' \
        server/src/ \
        guang@192.168.0.236:~/softwares/yoho-remote/server/src/ 2>/dev/null || true

    # 同步 package.json 和 scripts（构建脚本依赖这些）
    rsync -avz -e 'sshpass -p guang ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password' \
        cli/package.json \
        guang@192.168.0.236:~/softwares/yoho-remote/cli/package.json 2>/dev/null || true

    rsync -avz -e 'sshpass -p guang ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password' \
        cli/scripts/ \
        guang@192.168.0.236:~/softwares/yoho-remote/cli/scripts/ 2>/dev/null || true

    # 在 macmini 上重新构建 daemon
    echo "=== Building daemon on macmini..."
    sshpass -p 'guang' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password guang@192.168.0.236 \
        'cd ~/softwares/yoho-remote/cli && ~/.bun/bin/bun run build:exe:daemon'

    # 重启 macmini 上的 daemon
    echo "=== Restarting daemon on macmini..."
    sshpass -p 'guang' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password guang@192.168.0.236 \
        'pkill -f yoho-remote-daemon || true; sleep 1; ~/softwares/yoho-remote/start-daemon.sh > /dev/null 2>&1 &'

    echo "=== macmini daemon updated and restarted"
    exit 0
fi

echo "=== Committing and pushing changes..."
git add -A
git commit -m "deploy" --allow-empty || true
git push

# 生成东八区时间戳版本号 (v2026.01.02.1344)
VERSION="v$(TZ='Asia/Shanghai' date '+%Y.%m.%d.%H%M')"
echo "=== Updating version to $VERSION..."
cd cli
# 使用 node 来更新 package.json 的版本号
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Updated cli/package.json version to $VERSION');
"
cd ..

# 构建 web 前端
echo "=== Building web assets..."
bun run build:web
(cd server && bun run generate:embedded-web-assets)

# 构建 server
echo "=== Building yoho-remote-server..."
(cd cli && bun run build:exe:server)
sync

# 验证 server 构建成功
if [[ ! -f "$SERVER_EXE" ]]; then
    echo "ERROR: Server build failed - executable not found"
    exit 1
fi

SERVER_TIME=$(stat -c %Y "$SERVER_EXE")
NOW=$(date +%s)
SERVER_AGE=$((NOW - SERVER_TIME))

if [[ $SERVER_AGE -gt 60 ]]; then
    echo "ERROR: Server executable is $SERVER_AGE seconds old - build may have failed"
    exit 1
fi

echo "=== Server build verified (age: ${SERVER_AGE}s)"

# 构建主 CLI (用于 spawn session，不会触发 daemon 重启)
echo "=== Building yoho-remote CLI..."
(cd cli && bun run build:exe:cli)
sync

# 如果需要，构建 daemon
if [[ "$BUILD_DAEMON" == "true" ]]; then
    echo "=== Building yoho-remote-daemon..."
    (cd cli && bun run build:exe:daemon)
    sync

    if [[ ! -f "$DAEMON_EXE" ]]; then
        echo "ERROR: Daemon build failed - executable not found"
        exit 1
    fi

    DAEMON_TIME=$(stat -c %Y "$DAEMON_EXE")
    DAEMON_AGE=$((NOW - DAEMON_TIME))

    if [[ $DAEMON_AGE -gt 60 ]]; then
        echo "ERROR: Daemon executable is $DAEMON_AGE seconds old - build may have failed"
        exit 1
    fi

    echo "=== Daemon build verified (age: ${DAEMON_AGE}s)"
fi

# 确保 systemd service 包含 EnvironmentFile（加载 .env 中的 LITELLM 等变量）
YR_ENV_FILE="/home/guang/softwares/yoho-remote/.env"
SERVICE_FILE="/etc/systemd/system/yoho-remote-server.service"
if ! echo "guang" | sudo -S grep -q "EnvironmentFile=" "$SERVICE_FILE" 2>/dev/null; then
    echo "=== Adding EnvironmentFile to systemd service..."
    echo "guang" | sudo -S sed -i "/^ExecStart=/i EnvironmentFile=$YR_ENV_FILE" "$SERVICE_FILE"
    echo "guang" | sudo -S systemctl daemon-reload
fi

# 重启服务：用独立后台脚本执行，避免 stop daemon 杀掉当前会话导致脚本中断
RESTART_SCRIPT=$(mktemp /tmp/yr-restart-XXXXXX.sh)
cat > "$RESTART_SCRIPT" << 'RESTART_EOF'
#!/bin/bash
BUILD_DAEMON="$1"

# 1. 停止服务（先 daemon 后 server）
if [[ "$BUILD_DAEMON" == "true" ]]; then
    echo "guang" | sudo -S systemctl stop yoho-remote-daemon.service 2>/dev/null || true
fi
echo "guang" | sudo -S systemctl stop yoho-remote-server.service 2>/dev/null || true
sleep 1

# 2. 确保无残留进程（用完整路径 pkill 兜底，不会误杀脚本自身）
EXE_DIR="/home/guang/softwares/yoho-remote/cli/dist-exe/bun-linux-x64"
if [[ "$BUILD_DAEMON" == "true" ]]; then
    pkill -f "$EXE_DIR/yoho-remote-daemon" 2>/dev/null || true
fi
pkill -f "$EXE_DIR/yoho-remote-server" 2>/dev/null || true
sleep 1

# 确认被停止的进程已全部退出
REMAINING=$(pgrep -f "$EXE_DIR/yoho-remote-server" 2>/dev/null || true)
if [[ "$BUILD_DAEMON" == "true" ]]; then
    REMAINING="$REMAINING $(pgrep -f "$EXE_DIR/yoho-remote-daemon" 2>/dev/null || true)"
fi
REMAINING=$(echo "$REMAINING" | xargs)
if [[ -n "$REMAINING" ]]; then
    echo "WARNING: Remaining processes found (PIDs: $REMAINING), force killing..."
    kill -9 $REMAINING 2>/dev/null || true
    sleep 1
fi

# 3. 先启动 server（daemon 依赖 server）
echo "guang" | sudo -S systemctl start yoho-remote-server.service

# 等待 server 就绪
for i in {1..10}; do
    if systemctl is-active --quiet yoho-remote-server.service; then
        echo "=== Server started (attempt $i)"
        break
    fi
    sleep 1
done

if ! systemctl is-active --quiet yoho-remote-server.service; then
    echo "ERROR: yoho-remote-server.service failed to start"
    echo "guang" | sudo -S journalctl -u yoho-remote-server.service -n 20 --no-pager
    rm -f "$0"
    exit 1
fi

# 4. 再启动 daemon
if [[ "$BUILD_DAEMON" == "true" ]]; then
    echo "guang" | sudo -S systemctl start yoho-remote-daemon.service
    sleep 2
    if systemctl is-active --quiet yoho-remote-daemon.service; then
        echo "=== Daemon started successfully"
    else
        echo "ERROR: yoho-remote-daemon.service failed to start"
        echo "guang" | sudo -S journalctl -u yoho-remote-daemon.service -n 20 --no-pager
    fi
fi

echo "=== Done! Services restarted successfully."
rm -f "$0"
RESTART_EOF
chmod +x "$RESTART_SCRIPT"

echo "=== Restarting services in background..."
if [[ "$BUILD_DAEMON" == "true" ]]; then
    echo "    (with daemon restart)"
else
    echo "    (daemon was NOT rebuilt - sessions should remain online)"
fi
# setsid 让重启脚本完全脱离当前进程树，避免 stop daemon 时把脚本也杀掉
setsid bash "$RESTART_SCRIPT" "$BUILD_DAEMON" > /tmp/yr-restart.log 2>&1 &
echo "=== Restart dispatched (log: /tmp/yr-restart.log)"
