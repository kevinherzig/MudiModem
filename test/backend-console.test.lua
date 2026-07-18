-- On-device test for mudimodem.at_console (split/cap + per-step envelope parse),
-- run against a FAKE tool (test/fake-at-tool.py) so no modem traffic happens.
-- Env: MM_PLUGIN=<plugin path>  MUDIMODEM_AT_TOOL=<fake tool path>
package.loaded["oui.ubus"] = {
  call = function() error("at_console must not touch ubus") end
}

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M) == "table", "plugin must return a table")
assert(type(M.at_console) == "function", "at_console missing")

-- Rejections (no spawn happens for any of these).
assert(M.at_console(nil).error, "nil args must error")
assert(M.at_console({}).error, "missing cmd must error")
assert(M.at_console({ cmd = "" }).error, "empty cmd must error")
assert(M.at_console({ cmd = "   " }).error, "whitespace cmd must error")
assert(M.at_console({ cmd = "\n\n" }).error, "blank-only lines must error")
assert(M.at_console({ cmd = string.rep("A", 300) }).error, "over-long step must error")
assert(M.at_console({ cmd = "AT\n" .. string.rep("A", 300) }).error, "any over-long step must error")

-- Nine steps exceeds the max of 8.
local many = {}
for i = 1, 9 do many[i] = "AT+C" .. i end
assert(M.at_console({ cmd = table.concat(many, "\n") }).error, "over-8 steps must error")

-- Happy path, SINGLE step: shape + timeout clamp + cmd passthrough.
local r = M.at_console({ cmd = 'AT+QNWPREFCFG="nr5g_band"', timeout = 999 })
assert(r.ok == true, "expected ok, got: " .. tostring(r.error))
assert(r.requested == 1 and r.ran == 1 and r.aborted == false, "single-step counts")
assert(#r.steps == 1, "one step returned")
assert(r.steps[1].status == "ok", "status from the envelope")
assert(type(r.steps[1].elapsed_ms) == "number", "elapsed_ms is a number")
assert(r.steps[1].cmd == 'AT+QNWPREFCFG="nr5g_band"', "step cmd echoed back")
assert(r.steps[1].response:find("--timeout 60", 1, true), "timeout clamps to 60")
assert(r.steps[1].response:find('AT+QNWPREFCFG="nr5g_band"', 1, true), "inner quotes intact")

-- The backend must pass an end-of-options `--` before the steps so a step that
-- spells a tool flag is never parsed as one.
assert(r.steps[1].response:find(" -- ", 1, true), "backend must emit a -- sentinel before steps")

-- Timeout clamps low and defaults to 8.
local r2 = M.at_console({ cmd = "AT", timeout = 0 })
assert(r2.ok and r2.steps[1].response:find("--timeout 1", 1, true), "timeout clamps up to 1")
local r3 = M.at_console({ cmd = "AT" })
assert(r3.ok and r3.steps[1].response:find("--timeout 8", 1, true), "timeout defaults to 8")

-- MULTI step happy path: two frames parsed, in order.
local rm = M.at_console({ cmd = "AT+ONE\nAT+TWO" })
assert(rm.ok and rm.requested == 2 and rm.ran == 2 and rm.aborted == false, "two steps ran")
assert(rm.steps[1].cmd == "AT+ONE" and rm.steps[2].cmd == "AT+TWO", "step order preserved")

-- STOP on error: second step never ran; aborted flag + counts reflect it.
local re = M.at_console({ cmd = "AT+BAD__ERR__\nAT+NEVER" })
assert(re.ok, "an errored sequence still returns ok=true (transport succeeded)")
assert(re.requested == 2 and re.ran == 1 and re.aborted == true, "aborted after step 1")
assert(re.steps[1].status == "error", "first step marked error")
assert(#re.steps == 1, "no frame for the skipped step")

-- Single quotes survive shell quoting.
local r5 = M.at_console({ cmd = "AT+X='y'" })
assert(r5.ok and r5.steps[1].response:find("AT+X='y'", 1, true), "single quotes survive")

-- Channel-level failures still return {error}, never steps.
local rb = M.at_console({ cmd = "AT__BUSY__" })
assert(rb.error and not rb.ok and rb.error:lower():find("busy", 1, true), "busy errors")
local ro = M.at_console({ cmd = "AT__OPENFAIL__" })
assert(ro.error and ro.error:find("cannot open", 1, true), "openfail errors")
local rg = M.at_console({ cmd = "AT__GARBAGE__" })
assert(rg.error and rg.error:find("no envelope", 1, true), "no-envelope errors")
local rw = M.at_console({ cmd = "AT__WEIRD__" })
assert(rw.error and rw.error:find("unexpected status", 1, true), "unknown status errors")

-- Accept side of the caps: exactly 8 steps and a 256-char step are allowed.
local eight = {}
for i = 1, 8 do eight[i] = "AT+C" .. i end
local r8 = M.at_console({ cmd = table.concat(eight, "\n") })
assert(r8.ok and r8.requested == 8 and r8.ran == 8, "exactly 8 steps must be accepted")
local at256 = "AT+" .. string.rep("X", 253)   -- 256 chars total
assert(#at256 == 256, "fixture must be exactly 256 chars")
local r256 = M.at_console({ cmd = at256 })
assert(r256.ok, "a 256-char step must be accepted")

print("at_console backend OK")
