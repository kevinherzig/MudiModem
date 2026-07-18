-- On-box test for mudimodem.get_history. The backend pulls oui.ubus -> resty.http
-- which indexes ngx at load, so we stub ngx (CLAUDE.md §8). get_history itself
-- touches no ubus — it only reads the jsonl telemetry files under MUDIMODEM_HIST.
-- Run: MUDIMODEM_HIST=/tmp/mmhist-test lua test/backend-history.test.lua

local HIST = os.getenv("MUDIMODEM_HIST") or error("set MUDIMODEM_HIST")
os.execute("mkdir -p " .. HIST)

local function w(path, lines)
  local f = assert(io.open(path, "w"))
  f:write(table.concat(lines, "\n") .. "\n")
  f:close()
end
-- includes a malformed line (must be skipped) and out-of-order timestamps.
w(HIST .. "/samples.jsonl", {
  '{"t":1000,"slot":"1","id":"A1","rsrp":-101}',
  'garbage not json',
  '{"t":2000,"slot":"1","id":"B2","rsrp":-99}',
})
w(HIST .. "/events.jsonl", {
  '{"t":1500,"kind":"user","label":"Bands applied","detail":"SA n71"}',
})

ngx = { socket = { tcp = function() return { settimeout = function() end, connect = function() end } end },
  re = { match = function() end, gmatch = function() end, find = function() end },
  log = function() end, ERR = 0, WARN = 1, NOTICE = 2, INFO = 3, var = {}, req = {}, ctx = {},
  say = function() end, print = function() end, exit = function() end, HTTP_OK = 200,
  timer = { at = function() end },
  config = { ngx_lua_version = 10025, subsystem = "http", debug = false },
  worker = { id = function() return 0 end, count = function() return 4 end },
  now = function() return os.time() end, time = function() return os.time() end }

local ok, M = pcall(dofile, "/usr/lib/oui-httpd/rpc/mudimodem")
assert(ok, "backend failed to load: " .. tostring(M))
assert(type(M.get_history) == "function", "get_history missing")

-- Empty results come back as cjson.empty_array (userdata, so it encodes as []
-- for the frontend); len() measures either a real array or that sentinel as 0.
local function len(x) return (type(x) == "table") and #x or 0 end

local all = M.get_history({})
assert(len(all.samples) == 2, "expected 2 valid samples (1 malformed skipped), got " .. len(all.samples))
assert(len(all.events) == 1, "expected 1 event, got " .. len(all.events))
assert(all.samples[1].id == "A1", "first sample id preserved")
assert(all.now and all.now > 0, "now stamped in ms")

local since = M.get_history({ since = 1500 })
assert(len(since.samples) == 1, "since=1500 -> only t=2000 sample")
assert(since.samples[1].t == 2000, "correct sample after since")
assert(len(since.events) == 0, "since=1500 -> event at t=1500 is NOT > since")

-- Windowing returns the correct TAIL, oldest-first. The backward-read early-exit
-- (perf: it stops decoding once it passes `since` instead of decoding the whole
-- file) must not drop, duplicate, or reorder the returned window.
w(HIST .. "/samples.jsonl", {
  '{"t":100,"rsrp":-100}', '{"t":200,"rsrp":-101}', '{"t":300,"rsrp":-102}',
  '{"t":400,"rsrp":-103}', '{"t":500,"rsrp":-104}',
})
local tail = M.get_history({ since = 250 })
assert(len(tail.samples) == 3, "since=250 -> t=300,400,500 (3), got " .. len(tail.samples))
assert(tail.samples[1].t == 300, "window is oldest-first (first = 300)")
assert(tail.samples[3].t == 500, "window ends at the newest (last = 500)")
local none = M.get_history({ since = 500 })
assert(len(none.samples) == 0, "since=newest -> empty window")
local everything = M.get_history({})
assert(len(everything.samples) == 5, "no since -> the whole file (5)")
assert(everything.samples[1].t == 100 and everything.samples[5].t == 500, "full read stays oldest-first")

-- empty dir -> empty arrays, never an error
os.execute("rm -f " .. HIST .. "/samples.jsonl " .. HIST .. "/events.jsonl")
local empty = M.get_history({})
assert(len(empty.samples) == 0 and len(empty.events) == 0, "absent files -> empty arrays")
-- and they must encode as [] (not {}) so the frontend gets real arrays
local enc = require("cjson").encode(empty)
assert(enc:find('"samples":%[%]'), "empty samples must encode as []")
assert(enc:find('"events":%[%]'), "empty events must encode as []")

os.execute("rm -rf " .. HIST)
print("get_history OK: all=2/1, since=1/0, empty=0/0")
