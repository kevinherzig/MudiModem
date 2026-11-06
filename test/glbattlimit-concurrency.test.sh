#!/bin/sh
# Issue #7: a second `glbattlimit on` (the GUI slider, or i2c hotplug) must not
# leave two _watch processes, and status/off must see the one that is running.
#
# The failure mode on device: busybox ash defers a TERM trap until the external
# `sleep 15` returns, so the old watcher deletes the new watcher's PID file on
# the way out. Hotplug then finds no PID and starts another watcher.
#
# This harness never touches real sysfs or /tmp/glbattlimit.*. It rewrites a
# copy onto a fake charger and private state files. /bin/sh is the primary
# interpreter (dash here, busybox ash on the router — both use an external
# sleep, so the trap stays deferred). When a separate busybox ash exists, the
# suite runs again under it, once with /bin/sleep and once with ash's builtin.
#
#   sh test/glbattlimit-concurrency.test.sh
#   GLBATT_MODES=system sh test/glbattlimit-concurrency.test.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/src/sbin/glbattlimit"
HOTPLUG_SRC="$ROOT/src/hotplug/20-glbattlimit"
[ -f "$SRC" ] || { echo "FAIL: missing $SRC" >&2; exit 1; }
[ -f "$HOTPLUG_SRC" ] || { echo "FAIL: missing $HOTPLUG_SRC" >&2; exit 1; }

# Shipped script keeps production paths and the upstream hardening.
grep -q '^POLL=15$' "$SRC" || { echo "FAIL: production POLL drifted" >&2; exit 1; }
grep -q '^PIDF=/tmp/glbattlimit.pid$' "$SRC" || { echo "FAIL: production PIDF drifted" >&2; exit 1; }
grep -q 'acquire_lock' "$SRC" || { echo "FAIL: lock missing" >&2; exit 1; }
grep -q 'clear_own_state' "$SRC" || { echo "FAIL: owner-scoped cleanup missing" >&2; exit 1; }
grep -q 'kill -KILL' "$SRC" || { echo "FAIL: SIGKILL teardown missing" >&2; exit 1; }
grep -q 'on \[PERCENT\] gui' "$SRC" || { echo "FAIL: gui arg missing" >&2; exit 1; }

WORK=
BIN=
PIDF=
LIMF=
LOCKD=
LOG=
FAKE=
MODE=
HOTPLUG=

cleanup() {
    if [ -n "${BIN:-}" ]; then
        for d in /proc/[0-9]*; do
            [ -r "$d/cmdline" ] || continue
            p=${d##*/}
            cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null || true)
            case "$cmd" in
                *"$BIN _watch "*) kill -KILL "$p" 2>/dev/null || true ;;
            esac
        done
    fi
    if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
        rm -rf "$WORK" || true
    fi
    WORK= BIN= PIDF= LIMF= LOCKD= LOG= FAKE= HOTPLUG=
}
trap cleanup EXIT

fail() {
    echo "FAIL ($MODE): $1" >&2
    echo "--- pid ---" >&2
    cat "$PIDF" 2>/dev/null >&2 || echo "(none)" >&2
    echo "--- limit ---" >&2
    cat "$LIMF" 2>/dev/null >&2 || echo "(none)" >&2
    echo "--- vreg ---" >&2
    cat "$FAKE/buck/vreg" 2>/dev/null >&2 || true
    echo "--- log ---" >&2
    cat "$LOG" 2>/dev/null >&2 || true
    echo "--- watchers ---" >&2
    if [ -n "${BIN:-}" ]; then
        for d in /proc/[0-9]*; do
            [ -r "$d/cmdline" ] || continue
            cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null || true)
            case "$cmd" in
                *"$BIN"*) echo "$cmd" >&2 ;;
            esac
        done
    fi
    exit 1
}

count_watchers() {
    n=0
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null || true)
        case "$cmd" in
            *"$BIN _watch "*) n=$((n + 1)) ;;
        esac
    done
    echo "$n"
}

live_pid() {
    cat "$PIDF" 2>/dev/null || true
}

assert_one() {
    n=$(count_watchers)
    [ "$n" -eq 1 ] || fail "$1: watcher count $n"
    p=$(live_pid)
    [ -n "$p" ] || fail "$1: empty pid file"
    kill -0 "$p" 2>/dev/null || fail "$1: pid $p is not alive"
    # The pid file must name the _watch process, not a leftover sleep.
    found=0
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null || true)
        case "$cmd" in
            *"$BIN _watch "*)
                [ "${d##*/}" = "$p" ] && found=1
                ;;
        esac
    done
    [ "$found" -eq 1 ] || fail "$1: pid file $p is not the watcher"
}

last_state_log() {
    last=
    while IFS= read -r line; do
        case "$line" in
            *"active, limit"*|*"stopped, limit"*) last=$line ;;
        esac
    done < "$LOG"
    printf '%s\n' "$last"
}

prepare() {
    # $1 = system | ash-ext | ash-builtin
    MODE=$1
    cleanup
    WORK=$(mktemp -d)
    BIN="$WORK/glbattlimit"
    PIDF="$WORK/pid"
    LIMF="$WORK/limit"
    LOCKD="$WORK/lock"
    LOG="$WORK/log"
    FAKE="$WORK/sys"
    HOTPLUG="$WORK/hotplug"
    mkdir -p "$FAKE/bat" "$FAKE/charger" "$FAKE/pump" "$FAKE/buck" "$WORK/bin"
    # POLL=8 leaves a window where the old sleep is still running when
    # stop_watcher gives up on TERM (2s) and SIGKILLs. The copy's trailing
    # `sleep 2` (parent wait for the child to publish state) is `sleep 1`
    # so the suite stays short; production POLL and that sleep are unchanged.
    sed \
        -e "s|^BAT=.*|BAT=$FAKE/bat|" \
        -e "s|^CHG=.*|CHG=$FAKE/charger|" \
        -e "s|^PUMP=.*|PUMP=$FAKE/pump|" \
        -e "s|^BUCK=.*|BUCK=$FAKE/buck|" \
        -e "s|^PIDF=.*|PIDF=$PIDF|" \
        -e "s|^LIMF=.*|LIMF=$LIMF|" \
        -e "s|^LOCKD=.*|LOCKD=$LOCKD|" \
        -e 's|^POLL=15$|POLL=8|' \
        -e 's|^    sleep 2$|    sleep 1|' \
        "$SRC" > "$BIN"
    case "$MODE" in
        ash-ext|ash-builtin)
            sed '1s|^#!.*|#!/usr/bin/busybox ash|' "$BIN" > "$BIN.shebang"
            mv "$BIN.shebang" "$BIN"
            ;;
    esac
    if [ "$MODE" = "ash-ext" ]; then
        # Force the external sleep OpenWrt uses, so TERM stays deferred
        # even when this ash has sleep as a builtin.
        sed 's/ sleep / \/bin\/sleep /g' "$BIN" > "$BIN.sleep"
        mv "$BIN.sleep" "$BIN"
    fi
    chmod 0755 "$BIN"
    grep -q '^POLL=8$' "$BIN" || fail "POLL rewrite failed"
    grep -q 'sleep 2' "$BIN" && fail "startup sleep 2 still in the test copy"
    case "$MODE" in
        system|ash-builtin) busybox ash -n "$BIN" 2>/dev/null || sh -n "$BIN" ;;
        ash-ext) busybox ash -n "$BIN" ;;
    esac

    cat > "$WORK/bin/logger" <<'EOF'
#!/bin/sh
# logger -t TAG message...
shift 2
printf '%s\n' "$*" >> "$GLBATT_LOG"
EOF
    chmod 0755 "$WORK/bin/logger"

    sed "s|^PIDF=.*|PIDF=$PIDF|" "$HOTPLUG_SRC" > "$HOTPLUG"
    chmod 0755 "$HOTPLUG"
    printf '%s\n' '{"enabled":true,"limit_gui":80}' > "$WORK/battlimit.json"
    : > "$LOG"

    export GLBATT_LOG="$LOG"
    export PATH="$WORK/bin:$PATH"
}

sys() {
    # capacity voltage_uv current_ma online
    printf '%s\n' "$1" > "$FAKE/bat/capacity"
    printf '%s\n' "$2" > "$FAKE/bat/voltage_now"
    printf '%s\n' "$3" > "$FAKE/bat/current_now"
    printf '%s\n' "$4" > "$FAKE/charger/online"
    printf '%s\n' "0" > "$FAKE/pump/charge_en"
    printf '%s\n' "4400000" > "$FAKE/buck/vreg"
}

run_hotplug() {
    MUDIMODEM_BATTLIMIT_FILE="$WORK/battlimit.json" \
    MUDIMODEM_BATTLIMIT_BIN="$BIN" \
    MUDIMODEM_BATTLIMIT_CHG_ONLINE=1 \
    DRIVER=cw221X \
    sh "$HOTPLUG"
}

suite() {
    prepare "$1"
    echo "  suite: $MODE"

    sys 90 4100000 500 0
    if "$BIN" on abc >"$WORK/out" 2>&1; then fail "abc should be rejected"; fi
    grep -q 'Invalid value' "$WORK/out" || fail "abc message"
    if "$BIN" on 10 >"$WORK/out" 2>&1; then fail "gauge 10 should be rejected"; fi
    grep -q 'between 50 and 100' "$WORK/out" || fail "gauge 10 message"
    if "$BIN" on 10 gui >"$WORK/out" 2>&1; then fail "gui 10 should be rejected"; fi
    grep -q 'between 20 and 100' "$WORK/out" || fail "gui 10 message"
    if "$BIN" on 40 gui >"$WORK/out" 2>&1; then fail "gui 40 should be rejected"; fi
    grep -q 'between 50 and 100' "$WORK/out" || fail "gui 40 message"
    [ "$(count_watchers)" -eq 0 ] || fail "rejected on left a watcher"

    # Empty lock dir (holder died between mkdir and writing its pid) is reclaimed,
    # and a refused `on` still drops the lock on the way out.
    mkdir "$LOCKD"
    if "$BIN" on 80 >"$WORK/out" 2>&1; then fail "offline on should fail"; fi
    grep -q 'No charger connected' "$WORK/out" || fail "offline message"
    [ ! -d "$LOCKD" ] || fail "lock leaked after offline on"
    [ "$(count_watchers)" -eq 0 ] || fail "offline on started a watcher"
    echo "  ok: reject bad args, reclaim empty lock, no charger"

    # Dead lock owner + GUI conversion + gate_on (cap 90 >= gauge 71).
    sys 90 4100000 500 1
    mkdir "$LOCKD"
    printf '%s\n' 999999 > "$LOCKD/pid"
    "$BIN" on 80 gui >"$WORK/out" 2>&1 || fail "on 80 gui failed: $(cat "$WORK/out")"
    grep -q 'GUI 80 % -> gauge 71 %' "$WORK/out" || fail "gui conversion: $(cat "$WORK/out")"
    [ "$(cat "$LIMF")" = "71" ] || fail "limit file $(cat "$LIMF")"
    [ "$(cat "$FAKE/pump/charge_en")" = "0" ] || fail "pump not gated"
    [ "$(cat "$FAKE/buck/vreg")" = "3950000" ] || fail "vreg $(cat "$FAKE/buck/vreg")"
    assert_one "after gui on"
    st=$("$BIN" status 2>&1) || fail "status failed"
    case "$st" in
        *"active"*) ;;
        *) fail "status did not see the watcher: $st" ;;
    esac
    case "$st" in
        *"PID $(live_pid)"*) ;;
        *) fail "status pid: $st" ;;
    esac
    case "$st" in
        *"71 % gauge"*) ;;
        *) fail "status gauge: $st" ;;
    esac
    pid1=$(live_pid)
    echo "  ok: gui on, status sees the watcher, buck gated"

    # Repro: `on` again while the first watcher is inside sleep.
    # After the old sleep would have ended, the replacement is still the
    # only watcher, the pid file still names it, and vreg is still gated
    # (a late TERM trap would have restored the factory 4400000 uV).
    "$BIN" on 60 >"$WORK/out" 2>&1 || fail "second on failed: $(cat "$WORK/out")"
    assert_one "after second on"
    pid2=$(live_pid)
    [ "$pid2" != "$pid1" ] || fail "watcher was not replaced"
    kill -0 "$pid1" 2>/dev/null && fail "old watcher $pid1 still alive"
    [ "$(cat "$LIMF")" = "60" ] || fail "limit not updated"
    sleep 5
    assert_one "after old sleep window"
    [ "$(live_pid)" = "$pid2" ] || fail "pid file changed after the old sleep"
    [ "$(cat "$FAKE/buck/vreg")" = "3950000" ] || fail "late trap restored vreg"
    case "$(last_state_log)" in
        "active, limit 60%"*) ;;
        *) fail "log ended on '$(last_state_log)'" ;;
    esac
    echo "  ok: second on left a single watcher past the old sleep"

    # Hotplug sees the live pid and does not start another watcher.
    run_hotplug || fail "hotplug failed"
    assert_one "hotplug with live pid"
    [ "$(live_pid)" = "$pid2" ] || fail "hotplug replaced a healthy watcher"
    echo "  ok: hotplug no-ops while the pid file is live"

    # The reported failure: pid file gone, charger still online, hotplug
    # calls `on`. That must stop the sleeper and leave exactly one watcher.
    rm -f "$PIDF"
    run_hotplug || fail "hotplug repair failed"
    assert_one "hotplug repair"
    [ "$(live_pid)" != "$pid2" ] || fail "repair did not replace the old watcher"
    kill -0 "$pid2" 2>/dev/null && fail "pre-hotplug watcher still alive"
    [ "$(cat "$LIMF")" = "71" ] || fail "hotplug limit $(cat "$LIMF")"
    st=$("$BIN" status 2>&1) || fail "status after repair failed"
    case "$st" in
        *"active"*) ;;
        *) fail "status missed the repaired watcher: $st" ;;
    esac
    case "$st" in
        *"PID $(live_pid)"*) ;;
        *) fail "status repair pid: $st" ;;
    esac
    echo "  ok: hotplug repair stops the sleeper and status sees the new one"

    # off finds the watcher from /proc when the pid file does not.
    held=$(live_pid)
    rm -f "$PIDF"
    [ "$(count_watchers)" -eq 1 ] || fail "watcher vanished before off"
    "$BIN" off >"$WORK/out" 2>&1 || fail "off failed"
    [ "$(count_watchers)" -eq 0 ] || fail "off left a watcher"
    kill -0 "$held" 2>/dev/null && fail "off did not kill $held"
    [ ! -f "$PIDF" ] || fail "pid file survived off"
    st=$("$BIN" status 2>&1) || fail "status after off failed"
    case "$st" in
        *"Limit     : off"*) ;;
        *) fail "status after off: $st" ;;
    esac
    grep -q 'Charge limit off' "$WORK/out" || fail "off message"
    [ "$(cat "$FAKE/buck/vreg")" = "4400000" ] || fail "off did not restore vreg"
    echo "  ok: off stops the real watcher without the pid file"

    # Below the limit the buck target goes back to the factory voltage.
    "$BIN" on 100 >"$WORK/out" 2>&1 || fail "on 100 failed"
    assert_one "below limit"
    [ "$(cat "$FAKE/buck/vreg")" = "4400000" ] || fail "below-limit vreg"
    "$BIN" off >/dev/null 2>&1 || fail "off after below-limit"
    [ "$(count_watchers)" -eq 0 ] || fail "watcher left after below-limit off"
    echo "  ok: below-limit charging is unchanged"

    # Owner-scoped cleanup: a dying watcher's trap must not delete a pid
    # file that no longer names it (the other half of the race).
    : > "$LOG"
    "$BIN" on 80 >/dev/null 2>&1 || fail "on for owner-scope failed"
    assert_one "owner-scope start"
    w=$(live_pid)
    printf '%s\n' 424242 > "$PIDF"
    kill -TERM "$w" 2>/dev/null || fail "TERM $w failed"
    i=0
    while kill -0 "$w" 2>/dev/null; do
        i=$((i + 1))
        [ "$i" -lt 15 ] || fail "watcher survived TERM"
        sleep 1
    done
    [ "$(cat "$PIDF" 2>/dev/null)" = "424242" ] || fail "dying watcher removed a foreign pid file"
    [ "$(count_watchers)" -eq 0 ] || fail "watcher still counted after TERM"
    rm -f "$PIDF" "$LIMF"
    echo "  ok: TERM trap cleans up only its own pid file"

    # Two overlapping `on` calls serialize on the lock and leave one watcher.
    "$BIN" on 80 >"$WORK/c1.out" 2>&1 &
    c1=$!
    "$BIN" on 90 >"$WORK/c2.out" 2>&1 &
    c2=$!
    wait "$c1" || fail "concurrent on 80: $(cat "$WORK/c1.out" 2>/dev/null)"
    wait "$c2" || fail "concurrent on 90: $(cat "$WORK/c2.out" 2>/dev/null)"
    assert_one "after concurrent on"
    "$BIN" off >/dev/null 2>&1 || fail "final off"
    [ "$(count_watchers)" -eq 0 ] || fail "final off left a watcher"
    [ ! -d "$LOCKD" ] || fail "lock leaked"
    echo "  ok: overlapping on calls leave one watcher"

    cleanup
}

sh -n "$SRC"
suite system

if command -v busybox >/dev/null 2>&1; then
    link=$(readlink /bin/sh 2>/dev/null || true)
    run_ash=1
    case "$link" in
        *busybox*) run_ash=0 ;;
    esac
    case "${GLBATT_MODES:-all}" in
        system) run_ash=0 ;;
    esac
    if [ "$run_ash" -eq 1 ]; then
        suite ash-ext
        suite ash-builtin
    fi
fi

echo "glbattlimit-concurrency OK"
