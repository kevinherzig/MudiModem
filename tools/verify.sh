#!/bin/sh
# tools/verify.sh - assert Phase 0 landed correctly on the device.
set -eu
HOST="${MUDI_HOST:-mudi}"
# MM_PW: admin password, required only for /rpc round-trip steps (7c, 9b, 14b).
# Unset => those steps are skipped (every other check still runs).
# GL admin login is challenge-response (not a plaintext password field):
#   hash = sha256(username:openssl_passwd(alg,salt,pw):nonce)
fail() { echo "FAIL: $1" >&2; exit 1; }

# Authenticate to /rpc on the box; print the sid on stdout. Fails if login fails.
rpc_login() {
  # Password is exported into the remote env so shell-metacharacters in MM_PW
  # cannot break the remote python string (still keep MM_PW free of newlines).
  ssh -o BatchMode=yes "root@$HOST" "MM_PW=$(printf %s "$MM_PW" | sed "s/'/'\\\\''/g")" \
    'python3 - <<'"'"'PY'"'"'
import hashlib, json, os, subprocess, urllib.request, ssl
ctx = ssl._create_unverified_context()
def post(obj):
    req = urllib.request.Request(
        "https://127.0.0.1/rpc",
        data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, context=ctx, timeout=30).read())
pw = os.environ["MM_PW"]
user = "root"
chal = post({"jsonrpc":"2.0","id":1,"method":"challenge","params":{"username":user}})
r = chal.get("result") or {}
if not r.get("salt") or not r.get("nonce"):
    raise SystemExit("challenge failed: " + json.dumps(chal))
alg = int(r.get("alg") or 5)
crypt = subprocess.check_output(
    ["openssl", "passwd", "-%d" % alg, "-salt", r["salt"], pw], text=True
).strip()
h = hashlib.sha256(("%s:%s:%s" % (user, crypt, r["nonce"])).encode()).hexdigest()
res = post({"jsonrpc":"2.0","id":1,"method":"login","params":{"username":user,"hash":h}})
sid = (res.get("result") or {}).get("sid")
if not sid:
    raise SystemExit("login failed: " + json.dumps(res))
print(sid)
PY'
}

echo "1. files present"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem.common.js.gz' \
  || fail "chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem.json' \
  || fail "menu json missing"

echo "1b. A/B FOTA persist (keep.d + payload + nginx alias)"
ssh -o BatchMode=yes "root@$HOST" 'test -s /lib/upgrade/keep.d/mudimodem' \
  || fail "keep.d/mudimodem missing"
ssh -o BatchMode=yes "root@$HOST" 'grep -qxF /lib/upgrade/keep.d/mudimodem /lib/upgrade/keep.d/mudimodem \
  && grep -qxF /usr/share/mudimodem/ /lib/upgrade/keep.d/mudimodem \
  && grep -qxF /etc/nginx/gl-conf.d/mudimodem.conf /lib/upgrade/keep.d/mudimodem \
  && ! grep -E "^[[:space:]]*/www/" /lib/upgrade/keep.d/mudimodem' \
  || fail "keep.d missing self/payload/nginx entries or still lists /www"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/mudimodem/www/views/gl-sdk4-ui-mudimodem.common.js.gz \
  && test -s /usr/share/mudimodem/www/mudimodem/at-library.json.gz \
  && test -s /etc/nginx/gl-conf.d/mudimodem.conf \
  && grep -q "root /usr/share/mudimodem/www" /etc/nginx/gl-conf.d/mudimodem.conf' \
  || fail "FOTA persist payload or nginx alias missing"

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

echo "4. chunk evals AND renders live data after the round trip"
printf '%s' "$BODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem"){console.error("FAIL: eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    // Harness the component exactly as Vue would, with a stub websocket store.
    const h=(t,d,ch)=>((Array.isArray(d)||typeof d==="string")&&(ch=d,d={}),{t,d:d||{},ch});
    const txt=n=>n==null?"":typeof n==="string"?n:Array.isArray(n)?n.map(txt).join(""):txt(n.ch);
    const S={"cellular.modems_info":{modems:[{bus:"cpu",name:"RG650V-NA",type:0,band:{"NR-SA":[71]}}]},
             "cellular.modems_status":{modems:[{bus:"cpu",current_sim_slot:"1"}]},
             "cellular.networks_info":{networks:[{slot:"1",cell_info:{band:71,mode:"NR5G-SA FDD",rsrp:"-101",rsrp_level:3,sinr:"4",sinr_level:2,rsrq:"-14",rsrq_level:3,dl_bandwidth:"15MHz"}}]},
             "cellular.sims_info":{sims:[{slot:"1",mcc:"310",mnc:"260"}]}};
    const vm=Object.assign({},c.data());
    vm.$store={getters:{moduleStatus:n=>S[n]||{}}};
    for(const[k,f]of Object.entries(c.methods||{}))vm[k]=f.bind(vm);
    for(const[k,f]of Object.entries(c.computed||{}))Object.defineProperty(vm,k,{get:f.bind(vm),configurable:true});
    const out=txt(c.render.call(vm,h));
    if(!/-101/.test(out)||!/n71/.test(out)){console.error("FAIL: render missing live data\n"+out);process.exit(1);}
    console.log("   eval + render OK ->", c.name, "(shows -101 / n71)");
  })'

echo "4b. tracking chunk present, valid menu, serves, evals + renders"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz' \
  || fail "tracking chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem-tracking.json' \
  || fail "tracking menu json missing"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\"); local f=io.open(\"/usr/share/oui/menu.d/mudimodem-tracking.json\"); c.decode(f:read(\"*a\"))"' \
  || fail "tracking menu json does not parse (would break ui.get_menu_list for EVERY page)"
TBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-tracking.common.js?_t=1" | gzip -dc')
printf '%s' "$TBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-tracking"){console.error("FAIL: tracking eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    if(!/"get_history"/.test(s)){console.error("FAIL: does not read history over RPC");process.exit(1);}
    console.log("   tracking eval + render-only OK ->", c.name);
  })' || fail "tracking chunk eval failed"

# 5. RPC backend (only if we ship one) — run the real plugin against live ubus.
if [ -f src/rpc/mudimodem ]; then
  echo "5. RPC backend present + get_bands returns the three-layer model"
  ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/lib/oui-httpd/rpc/mudimodem' \
    || fail "backend not deployed (run ./tools/deploy.sh)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-backend.test.lua' < test/backend.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'lua /tmp/mm-backend.test.lua; rc=$?; rm -f /tmp/mm-backend.test.lua; exit $rc' \
    || fail "backend test failed on-device"
fi

# 6. Confirm-or-revert watchdog: isolation tests (dry, temp paths) + set_bands
#    interlock (shimmed — no real modem writes).
if [ -f src/sbin/mudimodem-revert ]; then
  echo "6. watchdog + set_bands safety interlock"
  ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-revert' \
    || fail "watchdog not installed (run ./tools/deploy.sh)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-revert.test.sh'  < test/revert.test.sh
  ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_HIST=/tmp/mmv-hist sh /tmp/mm-revert.test.sh /usr/sbin/mudimodem-revert >/dev/null; rc=$?; rm -rf /tmp/mm-revert.test.sh /tmp/mmv-hist; exit $rc' \
    || fail "watchdog isolation tests failed"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-w.test.lua' < test/backend-write.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_PENDING=/tmp/mmv-pending MUDIMODEM_ARMED=/tmp/mmv-armed MUDIMODEM_BIN=/usr/sbin/mudimodem-revert MUDIMODEM_HIST=/tmp/mmv-hist lua /tmp/mm-w.test.lua >/dev/null; rc=$?; rm -rf /tmp/mm-w.test.lua /tmp/mmv-pending /tmp/mmv-armed /tmp/mmv-hist; exit $rc' \
    || fail "set_bands interlock test failed"

  echo "6b. cell-lock backend + watchdog cell revert (isolation, on-device)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-l.test.lua'  < test/backend-lock.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-lw.test.lua' < test/backend-lock-write.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'MM_PLUGIN=/usr/lib/oui-httpd/rpc/mudimodem MUDIMODEM_PENDING=/tmp/mml-p MUDIMODEM_ARMED=/tmp/mml-a MUDIMODEM_STALE=/tmp/mml-s MUDIMODEM_HIST=/tmp/mml-h lua /tmp/mm-l.test.lua >/dev/null && MM_PLUGIN=/usr/lib/oui-httpd/rpc/mudimodem MUDIMODEM_PENDING=/tmp/mml-p MUDIMODEM_ARMED=/tmp/mml-a MUDIMODEM_STALE=/tmp/mml-s MUDIMODEM_BIN=/usr/sbin/mudimodem-revert MUDIMODEM_HIST=/tmp/mml-h lua /tmp/mm-lw.test.lua >/dev/null; rc=$?; rm -rf /tmp/mm-l.test.lua /tmp/mm-lw.test.lua /tmp/mml-p /tmp/mml-a /tmp/mml-s /tmp/mml-h; exit $rc' \
    || fail "cell-lock isolation tests failed on-device"
  ssh -o BatchMode=yes "root@$HOST" 'grep -q "\"\$KIND\" = \"cell\"" /usr/sbin/mudimodem-revert' \
    || fail "deployed watchdog lacks cell revert"
fi

echo "6c. clear_cell_lock restores mode to AUTO (static — never call it on the live link)"
ssh -o BatchMode=yes "root@$HOST" '
  f=/usr/lib/oui-httpd/rpc/mudimodem
  grep -q "function M.clear_cell_lock" "$f" || exit 1
  grep -q "mode_pref\",AUTO" "$f" || exit 1
  grep -q "nr5g_disable_mode\",0" "$f" || exit 1' \
  || fail "clear_cell_lock does not restore mode_pref=AUTO / nr5g_disable_mode=0"

# 7. History collector: service running + get_history parses telemetry.
if [ -f src/sbin/mudimodem-collectd ]; then
  echo "7. history collector running + get_history"
  ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-collectd' \
    || fail "collector not installed (run ./tools/deploy.sh)"
  ssh -o BatchMode=yes "root@$HOST" 'pgrep -f mudimodem-collectd >/dev/null' \
    || fail "collector process not running (/etc/init.d/mudimodem-collectd start)"
  # It should be writing samples within a couple of poll intervals.
  ssh -o BatchMode=yes "root@$HOST" 'for i in 1 2 3 4 5 6; do [ -s /tmp/mudimodem/samples.jsonl ] && exit 0; sleep 5; done; exit 1' \
    || fail "no samples.jsonl written after ~30s"
  echo "   collector is sampling ($(ssh -o BatchMode=yes "root@$HOST" 'wc -l < /tmp/mudimodem/samples.jsonl' | tr -d " ") lines)"
  # get_history parses the jsonl (fixtures under a temp HIST dir; ngx-stubbed).
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-hist.test.lua' < test/backend-history.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_HIST=/tmp/mmhist-test lua /tmp/mm-hist.test.lua; rc=$?; rm -f /tmp/mm-hist.test.lua; exit $rc' \
    || fail "get_history test failed on-device"
fi

# 7b. Battery history (issue #1): chunk serves + evals, collector is sampling,
#     and get_battery_history survives a real /rpc round trip.
echo "7b. battery chunk + battery.jsonl + get_battery_history"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-battery.common.js.gz' \
  || fail "battery chunk .gz missing"
BBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-battery.common.js?_t=1" | gzip -dc')
printf '%s' "$BBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-battery"){console.error("FAIL: battery eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    if(!/"get_battery_history"/.test(s)){console.error("FAIL: does not read battery history over RPC");process.exit(1);}
    console.log("   battery eval + render-only OK ->", c.name);
  })' || fail "battery chunk eval failed"

if [ -f src/sbin/mudimodem-collectd ]; then
  # The newest battery sample must be FRESH (within 60 s of box now). Checking
  # freshness rather than watching the file grow avoids a 25 s sleep here.
  ssh -o BatchMode=yes "root@$HOST" 'for i in 1 2 3 4 5 6; do [ -s /tmp/mudimodem/battery.jsonl ] && exit 0; sleep 5; done; exit 1' \
    || fail "no battery.jsonl written after ~30s"
  ssh -o BatchMode=yes "root@$HOST" 'lua -e "
    local f=io.open(\"/tmp/mudimodem/battery.jsonl\"); local last
    for l in f:lines() do last=l end
    local o=require(\"cjson\").decode(last)
    local age=(os.time()*1000)-o.t
    if age>60000 then os.exit(1) end
    if o.cap==nil or o.cur==nil then os.exit(1) end"' \
    || fail "battery.jsonl newest sample is stale (>60s) or missing cap/cur"
  echo "   battery collector is sampling (fresh sample, cap+cur present)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-bat.test.lua' < test/backend-battery-history.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_HIST=/tmp/mmbat-test lua /tmp/mm-bat.test.lua; rc=$?; rm -f /tmp/mm-bat.test.lua; exit $rc' \
    || fail "get_battery_history test failed on-device"
fi

# A REAL /rpc round trip. The on-device dofile test above bypasses oui's arg
# validation entirely, so only this can catch a -32602 rejection. Needs a sid,
# so it runs only when MM_PW is set (mirrors step 9b).
if [ -n "${MM_PW:-}" ]; then
  echo "7c. get_battery_history over /rpc (validation layer)"
  SID=$(rpc_login) || fail "login for /rpc round trip failed (is MM_PW correct?)"
  [ -n "$SID" ] || fail "login for /rpc round trip failed"
  RESP=$(ssh -o BatchMode=yes "root@$HOST" \
    'curl -sk -X POST https://127.0.0.1/rpc -H "Content-Type: application/json" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"'"$SID"'\",\"mudimodem\",\"get_battery_history\",{\"window_ms\":900000}]}"')
  echo "$RESP" | grep -q '"samples"' \
    || fail "get_battery_history over /rpc did not return samples (got: $RESP)"
  echo "$RESP" | grep -q '"error"' \
    && fail "get_battery_history over /rpc returned an error (got: $RESP)"
  echo "   /rpc round trip OK"
else
  echo "7c. SKIPPED — set MM_PW=<admin-password> to run the /rpc round-trip"
fi

# 8. Phase 3: AT console chunk + community library + own-channel AT tool.
echo "8. Phase 3: console chunk + AT library + AT tool"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz' \
  || fail "console chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/mudimodem/at-library.json.gz' \
  || fail "at-library .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/lib/mudimodem/mudimodem-at.py' \
  || fail "AT tool missing"

echo "8a. library gz parses on-device and is served via gzip_static"
ssh -o BatchMode=yes "root@$HOST" 'gzip -dc /www/mudimodem/at-library.json.gz > /tmp/mm-lib.json && lua -e "local c=require(\"cjson\"); local f=io.open(\"/tmp/mm-lib.json\"); local d=c.decode(f:read(\"*a\")); assert(type(d.entries)==\"table\" and #d.entries>0)"; rc=$?; rm -f /tmp/mm-lib.json; exit $rc' \
  || fail "at-library.json.gz is not valid gzipped JSON with entries"
ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/mudimodem/at-library.json?_t=1" | gzip -dc | grep -q "\"entries\""' \
  || fail "library not served via gzip_static"

echo "8b. console chunk serves + evals (render-only, speaks at_console)"
CONBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-console.common.js?_t=1" | gzip -dc')
printf '%s' "$CONBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-console"){console.error("FAIL: console eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    if(!/"at_console"/.test(s)){console.error("FAIL: does not speak at_console");process.exit(1);}
    if(/modem\.CPU\.AT|send_at_command/.test(s)){console.error("FAIL: touches GL AT surfaces");process.exit(1);}
    console.log("   console chunk eval OK ->", c.name);
  })' || fail "console chunk eval failed"

echo "8c. at_console backend (clamps + envelope, against the fake tool)"
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /tmp/mmtest'
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mmtest/fake-at.py' < test/fake-at-tool.py
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mmtest/t.lua' < test/backend-console.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_AT_TOOL=/tmp/mmtest/fake-at.py lua /tmp/mmtest/t.lua >/dev/null; rc=$?; rm -rf /tmp/mmtest; exit $rc' \
  || fail "at_console backend test failed on-device"

echo "8d. LIVE: one read-only AT through the real tool (per-step envelope + gl_modem sleep)"
ssh -o BatchMode=yes "root@$HOST" \
  'python3 /usr/lib/mudimodem/mudimodem-at.py --envelope --timeout 6 "AT" | head -1 | grep -qE "^MM-AT:ok:[0-9]+:1/1$"' \
  || fail "live AT through /dev/at_mdm0 did not return a per-step MM-AT:ok frame"

echo "8e. gl_modem alive and NOT left stopped (the one failure that must never survive)"
ssh -o BatchMode=yes "root@$HOST" \
  'pids=$(pidof gl_modem); [ -n "$pids" ] || exit 1; for p in $pids; do s=$(cut -d" " -f3 "/proc/$p/stat"); [ "$s" = "T" ] && exit 1; done; exit 0' \
  || fail "gl_modem missing or left in state T after the AT call"

echo "8f. library check/refresh tool installed + backend methods present"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/lib/mudimodem/mudimodem-lib' \
  || fail "mudimodem-lib not installed (run ./tools/deploy.sh)"
# `check` must always return valid JSON, even when the remote repo/dist is absent
# (fail-silent -> checked:false). Tolerant: we only assert it emits parseable JSON.
ssh -o BatchMode=yes "root@$HOST" 'python3 /usr/lib/mudimodem/mudimodem-lib check | python3 -c "import json,sys;d=json.load(sys.stdin);assert \"local_revision\" in d and \"checked\" in d"' \
  || fail "mudimodem-lib check did not emit a valid status envelope"
# Backend exposes both methods (dofile under the ngx stub is overkill here; grep the source is enough).
ssh -o BatchMode=yes "root@$HOST" 'grep -q "function M.library_status" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.refresh_library" /usr/lib/oui-httpd/rpc/mudimodem' \
  || fail "backend missing library_status/refresh_library"

# 9. Arg validator: the AT console's /rpc gate. Without this, oui's default
#    string validator -32602's every AT command containing + = " (only bare
#    ATI/AT slip through). This asserts the override admits real AT syntax —
#    the layer our direct-plugin tests (8c) never exercise.
echo "9. at_console arg validator admits real AT syntax (the -32602 fix)"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/gl-validator.d/mudimodem.lua' \
  || fail "mudimodem arg validator missing (AT commands would -32602 at /rpc)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-validator.test.lua' < test/backend-validator.test.lua
ssh -o BatchMode=yes "root@$HOST" 'lua /tmp/mm-validator.test.lua; rc=$?; rm -f /tmp/mm-validator.test.lua; exit $rc' \
  || fail "arg validator does not admit AT syntax (console would -32602)"

# 9b. LIVE /rpc round-trip: a TWO-LINE cmd must pass the oui validator AND run
#     both steps. This is the layer the on-device dofile tests (8c) bypass — a
#     newline-bearing cmd could -32602 at /rpc even though the backend is fine.
#     Needs an authenticated sid, so it runs only when MM_PW is provided.
if [ -n "${MM_PW:-}" ]; then
  echo "9b. multi-line cmd survives /rpc and runs both steps"
  SID=$(rpc_login) || fail "login for /rpc round-trip failed (is MM_PW correct?)"
  [ -n "$SID" ] || fail "login for /rpc round-trip failed (is MM_PW correct?)"
  RESP=$(ssh -o BatchMode=yes "root@$HOST" \
    'curl -sk -X POST https://127.0.0.1/rpc -H "Content-Type: application/json" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"call\",\"params\":[\"'"$SID"'\",\"mudimodem\",\"at_console\",{\"cmd\":\"AT\nATI\",\"timeout\":6}]}"')
  printf '%s' "$RESP" | grep -q -- '-32602' \
    && fail "multi-line cmd was rejected by the arg validator (-32602): $RESP"
  printf '%s' "$RESP" | grep -q '"ran":2' \
    || fail "multi-line /rpc did not run 2 steps (got: $RESP)"
  echo "   /rpc ran both steps of a multi-line cmd"
else
  echo "9b. SKIPPED — set MM_PW=<admin-password> to run the /rpc round-trip"
fi

# 10. Phase 5: Config tab / version check / self-update.
echo "10. Phase 5: version check + self-update"
ssh -o BatchMode=yes "root@$HOST" 'test -s /etc/mudimodem/version.json' \
  || fail "version.json not installed (run ./tools/deploy.sh)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-selfupdate' \
  || fail "self-update script not installed"
ssh -o BatchMode=yes "root@$HOST" 'grep -q "function M.app_version" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.device_info" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.self_update" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.update_status" /usr/lib/oui-httpd/rpc/mudimodem' \
  || fail "backend missing app_version/device_info/self_update/update_status"

echo "10a. app_version isolation test (offline, fake curl)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-ver.test.lua' < test/backend-version.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MM_TMP=/tmp/mm-ver-test MUDIMODEM_VERSION_FILE=/tmp/mm-ver-test/local.json MUDIMODEM_CURL=/tmp/mm-ver-test/curl.sh lua /tmp/mm-ver.test.lua; rc=$?; rm -rf /tmp/mm-ver.test.lua /tmp/mm-ver-test; exit $rc' \
  || fail "app_version isolation test failed"

echo "10b. self-update script isolation test (no real install)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-su.test.sh' < test/selfupdate.test.sh
ssh -o BatchMode=yes "root@$HOST" 'sh /tmp/mm-su.test.sh /usr/sbin/mudimodem-selfupdate; rc=$?; rm -f /tmp/mm-su.test.sh; exit $rc' \
  || fail "self-update isolation test failed"

echo "10c. app_version live shape (direct dofile call, real network)"
ssh -o BatchMode=yes "root@$HOST" 'lua -e '\''package.loaded["oui.ubus"]={call=function()end}; local M=dofile("/usr/lib/oui-httpd/rpc/mudimodem"); local r=M.app_version({}); assert(type(r)=="table" and r.installed~=nil, "app_version shape"); print("app_version live shape OK: installed="..tostring(r.installed).." checked="..tostring(r.checked))'\''' \
  || fail "app_version live shape check failed"

echo "11. Speedtest: files present, menu valid, chunk evals"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-speedtest.common.js.gz' \
  || fail "speedtest chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem-speedtest.json' \
  || fail "speedtest menu json missing"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\"); local f=io.open(\"/usr/share/oui/menu.d/mudimodem-speedtest.json\"); c.decode(f:read(\"*a\"))"' \
  || fail "speedtest menu json does not parse (would break ui.get_menu_list for EVERY page)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/lib/mudimodem/mudimodem-speedtest.py' \
  || fail "speedtest runner script missing or not executable"

STBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-speedtest.common.js?_t=1" | gzip -dc')
printf '%s' "$STBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-speedtest"){console.error("FAIL: speedtest chunk eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    if(!/"run_speedtest"/.test(s)){console.error("FAIL: does not call run_speedtest");process.exit(1);}
    console.log("   speedtest chunk eval OK ->", c.name);
  })' || fail "speedtest chunk eval failed"

echo "11a. Speedtest backend round trip (on-device)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-st.test.lua' < test/backend-speedtest.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_SPEEDTEST_HIST=/tmp/mmst-hist.jsonl MUDIMODEM_ST_SCHEDULE=/tmp/mmst-sched.json lua /tmp/mm-st.test.lua; rc=$?; rm -f /tmp/mm-st.test.lua /tmp/mmst-hist.jsonl /tmp/mmst-sched.json; exit $rc' \
  || fail "speedtest backend test failed on-device"

echo "11b. Speedtest scheduler service present (off by default)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-speedtestd' \
  || fail "speedtestd not installed (run ./tools/deploy.sh)"
ssh -o BatchMode=yes "root@$HOST" 'pgrep -f mudimodem-speedtestd >/dev/null' \
  || fail "speedtestd process not running (/etc/init.d/mudimodem-speedtestd start)"

echo "11c. LIVE: one real speed test end-to-end over Cellular"
ssh -o BatchMode=yes "root@$HOST" 'rm -f /tmp/mudimodem/speedtest-status.json'
RESULT=$(ssh -o BatchMode=yes "root@$HOST" '
  rm -f /tmp/mmv-speedtests.jsonl
  python3 /usr/lib/mudimodem/mudimodem-speedtest.py --trigger manual --iface cellular --hist /tmp/mmv-speedtests.jsonl
  rc=$?
  if [ $rc -eq 0 ] && [ -s /tmp/mmv-speedtests.jsonl ]; then
    lua -e "local c=require(\"cjson\");local f=io.open(\"/tmp/mmv-speedtests.jsonl\");local d=c.decode(f:read(\"*l\"));assert(d.down_mbps and d.down_mbps>0,\"down_mbps\");assert(d.up_mbps and d.up_mbps>0,\"up_mbps\");assert(d.latency_ms,\"latency_ms\");assert(d.carrier,\"carrier\")" \
      && rc=0 || rc=1
  else
    rc=1
  fi
  [ $rc -eq 0 ] && cat /tmp/mmv-speedtests.jsonl
  rm -f /tmp/mmv-speedtests.jsonl
  exit $rc
') || fail "live speed test failed (produced no result, timed out, or result missing down_mbps/up_mbps/latency_ms/carrier)"
echo "   live result: $RESULT"

# 12. Battery charge limit stack + isolation tests.
if [ -f src/sbin/glbattlimit ]; then
  echo "12. battery charge limit"
  ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/bin/glbattlimit' \
    || fail "glbattlimit missing"
  ssh -o BatchMode=yes "root@$HOST" 'test -x /etc/hotplug.d/i2c/20-glbattlimit' \
    || fail "hotplug glbattlimit missing"
  ssh -o BatchMode=yes "root@$HOST" 'test -x /etc/init.d/glbattlimit' \
    || fail "init glbattlimit missing"
  ssh -o BatchMode=yes "root@$HOST" 'test -f /etc/mudimodem/battlimit.json' \
    || fail "battlimit.json missing"
  ssh -o BatchMode=yes "root@$HOST" 'grep -q "function M.get_battlimit" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.set_battlimit" /usr/lib/oui-httpd/rpc/mudimodem' \
    || fail "backend missing get_battlimit/set_battlimit"
  # Live status (read-only; does not change charge path).
  ssh -o BatchMode=yes "root@$HOST" '/usr/bin/glbattlimit status >/dev/null' \
    || fail "glbattlimit status failed"

  echo "12a. get/set_battlimit isolation test (stub bin + temp config)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt.test.lua' < test/backend-battlimit.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'MM_TMP=/tmp/mm-batt-test MUDIMODEM_BATTLIMIT_FILE=/tmp/mm-batt-test/battlimit.json MUDIMODEM_BATTLIMIT_BIN=/tmp/mm-batt-test/glbattlimit MM_PLUGIN=/usr/lib/oui-httpd/rpc/mudimodem lua /tmp/mm-batt.test.lua; rc=$?; rm -rf /tmp/mm-batt.test.lua /tmp/mm-batt-test; exit $rc' \
    || fail "backend-battlimit isolation test failed"

  echo "12b. hotplug/init config isolation test (stub bin, no sysfs)"
  # Push sources the hotplug test needs: scripts under /tmp so the on-device test
  # can run without the full repo tree. Adapt ROOT by unpacking into a mini tree.
  ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /tmp/mm-batt-hp/src/hotplug /tmp/mm-batt-hp/src/etc/init.d /tmp/mm-batt-hp/test'
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt-hp/src/hotplug/20-glbattlimit' < src/hotplug/20-glbattlimit
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt-hp/src/etc/init.d/glbattlimit' < src/etc/init.d/glbattlimit
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt-hp/test/battlimit-hotplug.test.sh' < test/battlimit-hotplug.test.sh
  ssh -o BatchMode=yes "root@$HOST" 'chmod +x /tmp/mm-batt-hp/test/battlimit-hotplug.test.sh /tmp/mm-batt-hp/src/hotplug/20-glbattlimit /tmp/mm-batt-hp/src/etc/init.d/glbattlimit; sh /tmp/mm-batt-hp/test/battlimit-hotplug.test.sh; rc=$?; rm -rf /tmp/mm-batt-hp; exit $rc' \
    || fail "battlimit-hotplug isolation test failed"

  echo "12c. glbattlimit concurrency test (fake sysfs; repeated on + hotplug)"
  ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /tmp/mm-batt-cc/src/sbin /tmp/mm-batt-cc/src/hotplug /tmp/mm-batt-cc/test'
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt-cc/src/sbin/glbattlimit' < src/sbin/glbattlimit
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt-cc/src/hotplug/20-glbattlimit' < src/hotplug/20-glbattlimit
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-batt-cc/test/glbattlimit-concurrency.test.sh' < test/glbattlimit-concurrency.test.sh
  ssh -o BatchMode=yes "root@$HOST" 'chmod +x /tmp/mm-batt-cc/src/sbin/glbattlimit /tmp/mm-batt-cc/test/glbattlimit-concurrency.test.sh; sh /tmp/mm-batt-cc/test/glbattlimit-concurrency.test.sh; rc=$?; rm -rf /tmp/mm-batt-cc; exit $rc' \
    || fail "glbattlimit concurrency test failed"

  # sysupgrade registration — all four battlimit paths
  ssh -o BatchMode=yes "root@$HOST" 'for p in \
      /usr/bin/glbattlimit \
      /etc/hotplug.d/i2c/20-glbattlimit \
      /etc/init.d/glbattlimit \
      /etc/mudimodem/battlimit.json; do
      grep -qxF "$p" /etc/sysupgrade.conf || { echo "missing: $p"; exit 1; }
    done' \
    || fail "battlimit paths not in sysupgrade.conf (need bin+hotplug+init+json)"
fi

echo "13. LCD renderer files installed"
ssh -o BatchMode=yes "root@$HOST" \
  '[ -f /usr/bin/mudi.py ] && [ -f /usr/bin/mudi-watch.py ] && [ -f /etc/init.d/mudi ] && [ -f /etc/init.d/mudi-watch ]' \
  || fail "LCD renderer files missing"

echo "13b. LCD files registered in sysupgrade.conf"
ssh -o BatchMode=yes "root@$HOST" 'for p in \
    /usr/bin/mudi.py \
    /usr/bin/mudi-watch.py \
    /etc/init.d/mudi \
    /etc/init.d/mudi-watch; do
    grep -qxF "$p" /etc/sysupgrade.conf || { echo "missing: $p"; exit 1; }
  done' \
  || fail "LCD files not in sysupgrade.conf"

echo "14. collectd broadcast socket + latest.json are live"
ssh -o BatchMode=yes "root@$HOST" \
  '[ -S /tmp/mudimodem/collectd.sock ] && [ -f /tmp/mudimodem/latest.json ] && python3 -c "import json,sys; json.load(open(\"/tmp/mudimodem/latest.json\"))"' \
  || fail "collectd socket or latest.json missing/invalid (is the collector on the new build?)"

# 14b. LIVE /rpc round-trip: get_lcd must pass the arg validator and return an
#      availability snapshot. Needs an authenticated sid, so it runs only when
#      MM_PW is provided (mirrors step 9b).
if [ -n "${MM_PW:-}" ]; then
  echo "14b. get_lcd survives the /rpc validator and returns availability"
  SID=$(rpc_login) || fail "login for /rpc round-trip failed (is MM_PW correct?)"
  [ -n "$SID" ] || fail "login for /rpc round-trip failed (is MM_PW correct?)"
  RESP=$(ssh -o BatchMode=yes "root@$HOST" \
    'curl -sk -X POST https://127.0.0.1/rpc -H "Content-Type: application/json" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"call\",\"params\":[\"'"$SID"'\",\"mudimodem\",\"get_lcd\",{}]}"')
  printf '%s' "$RESP" | grep -q -- '-32602' \
    && fail "get_lcd was rejected by the arg validator (-32602): $RESP"
  printf '%s' "$RESP" | grep -q '"available"' \
    || fail "get_lcd did not return an availability snapshot (got: $RESP)"
  echo "   get_lcd round-trip OK"
  RESP=$(ssh -o BatchMode=yes "root@$HOST" \
    'curl -sk -X POST https://127.0.0.1/rpc -H "Content-Type: application/json" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"call\",\"params\":[\"'"$SID"'\",\"mudimodem\",\"set_lcd\",{\"default_page\":0}]}"')
  printf '%s' "$RESP" | grep -q -- '-32602' \
    && fail "set_lcd was rejected by the arg validator (-32602): $RESP"
  printf '%s' "$RESP" | grep -q '"available"' \
    || fail "set_lcd did not return an availability snapshot (got: $RESP)"
  echo "   set_lcd round-trip OK"
else
  echo "14b. SKIPPED — set MM_PW=<admin-password> to run the get_lcd/set_lcd /rpc round-trip"
fi

# 15. LCD python dependency guard. The 4.10 A/B FOTA wiped site-packages and left
# both LCD services crash-looping on ModuleNotFoundError while gl_screen kept the
# panel (§9). Assert the guard is installed, agrees with reality, and that no
# LCD service is sitting in a crash loop right now.
echo "15. LCD dep guard (mudimodem-lcddeps)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-lcddeps' \
  || fail "mudimodem-lcddeps missing or not executable"
ssh -o BatchMode=yes "root@$HOST" 'grep -q /usr/sbin/mudimodem-lcddeps /lib/upgrade/keep.d/mudimodem' \
  || fail "mudimodem-lcddeps not in keep.d — it would not survive the next FOTA"
for f in /etc/init.d/mudi /etc/init.d/mudi-watch; do
  ssh -o BatchMode=yes "root@$HOST" "test -f $f" || continue
  ssh -o BatchMode=yes "root@$HOST" "grep -q mudimodem-lcddeps $f" \
    || fail "$f does not gate procd on the dep check (post-FOTA crash loop returns)"
done
# Stubbed behaviour test — installs nothing, touches no service.
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-lcddeps.test.sh' < test/lcddeps.test.sh
ssh -o BatchMode=yes "root@$HOST" 'cd /tmp && sh /tmp/mm-lcddeps.test.sh /usr/sbin/mudimodem-lcddeps >/dev/null; rc=$?; rm -f /tmp/mm-lcddeps.test.sh; exit $rc' \
  || fail "mudimodem-lcddeps behaviour test failed"
# Live: if the renderer is installed, its imports must actually work.
if ssh -o BatchMode=yes "root@$HOST" 'test -f /usr/bin/mudi.py'; then
  ssh -o BatchMode=yes "root@$HOST" '/usr/sbin/mudimodem-lcddeps check' \
    || fail "LCD python deps are missing on the box — run: mudimodem-lcddeps heal"
  ssh -o BatchMode=yes "root@$HOST" '! logread | tail -200 | grep -q ModuleNotFoundError' \
    || fail "a service is crash-looping on ModuleNotFoundError (see logread)"
  echo "   deps import OK, no crash loop"
fi

echo "ALL CHECKS PASSED"
