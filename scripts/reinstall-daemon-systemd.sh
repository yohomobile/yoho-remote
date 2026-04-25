#!/bin/bash
set -euo pipefail

CLI_BIN="${1:-}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-yoho-remote-daemon.service}"

if [[ $EUID -ne 0 ]]; then
    echo "[daemon-deploy] Error: run this script with sudo/root" >&2
    exit 1
fi

if [[ -z "$CLI_BIN" ]]; then
    echo "Usage: $0 <path-to-yoho-remote-cli>" >&2
    exit 1
fi

if [[ ! -x "$CLI_BIN" ]]; then
    echo "[daemon-deploy] Error: CLI binary is not executable: $CLI_BIN" >&2
    exit 1
fi

service_user="${SUDO_USER:-${DAEMON_SERVICE_USER:-}}"
if [[ -z "$service_user" ]]; then
    echo "[daemon-deploy] Error: SUDO_USER or DAEMON_SERVICE_USER is required so daemon install can target the real service user" >&2
    exit 1
fi

export SUDO_USER="$service_user"

service_home="$(getent passwd "$service_user" | cut -d: -f6 || true)"
if [[ -z "$service_home" ]]; then
    service_home="/home/$service_user"
fi

load_current_daemon_env() {
    local current_env=""
    current_env="$(systemctl show "$SYSTEMD_SERVICE_NAME" -p Environment --value 2>/dev/null || true)"
    if [[ -n "$current_env" ]]; then
        for entry in $current_env; do
            local key="${entry%%=*}"
            local value="${entry#*=}"
            if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
                export "$key=$value"
            fi
        done
    fi

    local daemon_home="${YOHO_REMOTE_HOME:-$service_home/.yoho-remote}"
    local env_file="${DAEMON_ENV_FILE:-$daemon_home/daemon.systemd.env}"
    if [[ -f "$env_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        . "$env_file"
        set +a
    fi
}

load_current_daemon_env

daemon_home="${YOHO_REMOTE_HOME:-$service_home/.yoho-remote}"

check_user_systemd_prerequisites() {
    local uid
    uid="$(id -u "$service_user")"
    local xdg="/run/user/$uid"

    if ! command -v systemd-run >/dev/null 2>&1; then
        echo "[daemon-deploy] Error: systemd-run is required so daemon sessions can enter independent scopes" >&2
        exit 1
    fi

    if ! command -v loginctl >/dev/null 2>&1; then
        echo "[daemon-deploy] Error: loginctl is required to verify linger before daemon deploy" >&2
        exit 1
    fi

    local linger
    linger="$(loginctl show-user "$service_user" -p Linger --value 2>/dev/null || true)"
    if [[ "$linger" != "yes" ]]; then
        echo "[daemon-deploy] Error: user linger is ${linger:-<empty>} for $service_user" >&2
        echo "[daemon-deploy] Refusing daemon deploy: sessions would plain-spawn in the daemon cgroup and die on daemon restart" >&2
        echo "[daemon-deploy] Fix:  sudo loginctl enable-linger $service_user" >&2
        echo "[daemon-deploy] Note: socket may take 1-3 seconds to appear; rerun deploy if it still fails" >&2
        exit 1
    fi

    if [[ ! -S "$xdg/systemd/private" ]]; then
        echo "[daemon-deploy] Error: user systemd manager is not reachable at $xdg/systemd/private" >&2
        echo "[daemon-deploy] Fix: enable linger if not done (sudo loginctl enable-linger $service_user); wait 1-3s for socket; or log in once as $service_user to force user manager startup" >&2
        exit 1
    fi

    if ! sudo -u "$service_user" env \
            "HOME=$service_home" \
            "XDG_RUNTIME_DIR=$xdg" \
            "DBUS_SESSION_BUS_ADDRESS=unix:path=$xdg/bus" \
            systemd-run --user --scope --collect --quiet --unit="yr-preflight-$$" -- true \
            >/dev/null 2>&1; then
        echo "[daemon-deploy] Error: systemd-run --user --scope failed for $service_user" >&2
        echo "[daemon-deploy] Diagnose (run as $service_user):" >&2
        echo "  sudo -u $service_user XDG_RUNTIME_DIR=$xdg DBUS_SESSION_BUS_ADDRESS=unix:path=$xdg/bus systemctl --user status" >&2
        echo "  sudo -u $service_user XDG_RUNTIME_DIR=$xdg DBUS_SESSION_BUS_ADDRESS=unix:path=$xdg/bus systemctl --user --failed" >&2
        echo "  journalctl --user-unit=user@$uid.service -xe -n 40 --no-pager" >&2
        echo "[daemon-deploy] Refusing silent plain spawn; fix user D-Bus/systemd before deploying daemon" >&2
        exit 1
    fi

    echo "[daemon-deploy] Verified user systemd prerequisites: user=$service_user linger=yes scope=available"
}

check_user_systemd_prerequisites

if [[ -z "${CLI_API_TOKEN:-}" ]]; then
    echo "[daemon-deploy] Error: CLI_API_TOKEN is missing from the current daemon environment" >&2
    exit 1
fi

if [[ -z "${YOHO_REMOTE_URL:-}" ]]; then
    echo "[daemon-deploy] Error: YOHO_REMOTE_URL is missing from the current daemon environment" >&2
    exit 1
fi

echo "[daemon-deploy] Reinstalling managed daemon unit via: $CLI_BIN daemon install"
"$CLI_BIN" daemon install

if [[ -d "$daemon_home/runtime" ]]; then
    echo "[daemon-deploy] Restoring runtime ownership under $daemon_home/runtime to $service_user"
    chown -R "$service_user:$service_user" "$daemon_home/runtime"
fi

echo "[daemon-deploy] Restarting $SYSTEMD_SERVICE_NAME to load the deployed binary"
systemctl restart "$SYSTEMD_SERVICE_NAME"

# 轮询直到 systemd 报告 active（最多 10 秒，每 200ms 检查一次）。
# 替代固定 sleep 2 + 单次 is-active 检查 — 通常在 1 秒内完成。
for _ in $(seq 1 50); do
    systemctl is-active --quiet "$SYSTEMD_SERVICE_NAME" && break
    sleep 0.2
done

if ! systemctl is-active --quiet "$SYSTEMD_SERVICE_NAME"; then
    echo "[daemon-deploy] Error: $SYSTEMD_SERVICE_NAME is not active after restart" >&2
    journalctl -u "$SYSTEMD_SERVICE_NAME" -n 40 --no-pager || true
    exit 1
fi

kill_mode="$(systemctl show "$SYSTEMD_SERVICE_NAME" -p KillMode --value 2>/dev/null || true)"
if [[ "$kill_mode" != "control-group" ]]; then
    echo "[daemon-deploy] Error: expected KillMode=control-group, got ${kill_mode:-<empty>}" >&2
    exit 1
fi

current_env="$(systemctl show "$SYSTEMD_SERVICE_NAME" -p Environment --value 2>/dev/null || true)"
if [[ " $current_env " != *" YR_DAEMON_UNDER_SYSTEMD=1 "* ]]; then
    echo "[daemon-deploy] Error: YR_DAEMON_UNDER_SYSTEMD=1 is missing from the effective unit environment" >&2
    exit 1
fi

echo "[daemon-deploy] Verified managed daemon unit: KillMode=$kill_mode, YR_DAEMON_UNDER_SYSTEMD=1"
