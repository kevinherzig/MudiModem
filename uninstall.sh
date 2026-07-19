#!/bin/sh
# MudiModem uninstaller — run ON the GL-E5800 ("Mudi"). Removes every file the
# installer placed, de-registers them from sysupgrade.conf, and restarts nginx.
# Idempotent. Does NOT touch the modem's band/cell-lock NV — clear those from the
# panel (or the ssh panic-restore) BEFORE uninstalling if you want them gone.
# Run it from a root shell on the router (ssh root@<router> first if remote):
#
#   curl -fsSL https://raw.githubusercontent.com/kevinherzig/MudiModem/main/uninstall.sh | sh
set -eu

MODEL=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0')
case "$MODEL" in
  *E5800*) echo "target OK: $MODEL" ;;
  *) echo "REFUSING: this is not a GL-E5800 (got: '${MODEL:-unknown}')" >&2; exit 1 ;;
esac

FILES="
/www/views/gl-sdk4-ui-mudimodem.common.js.gz
/www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz
/www/views/gl-sdk4-ui-mudimodem-console.common.js.gz
/www/mudimodem/at-library.json.gz
/usr/share/oui/menu.d/mudimodem.json
/usr/share/oui/menu.d/mudimodem-tracking.json
/usr/lib/mudimodem/mudimodem-at.py
/usr/lib/mudimodem/mudimodem-lib
/usr/sbin/mudimodem-revert
/usr/share/gl-validator.d/mudimodem.lua
/usr/lib/oui-httpd/rpc/mudimodem
/usr/sbin/mudimodem-collectd
/etc/init.d/mudimodem-collectd
"

# Stop + disable the collector service before removing its files.
if [ -x /etc/init.d/mudimodem-collectd ]; then
  /etc/init.d/mudimodem-collectd stop    2>/dev/null || true
  /etc/init.d/mudimodem-collectd disable 2>/dev/null || true
  echo "collector stopped + disabled"
fi

echo "removing files:"
for p in $FILES; do [ -e "$p" ] && rm -f "$p" && echo "  $p"; done

# Our own dirs + runtime state (pending-revert marker). Only remove if empty/ours.
rm -rf /usr/lib/mudimodem /www/mudimodem /etc/mudimodem 2>/dev/null || true

# De-register from sysupgrade.conf (drop exactly our lines, keep everything else).
f=/etc/sysupgrade.conf
if [ -f "$f" ]; then
  tmp=$(mktemp)
  grep -vxF "$(printf '%s\n' $FILES)" "$f" > "$tmp" 2>/dev/null || cp "$f" "$tmp"
  cat "$tmp" > "$f"; rm -f "$tmp"
  echo "de-registered from sysupgrade.conf"
fi

# Restart nginx so the cached RPC plugin is dropped and the removed chunks 404.
/etc/init.d/nginx restart 2>/dev/null || true
echo "nginx restarted"

echo ""
echo "MudiModem removed. Reload the GL admin — the MODEM item is gone. No reboot"
echo "needed. (Any band/cell lock you set lives in modem NV and is unaffected.)"
