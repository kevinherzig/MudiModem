#!/bin/sh
# Behavioural test for src/sbin/mudimodem-lcddeps — the LCD python dependency
# guard added after the 4.8.5 -> 4.10.0 A/B FOTA wiped site-packages and left
# mudi.py / mudi-watch.py crash-looping on ModuleNotFoundError while gl_screen
# kept the panel (2026-08-24).
#
# Also covers the 4.10.2 failure (issue #6): a zero-byte /usr/bin/python3.11 is
# re-executed by ash as an empty shell script, so `python3 -c ...` exits 0 with
# no stdout. check must require the sentinel, and install must force-reinstall
# python3-base, libpython3-3.11 and python3-light, then re-verify.
#
# Runs anywhere: python3, opkg, logger and the init scripts are all stubbed, so
# nothing is installed and no service is touched. $1 = path to the script.
set -eu
SCRIPT="${1:-$(dirname "$0")/../src/sbin/mudimodem-lcddeps}"
[ -f "$SCRIPT" ] || { echo "FAIL: no such script: $SCRIPT" >&2; exit 1; }
SCRIPT=$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  ok: $1"; }

SENTINEL=$(sed -n 's/^SENTINEL=//p' "$SCRIPT" | head -n 1)
[ -n "$SENTINEL" ] || fail "script must define SENTINEL (stdout token, not the exit code)"
LIBPYTHON=$(sed -n 's/^LIBPYTHON_FALLBACK=//p' "$SCRIPT" | head -n 1)
[ -n "$LIBPYTHON" ] || fail "script must define LIBPYTHON_FALLBACK"
PY_CORE=$(sed -n 's/^PY_CORE="\(.*\)"$/\1/p' "$SCRIPT" | head -n 1)
echo " $PY_CORE " | grep -q ' python3-base ' || fail "PY_CORE must include python3-base"
echo " $PY_CORE " | grep -q ' python3-light ' || fail "PY_CORE must include python3-light"

# --- stubs ------------------------------------------------------------------
# python3: three behaviours, selected by $WORK/python_mode (default ok).
#   ok    — print SENTINEL if every requested module is in $WORK/have, else
#           the missing names. Exit 0 either way: a real ImportError exits 1,
#           but the guard must not trust the exit code, so the stub refuses
#           to make "nonzero" the thing the test depends on.
#   noop  — exit 0, no stdout. This is a zero-byte python3.11: ash re-execs
#           ENOEXEC as an empty script.
#   fail  — ImportError on stdout, exit 1, no sentinel.
cat > "$BIN/python3" <<EOF
#!/bin/sh
mode=ok
[ -f "\$WORK/python_mode" ] && mode=\$(cat "\$WORK/python_mode")
case "\$mode" in
  noop) exit 0 ;;
  fail)
    echo "ImportError: No module named numpy"
    exit 1 ;;
esac
sentinel=""
mods=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = -c ]; then prev=\$a; continue; fi
  if [ "\$a" = -c ]; then prev=-c; continue; fi
  if [ "\$a" = "$SENTINEL" ]; then sentinel=\$a; prev=\$a; continue; fi
  if [ -n "\$sentinel" ]; then mods="\$mods \$a"; fi
  prev=\$a
done
bad=""
for m in \$mods; do
  grep -qx "\$m" "\$WORK/have" 2>/dev/null || bad="\$bad \$m"
done
if [ -z "\$bad" ]; then
  echo "$SENTINEL"
  exit 0
fi
for m in \$bad; do
  echo "\$m"
done
exit 0
EOF

# opkg: list-installed reads $WORK/installed; install appends and logs the call.
# Reinstalling python3-base is what replaces a zero-byte interpreter, so the
# stub clears a noop/fail mode when that package is installed.
write_opkg_ok() {
cat > "$BIN/opkg" <<'EOF'
#!/bin/sh
echo "opkg $*" >> "$WORK/opkg.log"
case "$1" in
  list-installed) cat "$WORK/installed" 2>/dev/null ;;
  update) [ -f "$WORK/net_down" ] && exit 1; exit 0 ;;
  install)
      shift
      for a in "$@"; do case "$a" in --*) continue ;; *) pkg=$a ;; esac; done
      echo "$pkg - stub" >> "$WORK/installed"
      # installing pillow is what makes PIL importable, and only if libtiff6
      # is already in — this is the real-world coupling the ordering protects.
      if [ "$pkg" = python3-pillow ]; then
          grep -q '^libtiff6 ' "$WORK/installed" && echo PIL >> "$WORK/have"
      fi
      [ "$pkg" = python3-numpy ] && echo numpy >> "$WORK/have"
      [ "$pkg" = python3-evdev ] && echo evdev >> "$WORK/have"
      # A force-reinstall of the interpreter replaces the empty binary.
      [ "$pkg" = python3-base ] && echo ok > "$WORK/python_mode"
      exit 0 ;;
esac
exit 0
EOF
chmod +x "$BIN/opkg"
}

cat > "$BIN/logger" <<'EOF'
#!/bin/sh
echo "$*" >> "$WORK/logger.log"
EOF

# init scripts: record that they were asked to start, never actually start
mkdir -p "$WORK/etc/init.d"
for s in mudi mudi-watch; do
  cat > "$WORK/etc/init.d/$s" <<EOF
#!/bin/sh
echo "$s \$1" >> "\$WORK/started.log"
EOF
  chmod +x "$WORK/etc/init.d/$s"
done

chmod +x "$BIN"/*
write_opkg_ok
export WORK
export PATH="$BIN:$PATH"

# The script hardcodes /etc/init.d/... — rewrite those to the stub tree so the
# test can never touch the real services, even if run as root on a device.
sed "s|/etc/init.d/|$WORK/etc/init.d/|g; s|LOCK=/tmp/|LOCK=$WORK/|; s|STAMP=/tmp/|STAMP=$WORK/|" \
    "$SCRIPT" > "$WORK/lcddeps"
chmod +x "$WORK/lcddeps"
S="$WORK/lcddeps"

reset() { : > "$WORK/have"; : > "$WORK/installed"; rm -f "$WORK"/*.log "$WORK"/*.failed "$WORK/net_down" "$WORK/python_mode"; }

# Mark every package the script might consider "already installed", including
# the interpreter packages and the resolved libpython fallback.
seed_all_installed() {
    for p in $PY_CORE $LIBPYTHON $(sed -n 's/^LCD_DEPS="\(.*\)"$/\1/p' "$SCRIPT") python3-pillow; do
        echo "$p - stub" >> "$WORK/installed"
    done
}

echo "== mudimodem-lcddeps =="

# --- 1. check: working python prints the sentinel -> exit 0, silent ---
reset; printf 'numpy\nevdev\nPIL\n' > "$WORK/have"
out=$("$S" check) || fail "check must exit 0 when python prints the sentinel"
[ -z "$out" ] || fail "check must be silent on success (got: $out)"
pass "check exits 0 and prints nothing when the sentinel is present"

# --- 1b. check: empty/no-op python (exit 0, no stdout) is NOT success ---
# The 4.10.2 router: /usr/bin/python3.11 was zero bytes. ash ran it as an
# empty script. Modules can even be "present"; the interpreter never ran.
reset; echo noop > "$WORK/python_mode"
printf 'numpy\nevdev\nPIL\n' > "$WORK/have"
out=$("$S" check) && fail "check must fail when python exits 0 with no output"
[ "$out" = "python-runtime" ] || fail "a silent python must be reported as python-runtime (got: $out)"
echo "$out" | grep -q "$SENTINEL" && fail "noop python must not satisfy the sentinel"
pass "check fails when python is a no-op (exit 0, no stdout)"

# --- 1c. check: python runs, imports fail, no sentinel ---
reset; echo fail > "$WORK/python_mode"
out=$("$S" check) && fail "check must fail when imports fail"
echo "$out" | grep -q 'ImportError' || fail "check must surface the import failure (got: $out)"
[ "$out" = "$SENTINEL" ] && fail "an import error must not count as the sentinel"
pass "check fails when python cannot import the LCD modules"

# --- 2. check: missing modules are named, even if python exits 0 ---
reset; printf 'evdev\n' > "$WORK/have"
out=$("$S" check) && fail "check must exit nonzero when a module is missing"
echo "$out" | grep -q numpy || fail "check must name numpy as missing"
echo "$out" | grep -q PIL   || fail "check must name PIL as missing"
echo "$out" | grep -q evdev && fail "check must NOT name evdev (it imports fine)"
echo "$out" | grep -q "$SENTINEL" && fail "a partial import must not print the sentinel"
pass "check exits 1 and reports exactly the missing modules"

# --- 3. install: runtime packages, only what is missing, pillow --nodeps, order ---
reset
echo "python3-numpy - 1.24.3" > "$WORK/installed"   # numpy already there
echo numpy > "$WORK/have"
"$S" install >/dev/null 2>&1 || fail "install should succeed with the stub feed"
grep -q 'opkg install python3-numpy' "$WORK/opkg.log" && fail "install must skip already-installed packages"
grep -q 'opkg install --nodeps python3-pillow' "$WORK/opkg.log" \
    || fail "pillow must be installed with --nodeps (libfreetype clash with gl-sdk4-screen-large)"
grep -q "opkg install python3-base" "$WORK/opkg.log" \
    || fail "install must install python3-base when it is missing"
grep -q "opkg install $LIBPYTHON" "$WORK/opkg.log" \
    || fail "install must install $LIBPYTHON when opkg has no libpython3 entry"
libp=$(grep -n "install $LIBPYTHON" "$WORK/opkg.log" | head -1 | cut -d: -f1)
base=$(grep -n 'install python3-base' "$WORK/opkg.log" | head -1 | cut -d: -f1)
light=$(grep -n 'install python3-light' "$WORK/opkg.log" | head -1 | cut -d: -f1)
tiff=$(grep -n 'install libtiff6'  "$WORK/opkg.log" | head -1 | cut -d: -f1)
pill=$(grep -n 'install --nodeps python3-pillow' "$WORK/opkg.log" | head -1 | cut -d: -f1)
if [ -z "$libp" ] || [ -z "$base" ] || [ -z "$light" ] || [ -z "$tiff" ] || [ -z "$pill" ]; then
    fail "install log missing an expected package"
fi
[ "$libp" -lt "$base" ] || fail "libpython must be installed before python3-base (the binary links it)"
[ "$base" -lt "$light" ] || fail "python3-base must be installed before python3-light"
[ "$light" -lt "$tiff" ] || fail "python3-light must be installed before libtiff6"
[ "$tiff" -lt "$pill" ] || fail "libtiff6 must be installed BEFORE pillow (PIL/_imaging.so links it)"
pass "install orders libpython, python3-base, python3-light, libtiff6, then --nodeps pillow"

# --- 4. install: reports failure against the probe, not opkg's exit status ---
# A package can install cleanly and still not import — the libtiff6 failure mode.
reset
cat > "$BIN/opkg" <<'EOF'
#!/bin/sh
echo "opkg $*" >> "$WORK/opkg.log"
case "$1" in
  list-installed) cat "$WORK/installed" 2>/dev/null ;;
  update) exit 0 ;;
  install) shift; for a in "$@"; do case "$a" in --*) continue ;; *) pkg=$a ;; esac; done
           echo "$pkg - stub" >> "$WORK/installed"; exit 0 ;;   # installs, nothing imports
esac
exit 0
EOF
chmod +x "$BIN/opkg"
"$S" install >/dev/null 2>&1 && fail "install must fail when modules still do not import after a 'successful' opkg run"
pass "install verifies the sentinel, not opkg exit status"

# --- 5. heal: does not start services when the install failed ---
reset
"$S" heal >/dev/null 2>&1 && fail "heal must fail when deps cannot be installed"
[ -f "$WORK/started.log" ] && fail "heal must NOT start services after a failed install (would re-enter the crash loop)"
pass "heal refuses to start the panel after a failed install"

# --- 6. heal: one failure per boot, no infinite retry ---
# test 5 above left the failure stamp; a second heal must refuse rather than retry
out=$("$S" heal 2>&1 || true)
echo "$out" | grep -q 'already failed this boot' || fail "heal must not retry after a failure until reboot"
pass "heal gives up for the boot rather than looping"

# --- 7. heal: happy path installs then starts BOTH services ---
# restore the working opkg stub
reset
write_opkg_ok
"$S" heal >/dev/null 2>&1 || fail "heal must succeed when the feed works"
grep -q 'mudi start'       "$WORK/started.log" || fail "heal must start mudi"
grep -q 'mudi-watch start' "$WORK/started.log" || fail "heal must start mudi-watch"
pass "heal installs then starts both LCD services"

# --- 7b. install: forces a reinstall when opkg's DB disagrees with imports ---
# Every package marked installed, yet nothing imports. Trusting opkg here would
# report success and hand the panel back to the crash loop. The runtime
# packages are part of that set: a zero-byte python3.11 is still "installed".
reset
seed_all_installed
"$S" install >/dev/null 2>&1 || fail "install must recover when the opkg DB and imports diverge"
grep -q -- '--force-reinstall' "$WORK/opkg.log" \
    || fail "install must --force-reinstall when packages look present but imports do not confirm"
grep -q 'opkg install --nodeps --force-reinstall python3-pillow' "$WORK/opkg.log" \
    || fail "a forced pillow reinstall must keep --nodeps"
grep -q "opkg install --force-reinstall python3-base" "$WORK/opkg.log" \
    || fail "a forced reinstall must include python3-base"
grep -q "opkg install --force-reinstall python3-light" "$WORK/opkg.log" \
    || fail "a forced reinstall must include python3-light"
grep -q "opkg install --force-reinstall $LIBPYTHON" "$WORK/opkg.log" \
    || fail "a forced reinstall must include $LIBPYTHON"
pass "install force-reinstalls the runtime and the LCD set when the DB and imports disagree"

# --- 7c. no-op interpreter, packages all "installed": repair, then re-verify ---
# python exits 0 with no stdout until python3-base is force-reinstalled, which
# is the on-device "replace the empty binary" step. install must not return 0
# unless a later probe prints the sentinel.
reset
echo noop > "$WORK/python_mode"
seed_all_installed
"$S" install >/dev/null 2>&1 || fail "install must repair a no-op interpreter and then re-verify"
grep -q "opkg install --force-reinstall python3-base" "$WORK/opkg.log" \
    || fail "repair must --force-reinstall python3-base"
grep -q "opkg install --force-reinstall $LIBPYTHON" "$WORK/opkg.log" \
    || fail "repair must --force-reinstall $LIBPYTHON"
grep -q "opkg install --force-reinstall python3-light" "$WORK/opkg.log" \
    || fail "repair must --force-reinstall python3-light"
# The re-verify is the install exit status above. Also prove check now passes.
out=$("$S" check) || fail "check must pass after the runtime reinstall"
[ -z "$out" ] || fail "check must be silent after repair (got: $out)"
pass "repair force-reinstalls python3-base, libpython and python3-light, then re-verifies"

# --- 8. heal: no-op when deps are already healthy ---
reset; printf 'numpy\nevdev\nPIL\n' > "$WORK/have"
"$S" heal >/dev/null 2>&1 || fail "heal must succeed as a no-op when deps are fine"
[ -f "$WORK/started.log" ] && fail "heal must not restart services when nothing was wrong"
pass "heal is a no-op on a healthy box"

# --- 9 & 10. static repo assertions -------------------------------------------
# Only meaningful when run from a checkout. On the device (verify.sh passes
# /usr/sbin/mudimodem-lcddeps) there is no src/ tree, so skip rather than fail —
# verify.sh asserts the installed equivalents separately.
REPO=$(cd "$(dirname "$SCRIPT")/../.." 2>/dev/null && pwd)
if [ -z "$REPO" ] || [ ! -f "$REPO/src/lcd/mudi.init" ]; then
  echo "  -- skipped: static repo assertions (no checkout here)"
  echo "PASS: mudimodem-lcddeps"
  exit 0
fi
cd "$REPO"

# --- 9. static: the init scripts actually call the guard ---
for f in src/lcd/mudi.init src/lcd/mudi-watch.init; do
  grep -q 'mudimodem-lcddeps' "$f" || fail "$f must consult mudimodem-lcddeps before opening a procd instance"
  grep -q 'heal' "$f"              || fail "$f must spawn a heal when the check fails"
  # the guard must come BEFORE procd_open_instance, or procd still crash-loops
  g=$(grep -n 'DEPS" check' "$f" | head -1 | cut -d: -f1)
  o=$(grep -n 'procd_open_instance' "$f" | head -1 | cut -d: -f1)
  [ -n "$g" ] && [ "$g" -lt "$o" ] || fail "$f: dep check must precede procd_open_instance"
done
pass "both init scripts gate procd on the dep check"

# --- 10. static: the dep list lives in ONE place ---
grep -q 'LCD_DEPS=' install.sh && fail "install.sh must not carry its own LCD_DEPS list (drift is what broke the panel)"
grep -q 'mudimodem-lcddeps install' install.sh || fail "install.sh must delegate dep install to mudimodem-lcddeps"
grep -q '/usr/sbin/mudimodem-lcddeps' src/upgrade/keep.d/mudimodem \
    || fail "keep.d must preserve mudimodem-lcddeps (it is the thing that repairs the next FOTA)"
grep -q 'python3-base' src/sbin/mudimodem-lcddeps \
    || fail "runtime repair must reinstall python3-base"
grep -q 'libpython3-3.11' src/sbin/mudimodem-lcddeps \
    || fail "runtime repair must know the libpython3-3.11 fallback"
grep -q 'SENTINEL=' src/sbin/mudimodem-lcddeps \
    || fail "check must have a sentinel constant"
pass "dependency recipe has a single source of truth and survives FOTA"

echo "PASS: mudimodem-lcddeps"
