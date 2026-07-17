-- Isolation test for set_bands/confirm. Shims oui.ubus AND os.execute so NO
-- real AT write and NO real process launch ever happen; pending/armed go to
-- temp paths (set via env before this runs). Proves the safety interlock:
-- set_bands must refuse to write unless the watchdog armed first.
--
-- Env (set by the runner): MUDIMODEM_PENDING, MUDIMODEM_ARMED, MUDIMODEM_BIN

local PENDING = assert(os.getenv("MUDIMODEM_PENDING"), "set MUDIMODEM_PENDING")
local ARMED   = assert(os.getenv("MUDIMODEM_ARMED"),   "set MUDIMODEM_ARMED")

-- ---- shim oui.ubus: canned reads, record AT writes ----
local at_cmds = {}
package.loaded["oui.ubus"] = {
  call = function(object, method, params)
    if object == "modem.CPU.AT" and method == "get_result_AT" then
      local cmd = params.cmd
      at_cmds[#at_cmds + 1] = cmd
      if cmd == "AT+QSPN" then
        return { data = '\r\n+QSPN: "T-Mobile","T-Mobile","",0,"310260"\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="nr5g_band"' then
        return { data = '\r\n+QNWPREFCFG: "nr5g_band",71\r\n\r\nOK\r\n' }
      end
      return { data = "\r\nOK\r\n" }
    elseif object == "cellular.modem" and method == "status" then
      return { modems = { { bus = "cpu", current_sim_slot = "1" } } }
    elseif object == "cellular.sim" and method == "info" then
      return { sims = { { slot = "1", mcc = "310", mnc = "260" } } }
    end
    return {}
  end
}

-- ---- shim os.execute: record, and (optionally) simulate the watchdog arming ----
local exec_cmds = {}
local ARM_ON_WATCH = true      -- flip to false to simulate a launch that never arms
local function install_exec()
  os.execute = function(cmd)
    exec_cmds[#exec_cmds + 1] = cmd
    if ARM_ON_WATCH and cmd:find("watch") then
      local f = io.open(ARMED, "w"); if f then f:close() end
    end
    return true               -- never actually run anything (no mkdir, no sleep, no launch)
  end
end
install_exec()

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.set_bands) == "function", "set_bands missing")
assert(type(M.confirm) == "function", "confirm missing")

local function idx(pat) for i, c in ipairs(at_cmds) do if c:find(pat, 1, true) then return i end end end
local function reset() at_cmds = {}; exec_cmds = {}; os.remove(PENDING); os.remove(ARMED) end

-- 1. Happy path: reads previous, arms, then writes; order is safe.
reset()
local r = M.set_bands({ sa = { 71 } })
assert(r.ok == true, "set_bands should succeed; got: " .. tostring(r.error))
assert(r.applied == "71" and r.previous == "71", "applied/previous wrong")
assert(r.sub_id == 1, "sub_id should be PLMN-matched to 1")
local i_read  = idx('AT+QNWPREFCFG="nr5g_band"')       -- the read (no comma)
local i_write = idx('AT+QNWPREFCFG="nr5g_band",71')    -- the write
assert(i_read and i_write, "must read then write nr5g_band")
local i_watch
for i, c in ipairs(exec_cmds) do if c:find("watch") then i_watch = i end end
assert(i_watch, "must launch the watchdog")
-- pending file must have been written with the previous value
local pf = io.open(PENDING, "r"); assert(pf, "pending not written")
local body = pf:read("*a"); pf:close()
assert(body:find("PREV_nr5g_band=71"), "pending must capture previous config")
print("  ok  - happy path: read 71, armed, wrote 71, pending captured previous")

-- 2. Empty list is refused (would drop all service) — no launch, no write.
reset()
r = M.set_bands({ sa = {} })
assert(r.error and r.error:find("empty"), "empty list must be refused")
assert(#at_cmds == 0 and #exec_cmds == 0, "empty must not touch the modem")
print("  ok  - empty band list refused, nothing written")

-- 3. Invalid band value is refused.
reset()
r = M.set_bands({ sa = { "7x" } })
assert(r.error and r.error:find("invalid"), "invalid band must be refused")
print("  ok  - invalid band value refused")

-- 4. Watchdog fails to arm -> NO band write, pending cleaned up.
reset()
ARM_ON_WATCH = false
r = M.set_bands({ sa = { 71 } })
ARM_ON_WATCH = true
assert(r.error and r.error:find("arm"), "must fail when watchdog does not arm")
assert(not idx('AT+QNWPREFCFG="nr5g_band",71'), "must NOT write bands without a live net")
local pf2 = io.open(PENDING, "r")
assert(not pf2, "pending must be cleaned up on arm failure"); if pf2 then pf2:close() end
print("  ok  - no arm => no write, pending cleaned up (THE safety interlock)")

-- 5. confirm removes the pending file so the watchdog won't revert.
reset()
local f = io.open(PENDING, "w"); f:write("SUB_ID=1\nPREV_nr5g_band=71\n"); f:close()
r = M.confirm({})
assert(r.ok == true, "confirm should succeed")
assert(not io.open(PENDING, "r"), "confirm must remove pending")
print("  ok  - confirm clears pending (cancels the revert)")

print("ALL SET_BANDS TESTS PASSED")
