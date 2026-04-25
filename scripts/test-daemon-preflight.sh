#!/bin/bash
# Self-test for daemon_systemd_preflight_snippet (deploy.sh) and the same
# preflight pattern used inside reinstall-daemon-systemd.sh.
#
# We isolate `loginctl` and `systemd-run` via PATH overrides in a tmp dir and
# build/break a fake `XDG_RUNTIME_DIR` (real AF_UNIX socket via python3 to make
# `[[ -S … ]]` honest). The "missing socket" and "linger=no" cases need no
# external tooling; the "dry-run failure" case requires python3 to mint a real
# unix socket. If python3 is missing, that single case is skipped with a notice.
#
# Usage: bash scripts/test-daemon-preflight.sh

set -uo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0
SKIP=0

snippet="$(awk '/^daemon_systemd_preflight_snippet\(\) \{/{flag=1;next} /^}/{if(flag){exit}} flag{print}' deploy.sh \
    | sed -e '1{/^[[:space:]]*cat <<'\''EOS'\''[[:space:]]*$/d;}' -e '${/^[[:space:]]*EOS[[:space:]]*$/d;}')"

if [[ -z "$snippet" ]]; then
    echo "ERROR: failed to extract preflight snippet from deploy.sh" >&2
    exit 2
fi

run_case() {
    local label="$1"
    local fake_dir="$2"
    local fake_xdg="$3"
    local expect_rc="$4"
    local expect_substr="$5"

    local out rc
    out="$(PATH="$fake_dir:$PATH" XDG_RUNTIME_DIR="$fake_xdg" \
        bash -c "$snippet" _ "$(id -un)" 2>&1)"
    rc=$?

    local ok=true
    if [[ "$rc" -ne "$expect_rc" ]]; then
        ok=false
    fi
    if [[ -n "$expect_substr" && "$out" != *"$expect_substr"* ]]; then
        ok=false
    fi

    if $ok; then
        echo "  ✓ $label  (rc=$rc)"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $label"
        echo "    expected rc=$expect_rc substr='$expect_substr'"
        echo "    got      rc=$rc"
        echo "    output: |$out|"
        FAIL=$((FAIL + 1))
    fi
}

make_fake_dir() {
    local dir; dir="$(mktemp -d)"
    local linger="$1"
    local systemd_run_rc="$2"

    cat >"$dir/loginctl" <<EOF
#!/bin/bash
# Fake loginctl; only the show-user variant is exercised by the snippet.
if [[ "\$1" == "show-user" && "\$3" == "-p" && "\$4" == "Linger" && "\$5" == "--value" ]]; then
    echo "$linger"
    exit 0
fi
echo "fake loginctl: unsupported invocation \$*" >&2
exit 1
EOF
    cat >"$dir/systemd-run" <<EOF
#!/bin/bash
exit $systemd_run_rc
EOF
    chmod +x "$dir/loginctl" "$dir/systemd-run"
    echo "$dir"
}

# ---- case 1: linger=no ---------------------------------------------------
TMP_XDG="$(mktemp -d)"
FAKE1="$(make_fake_dir "no" 0)"
run_case "linger=no exits non-zero with enable-linger hint" \
    "$FAKE1" "$TMP_XDG" 1 "enable-linger"
rm -rf "$FAKE1" "$TMP_XDG"

# ---- case 2: linger=yes but private socket missing -----------------------
TMP_XDG="$(mktemp -d)"
mkdir -p "$TMP_XDG/systemd"  # directory exists but `private` socket does not
FAKE2="$(make_fake_dir "yes" 0)"
run_case "missing /run/user/<uid>/systemd/private exits with user@.service hint" \
    "$FAKE2" "$TMP_XDG" 1 "user systemd manager is not reachable"
rm -rf "$FAKE2" "$TMP_XDG"

# ---- case 3: socket present but systemd-run dry-run fails ----------------
if command -v python3 >/dev/null 2>&1; then
    TMP_XDG="$(mktemp -d)"
    mkdir -p "$TMP_XDG/systemd"
    python3 - "$TMP_XDG/systemd/private" <<'PYEOF'
import socket, sys
p = sys.argv[1]
s = socket.socket(socket.AF_UNIX)
s.bind(p)
s.close()
PYEOF
    FAKE3="$(make_fake_dir "yes" 1)"
    run_case "systemd-run dry-run failure exits with D-Bus/systemd hint" \
        "$FAKE3" "$TMP_XDG" 1 "systemd-run --user --scope failed"
    rm -rf "$FAKE3" "$TMP_XDG"
else
    echo "  ⚠ SKIP: python3 unavailable; cannot mint a real AF_UNIX socket for dry-run-failure case"
    SKIP=$((SKIP + 1))
fi

# ---- case 4: happy path (linger=yes, socket present, systemd-run rc=0) ---
if command -v python3 >/dev/null 2>&1; then
    TMP_XDG="$(mktemp -d)"
    mkdir -p "$TMP_XDG/systemd"
    python3 - "$TMP_XDG/systemd/private" <<'PYEOF'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.close()
PYEOF
    FAKE4="$(make_fake_dir "yes" 0)"
    run_case "happy path exits 0 with success log" \
        "$FAKE4" "$TMP_XDG" 0 "OK: linger=yes"
    rm -rf "$FAKE4" "$TMP_XDG"
else
    echo "  ⚠ SKIP: python3 unavailable; cannot exercise happy-path"
    SKIP=$((SKIP + 1))
fi

echo ""

# ---- guard: deploy.sh must not pass NCU_SUDO_PASS through systemd-run --setenv
# Rationale: --setenv values are visible in `systemctl --user show <scope> -p Environment`
# and in /proc/<systemd-run>/cmdline for the entire deploy lifetime. The detached
# child re-execs `bash $0` and re-reads the literal NCU_SUDO_PASS=... assignment, so
# passthrough is unnecessary as well as unsafe.
if grep -nE 'passthrough_keys=\([^)]*NCU_SUDO_PASS' deploy.sh >/dev/null 2>&1; then
    echo "  ✗ guard: NCU_SUDO_PASS found in passthrough_keys (would leak via systemd-run --setenv)"
    grep -nE 'passthrough_keys=\([^)]*NCU_SUDO_PASS' deploy.sh
    FAIL=$((FAIL + 1))
elif grep -nE -- '--setenv=NCU_SUDO_PASS' deploy.sh >/dev/null 2>&1; then
    echo "  ✗ guard: --setenv=NCU_SUDO_PASS literal found in deploy.sh"
    grep -nE -- '--setenv=NCU_SUDO_PASS' deploy.sh
    FAIL=$((FAIL + 1))
else
    echo "  ✓ guard: NCU_SUDO_PASS is not passed through systemd-run --setenv"
    PASS=$((PASS + 1))
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
