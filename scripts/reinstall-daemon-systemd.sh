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

wait_for_systemd_active() {
    local service_name="$1"
    local timeout_seconds="${2:-30}"
    local waited=0
    local last_state=""
    local last_substate=""

    while (( waited < timeout_seconds )); do
        if systemctl is-active --quiet "$service_name"; then
            local active_state=""
            local sub_state=""
            active_state="$(systemctl show "$service_name" -p ActiveState --value 2>/dev/null || true)"
            sub_state="$(systemctl show "$service_name" -p SubState --value 2>/dev/null || true)"
            echo "[daemon-deploy] $service_name is active (state=${active_state:-unknown}, substate=${sub_state:-unknown}) after ${waited}s"
            return 0
        fi

        local active_state=""
        local sub_state=""
        active_state="$(systemctl show "$service_name" -p ActiveState --value 2>/dev/null || true)"
        sub_state="$(systemctl show "$service_name" -p SubState --value 2>/dev/null || true)"
        if [[ "$active_state" != "$last_state" || "$sub_state" != "$last_substate" ]]; then
            echo "[daemon-deploy] Waiting for $service_name: state=${active_state:-unknown}, substate=${sub_state:-unknown}, elapsed=${waited}s"
            last_state="$active_state"
            last_substate="$sub_state"
        fi

        sleep 1
        waited=$(( waited + 1 ))
    done

    return 1
}

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

echo "[daemon-deploy] Restarting $SYSTEMD_SERVICE_NAME to load the deployed binary"
systemctl restart "$SYSTEMD_SERVICE_NAME"

if ! wait_for_systemd_active "$SYSTEMD_SERVICE_NAME" 30; then
    active_state="$(systemctl show "$SYSTEMD_SERVICE_NAME" -p ActiveState --value 2>/dev/null || true)"
    sub_state="$(systemctl show "$SYSTEMD_SERVICE_NAME" -p SubState --value 2>/dev/null || true)"
    echo "[daemon-deploy] Error: $SYSTEMD_SERVICE_NAME did not become active within 30s (state=${active_state:-unknown}, substate=${sub_state:-unknown})" >&2
    systemctl status "$SYSTEMD_SERVICE_NAME" --no-pager || true
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
