#!/bin/bash
set -e

cd "$(dirname "$0")"

export PATH="$HOME/.bun/bin:$PATH"

TENCENT_HOST="ubuntu@124.222.227.179"
TEMP_BUILD_DIR="/tmp/yoho-remote-build-tencent"
DAEMON_EXE="$TEMP_BUILD_DIR/yoho-remote-daemon"
ZIP_FILE="/tmp/yoho-remote-daemon.zip"

echo "=== Building yoho-remote-daemon in isolated directory..."

# 创建独立的临时编译目录（不影响本机运行的 daemon）
rm -rf "$TEMP_BUILD_DIR"
mkdir -p "$TEMP_BUILD_DIR"

# 编译到临时目录
(cd cli && bun build --compile --no-compile-autoload-dotenv \
    --feature=YR_TARGET_LINUX_X64 \
    --target=bun-linux-x64 \
    --outfile="$DAEMON_EXE" \
    src/bootstrap-daemon.ts)

# 验证构建成功
if [[ ! -f "$DAEMON_EXE" ]]; then
    echo "ERROR: Daemon build failed - executable not found"
    exit 1
fi

echo "=== Build completed successfully"

# 压缩二进制文件
echo "=== Compressing daemon executable..."
zip -j "$ZIP_FILE" "$DAEMON_EXE"

# 上传到腾讯服务器
echo "=== Uploading to Tencent server (124.222.227.179)..."
rsync -avz --timeout=60 --progress \
    -e "ssh -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3" \
    "$ZIP_FILE" "$TENCENT_HOST:~/"

# 在腾讯服务器上解压并安装
echo "=== Installing on Tencent server..."
ssh "$TENCENT_HOST" bash << 'EOF'
    set -e
    # 创建临时目录并解压
    mkdir -p /tmp/yoho-remote-tencent
    unzip -o ~/yoho-remote-daemon.zip -d /tmp/yoho-remote-tencent/

    # 安装到目标目录
    sudo mkdir -p /opt/yoho-remote
    sudo mv /tmp/yoho-remote-tencent/yoho-remote-daemon /opt/yoho-remote/
    sudo chmod +x /opt/yoho-remote/yoho-remote-daemon

    # 清理临时文件
    rm -rf /tmp/yoho-remote-tencent
    rm -f ~/yoho-remote-daemon.zip

    echo "Installation complete"
EOF

# 重启腾讯服务器上的 daemon 服务
echo "=== Restarting daemon on Tencent server..."
ssh "$TENCENT_HOST" bash << 'EOF'
    sudo systemctl restart yoho-remote-daemon
    sleep 2
    if systemctl is-active --quiet yoho-remote-daemon; then
        echo "=== Done! Tencent daemon restarted successfully."
        systemctl status yoho-remote-daemon --no-pager | head -n 10
    else
        echo "ERROR: yoho-remote-daemon failed to start"
        sudo journalctl -u yoho-remote-daemon -n 20 --no-pager
        exit 1
    fi
EOF

# 清理本地临时文件
rm -rf "$TEMP_BUILD_DIR" "$ZIP_FILE"

echo ""
echo "=== Tencent deployment completed successfully!"
