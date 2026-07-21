#!/bin/sh
# MudiModem installer — run ON the GL-E5800 ("Mudi"). Self-contained: fetches
# every source file from GitHub and installs it, gzipping the view chunks on the
# box (busybox gzip). No toolchain, no committed artifacts. Idempotent.
# Run it from a root shell on the router (ssh root@<router> first if remote):
#
#   curl -fsSL https://raw.githubusercontent.com/kevinherzig/MudiModem/main/install.sh | sh
#
# Env: MUDIMODEM_REF (branch/tag, default main), MUDIMODEM_BASE (override raw URL).
set -eu

REF="${MUDIMODEM_REF:-main}"
BASE="${MUDIMODEM_BASE:-https://raw.githubusercontent.com/kevinherzig/MudiModem/$REF}"

# Model guard: on some LANs 192.168.8.1 is a DIFFERENT GL router (AXT1800). Never
# write to anything that isn't a Mudi.
MODEL=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0')
case "$MODEL" in
  *E5800*) echo "target OK: $MODEL" ;;
  *) echo "REFUSING: this is not a GL-E5800 (got: '${MODEL:-unknown}')" >&2; exit 1 ;;
esac

fetch() { curl -fsSL "$BASE/$1"; }   # curl -f => nonzero on HTTP error => set -e aborts

# Fetch a source file to a temp path first, so a mid-stream curl failure can't
# leave a truncated file in place (POSIX sh has no pipefail).
grab() { tmp=$(mktemp); fetch "$1" > "$tmp" || { echo "fetch failed: $1" >&2; rm -f "$tmp"; exit 1; }; }

gz_install()  { grab "$1"; gzip -9 -c "$tmp" > "$2"; rm -f "$tmp"; echo "  $2"; }         # $1 src, $2 .gz target
cp_install()  { grab "$1"; cat "$tmp" > "$2"; chmod "$3" "$2"; rm -f "$tmp"; echo "  $2"; } # $1 src, $2 target, $3 mode

mkdir -p /www/views /www/mudimodem /usr/lib/mudimodem /usr/share/oui/menu.d \
         /usr/share/gl-validator.d /usr/lib/oui-httpd/rpc /usr/sbin /etc/init.d /etc/mudimodem

echo "installing view chunks + menu + library:"
gz_install src/views/mudimodem.js          /www/views/gl-sdk4-ui-mudimodem.common.js.gz
gz_install src/views/mudimodem-tracking.js /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz
gz_install src/views/mudimodem-console.js  /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz
gz_install src/at-library.snapshot.json    /www/mudimodem/at-library.json.gz
cp_install src/menu/mudimodem.json          /usr/share/oui/menu.d/mudimodem.json          0644
cp_install src/menu/mudimodem-tracking.json /usr/share/oui/menu.d/mudimodem-tracking.json 0644
cp_install version.json                     /etc/mudimodem/version.json                   0644

echo "installing AT channel + library tool:"
cp_install tools/mudimodem-at.py /usr/lib/mudimodem/mudimodem-at.py 0644
cp_install tools/mudimodem-lib   /usr/lib/mudimodem/mudimodem-lib   0755

echo "installing watchdog + validator + backend:"
# Watchdog + validator BEFORE the backend: set_bands needs the watchdog present,
# and the validator must exist before nginx reloads the plugin (§8).
cp_install src/sbin/mudimodem-revert  /usr/sbin/mudimodem-revert            0755
cp_install src/sbin/mudimodem-selfupdate /usr/sbin/mudimodem-selfupdate     0755
cp_install src/validator/mudimodem.lua /usr/share/gl-validator.d/mudimodem.lua 0644
cp_install src/rpc/mudimodem          /usr/lib/oui-httpd/rpc/mudimodem       0644
# RESTART not reload: nginx caches the plugin per worker; reload leaves stale
# workers serving -32601 for the new methods (§8). ~1s admin blip, no link touch.
/etc/init.d/nginx restart 2>/dev/null || true
echo "  nginx restarted"

echo "installing history collector service:"
cp_install src/sbin/mudimodem-collectd        /usr/sbin/mudimodem-collectd    0755
cp_install src/etc/init.d/mudimodem-collectd  /etc/init.d/mudimodem-collectd  0755
/etc/init.d/mudimodem-collectd enable  2>/dev/null || true
/etc/init.d/mudimodem-collectd restart 2>/dev/null || true
echo "  collector enabled + started"

# Survive a firmware upgrade (our files live outside /etc/config). Idempotent.
echo "registering files in /etc/sysupgrade.conf:"
f=/etc/sysupgrade.conf; touch "$f"
for p in \
  /www/views/gl-sdk4-ui-mudimodem.common.js.gz \
  /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz \
  /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz \
  /www/mudimodem/at-library.json.gz \
  /usr/share/oui/menu.d/mudimodem.json \
  /usr/share/oui/menu.d/mudimodem-tracking.json \
  /usr/lib/mudimodem/mudimodem-at.py \
  /usr/lib/mudimodem/mudimodem-lib \
  /usr/sbin/mudimodem-revert \
  /usr/sbin/mudimodem-selfupdate \
  /usr/share/gl-validator.d/mudimodem.lua \
  /usr/lib/oui-httpd/rpc/mudimodem \
  /usr/sbin/mudimodem-collectd \
  /etc/init.d/mudimodem-collectd \
  /etc/mudimodem/version.json \
; do grep -qxF "$p" "$f" || echo "$p" >> "$f"; done
echo "  done"

echo ""
echo "MudiModem installed. Reload the GL admin in your browser — a MODEM item"
echo "appears in the top navigation. No reboot needed."
