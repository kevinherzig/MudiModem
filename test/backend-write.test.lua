-- Isolation test for set_bands/confirm. Shims oui.ubus AND os.execute so NO
-- real AT write and NO real process launch ever happen; pending/armed go to
-- temp paths (set via env before this runs). Proves the safety interlock:
-- set_bands must refuse to write unless the watchdog armed first.
--
-- Env (set by the runner): MUDIMODEM_PENDING, MUDIMODEM_ARMED, MUDIMODEM_BIN

local PENDING = assert(os.getenv("MUDIMODEM_PENDING"), "set MUDIMODEM_PENDING")
local ARMED   = assert(os.getenv("MUDIMODEM_ARMED"),   "set MUDIMODEM_ARMED")

-- ---- shim oui.ubus: canned reads, record AT + set_feature_config writes ----
local at_cmds = {}
local setfeat_calls = {}
package.loaded["oui.ubus"] = {
  call = function(object, method, params)
    if object == "modem.CPU.AT" and method == "get_result_AT" then
      local cmd = params.cmd
      at_cmds[#at_cmds + 1] = cmd
      if cmd == "AT+QSPN" then
        return { data = '\r\n+QSPN: "T-Mobile","T-Mobile","",0,"310260"\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="nr5g_band"' then
        return { data = '\r\n+QNWPREFCFG: "nr5g_band",71\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="lte_band"' then
        return { data = '\r\n+QNWPREFCFG: "lte_band",2:66\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="nsa_nr5g_band"' then
        return { data = '\r\n+QNWPREFCFG: "nsa_nr5g_band",0\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="mode_pref"' then
        return { data = '\r\n+QNWPREFCFG: "mode_pref",NR5G\r\n\r\nOK\r\n' }
      end
      return { data = "\r\nOK\r\n" }
    elseif object == "cellular.modem" and method == "status" then
      return { modems = { { bus = "cpu", current_sim_slot = "1" } } }
    elseif object == "cellular.sim" and method == "info" then
      return { sims = { { slot = "1", mcc = "310", mnc = "260" } } }
    elseif object == "cellular.modem" and method == "get_all_config" then
      return { slot_feature = { ["s1_bcpu_test"] = {
        network_mode = "NR5G",
        band = { band_enable = true, band_filter_mode = 0,
                 band_list = { LTE = {}, ["NR-SA"] = { 71 }, ["NR-NSA"] = {} } } } } }
    elseif object == "cellular.modem" and method == "set_feature_config" then
      setfeat_calls[#setfeat_calls + 1] = params
      return { ok = true, changed = true }
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
local function reset() at_cmds = {}; exec_cmds = {}; setfeat_calls = {}; os.remove(PENDING); os.remove(ARMED) end

-- 1. Happy path (SA only): reads previous, arms, then writes; order is safe.
reset()
local r = M.set_bands({ sa = { 71 } })
assert(r.ok == true, "set_bands should succeed; got: " .. tostring(r.error))
assert(r.applied and r.applied.sa == "71", "applied.sa wrong")
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

-- 1b. Multi-RAT: SA + LTE together, each read + written, both stashed.
reset()
r = M.set_bands({ sa = { 71, 41 }, lte = { 2, 66, 12 } })
assert(r.ok == true, "multi-RAT set_bands should succeed; got: " .. tostring(r.error))
assert(r.applied.sa == "71:41" and r.applied.lte == "2:66:12", "applied map wrong")
assert(idx('AT+QNWPREFCFG="nr5g_band",71:41'), "must write SA")
assert(idx('AT+QNWPREFCFG="lte_band",2:66:12'), "must write LTE")
local pf1b = io.open(PENDING, "r"); body = pf1b:read("*a"); pf1b:close()
assert(body:find("PREV_lte_band=2:66") and body:find("APPLIED_lte_band=2:66:12"), "must stash LTE prev+applied")
print("  ok  - multi-RAT: SA + LTE written and stashed")

-- 1c. Mode + NSA change: writes mode_pref + nsa_nr5g_band, stashes both.
reset()
r = M.set_bands({ nsa = { 71, 41 }, mode = "AUTO" })
assert(r.ok == true, "mode+nsa set_bands should succeed; got: " .. tostring(r.error))
assert(r.applied.nsa == "71:41" and r.applied.mode == "AUTO", "applied nsa/mode wrong")
assert(idx('AT+QNWPREFCFG="nsa_nr5g_band",71:41'), "must write NSA")
assert(idx('AT+QNWPREFCFG="mode_pref",AUTO'), "must write mode_pref")
local pf1c = io.open(PENDING, "r"); body = pf1c:read("*a"); pf1c:close()
assert(body:find("PREV_mode_pref=NR5G") and body:find("APPLIED_mode_pref=AUTO"), "must stash mode prev+applied")
print("  ok  - mode + NSA: mode_pref and nsa_nr5g_band written and stashed")

-- 1d. Invalid mode is refused.
reset()
r = M.set_bands({ mode = "6G" })
assert(r.error and r.error:find("invalid mode"), "invalid mode must be refused")
print("  ok  - invalid mode refused")

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

-- 5. confirm removes pending AND commits kept bands (SA + LTE) AND the mode to
--    GL's durable config (Path B), via set_feature_config.
reset()
M.set_bands({ sa = { 71, 41 }, lte = { 2, 66 }, mode = "AUTO" })   -- stored network_mode is NR5G
r = M.confirm({})
assert(r.ok == true and r.confirmed == true, "confirm should succeed")
assert(r.durable == true, "confirm must report a durable GL-config commit")
assert(not io.open(PENDING, "r"), "confirm must remove pending")
assert(#setfeat_calls == 1, "confirm must call set_feature_config exactly once")
local sf = setfeat_calls[1]
assert(sf.location_id == "s1_bcpu_test", "must target the active slot's location_id")
assert(sf.data.network_mode == "AUTO", "must commit the applied mode (AUTO), overriding stored NR5G")
local bl = sf.data and sf.data.band and sf.data.band.band_list
assert(bl, "must send the band config")
assert(table.concat(bl["NR-SA"], ",") == "71,41", "must commit applied NR-SA")
assert(table.concat(bl["LTE"], ",") == "2,66", "must commit applied LTE")
print("  ok  - confirm commits kept SA+LTE bands AND mode to GL config (durable)")

-- 6. confirm with nothing stashed (e.g. legacy pending) still succeeds, no commit.
reset()
local f = io.open(PENDING, "w"); f:write("SUB_ID=1\nPREV_nr5g_band=71\n"); f:close()
r = M.confirm({})
assert(r.ok == true and r.durable == false, "no SLOT/APPLIED => confirm succeeds but not durable")
assert(#setfeat_calls == 0, "must not call set_feature_config without stashed bands")
print("  ok  - confirm without stashed bands: no-op commit, still clears pending")

print("ALL SET_BANDS TESTS PASSED")
