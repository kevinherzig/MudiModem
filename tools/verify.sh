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

# 5. RPC backend (only if we ship one) — run the real plugin against live ubus.
if [ -f src/rpc/mudimodem ]; then
  echo "5. RPC backend present + get_bands returns the three-layer model"
  ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/lib/oui-httpd/rpc/mudimodem' \
    || fail "backend not deployed (run ./tools/deploy.sh)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-backend.test.lua' < test/backend.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'lua /tmp/mm-backend.test.lua; rc=$?; rm -f /tmp/mm-backend.test.lua; exit $rc' \
    || fail "backend test failed on-device"
fi

echo "ALL CHECKS PASSED"
