-- On-device test for the mudimodem speedtest RPC methods. Runs the REAL
-- plugin against LIVE ubus (for get_speedtest_interfaces / run_speedtest's
-- iface check) plus isolated temp files (for status/history/schedule), using
-- the same native-ubus-shim technique as test/backend.test.lua.
-- Run by tools/verify.sh on the device. Exit 0 = pass, 1 = fail.

local native = require "ubus"
local conn = assert(native.connect(), "ubus connect failed")
package.loaded["oui.ubus"] = {
  call = function(object, method, params) return conn:call(object, method, params or {}) end
}

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M) == "table", "plugin must return a table")
for _, name in ipairs({ "get_speedtest_interfaces", "run_speedtest", "get_speedtest_status",
                         "get_speedtest_history", "clear_speedtest_history",
                         "get_speedtest_schedule", "set_speedtest_schedule" }) do
  assert(type(M[name]) == "function", name .. " missing")
end

-- 1. get_speedtest_interfaces: real ubus data. Cellular MUST resolve on this
-- box (it's the box's only always-up path); wired's device/up may vary
-- (cable may or may not be plugged in) -- assert shape, not a specific value.
local ifaces = M.get_speedtest_interfaces({})
assert(type(ifaces.cellular) == "table", "cellular key present")
assert(type(ifaces.cellular.device) == "string" and ifaces.cellular.device ~= "",
       "cellular device resolves to a real device name, got: " .. tostring(ifaces.cellular.device))
assert(ifaces.cellular.up == true, "cellular must be up on this box")
assert(type(ifaces.wired) == "table", "wired key present")
assert(ifaces.wired.up == true or ifaces.wired.up == false, "wired.up is a boolean")

-- 2. run_speedtest refuses an invalid iface without touching anything.
local bad = M.run_speedtest({ iface = "vpn" })
assert(bad.error, "invalid iface must be refused")

-- 3. get_speedtest_status / get_speedtest_history / clear_speedtest_history
-- against isolated temp files (no real test run -- that's a separate LIVE
-- smoke test in verify.sh, since it costs real cellular data).
local HIST = os.getenv("MUDIMODEM_SPEEDTEST_HIST") or error("set MUDIMODEM_SPEEDTEST_HIST")
os.execute("mkdir -p " .. (HIST:match("(.*/)") or "."))
local f = assert(io.open(HIST, "w"))
f:write('{"t":1000,"iface":"cellular","down_mbps":42.1,"up_mbps":11.3,"latency_ms":61}\n')
f:write('garbage not json\n')
f:write('{"t":2000,"iface":"wired","down_mbps":500.0,"up_mbps":100.0,"latency_ms":8}\n')
f:close()

-- Empty results come back as cjson.empty_array (userdata, so it encodes as []
-- for the frontend, same trick as get_history) -- len() measures either a
-- real array or that sentinel as 0 (matches test/backend-history.test.lua).
local function len(x) return (type(x) == "table") and #x or 0 end

local all = M.get_speedtest_history({})
assert(len(all.results) == 2, "expected 2 valid results (1 malformed skipped), got " .. len(all.results))
local cellOnly = M.get_speedtest_history({ iface = "cellular" })
assert(len(cellOnly.results) == 1 and cellOnly.results[1].iface == "cellular", "iface filter works")
local since = M.get_speedtest_history({ since = 1000 })
assert(len(since.results) == 1 and since.results[1].t == 2000, "since filter works")

local status_absent = M.get_speedtest_status({})
assert(status_absent.running == false, "no status file yet -> not running")

local cleared = M.clear_speedtest_history({})
assert(cleared.ok == true)
local afterClear = M.get_speedtest_history({})
assert(len(afterClear.results) == 0, "history empty after clear")

-- 4. schedule read/write round trip.
local SCHED = os.getenv("MUDIMODEM_ST_SCHEDULE") or error("set MUDIMODEM_ST_SCHEDULE")
os.execute("rm -f " .. SCHED)
local defaultSched = M.get_speedtest_schedule({})
assert(defaultSched.enabled == false, "default schedule is off")

local badInterval = M.set_speedtest_schedule({ enabled = true, interval_seconds = 42 })
assert(badInterval.error, "non-whitelisted interval must be refused")

local ok = M.set_speedtest_schedule({ enabled = true, interval_seconds = 3600 })
assert(ok.ok == true)
local reread = M.get_speedtest_schedule({})
assert(reread.enabled == true and reread.interval_seconds == 3600, "schedule persisted")

os.execute("rm -f " .. HIST .. " " .. SCHED)
print("backend-speedtest OK: interfaces/run_speedtest-guard/history-filters/clear/schedule all pass")
