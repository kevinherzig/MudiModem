-- Isolation test for get_lock. Shims oui.ubus (canned AT replies incl. a
-- crossed-reply round) and ngx.location.capture (canned glc bodies). No box.
-- Env (set by runner): MM_PLUGIN, MUDIMODEM_PENDING, MUDIMODEM_ARMED, MUDIMODEM_STALE

local at_log, at_replies = {}, {}
package.loaded["oui.ubus"] = {
  call = function(object, method, params)
    if object == "modem.CPU.AT" and method == "get_result_AT" then
      at_log[#at_log + 1] = params.cmd
      local q = table.remove(at_replies, 1)
      if q ~= nil then return { data = q } end            -- scripted (crossed) reply
      local cmd = params.cmd
      if cmd == "AT+QSPN" then
        return { data = '\r\n+QSPN: "T-Mobile","T-Mobile","",0,"310260"\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWLOCK="common/4g"' then
        return { data = '\r\n+QNWLOCK: "common/4g",0\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWLOCK="common/5g"' then
        return { data = '\r\n+QNWLOCK: "common/5g",516,127490,15,71\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWLOCK="save_ctrl"' then
        return { data = '\r\n+QNWLOCK: "save_ctrl",0,0\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QENG="servingcell"' then
        return { data = '\r\n+QENG: "servingcell","NOCONN","NR5G-SA","FDD",310,260,18B1AE035,516,870100,127490,71,2,-98,-12,13,0,-\r\n\r\nOK\r\n' }
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

-- glc stub: nginx subrequest to GL's C plugins. Body format: "<code> <json>".
local glc_calls = {}
local glc_body = '0 {"slot1":{"cellid":"18B1AE035","network_type":"NR5G","pci":516,"freq":127490,"scs":15,"band":71},"slot2":{}}'
ngx = {
  HTTP_POST = "POST",
  location = { capture = function(uri, opts)
    glc_calls[#glc_calls + 1] = { uri = uri, body = opts and opts.body }
    return { status = 200, body = glc_body }
  end },
}

local M = dofile(assert(os.getenv("MM_PLUGIN"), "set MM_PLUGIN"))
assert(type(M.get_lock) == "function", "get_lock missing")

-- 1. Locked-5g picture: modem truth + GL store + serving cell all parsed.
local r = M.get_lock({})
assert(r.lock.l4g.locked == false, "4g should be unlocked")
assert(r.lock.l5g.locked == true, "5g should be locked")
assert(r.lock.l5g.pci == 516 and r.lock.l5g.freq == 127490, "5g pci/freq wrong")
assert(r.lock.l5g.scs == 15 and r.lock.l5g.band == 71, "5g scs/band wrong")
assert(r.lock.save_ctrl.raw == "0,0", "save_ctrl raw wrong")
assert(r.gl.locked == true, "GL store should show locked")
assert(r.gl.tower.pci == 516, "GL tower passthrough wrong")
assert(r.serving.rat == "NR5G-SA", "serving rat wrong")
assert(r.serving.pci == 516 and r.serving.arfcn == 127490 and r.serving.band == 71,
       "serving pci/arfcn/band wrong")
assert(r.stale == false, "agreeing stores must not be stale")
assert(r.meta.sub_id == 1, "sub_id must be PLMN-matched")
-- glc was called with the right object/method
assert(glc_calls[1].body:find('"get_cell_tower"'), "must call modem.get_cell_tower")

-- 2. Crossed-reply guard: first reply is the WRONG payload; must retry.
at_replies = { '\r\n+QNWPREFCFG: "nr5g_band",71\r\n\r\nOK\r\n' }   -- crossed junk
r = M.get_lock({})
assert(r.lock.l4g and r.lock.l4g.locked == false, "guard must retry past crossed reply")

-- 3. Stale detection: GL locked, modem unlocked -> stale=true.
glc_body = '0 {"slot1":{"cellid":"X","network_type":"NR5G","pci":9,"freq":1,"scs":15,"band":71},"slot2":{}}'
package.loaded["oui.ubus"].call = (function(orig)
  return function(o, m, p)
    if o == "modem.CPU.AT" and p and p.cmd == 'AT+QNWLOCK="common/5g"' then
      return { data = '\r\n+QNWLOCK: "common/5g",0\r\n\r\nOK\r\n' }
    end
    return orig(o, m, p)
  end
end)(package.loaded["oui.ubus"].call)
r = M.get_lock({})
assert(r.lock.l5g.locked == false and r.gl.locked == true, "setup wrong")
assert(r.stale == true, "GL-locked + modem-unlocked must be stale")

print("backend-lock.test.lua: all ok")
