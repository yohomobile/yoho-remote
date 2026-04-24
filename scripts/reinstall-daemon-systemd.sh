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
sleep 2

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
