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
echo "deployed to $HOST"
