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

# Confirm-or-revert watchdog + panic restore (§5). Inert until invoked; install
# it BEFORE the backend so set_bands can always find it.
if [ -f src/sbin/mudimodem-revert ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/sbin/mudimodem-revert && chmod 0755 /usr/sbin/mudimodem-revert && mkdir -p /etc/mudimodem' \
    < src/sbin/mudimodem-revert
  echo "watchdog installed (/usr/sbin/mudimodem-revert)"
fi

# RPC backend (Lua plugin). nginx caches the plugin per worker, so a reload is
# required for edits to take effect (CLAUDE.md §8).
if [ -f src/rpc/mudimodem ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/lib/oui-httpd/rpc/mudimodem' \
    < src/rpc/mudimodem
  ssh -o BatchMode=yes "root@$HOST" '/etc/init.d/nginx reload' 2>/dev/null || true
  echo "backend deployed + nginx reloaded"
fi
echo "deployed to $HOST"
