#!/bin/sh
# tools/verify.sh - assert Phase 0 landed correctly on the device.
set -eu
HOST="${MUDI_HOST:-mudi}"
fail() { echo "FAIL: $1" >&2; exit 1; }

echo "1. files present"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem.common.js.gz' \
  || fail "chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem.json' \
  || fail "menu json missing"

echo "2. menu json is valid JSON on-device"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\"); local f=io.open(\"/usr/share/oui/menu.d/mudimodem.json\"); c.decode(f:read(\"*a\"))"' \
  || fail "menu json does not parse (would break ui.get_menu_list for EVERY page)"

echo "3. nginx serves the chunk via gzip_static"
# The device's libcurl has no --compressed, so ask for gzip and decode ourselves.
# Without Accept-Encoding: gzip there is no plain file to serve and nginx 302s --
# harmless, since every browser sends it.
BODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem.common.js?_t=1" | gzip -dc')
echo "$BODY" | grep -q 'name: *"mudimodem"' || fail "chunk not served / wrong content"

echo "4. chunk still evals to the component after the round trip"
printf '%s' "$BODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem"){console.error("FAIL: eval");process.exit(1);}
    console.log("   eval OK ->", c.name);
  })'

echo "ALL PHASE 0 CHECKS PASSED"
