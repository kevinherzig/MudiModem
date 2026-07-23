#!/bin/sh
# Isolation test for config-aware glbattlimit hotplug/init glue.
# Uses a stub glbattlimit that records its argv; never touches real sysfs.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

STUB="$TMP/glbattlimit"
LOG="$TMP/calls.log"
CFG="$TMP/battlimit.json"
HOTPLUG="$ROOT/src/hotplug/20-glbattlimit"
INIT="$ROOT/src/etc/init.d/glbattlimit"

cat > "$STUB" <<'EOF'
#!/bin/sh
echo "$*" >> "$CALL_LOG"
exit 0
EOF
chmod +x "$STUB"

# ---- helpers that inject CFG/BIN/CHG into the scripts under test ----
# The production scripts must honour:
#   MUDIMODEM_BATTLIMIT_FILE, MUDIMODEM_BATTLIMIT_BIN, MUDIMODEM_BATTLIMIT_CHG_ONLINE
# (env overrides for tests; production defaults to the real paths / sysfs read).

run_hotplug() {
  CALL_LOG="$LOG" \
  MUDIMODEM_BATTLIMIT_FILE="$CFG" \
  MUDIMODEM_BATTLIMIT_BIN="$STUB" \
  MUDIMODEM_BATTLIMIT_CHG_ONLINE="$1" \
  DRIVER=cw221X \
  sh "$HOTPLUG"
}

# Case A: missing config → no-op (defaults disabled)
rm -f "$CFG" "$LOG"
run_hotplug 1
[ ! -f "$LOG" ] || { echo "FAIL A: expected no call"; cat "$LOG"; exit 1; }

# Case B: enabled false → no-op
echo '{"enabled":false,"limit_gui":80}' > "$CFG"
run_hotplug 1
[ ! -f "$LOG" ] || { echo "FAIL B: expected no call"; cat "$LOG"; exit 1; }

# Case C: enabled true, charger offline → no-op
echo '{"enabled":true,"limit_gui":80}' > "$CFG"
run_hotplug 0
[ ! -f "$LOG" ] || { echo "FAIL C: expected no call when offline"; cat "$LOG"; exit 1; }

# Case D: enabled true, charger online → on 80 gui
echo '{"enabled":true,"limit_gui":80}' > "$CFG"
rm -f "$LOG"
run_hotplug 1
grep -qx 'on 80 gui' "$LOG" || { echo "FAIL D: expected 'on 80 gui'"; cat "$LOG"; exit 1; }

# Case E: init start with enabled + online
echo '{"enabled":true,"limit_gui":75}' > "$CFG"
rm -f "$LOG"
CALL_LOG="$LOG" \
MUDIMODEM_BATTLIMIT_FILE="$CFG" \
MUDIMODEM_BATTLIMIT_BIN="$STUB" \
MUDIMODEM_BATTLIMIT_CHG_ONLINE=1 \
sh -c '. "'"$INIT"'"; start'
grep -qx 'on 75 gui' "$LOG" || { echo "FAIL E: init start"; cat "$LOG"; exit 1; }

echo "battlimit-hotplug OK"
