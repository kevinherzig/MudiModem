-- Isolation test for set_cell_lock / clear_cell_lock / confirm / revert_now
-- (cell kind). Shims oui.ubus, ngx (glc), os.execute (watchdog arm). No box.
local PENDING = assert(os.getenv("MUDIMODEM_PENDING"))
local ARMED   = assert(os.getenv("MUDIMODEM_ARMED"))
local STALE   = assert(os.getenv("MUDIMODEM_STALE"))

local at_log = {}
local lock5_reply = '\r\n+QNWLOCK: "common/5g",0\r\n\r\nOK\r\n'
local lock4_reply = '\r\n+QNWLOCK: "common/4g",0\r\n\r\nOK\r\n'
local setfeat_calls = {}
package.loaded["oui.ubus"] = {
  call = function(object, method, params)
    if object == "modem.CPU.AT" and method == "get_result_AT" then
      local cmd = params.cmd
      at_log[#at_log + 1] = cmd .. " @" .. tostring(params.sub_id)
      if cmd == "AT+QSPN" then
        return { data = '\r\n+QSPN: "T-Mobile","T-Mobile","",0,"310260"\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWLOCK="common/4g"' then
        return { data = lock4_reply }
      elseif cmd == 'AT+QNWLOCK="common/5g"' then
        return { data = lock5_reply }
      elseif cmd == 'AT+QNWLOCK="save_ctrl"' then
        return { data = '\r\n+QNWLOCK: "save_ctrl",0,0\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="mode_pref"' then
        return { data = '\r\n+QNWPREFCFG: "mode_pref",NR5G\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWPREFCFG="nr5g_disable_mode"' then
        return { data = '\r\n+QNWPREFCFG: "nr5g_disable_mode",0\r\n\r\nOK\r\n' }
      end
      return { data = "\r\nOK\r\n" }
    elseif object == "cellular.modem" and method == "status" then
      return { modems = { { bus = "cpu", current_sim_slot = "1" } } }
    elseif object == "cellular.sim" and method == "info" then
      return { sims = { { slot = "1", mcc = "310", mnc = "260" } } }
    elseif object == "cellular.modem" and method == "get_all_config" then
      -- Non-empty and slot-matching on purpose: if a future regression makes
      -- confirm() fall through past the KIND=="cell" early-return, this makes
      -- the "if sf then" block in the general (band) path actually live,
      -- rather than trivially nil -- so scenario 6 exercises the same code a
      -- band confirm would, and any regression that also loosens the `any`
      -- gate (the other thing currently keeping a cell confirm from writing
      -- band config) has something real to write.
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

local glc_calls, glc_fail = {}, false
ngx = {
  HTTP_POST = "POST",
  location = { capture = function(uri, opts)
    local body = opts and opts.body or ""
    glc_calls[#glc_calls + 1] = body
    if glc_fail and body:find("set_cell_tower") then
      return { status = 200, body = "20002044 lock failed" }
    end
    if body:find("get_cell_tower") then
      return { status = 200, body = '0 {"slot1":{},"slot2":{}}' }
    end
    return { status = 200, body = "0 {}" }
  end },
}

local exec_cmds = {}
os.execute = function(cmd)
  exec_cmds[#exec_cmds + 1] = cmd
  if cmd:find("watch") then local f = io.open(ARMED, "w"); if f then f:close() end end
  return true
end

local M = dofile(assert(os.getenv("MM_PLUGIN")))
assert(type(M.set_cell_lock) == "function", "set_cell_lock missing")
assert(type(M.clear_cell_lock) == "function", "clear_cell_lock missing")
assert(type(M.scan_cells) == "function", "scan_cells missing")

local function reset()
  at_log = {}; glc_calls = {}; exec_cmds = {}; setfeat_calls = {}
  os.remove(PENDING); os.remove(ARMED); os.remove(STALE)
  glc_fail = false
  lock5_reply = '\r\n+QNWLOCK: "common/5g",0\r\n\r\nOK\r\n'
  lock4_reply = '\r\n+QNWLOCK: "common/4g",0\r\n\r\nOK\r\n'
end
local function pget(key)
  for line in io.lines(PENDING) do
    local k, v = line:match("^([%w_]+)=(.*)$"); if k == key then return v end
  end
end

-- 1. Happy path: snapshot -> arm -> GL write; pending has the cell layout.
reset()
local r = M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 })
assert(r.ok == true, "should succeed; got " .. tostring(r.error))
assert(r.window == 60 and r.sub_id == 1, "window/sub_id wrong")
assert(pget("KIND") == "cell" and pget("RAT") == "5g", "pending KIND/RAT wrong")
assert(pget("PREV_SAVE_CTRL") == "0,0", "PREV_SAVE_CTRL wrong")
assert(pget("PREV_mode_pref") == "NR5G", "PREV_mode_pref wrong")
local armed_at, wrote_at
for i, c in ipairs(exec_cmds) do if c:find("watch") then armed_at = i end end
for i, c in ipairs(glc_calls) do if c:find("set_cell_tower") then wrote_at = i end end
assert(armed_at and wrote_at, "must arm watchdog and call set_cell_tower")
local set_body = glc_calls[wrote_at]
assert(set_body:find('"lock":true') and set_body:find('"pci":516') and
       set_body:find('"freq":127490') and set_body:find('"scs":15') and
       set_body:find('"band":71') and set_body:find('"network_type":"NR5G"'),
       "set_cell_tower payload wrong: " .. set_body)

-- 2. Refuse while a lock already exists.
reset()
lock5_reply = '\r\n+QNWLOCK: "common/5g",516,127490,15,71\r\n\r\nOK\r\n'
r = M.set_cell_lock({ rat = "5g", pci = 9, freq = 1, scs = 15, band = 71 })
assert(r.error and r.error:find("unlock first"), "must refuse over an existing lock")

-- 3. Refuse while another change is pending.
reset()
local f = io.open(PENDING, "w"); f:write("SUB_ID=1\n"); f:close()
r = M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 })
assert(r.error and r.error:find("pending"), "must refuse while pending exists")

-- 4. Validation: bad rat, missing pci, missing scs on 5g.
reset()
assert(M.set_cell_lock({ rat = "6g", pci = 1, freq = 1 }).error, "bad rat accepted")
assert(M.set_cell_lock({ rat = "5g", freq = 1, scs = 15, band = 71 }).error, "missing pci accepted")
assert(M.set_cell_lock({ rat = "5g", pci = 1, freq = 1 }).error, "5g without scs/band accepted")

-- 5. GL write failure -> pending cleaned up, error surfaced with the code.
reset()
glc_fail = true
r = M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 })
assert(r.error and tostring(r.error):find("20002044"), "GL error code not surfaced")
assert(not io.open(PENDING, "r"), "pending must be removed on GL failure")

-- 6. confirm on a cell pending: clears it, does NOT touch set_feature_config.
-- set_feature_config is called via oui.ubus (the shim above), NOT via
-- ngx.location.capture/glc_calls -- so this must scan setfeat_calls, not
-- glc_calls, or a regression that removes the `KIND=="cell"` early-return in
-- M.confirm (falling through into the band-durability set_feature_config
-- path) would go undetected.
reset()
assert(M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 }).ok)
glc_calls = {}; setfeat_calls = {}
r = M.confirm({})
assert(r.ok and r.confirmed, "confirm failed")
assert(not io.open(PENDING, "r"), "pending must be gone after confirm")
assert(#setfeat_calls == 0, "cell confirm must not touch band config (set_feature_config)")

-- 7. revert_now on a cell pending: GL unlock + mode restore + pending gone.
reset()
assert(M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 }).ok)
at_log = {}; glc_calls = {}
r = M.revert_now({})
assert(r.ok and r.reverted, "revert_now failed")
local unlocked
for _, c in ipairs(glc_calls) do if c:find('"lock":false') then unlocked = true end end
assert(unlocked, "revert_now must GL-unlock")
local mode_restored, disable_restored, savectrl_restored
for _, c in ipairs(at_log) do
  if c:find('mode_pref",NR5G') then mode_restored = true end
  if c:find('nr5g_disable_mode",0') then disable_restored = true end
  if c:find('save_ctrl",0,0') then savectrl_restored = true end
end
assert(mode_restored, "revert_now must restore mode_pref")
assert(disable_restored, "revert_now must restore nr5g_disable_mode")
assert(savectrl_restored, "revert_now must restore save_ctrl")
assert(not io.open(PENDING, "r"), "pending must be gone after revert")

-- 8. clear_cell_lock: GL unlock + stale marker removed.
reset()
local sf = io.open(STALE, "w"); sf:write("x"); sf:close()
r = M.clear_cell_lock({})
assert(r.ok, "clear_cell_lock failed")
assert(not io.open(STALE, "r"), "stale marker must be cleared")

-- 9. set_bands now ALSO refuses while a pending exists (shared interlock:
-- a band apply must not clobber a cell pending, or vice versa).
reset()
local f9 = io.open(PENDING, "w"); f9:write("KIND=cell\nSUB_ID=1\n"); f9:close()
r = M.set_bands({ sa = { 71 } })
assert(r.error and r.error:find("pending"), "set_bands must refuse while a pending exists")

-- 10. Fail CLOSED when the lock-state read can't be verified: at_expect
-- exhausts its 3 retries on a crossed/non-matching reply, parse_qnwlock5
-- degrades to nil, and set_cell_lock must refuse rather than treat "unknown"
-- the same as "unlocked" (Finding 1). No GL write, no pending file left.
reset()
lock5_reply = '\r\n+QNWPREFCFG: "nr5g_band",71\r\n\r\nOK\r\n'   -- matches no QNWLOCK marker -> crossed
r = M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 })
assert(r.error and r.error:find("could not read"), "must refuse when lock state can't be read; got " .. tostring(r.error))
for _, c in ipairs(glc_calls) do assert(not c:find("set_cell_tower"), "must not call set_cell_tower when lock state is unknown") end
assert(not io.open(PENDING, "r"), "no pending file must remain after a failed-read refusal")

print("backend-lock-write.test.lua: all ok")
