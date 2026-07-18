#!/bin/sh
# Isolation tests for mudimodem-revert. DRY mode + temp paths: never touches the
# modem or /etc. Proves the safety logic before any real band write can exist.
#
# Usage: sh revert.test.sh /path/to/mudimodem-revert
set -u
SCRIPT="${1:-/tmp/mudimodem-revert}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILED=0

pass() { echo "  ok  - $1"; }
fail() { echo "  FAIL- $1"; FAILED=1; }

run() {  # runs the watchdog with isolated env; extra env in $EXTRA
  P="$WORK/pending"; L="$WORK/log"
  env MUDIMODEM_DRY=1 MUDIMODEM_PENDING="$P" MUDIMODEM_LOG="$L" \
      MUDIMODEM_ARMED="$WORK/armed" MUDIMODEM_WINDOW="${WIN:-1}" \
      MUDIMODEM_STALE="$WORK/stale" sh "$SCRIPT" "$@"
}
mkpending() { printf 'SUB_ID=1\nPREV_nr5g_band=%s\n' "$1" > "$WORK/pending"; }
inlog() { grep -q "$1" "$WORK/log" 2>/dev/null; }

echo "1. watch: window elapses, still pending -> reverts to previous"
rm -f "$WORK/log"; mkpending "71"
WIN=1 run watch
inlog "reverting"                 && pass "logged revert" || fail "no revert logged"
inlog 'nr5g_band\\",71'           && pass "DRY-wrote nr5g_band 71" || fail "wrong/no AT write"
[ ! -f "$WORK/pending" ]          && pass "pending cleared" || fail "pending not cleared"

echo "2. watch: confirmed within window -> NO revert"
rm -f "$WORK/log" "$WORK/armed"; mkpending "71"
WIN=3 run watch &
WPID=$!
sleep 1
[ -f "$WORK/armed" ]              && pass "arm marker present during window" || fail "never armed"
rm -f "$WORK/pending"             # simulate mudimodem.confirm
wait "$WPID"
inlog "confirmed within window"   && pass "logged confirm" || fail "no confirm logged"
inlog "reverting"                 && fail "reverted despite confirm!" || pass "did not revert"
[ ! -f "$WORK/armed" ]            && pass "arm marker cleared after" || fail "arm marker leaked"

echo "3. boot-check: stale pending survives reboot -> reverts"
rm -f "$WORK/log"; mkpending "71"
run boot-check
inlog "stale pending"             && pass "detected stale" || fail "missed stale pending"
[ ! -f "$WORK/pending" ]          && pass "pending cleared" || fail "pending not cleared"

echo "4. boot-check: nothing pending -> no-op"
rm -f "$WORK/log" "$WORK/pending"
run boot-check
inlog "nothing pending"           && pass "clean no-op" || fail "unexpected action"
inlog "reverting"                 && fail "reverted with no pending!" || pass "did not revert"

echo "5. panic: restores known-good SA + clears cell locks"
rm -f "$WORK/log"; mkpending "71"
run panic 1
inlog 'nr5g_band\\",2:5:7:12:13:14:25:26:29:30:38:41:48:66:70:71:77:78' \
                                  && pass "wrote full known-good SA" || fail "wrong known-good list"
inlog 'QNWLOCK=\\"common/4g\\",0' && pass "cleared 4g lock" || fail "did not clear 4g lock"
inlog 'QNWLOCK=\\"common/5g\\",0' && pass "cleared 5g lock" || fail "did not clear 5g lock"
[ ! -f "$WORK/pending" ]          && pass "pending cleared" || fail "pending not cleared"

echo "6. watch (KIND=cell): reverts by raw-AT unlock + restores prefs + marks stale"
rm -f "$WORK/log" "$WORK/stale"
printf 'KIND=cell\nSUB_ID=1\nSLOT=1\nRAT=5g\nPREV_SAVE_CTRL=0,0\nPREV_mode_pref=NR5G\nPREV_nr5g_disable_mode=0\n' > "$WORK/pending"
WIN=1 run watch
inlog 'QNWLOCK=\\"common/5g\\",0'      && pass "unlocked 5g" || fail "no 5g unlock"
inlog 'QNWLOCK=\\"save_ctrl\\",0,0'    && pass "restored save_ctrl" || fail "no save_ctrl restore"
inlog 'mode_pref\\",NR5G'              && pass "restored mode_pref" || fail "no mode_pref restore"
inlog 'nr5g_disable_mode\\",0'         && pass "restored nr5g_disable_mode" || fail "no disable_mode restore"
[ -f "$WORK/stale" ]                   && pass "stale marker dropped" || fail "no stale marker"
[ ! -f "$WORK/pending" ]               && pass "pending cleared" || fail "pending not cleared"

echo "7. watch (KIND=cell, 4g): unlocks the right RAT"
rm -f "$WORK/log" "$WORK/stale"
printf 'KIND=cell\nSUB_ID=1\nSLOT=1\nRAT=4g\nPREV_SAVE_CTRL=0,0\nPREV_mode_pref=AUTO\nPREV_nr5g_disable_mode=\n' > "$WORK/pending"
WIN=1 run watch
inlog 'QNWLOCK=\\"common/4g\\",0'      && pass "unlocked 4g" || fail "no 4g unlock"
inlog 'QNWLOCK=\\"common/5g\\",0'      && fail "touched 5g needlessly" || pass "left 5g alone"

echo "8. panic: also resets save_ctrl, mode_pref, and nr5g_disable_mode"
rm -f "$WORK/log"
run panic 1
inlog 'QNWLOCK=\\"save_ctrl\\",0,0'    && pass "save_ctrl reset" || fail "no save_ctrl reset"
inlog 'mode_pref\\",AUTO'              && pass "mode_pref AUTO" || fail "no mode_pref reset"
inlog 'nr5g_disable_mode\\",0'         && pass "nr5g_disable_mode reset (M1)" || fail "no nr5g_disable_mode reset"

echo "9. watch (I1): a superseded watchdog (arm nonce no longer ours) stands down"
# W1 arms for pending A with a long window. Mid-window a NEWER watchdog is
# simulated by overwriting the arm marker with a different nonce (as a real
# new experiment's watchdog would). W1 must NOT revert and must NOT delete the
# newer arm marker.
rm -f "$WORK/log"; mkpending "71"
WIN=3 run watch &
WPID=$!
sleep 1
[ -f "$WORK/armed" ]              && pass "W1 armed (nonce present)" || fail "W1 never armed"
echo 999999 > "$WORK/armed"       # simulate a newer watchdog taking over the arm
wait "$WPID"
inlog "superseded"               && pass "W1 logged stand-down" || fail "W1 did not detect supersede"
inlog "reverting"                && fail "superseded W1 reverted anyway!" || pass "superseded W1 did not revert"
[ -f "$WORK/pending" ]           && pass "pending left intact for the new owner" || fail "W1 wrongly cleared pending"
[ "$(cat "$WORK/armed" 2>/dev/null)" = "999999" ] && pass "newer arm marker left intact" || fail "W1 stomped the newer arm marker"

echo
if [ "$FAILED" = "0" ]; then echo "ALL REVERT TESTS PASSED"; else echo "REVERT TESTS FAILED"; exit 1; fi
