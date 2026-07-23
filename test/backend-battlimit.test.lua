-- Isolation tests for mudimodem.get_battlimit / set_battlimit.
-- Stubs glbattlimit via a shell script; overrides config path via env.
package.loaded["oui.ubus"] = { call = function() return nil, "unused" end }

local TMP = os.getenv("MM_TMP") or "/tmp/mm-batt-test"
os.execute("rm -rf " .. TMP .. "; mkdir -p " .. TMP)

local CFG = TMP .. "/battlimit.json"
local BIN = TMP .. "/glbattlimit"
local LOG = TMP .. "/calls.log"

local function writef(path, s)
  local f = assert(io.open(path, "w")); f:write(s); f:close()
end

-- Stub: logs "on …" / "off" / "status"; status prints a fixed block.
writef(BIN, string.format([[#!/bin/sh
echo "$*" >> "%s"
if [ "$1" = "status" ]; then
  cat <<'ST'
Limit     : off
Capacity  : 72 %% gauge / ~81 %% GUI (estimated)
Voltage   : 4024 mV
Current   : -288 mA  (+charging -discharging 0=blocked)
Charger   : online=0
Pump      : charge_en=0  (0=off 1=bypass 2=2:1)
Buck vreg : 4400000 uV  (factory 4400000)
ST
  exit 0
fi
exit 0
]], LOG))
os.execute("chmod +x " .. BIN)

-- Env must be set BEFORE dofile if the plugin reads getenv at load;
-- these methods re-read getenv on each call (same pattern as VERSION_FILE).
local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.get_battlimit) == "function", "get_battlimit missing")
assert(type(M.set_battlimit) == "function", "set_battlimit missing")

-- Point plugin at our stubs (plugin must re-read these each call).
-- The test harness sets them in the environment before invoking lua:
--   MUDIMODEM_BATTLIMIT_FILE, MUDIMODEM_BATTLIMIT_BIN

-- Case A: missing config → defaults disabled, available true, status parsed
os.remove(CFG)
os.remove(LOG)
local a = M.get_battlimit({})
assert(a.enabled == false, "A enabled default")
assert(a.limit_gui == 80, "A limit_gui default")
assert(a.available == true, "A available")
assert(a.capacity_gauge == 72, "A capacity_gauge: " .. tostring(a.capacity_gauge))
assert(a.capacity_gui == 81, "A capacity_gui: " .. tostring(a.capacity_gui))
assert(a.charger_online == false, "A charger")
assert(a.active == false, "A active")

-- Case B: set enable + 80 → writes file + calls on 80 gui when status says online
-- Re-stub status with online=1 for apply path. Easiest: rewrite BIN mid-test.
writef(BIN, string.format([[#!/bin/sh
echo "$*" >> "%s"
if [ "$1" = "status" ]; then
  if [ -f "%s/force_online" ]; then
    echo "Limit     : active (71 %% gauge / ~80 %% GUI, PID 9)"
    echo "Capacity  : 70 %% gauge / ~78 %% GUI (estimated)"
    echo "Voltage   : 4100 mV"
    echo "Current   : 0 mA  (+charging -discharging 0=blocked)"
    echo "Charger   : online=1"
    echo "Pump      : charge_en=0  (0=off 1=bypass 2:1)"
    echo "Buck vreg : 3900000 uV  (factory 4400000)"
  else
    echo "Limit     : off"
    echo "Capacity  : 72 %% gauge / ~81 %% GUI (estimated)"
    echo "Voltage   : 4024 mV"
    echo "Current   : -288 mA"
    echo "Charger   : online=0"
    echo "Pump      : charge_en=0"
    echo "Buck vreg : 4400000 uV  (factory 4400000)"
  fi
  exit 0
fi
exit 0
]], LOG, TMP))
os.execute("chmod +x " .. BIN)
os.execute("touch " .. TMP .. "/force_online")
os.remove(LOG)

local b = M.set_battlimit({ enabled = true, limit_gui = 80 })
assert(b.enabled == true, "B enabled")
assert(b.limit_gui == 80, "B limit_gui")
local cf = assert(io.open(CFG, "r")); local body = cf:read("*a"); cf:close()
assert(body:find('"enabled"%s*:%s*true'), "B file enabled: " .. body)
assert(body:find('"limit_gui"%s*:%s*80'), "B file limit: " .. body)
-- Apply should have called: on 80 gui
local lf = assert(io.open(LOG, "r")); local calls = lf:read("*a"); lf:close()
assert(calls:find("on 80 gui", 1, true), "B called on 80 gui: " .. calls)

-- Case C: disable → off
os.remove(LOG)
local c = M.set_battlimit({ enabled = false, limit_gui = 80 })
assert(c.enabled == false, "C enabled")
lf = assert(io.open(LOG, "r")); calls = lf:read("*a"); lf:close()
assert(calls:find("off", 1, true), "C called off: " .. calls)

-- Case D: invalid limit_gui → error, no write of invalid
local before = body
local d = M.set_battlimit({ enabled = true, limit_gui = 5 })
assert(type(d.error) == "string", "D error")
cf = assert(io.open(CFG, "r")); local after = cf:read("*a"); cf:close()
assert(not after:find('"limit_gui"%s*:%s*5'), "D must not persist 5: " .. after)

-- Case E: missing binary → available false
local bad = TMP .. "/missing-bin"
-- Point at non-executable path via env is process-level; for this case the
-- plugin should treat non-executable BIN as unavailable. Temporarily rename.
os.execute("mv " .. BIN .. " " .. BIN .. ".bak")
local e = M.get_battlimit({})
assert(e.available == false, "E available false")
os.execute("mv " .. BIN .. ".bak " .. BIN)

os.execute("rm -rf " .. TMP)
print("backend-battlimit OK")
