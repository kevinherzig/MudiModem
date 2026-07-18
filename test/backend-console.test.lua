-- On-device test for mudimodem.at_console (arg clamping + envelope parsing),
-- run against a FAKE tool (test/fake-at-tool.py) so no modem traffic happens.
-- Env: MM_PLUGIN=<plugin path>  MUDIMODEM_AT_TOOL=<fake tool path>
-- at_console must never touch ubus — the stub below makes any call fatal.
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
assert(M.at_console({ cmd = string.rep("A", 300) }).error, "over-long cmd must error")

-- Happy path through the fake tool: envelope parsed, args passed through.
local r = M.at_console({ cmd = 'AT+QNWPREFCFG="nr5g_band"', timeout = 999 })
assert(r.ok == true, "expected ok, got: " .. tostring(r.error))
assert(r.status == "ok", "status must come from the envelope")
assert(type(r.elapsed_ms) == "number", "elapsed_ms must be a number")
assert(r.response:find("--timeout 60", 1, true), "timeout must clamp to 60, got: " .. r.response)
assert(r.response:find('AT+QNWPREFCFG="nr5g_band"', 1, true),
  "cmd must pass through with inner quotes intact")

-- Timeout clamps low too, and defaults to 8.
local r2 = M.at_console({ cmd = "AT", timeout = 0 })
assert(r2.ok and r2.response:find("--timeout 1", 1, true), "timeout must clamp up to 1")
local r3 = M.at_console({ cmd = "AT" })
assert(r3.ok and r3.response:find("--timeout 8", 1, true), "timeout must default to 8")

-- Newlines collapse: one command per send, no injection of a second line.
local r4 = M.at_console({ cmd = "AT\nATZ" })
assert(r4.ok, "collapsed cmd must still run")
assert(r4.response:find("AT ATZ", 1, true), "newline must collapse to a space")
assert(not r4.response:find("\nATZ", 1, true), "no second command line")

-- Single quotes in cmd must not break the shell quoting.
local r5 = M.at_console({ cmd = "AT+X='y'" })
assert(r5.ok and r5.response:find("AT+X='y'", 1, true), "single quotes survive")

-- Error/fallback paths, driven by the fake tool's branching (no modem, no ubus).
local rb = M.at_console({ cmd = "AT__BUSY__" })
assert(rb.error and not rb.ok, "busy must error, not succeed")
assert(rb.error:lower():find("busy", 1, true), "busy error must mention busy, got: " .. rb.error)

local ro = M.at_console({ cmd = "AT__OPENFAIL__" })
assert(ro.error and not ro.ok, "openfail must error, not succeed")
assert(ro.error:find("cannot open", 1, true), "openfail error must mention the port, got: " .. ro.error)

local rg = M.at_console({ cmd = "AT__GARBAGE__" })
assert(rg.error and not rg.ok, "garbage (no envelope) must error, not succeed")
assert(rg.error:find("no envelope", 1, true), "garbage error must mention no envelope, got: " .. rg.error)

-- Unknown-but-matching status must NOT be reported as success (Fix 2).
local rw = M.at_console({ cmd = "AT__WEIRD__" })
assert(rw.error and not rw.ok, "unknown status must error, not succeed")
assert(rw.error:find("unexpected status", 1, true), "weird-status error must say so, got: " .. rw.error)

print("at_console backend OK")
