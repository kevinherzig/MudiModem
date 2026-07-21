-- On-device isolation test for mudimodem.app_version + device_info.
-- dofiles the REAL plugin with oui.ubus shimmed (app_version uses no ubus;
-- device_info calls ubus system board, which the shim answers). Overrides
-- VERSION_FILE + CURL via env so the check is deterministic and offline.
-- Run by verify.sh. Exit 0 = pass.
local board_ok = true   -- flipped false for Case F to exercise the failure branch
package.loaded["oui.ubus"] = { call = function(obj, method)
  if obj == "system" and method == "board" then
    if board_ok then return { model = "GL.iNet E5800 TEST", system = "ARMv8 TEST" } end
    return nil, "err"
  end
  return nil, "unused"
end }

local TMP = os.getenv("MM_TMP") or "/tmp/mm-ver-test"
os.execute("rm -rf " .. TMP .. "; mkdir -p " .. TMP)

-- A fake curl: ignores every arg, prints whatever is in $TMP/remote.json.
local curl = TMP .. "/curl.sh"
local cf = assert(io.open(curl, "w"))
cf:write("#!/bin/sh\ncat " .. TMP .. "/remote.json\n")
cf:close()
os.execute("chmod +x " .. curl)

local function writef(path, s) local f = assert(io.open(path, "w")); f:write(s); f:close() end

-- Env (MUDIMODEM_VERSION_FILE, MUDIMODEM_CURL, MM_PLUGIN) is set by the ssh
-- wrapper in verify.sh; the plugin reads it via os.getenv at load + call time.
local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.app_version) == "function", "app_version missing")

-- Case A: installed != latest  -> update_available true, checked true.
writef(os.getenv("MUDIMODEM_VERSION_FILE"), '{"version":"1.0.0"}')
writef(TMP .. "/remote.json", '{"version":"1.0.2"}')
local a = M.app_version({})
assert(a.installed == "1.0.0", "A installed: " .. tostring(a.installed))
assert(a.latest == "1.0.2", "A latest: " .. tostring(a.latest))
assert(a.checked == true, "A checked")
assert(a.update_available == true, "A update_available")
assert(a.error == nil, "A no error")

-- Case B: installed == latest  -> update_available false.
writef(TMP .. "/remote.json", '{"version":"1.0.0"}')
local b = M.app_version({})
assert(b.update_available == false, "B up to date")
assert(b.checked == true, "B checked")

-- Case C: malformed remote     -> fail-silent (error set, not checked).
writef(TMP .. "/remote.json", 'not json')
local c = M.app_version({})
assert(c.checked == false, "C not checked")
assert(c.update_available == false, "C no update on failure")
assert(type(c.error) == "string", "C error string")
assert(c.installed == "1.0.0", "C still reports installed")

-- Case D: missing local version file -> installed "unknown".
os.remove(os.getenv("MUDIMODEM_VERSION_FILE"))
writef(TMP .. "/remote.json", '{"version":"1.0.2"}')
local d = M.app_version({})
assert(d.installed == "unknown", "D installed unknown: " .. tostring(d.installed))

-- Case E: device_info returns model + cpu from the ubus board shim.
assert(type(M.device_info) == "function", "device_info missing")
local dv = M.device_info({})
assert(dv.model == "GL.iNet E5800 TEST", "E device_info model: " .. tostring(dv.model))
assert(dv.cpu == "ARMv8 TEST", "E device_info cpu: " .. tostring(dv.cpu))

-- Case F: ubus system board failure -> device_info fails closed to {"",""}.
board_ok = false
local df = M.device_info({})
assert(df.model == "", "F device_info model on failure: " .. tostring(df.model))
assert(df.cpu == "", "F device_info cpu on failure: " .. tostring(df.cpu))

os.execute("rm -rf " .. TMP)
print("backend-version OK")
