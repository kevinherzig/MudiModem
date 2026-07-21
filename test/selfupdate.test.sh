#!/bin/sh
# Isolation test for mudimodem-selfupdate. All paths + the install command are
# overridden via env so nothing real is fetched or installed. $1 = script path.
set -u
SCRIPT="${1:-/usr/sbin/mudimodem-selfupdate}"
T=$(mktemp -d)
LOCK="$T/lock.d"; RESULT="$T/result.json"; LOG="$T/update.log"
fail() { echo "FAIL: $1" >&2; rm -rf "$T"; exit 1; }

# --- success path: command exits 0 -> result ok:true, lock cleaned up ---
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="true" \
  sh "$SCRIPT"
[ -f "$RESULT" ] || fail "no result file after success"
grep -q '"ok":true' "$RESULT" || fail "success did not record ok:true ($(cat "$RESULT"))"
[ -d "$LOCK" ] && fail "lockdir not removed after success"

# --- failure path: command exits nonzero -> result ok:false + error ---
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="sh -c 'echo boom >&2; exit 7'" \
  sh "$SCRIPT"
grep -q '"ok":false' "$RESULT" || fail "failure did not record ok:false ($(cat "$RESULT"))"
grep -q '"error"' "$RESULT" || fail "failure did not record an error field"

# --- concurrency: a pre-existing lockdir makes the script a no-op ---
mkdir -p "$LOCK"
rm -f "$RESULT"
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="true" \
  sh "$SCRIPT"
[ -f "$RESULT" ] && fail "second run ran despite existing lockdir"
rmdir "$LOCK"

# --- stale lock: a lockdir far older than the threshold gets reaped, so the
# run proceeds instead of wedging forever (SIGKILL/OOM/power-loss recovery) ---
mkdir -p "$LOCK"
touch -t 202001010000 "$LOCK"
rm -f "$RESULT"
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="true" \
  sh "$SCRIPT"
[ -f "$RESULT" ] || fail "stale lockdir was not reaped (no result written)"
grep -q '"ok":true' "$RESULT" || fail "stale-reap run did not record ok:true ($(cat "$RESULT"))"
rm -f "$RESULT"
[ -d "$LOCK" ] && rmdir "$LOCK" 2>/dev/null

# --- fresh lock: a lockdir with a current mtime is NOT reaped -> still a no-op ---
mkdir -p "$LOCK"
rm -f "$RESULT"
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="true" \
  sh "$SCRIPT"
[ -f "$RESULT" ] && fail "fresh lockdir was reaped (concurrency protection broken)"
rmdir "$LOCK"

rm -rf "$T"
echo "selfupdate OK"
