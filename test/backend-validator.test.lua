-- Verifies the mudimodem arg validator admits real AT syntax — the fix for the
-- -32602 "Invalid params of cmd" bug. oui-lib-rpc.lua applies a DEFAULT string
-- validator (^[%w%.%s%-_:#/]-$) that rejects the '+', '=', '"' every AT command
-- uses, so without this override only bare ATI/AT reach the backend.
--
-- Run on-device (dev box has no lua). Env: MM_VALIDATOR=<path>. Exit 0 = pass.

local path = os.getenv("MM_VALIDATOR") or "/usr/share/gl-validator.d/mudimodem.lua"
local v = dofile(path)
assert(type(v) == "table", "validator must return a table")
assert(type(v.at_console) == "table", "at_console entry missing")

local pat = v.at_console.cmd
assert(type(pat) == "string" or type(pat) == "function",
  "at_console.cmd validator must be a Lua pattern or a function")

-- Mirror how oui-lib-rpc.lua tests a string param: pattern -> v:match(pat),
-- function -> vt(v); truthy result = admitted.
local function admits(s)
  if type(pat) == "function" then return pat(s) and true or false end
  return s:match(pat) ~= nil
end

-- Every real AT command must be admitted (these are exactly what -32602'd
-- before the fix — the console is useless if they don't reach the backend).
for _, s in ipairs({
  "AT",
  "ATI",
  "AT+CSQ",
  'AT+QENG="servingcell"',
  'AT+QNWPREFCFG="nr5g_band"',
  'AT+QNWPREFCFG="nr5g_band",41:66:71',
  "AT+CFUN=1",
}) do
  assert(admits(s), "validator must admit AT command: " .. s)
end

-- Prove the bug premise: the oui DEFAULT string validator rejects the same
-- commands, which is the whole reason this override file has to exist.
local DEFAULT = "^[%w%.%s%-_:#/]-$"
assert(not ("AT+CSQ"):match(DEFAULT), "default should reject '+' (bug premise broken)")
assert(not ('AT+QENG="servingcell"'):match(DEFAULT), "default should reject '\"' (bug premise broken)")
-- ...and that bare AT/ATI slip through the default (why 'one or two worked').
assert(("ATI"):match(DEFAULT), "default should admit bare ATI")

print("validator OK: at_console.cmd admits AT syntax the oui default rejects")
