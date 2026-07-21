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

echo "8d. LIVE: one read-only AT through the real tool (envelope + gl_modem sleep)"
ssh -o BatchMode=yes "root@$HOST" \
  'python3 /usr/lib/mudimodem/mudimodem-at.py --envelope --timeout 6 "AT" | head -1 | grep -q "^MM-AT:ok"' \
  || fail "live AT through /dev/at_mdm0 did not return MM-AT:ok"

echo "8e. gl_modem alive and NOT left stopped (the one failure that must never survive)"
ssh -o BatchMode=yes "root@$HOST" \
  'pids=$(pidof gl_modem); [ -n "$pids" ] || exit 1; for p in $pids; do s=$(cut -d" " -f3 "/proc/$p/stat"); [ "$s" = "T" ] && exit 1; done; exit 0' \
  || fail "gl_modem missing or left in state T after the AT call"

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

echo "10. Speedtest: files present, menu valid, chunk evals"
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

echo "10a. Speedtest backend round trip (on-device)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-st.test.lua' < test/backend-speedtest.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_SPEEDTEST_HIST=/tmp/mmst-hist.jsonl MUDIMODEM_ST_SCHEDULE=/tmp/mmst-sched.json lua /tmp/mm-st.test.lua; rc=$?; rm -f /tmp/mm-st.test.lua; exit $rc' \
  || fail "speedtest backend test failed on-device"

echo "10b. Speedtest scheduler service present (off by default)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-speedtestd' \
  || fail "speedtestd not installed (run ./tools/deploy.sh)"
ssh -o BatchMode=yes "root@$HOST" 'pgrep -f mudimodem-speedtestd >/dev/null' \
  || fail "speedtestd process not running (/etc/init.d/mudimodem-speedtestd start)"

echo "10c. LIVE: one real speed test end-to-end over Cellular"
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

echo "ALL CHECKS PASSED"
