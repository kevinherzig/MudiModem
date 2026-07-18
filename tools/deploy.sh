#!/bin/sh
# tools/deploy.sh - push Phase 0 artifacts to the Mudi.
# No scp: the box has no sftp-server, so we stream over ssh `cat`.
set -eu
cd "$(dirname "$0")/.."
HOST="${MUDI_HOST:-mudi}"

# Model guard: 192.168.8.1 on this LAN is a DIFFERENT GL router (AXT1800).
MODEL=$(ssh -o BatchMode=yes "root@$HOST" 'cat /proc/device-tree/model' 2>/dev/null | tr -d '\0')
case "$MODEL" in
  *E5800*) : ;;
  *) echo "REFUSING: '$HOST' is not a GL-E5800 (got: '$MODEL')" >&2; exit 1 ;;
esac
echo "target OK: $MODEL"

./tools/build.sh

ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/share/oui/menu.d/mudimodem.json' \
  < src/menu/mudimodem.json

# Tracking page (hidden level:0 route) — second chunk + menu entry.
ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem-tracking.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/share/oui/menu.d/mudimodem-tracking.json' \
  < src/menu/mudimodem-tracking.json
echo "tracking chunk + menu deployed"

# Phase 3: AT console chunk + community library + our own AT channel tool.
ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem-console.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /www/mudimodem && cat > /www/mudimodem/at-library.json.gz' \
  < build/at-library.json.gz
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /usr/lib/mudimodem && cat > /usr/lib/mudimodem/mudimodem-at.py' \
  < tools/mudimodem-at.py
echo "console chunk + AT library + AT tool deployed"

# Confirm-or-revert watchdog + panic restore (§5). Inert until invoked; install
# it BEFORE the backend so set_bands can always find it.
if [ -f src/sbin/mudimodem-revert ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/sbin/mudimodem-revert && chmod 0755 /usr/sbin/mudimodem-revert && mkdir -p /etc/mudimodem' \
    < src/sbin/mudimodem-revert
  echo "watchdog installed (/usr/sbin/mudimodem-revert)"
fi

# Arg validator for the mudimodem object. ⚠️ REQUIRED for the AT console: without
# it, oui applies a default allowlist that rejects '+', '=', '"' — so every real
# AT command -32602's before the backend runs (only bare ATI/AT slip through).
# Push BEFORE the backend so the nginx restart below picks up a consistent set.
if [ -f src/validator/mudimodem.lua ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/share/gl-validator.d/mudimodem.lua' \
    < src/validator/mudimodem.lua
  echo "arg validator deployed (/usr/share/gl-validator.d/mudimodem.lua)"
fi

# RPC backend (Lua plugin). nginx caches the plugin per worker (oui/rpc.lua
# objects[]). ⚠️ Use RESTART, not reload: reload (HUP) leaves old workers alive
# — and long-lived /ws websocket connections keep them alive — still serving
# /rpc from the STALE cached plugin. A newly-ADDED method then returns -32601
# "Method not found" on those workers, intermittently, which pops GL's global
# "Unknown error" banner. restart forces every worker to re-dofile the current
# file. Costs a ~1s admin-UI blip; does NOT touch the cellular link. (CLAUDE.md §8)
if [ -f src/rpc/mudimodem ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/lib/oui-httpd/rpc/mudimodem' \
    < src/rpc/mudimodem
  ssh -o BatchMode=yes "root@$HOST" '/etc/init.d/nginx restart' 2>/dev/null || true
  echo "backend deployed + nginx restarted"
fi

# Background history collector (Python daemon + procd service). Poll ubus only.
if [ -f src/sbin/mudimodem-collectd ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/sbin/mudimodem-collectd && chmod 0755 /usr/sbin/mudimodem-collectd' \
    < src/sbin/mudimodem-collectd
  ssh -o BatchMode=yes "root@$HOST" 'cat > /etc/init.d/mudimodem-collectd && chmod 0755 /etc/init.d/mudimodem-collectd' \
    < src/etc/init.d/mudimodem-collectd
  # enable (start on boot) + (re)start now so a new binary takes effect.
  ssh -o BatchMode=yes "root@$HOST" '/etc/init.d/mudimodem-collectd enable; /etc/init.d/mudimodem-collectd restart' 2>/dev/null || true
  echo "collector deployed + service (re)started"
fi

# Preserve our files across a firmware upgrade (they live outside /etc/config).
# Idempotent: only add lines not already present.
ssh -o BatchMode=yes "root@$HOST" 'f=/etc/sysupgrade.conf; touch "$f"; for p in \
  /www/views/gl-sdk4-ui-mudimodem.common.js.gz \
  /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz \
  /usr/share/oui/menu.d/mudimodem.json \
  /usr/share/oui/menu.d/mudimodem-tracking.json \
  /usr/lib/oui-httpd/rpc/mudimodem \
  /usr/sbin/mudimodem-revert \
  /usr/sbin/mudimodem-collectd \
  /etc/init.d/mudimodem-collectd \
  /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz \
  /www/mudimodem/at-library.json.gz \
  /usr/lib/mudimodem/mudimodem-at.py \
  /usr/share/gl-validator.d/mudimodem.lua \
  ; do \
  grep -qxF "$p" "$f" || echo "$p" >> "$f" ; done'
echo "sysupgrade.conf registered"
echo "deployed to $HOST"
