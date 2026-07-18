# Cell-lock Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cell-lock tab that pins the modem to a specific cell via GL's own `set_cell_tower` stack, wrapped in MudiModem's confirm-or-revert watchdog.

**Architecture:** The Lua backend gains read (`get_lock`), scan (`scan_cells`), and write (`set_cell_lock`/`clear_cell_lock`) methods. Writes go through GL's closed `modem.so` via the same nginx-internal `/cgi-bin/glc` subrequest oui itself uses — so GL's store and the modem always agree. The watchdog reverts from plain shell (raw AT unlock) if the user doesn't confirm; GL-store reconciliation happens through the backend afterwards. The Vue chunk replaces the "Cell lock — Phase 2" placeholder with three cards: Current cell (pin), Nearby cells (scan), Recovery.

**Tech Stack:** Lua (oui rpc plugin, no pcall around cosockets), BusyBox sh (watchdog), hand-written Vue 2 runtime-only chunk (`render(h)`, no templates), Node built-in test runner for chunk tests, plain `lua` for backend isolation tests.

**Spec:** `docs/superpowers/specs/2026-07-18-cell-lock-tab-design.md` — read it first. Recon evidence: `reference/quectel-at-reference.md` §6a.

## Global Constraints

- Branch: `cell-lock`. Commit after each task (Kevin has sanctioned commits for this plan's execution).
- **⚠️ NO `AT+QNWLOCK` set forms, no `set_cell_tower`, no `scan_cell_tower` may ever FIRE against the live box before Task 7 (the supervised milestone, Kevin present).** Deploying files is fine — nothing fires by itself. All earlier tasks are proven by isolation tests only.
- **Never wrap `oui.ubus.call` (or anything using an nginx cosocket, incl. `ngx.location.capture`) in `pcall`** — cosockets yield; yielding across a C-call boundary throws on this box (CLAUDE.md §8). `pcall(cjson.decode, …)` is fine (can't yield).
- Never send `sub_id=0` (CLAUDE.md §6). Always `resolve_active()`.
- Deploy transfer is `ssh root@mudi 'cat > path' < file` (no scp). `tools/deploy.sh` is model-guarded — always use it. After backend changes: `ssh root@mudi /etc/init.d/nginx restart` (restart, not reload, when a fix must take now).
- The chunk must remain a single expression (`module.exports = {…};`), Vue 2.6.12 runtime-only: `render(h)` only, never `template:`.
- Don't reboot the Mudi. Don't commit unless the step says so. Keep the real router IP out of the repo.
- The `192.168.8.1` trap: that's a different router. Only `ssh root@mudi`.
- One pending change at a time — cell lock and bands share `pending.json` and the watchdog.
- One cell lock at a time — `set_cell_lock` refuses when any lock (4g or 5g) is already set; the user unlocks first. This keeps the pending file shell-safe (no JSON) and the revert target always "unlocked".

## Interfaces established by this plan (all tasks; exact names)

Backend methods (callable as `window.$rpcRequest("call", ["sid","mudimodem","<m>", args])`):

| Method | Args | Returns |
|---|---|---|
| `get_lock` | `{}` | `{ lock={l4g,l5g,save_ctrl}, gl={locked,tower}, serving, stale, pending_kind, operator_config, meta={sub_id,slot,plmn,plmn_matched} }` |
| `scan_cells` | `{}` | `{ towers=[…GL's objects verbatim…], ts }` or `{ error }` |
| `set_cell_lock` | `{ rat="4g"\|"5g", pci, freq, scs?, band?, extra? }` | `{ ok, window=60, applied, sub_id }` or `{ error }` |
| `clear_cell_lock` | `{}` | `{ ok }` or `{ error }` |
| `confirm` | `{}` | unchanged shape; now handles `KIND=cell` pending |
| `revert_now` | `{}` | unchanged shape; now handles `KIND=cell` pending |

Sub-shapes: `lock.l4g = {locked, mode?, freq?, pci?}` · `lock.l5g = {locked, pci?, freq?, scs?, band?}` · `lock.save_ctrl = {raw="0,0", s4g=0|1, s5g=0|1}` · `serving = {rat, pci, arfcn, band, cell_id}` (nil fields when unparseable).

Pending file, `KIND=cell` layout (shell-sourceable, one `KEY=value` per line, no quotes/spaces in values):

```
KIND=cell
SUB_ID=1
SLOT=1
RAT=5g
PREV_SAVE_CTRL=0,0
PREV_mode_pref=NR5G
PREV_nr5g_disable_mode=0
```

New watchdog path: `STALE` marker `/etc/mudimodem/gl-stale` (env override `MUDIMODEM_STALE`).

---

### Task 1: Backend read path — `glc()` helper, QNWLOCK/QENG parsers, `get_lock`

**Files:**
- Modify: `src/rpc/mudimodem` (helpers after `resolve_active`, ~line 152; `M.get_lock` after `M.get_bands`)
- Create: `test/backend-lock.test.lua`

**Interfaces:**
- Consumes: existing `at()`, `resolve_active()`, `file_exists()`, `pending_get()` (note: `pending_get` is currently defined *below* `get_bands` — move it up next to `file_exists` so `get_lock` can use it).
- Produces: `glc(object, method, args) -> (table|nil, err)`, `at_expect(cmd, expect, sub_id)`, `parse_qnwlock4(blob)`, `parse_qnwlock5(blob)`, `parse_savectrl(blob)`, `parse_serving(blob)`, `STALE` path constant, `M.get_lock(args)`.

- [ ] **Step 1: Write the failing test**

Create `test/backend-lock.test.lua` (mirror the harness style of `test/backend-write.test.lua`: shim `oui.ubus`, add a `ngx` stub for glc, `dofile` the plugin via `MM_PLUGIN`):

```lua
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/kevin/MudiModem/.worktrees/cell-lock
W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a \
  MUDIMODEM_STALE=$W/s lua test/backend-lock.test.lua
```
Expected: FAIL with `get_lock missing`.

- [ ] **Step 3: Implement in `src/rpc/mudimodem`**

3a. Add next to the other path constants (after line 20):

```lua
local STALE      = os.getenv("MUDIMODEM_STALE")   or "/etc/mudimodem/gl-stale"
```

3b. Move the existing `pending_get` function (currently at line ~332) up to sit directly after `file_exists` (line ~98), unchanged.

3c. Add after `resolve_active` (~line 152):

```lua
-- Call one of GL's C rpc plugins (modem.so) exactly as oui.rpc's glc_call does
-- (reference/oui-lib-rpc.lua:126): nginx-internal POST to /cgi-bin/glc, response
-- body is "<code> <json>". Returns (table|nil, err). NOT pcall-wrapped: capture
-- is a cosocket-style nginx API and must be allowed to yield.
local function glc(object, method, args)
  local res = ngx.location.capture("/cgi-bin/glc", {
    method = ngx.HTTP_POST,
    body = cjson.encode({ object = object, method = method, args = args or {} }),
  })
  if not res or res.status ~= 200 then
    return nil, "glc http " .. tostring(res and res.status)
  end
  local code = tonumber(res.body:match("(-?%d+)"))
  if code ~= 0 then return nil, code end                 -- GL error code (e.g. 20002044)
  local msg = res.body:match("%d+ (.*)") or ""
  local ok, obj = pcall(cjson.decode, msg)               -- decode can't yield; pcall fine
  if not ok or type(obj) ~= "table" then return nil, "glc bad json" end
  return obj
end

-- AT read with the crossed-reply guard (reference §10): the shared channel can
-- answer with a DIFFERENT command's payload. Retry until the reply carries the
-- expected marker; nil after 3 tries (callers treat nil as "unknown").
local function at_expect(cmd, expect, sub_id)
  for _ = 1, 3 do
    local blob = at(cmd, sub_id)
    if blob and blob:find(expect, 1, true) then return blob end
  end
  return nil
end

-- Numbers after a QNWLOCK tag:  '+QNWLOCK: "common/5g",516,127490,15,71'
local function qnwlock_nums(blob, tag)
  if not blob then return nil end
  local tail = blob:match('%+QNWLOCK: "' .. tag .. '",([%d,%s]*)')
  if not tail then return nil end
  local out = {}
  for n in tail:gmatch("(%d+)") do out[#out + 1] = tonumber(n) end
  return out
end

-- "common/4g": ,0 = unlocked; locked reply is ,<mode>,<freq>,<pci>
-- (field order per GL's own parser in /lib/functions/modem.sh:940-942).
local function parse_qnwlock4(blob)
  local n = qnwlock_nums(blob, "common/4g")
  if not n then return nil end
  if #n <= 1 then return { locked = (n[1] or 0) ~= 0 } end
  return { locked = true, mode = n[1], freq = n[2], pci = n[3] }
end

-- "common/5g": ,0 = unlocked; locked reply is ,<pci>,<freq>,<scs>,<band>
-- (PCI FIRST — reference §6a; parser order per modem.sh:926-929).
local function parse_qnwlock5(blob)
  local n = qnwlock_nums(blob, "common/5g")
  if not n then return nil end
  if #n <= 1 then return { locked = (n[1] or 0) ~= 0 } end
  return { locked = true, pci = n[1], freq = n[2], scs = n[3], band = n[4] }
end

local function parse_savectrl(blob)
  local n = qnwlock_nums(blob, "save_ctrl")
  if not n or #n < 2 then return nil end
  return { raw = n[1] .. "," .. n[2], s4g = n[1], s5g = n[2] }
end

-- Serving cell from QENG. SA field order verified on-box (reference §8):
-- "servingcell",<state>,"NR5G-SA",<duplex>,<mcc>,<mnc>,<cell_id>,<pci>,<tac>,<arfcn>,<band>,…
-- LTE order is from the 5-series manual (📘 — re-verify at the Task 7 milestone):
-- "servingcell",<state>,"LTE",<is_tdd>,<mcc>,<mnc>,<cell_id>,<pci>,<earfcn>,<band>,…
local function parse_serving(blob)
  if not blob then return nil end
  local line = blob:match('%+QENG: "servingcell"[^\r\n]*')
  if not line then return nil end
  local f = {}
  for tok in line:gmatch('[^,]+') do f[#f + 1] = (tok:gsub('^%s*"?', ''):gsub('"?%s*$', '')) end
  -- f[1]='+QENG: servingcell', f[2]=state, f[3]=rat
  local rat = f[3]
  if rat == "NR5G-SA" then
    return { rat = rat, cell_id = f[7], pci = tonumber(f[8]),
             arfcn = tonumber(f[10]), band = tonumber(f[11]) }
  elseif rat == "LTE" then
    return { rat = rat, cell_id = f[7], pci = tonumber(f[8]),
             arfcn = tonumber(f[9]), band = tonumber(f[10]) }
  end
  return { rat = rat }
end
```

3d. Add `M.get_lock` after `M.get_bands` (~line 223):

```lua
-- READ: cell-lock picture — modem truth (QNWLOCK), GL's store (get_cell_tower),
-- the serving cell (lock target for pin-current), and stale/pending flags.
function M.get_lock(args)
  local sub_id, plmn, matched, slot = resolve_active()
  local l4 = parse_qnwlock4(at_expect('AT+QNWLOCK="common/4g"', '"common/4g"', sub_id))
  local l5 = parse_qnwlock5(at_expect('AT+QNWLOCK="common/5g"', '"common/5g"', sub_id))
  local sc = parse_savectrl(at_expect('AT+QNWLOCK="save_ctrl"', '"save_ctrl"', sub_id))
  local serving = parse_serving(at_expect('AT+QENG="servingcell"', '"servingcell"', sub_id))

  local gl = glc("modem", "get_cell_tower", { bus = "cpu" })
  local tower = gl and gl["slot" .. tostring(slot)] or nil
  local gl_locked = (tower and tower.cellid and tower.cellid ~= "") and true or false
  local modem_locked = (l4 and l4.locked) or (l5 and l5.locked) or false

  -- Shape unknown until Task 7 captures it; returned raw for the UI to inspect.
  local opcfg = glc("modem", "get_operator_config", { bus = "cpu" })

  return {
    lock = { l4g = l4, l5g = l5, save_ctrl = sc },
    gl = { locked = gl_locked, tower = tower },
    serving = serving,
    stale = file_exists(STALE) or (gl_locked and not modem_locked),
    pending_kind = pending_get("KIND") or (file_exists(PENDING) and "bands" or nil),
    operator_config = opcfg,
    meta = { sub_id = sub_id, slot = slot, plmn = plmn, plmn_matched = matched },
  }
end
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a \
  MUDIMODEM_STALE=$W/s lua test/backend-lock.test.lua
```
Expected: `backend-lock.test.lua: all ok`.

Also re-run the existing backend tests to prove no regression (they have no `ngx` global — the plugin must still *load* without one, which it does because `glc` only touches `ngx` at call time):

```bash
W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a lua test/backend.test.lua
W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a lua test/backend-write.test.lua
```
Expected: both pass as before.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/mudimodem test/backend-lock.test.lua
git commit -m "cell-lock: backend read path — glc helper, QNWLOCK/QENG parsers, get_lock"
```

---

### Task 2: Backend write path — `set_cell_lock`, `clear_cell_lock`, `scan_cells`, cell branches in `confirm`/`revert_now`

**Files:**
- Modify: `src/rpc/mudimodem`
- Create: `test/backend-lock-write.test.lua`

**Interfaces:**
- Consumes: Task 1's `glc`, `at_expect`, `parse_qnwlock4/5`, `parse_savectrl`, `STALE`; existing `PENDING`, `ARMED`, `REVERT_BIN`, `at()`, `resolve_active()`, `append_event()`, `pending_get()`, `file_exists()`.
- Produces: `M.set_cell_lock`, `M.clear_cell_lock`, `M.scan_cells`; `confirm`/`revert_now` handle `KIND=cell`. Pending layout per the header table.

- [ ] **Step 1: Write the failing test**

Create `test/backend-lock-write.test.lua`:

```lua
-- Isolation test for set_cell_lock / clear_cell_lock / confirm / revert_now
-- (cell kind). Shims oui.ubus, ngx (glc), os.execute (watchdog arm). No box.
local PENDING = assert(os.getenv("MUDIMODEM_PENDING"))
local ARMED   = assert(os.getenv("MUDIMODEM_ARMED"))
local STALE   = assert(os.getenv("MUDIMODEM_STALE"))

local at_log = {}
local lock5_reply = '\r\n+QNWLOCK: "common/5g",0\r\n\r\nOK\r\n'
package.loaded["oui.ubus"] = {
  call = function(object, method, params)
    if object == "modem.CPU.AT" and method == "get_result_AT" then
      local cmd = params.cmd
      at_log[#at_log + 1] = cmd .. " @" .. tostring(params.sub_id)
      if cmd == "AT+QSPN" then
        return { data = '\r\n+QSPN: "T-Mobile","T-Mobile","",0,"310260"\r\n\r\nOK\r\n' }
      elseif cmd == 'AT+QNWLOCK="common/4g"' then
        return { data = '\r\n+QNWLOCK: "common/4g",0\r\n\r\nOK\r\n' }
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
  at_log = {}; glc_calls = {}; exec_cmds = {}
  os.remove(PENDING); os.remove(ARMED); os.remove(STALE)
  glc_fail = false
  lock5_reply = '\r\n+QNWLOCK: "common/5g",0\r\n\r\nOK\r\n'
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
reset()
assert(M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 }).ok)
glc_calls = {}
r = M.confirm({})
assert(r.ok and r.confirmed, "confirm failed")
assert(not io.open(PENDING, "r"), "pending must be gone after confirm")
for _, c in ipairs(glc_calls) do assert(not c:find("set_feature_config"), "cell confirm must not touch band config") end

-- 7. revert_now on a cell pending: GL unlock + mode restore + pending gone.
reset()
assert(M.set_cell_lock({ rat = "5g", pci = 516, freq = 127490, scs = 15, band = 71 }).ok)
at_log = {}; glc_calls = {}
r = M.revert_now({})
assert(r.ok and r.reverted, "revert_now failed")
local unlocked
for _, c in ipairs(glc_calls) do if c:find('"lock":false') then unlocked = true end end
assert(unlocked, "revert_now must GL-unlock")
local mode_restored
for _, c in ipairs(at_log) do if c:find('mode_pref",NR5G') then mode_restored = true end end
assert(mode_restored, "revert_now must restore mode_pref")
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

print("backend-lock-write.test.lua: all ok")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a \
  MUDIMODEM_STALE=$W/s lua test/backend-lock-write.test.lua
```
Expected: FAIL with `set_cell_lock missing`.

- [ ] **Step 3: Implement in `src/rpc/mudimodem`**

3a. Add after `M.get_lock`:

```lua
-- SCAN: GL's full network scan (AT+QSCAN under the hood). DISRUPTIVE — the
-- modem leaves the serving cell for up to ~10 minutes. The UI gates this
-- behind an explicit warning; never call it as part of a read.
function M.scan_cells(args)
  local _, _, _, slot = resolve_active()
  local res, err = glc("modem", "scan_cell_tower", { bus = "cpu", slot = tonumber(slot) or 1 })
  if not res then return { error = "scan failed: " .. tostring(err) } end
  append_event("user", "Cell scan", "")
  return { towers = arr(res.towers or {}), ts = os.time() * 1000 }
end

-- WRITE: lock to one cell via GL's stack, protected by confirm-or-revert.
-- args = { rat="4g"|"5g", pci, freq, scs?, band?, extra? } — extra is an
-- optional table of passthrough tower fields (cellid, carrier, mcc, mnc, …)
-- from a scan row, forwarded verbatim so GL stores what it scanned.
function M.set_cell_lock(args)
  local rat = args and args.rat
  if rat ~= "4g" and rat ~= "5g" then return { error = "rat must be '4g' or '5g'" } end
  local function int(v)
    local n = tonumber(v)
    if n and n >= 0 and n == math.floor(n) then return n end
  end
  local pci, freq = int(args.pci), int(args.freq)
  if not pci or not freq then return { error = "pci and freq are required integers" } end
  local scs, band = int(args.scs), int(args.band)
  if rat == "5g" and (not scs or not band) then
    return { error = "a 5g lock needs scs and band" }
  end
  if file_exists(PENDING) then
    return { error = "another change is pending; keep or revert it first" }
  end

  local sub_id, _, _, slot = resolve_active()

  -- One lock at a time (keeps the revert target = "unlocked", always).
  local l4 = parse_qnwlock4(at_expect('AT+QNWLOCK="common/4g"', '"common/4g"', sub_id))
  local l5 = parse_qnwlock5(at_expect('AT+QNWLOCK="common/5g"', '"common/5g"', sub_id))
  if (l4 and l4.locked) or (l5 and l5.locked) then
    return { error = "a cell lock is already set; unlock first" }
  end

  -- Snapshot the revert target: current save_ctrl + mode prefs (GL's lock
  -- changes mode_pref / nr5g_disable_mode as a side effect — spec §0).
  local sc = parse_savectrl(at_expect('AT+QNWLOCK="save_ctrl"', '"save_ctrl"', sub_id))
  local mblob = at('AT+QNWPREFCFG="mode_pref"', sub_id)
  local pmode = (mblob and mblob:match('"mode_pref",([%w:]+)')) or ""
  local dblob = at('AT+QNWPREFCFG="nr5g_disable_mode"', sub_id)
  local pdis = (dblob and dblob:match('"nr5g_disable_mode",(%d+)')) or ""

  os.execute("mkdir -p /etc/mudimodem 2>/dev/null")
  local f = io.open(PENDING, "w")
  if not f then return { error = "cannot write pending state" } end
  f:write(table.concat({
    "KIND=cell", "SUB_ID=" .. sub_id, "SLOT=" .. tostring(slot), "RAT=" .. rat,
    "PREV_SAVE_CTRL=" .. ((sc and sc.raw) or ""),
    "PREV_mode_pref=" .. pmode,
    "PREV_nr5g_disable_mode=" .. pdis,
  }, "\n") .. "\n")
  f:close()

  -- Arm the watchdog; no arm, no write (same interlock as set_bands).
  os.remove(ARMED)
  os.execute(REVERT_BIN .. " watch >/dev/null 2>&1 &")
  os.execute("sleep 1")
  if not file_exists(ARMED) then
    os.remove(PENDING)
    return { error = "revert watchdog failed to arm; no change written" }
  end

  -- Write through GL so its store and the modem agree (spec §3).
  local payload = { bus = "cpu", slot = tonumber(slot) or 1, lock = true,
                    network_type = (rat == "5g") and "NR5G" or "LTE",
                    pci = pci, freq = freq }
  if rat == "5g" then payload.scs = scs; payload.band = band
  elseif band then payload.band = band end
  if type(args.extra) == "table" then
    for k, v in pairs(args.extra) do
      if payload[k] == nil then payload[k] = v end
    end
  end
  local res, err = glc("modem", "set_cell_tower", payload)
  if not res then
    os.remove(PENDING)          -- nothing was written; stand the watchdog down
    return { error = "GL lock call failed: " .. tostring(err) }
  end

  append_event("user", "Cell lock applied",
    rat .. " pci " .. pci .. " freq " .. freq .. (band and (" band " .. band) or ""))
  return { ok = true, window = 60, sub_id = sub_id,
           applied = { rat = rat, pci = pci, freq = freq, scs = scs, band = band } }
end

-- Unlock (risk-reducing — no revert window). Also the stale-store reconciler.
function M.clear_cell_lock(args)
  local _, _, _, slot = resolve_active()
  local gl = glc("modem", "get_cell_tower", { bus = "cpu" })
  local tower = (gl and gl["slot" .. tostring(slot)]) or {}
  local payload = { bus = "cpu", slot = tonumber(slot) or 1, lock = false }
  for k, v in pairs(tower) do if payload[k] == nil then payload[k] = v end end
  local res, err = glc("modem", "set_cell_tower", payload)
  if not res then return { error = "GL unlock failed: " .. tostring(err) } end
  os.remove(STALE)
  append_event("user", "Cell lock cleared", "")
  return { ok = true }
end
```

3b′. In `M.set_bands`, add the shared interlock right after the `#changes == 0` check (line ~253):

```lua
  if file_exists(PENDING) then
    return { error = "another change is pending; keep or revert it first" }
  end
```

3b. In `M.confirm`, insert at the very top (before the `slot` read):

```lua
  if pending_get("KIND") == "cell" then
    -- GL wrote its own store when the lock was applied; keeping it needs no
    -- Path-B commit — just stand the watchdog down.
    os.remove(PENDING)
    append_event("user", "Kept", "Cell lock confirmed")
    return { ok = true, confirmed = true, durable = true }
  end
```

3c. In `M.revert_now`, insert after the `file_exists(PENDING)` check:

```lua
  if pending_get("KIND") == "cell" then
    local slot = tonumber(pending_get("SLOT")) or 1
    local sub  = tonumber(pending_get("SUB_ID")) or 1
    local gl = glc("modem", "get_cell_tower", { bus = "cpu" })
    local tower = (gl and gl["slot" .. slot]) or {}
    local payload = { bus = "cpu", slot = slot, lock = false }
    for k, v in pairs(tower) do if payload[k] == nil then payload[k] = v end end
    glc("modem", "set_cell_tower", payload)          -- clean GL-level unlock
    local pm = pending_get("PREV_mode_pref")
    if pm and pm ~= "" then at('AT+QNWPREFCFG="mode_pref",' .. pm, sub) end
    local pd = pending_get("PREV_nr5g_disable_mode")
    if pd and pd ~= "" then at('AT+QNWPREFCFG="nr5g_disable_mode",' .. pd, sub) end
    local psc = pending_get("PREV_SAVE_CTRL")
    if psc and psc ~= "" then at('AT+QNWLOCK="save_ctrl",' .. psc, sub) end
    os.remove(PENDING)
    os.remove(ARMED)
    append_event("user", "Reverted", "Cell lock removed")
    return { ok = true, reverted = true }
  end
```

- [ ] **Step 4: Run all backend tests to verify they pass**

```bash
for t in backend backend-write backend-lock backend-lock-write; do
  W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a \
    MUDIMODEM_STALE=$W/s lua test/$t.test.lua || exit 1
done
```
Expected: four `all ok` lines (existing suites unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/rpc/mudimodem test/backend-lock-write.test.lua
git commit -m "cell-lock: backend writes — set_cell_lock/clear_cell_lock/scan_cells + cell confirm/revert"
```

---

### Task 3: Watchdog — `KIND=cell` revert, stale marker, panic hardening

**Files:**
- Modify: `src/sbin/mudimodem-revert`
- Modify: `test/revert.test.sh`

**Interfaces:**
- Consumes: pending layout from Task 2 (`KIND`, `RAT`, `SUB_ID`, `PREV_SAVE_CTRL`, `PREV_mode_pref`, `PREV_nr5g_disable_mode`).
- Produces: on cell revert the watchdog raw-AT-unlocks and touches `$STALE`; `panic` additionally writes `save_ctrl,0,0` and `mode_pref,AUTO`.

- [ ] **Step 1: Extend `test/revert.test.sh` — add after test 5 (and add `MUDIMODEM_STALE="$WORK/stale"` to the `env` line in `run()`):**

```sh
echo "6. watch (KIND=cell): reverts by raw-AT unlock + restores prefs + marks stale"
rm -f "$WORK/log" "$WORK/stale"
printf 'KIND=cell\nSUB_ID=1\nSLOT=1\nRAT=5g\nPREV_SAVE_CTRL=0,0\nPREV_mode_pref=NR5G\nPREV_nr5g_disable_mode=0\n' > "$WORK/pending"
WIN=1 run watch
inlog 'QNWLOCK=\\"common/5g\\",0'      && pass "unlocked 5g" || fail "no 5g unlock"
inlog 'QNWLOCK=\\"save_ctrl\\",0,0'    && pass "restored save_ctrl" || fail "no save_ctrl restore"
inlog 'mode_pref\\",NR5G'              && pass "restored mode_pref" || fail "no mode_pref restore"
inlog 'nr5g_disable_mode\\",0'         && pass "restored nr5g_disable_mode" || fail "no disable_mode restore"
[ -f "$WORK/stale" ]                   && pass "stale marker dropped" || fail "no stale marker"
[ ! -f "$WORK/pending" ]               && pass "pending cleared" || fail "pending not cleared"

echo "7. watch (KIND=cell, 4g): unlocks the right RAT"
rm -f "$WORK/log" "$WORK/stale"
printf 'KIND=cell\nSUB_ID=1\nSLOT=1\nRAT=4g\nPREV_SAVE_CTRL=0,0\nPREV_mode_pref=AUTO\nPREV_nr5g_disable_mode=\n' > "$WORK/pending"
WIN=1 run watch
inlog 'QNWLOCK=\\"common/4g\\",0'      && pass "unlocked 4g" || fail "no 4g unlock"
inlog 'QNWLOCK=\\"common/5g\\",0'      && fail "touched 5g needlessly" || pass "left 5g alone"

echo "8. panic: also resets save_ctrl and mode_pref"
rm -f "$WORK/log"
run panic 1
inlog 'QNWLOCK=\\"save_ctrl\\",0,0'    && pass "save_ctrl reset" || fail "no save_ctrl reset"
inlog 'mode_pref\\",AUTO'              && pass "mode_pref AUTO" || fail "no mode_pref reset"
```

- [ ] **Step 2: Run to verify the new cases fail**

```bash
sh test/revert.test.sh src/sbin/mudimodem-revert
```
Expected: tests 1–5 pass, 6–8 FAIL.

- [ ] **Step 3: Implement in `src/sbin/mudimodem-revert`**

3a. Add `STALE="${MUDIMODEM_STALE:-/etc/mudimodem/gl-stale}"` next to the other path vars (after line 32).

3b. Replace the body of `restore_from_pending()` with a KIND dispatch (keep the existing band logic as the default branch):

```sh
restore_from_pending() {
  if [ ! -f "$PENDING" ]; then log "no pending file; nothing to restore"; return 0; fi
  KIND=""; SUB_ID=1; RAT=""; PREV_SAVE_CTRL=""; PREV_mode_pref=""; PREV_nr5g_disable_mode=""
  PREV_nr5g_band=""; PREV_nsa_nr5g_band=""; PREV_lte_band=""
  # shellcheck disable=SC1090
  . "$PENDING"
  if [ "$KIND" = "cell" ]; then
    # Cell lock: raw-AT unlock saves the LINK now; GL's store is reconciled by
    # the backend once the page can reach it again (the stale marker drives that).
    log "cell revert: unlock common/${RAT:-5g} (sub_id ${SUB_ID:-1})"
    at "AT+QNWLOCK=\"common/${RAT:-5g}\",0" "${SUB_ID:-1}"
    [ -n "$PREV_SAVE_CTRL" ]        && at "AT+QNWLOCK=\"save_ctrl\",$PREV_SAVE_CTRL" "${SUB_ID:-1}"
    [ -n "$PREV_mode_pref" ]        && at "AT+QNWPREFCFG=\"mode_pref\",$PREV_mode_pref" "${SUB_ID:-1}"
    [ -n "$PREV_nr5g_disable_mode" ] && at "AT+QNWPREFCFG=\"nr5g_disable_mode\",$PREV_nr5g_disable_mode" "${SUB_ID:-1}"
    : > "$STALE" 2>/dev/null
  else
    [ -n "${PREV_nr5g_band:-}" ]     && set_band "nr5g_band"     "$PREV_nr5g_band"     "${SUB_ID:-1}"
    [ -n "${PREV_nsa_nr5g_band:-}" ] && set_band "nsa_nr5g_band" "$PREV_nsa_nr5g_band" "${SUB_ID:-1}"
    [ -n "${PREV_lte_band:-}" ]      && set_band "lte_band"      "$PREV_lte_band"      "${SUB_ID:-1}"
    [ -n "${PREV_mode_pref:-}" ]     && { log "restore mode_pref -> $PREV_mode_pref"; at "AT+QNWPREFCFG=\"mode_pref\",$PREV_mode_pref" "${SUB_ID:-1}"; }
  fi
  rm -f "$PENDING"
  log "revert complete; pending cleared"
}
```

3c. In the `panic` case, after the two existing `QNWLOCK` clears, add:

```sh
    at 'AT+QNWLOCK="save_ctrl",0,0' "$SUB"
    at 'AT+QNWPREFCFG="mode_pref",AUTO' "$SUB"
```

Also update the header comment's mode list (`panic` now: known-good bands + cell unlock + save_ctrl reset + mode AUTO), and drop the now-stale "Set-side QNWLOCK is unverified" comment at line 111 (it's verified — reference §6a).

- [ ] **Step 4: Run to verify all pass**

```bash
sh test/revert.test.sh src/sbin/mudimodem-revert
```
Expected: all 8 sections pass, `FAILED=0`.

- [ ] **Step 5: Commit**

```bash
git add src/sbin/mudimodem-revert test/revert.test.sh
git commit -m "cell-lock: watchdog cell revert (raw-AT unlock + stale marker) + panic hardening"
```

---

### Task 4: Chunk — pending-kind plumbing + Current-cell card (pin / unlock)

**Files:**
- Modify: `src/views/mudimodem.js`
- Modify: `test/chunk.test.js`

**Interfaces:**
- Consumes: `get_lock` / `set_cell_lock` / `clear_cell_lock` / `confirm` / `revert_now` (shapes in the header table); existing `pending`, `startCountdown`, `renderRevert`, `qColor`.
- Produces: `data`: `lockData`, `lockLoading`, `lockError`, `lockBusy`, `lockConfirm`; `pending.kind` (`"bands"`|`"cell"`); methods `fetchLock()`, `pinTarget()`, `scsFor(band)`, `lockCell(target)`, `unlockCell()`, `renderLock(h)`, `renderCurrentCell(h)`. `SCS_DEFAULT` table.

- [ ] **Step 1: Write failing tests — append to `test/chunk.test.js`:**

```js
// ---- Cell-lock tab ----

const LOCKDATA_UNLOCKED = {
  lock: { l4g: { locked: false }, l5g: { locked: false }, save_ctrl: { raw: '0,0', s4g: 0, s5g: 0 } },
  gl: { locked: false, tower: null },
  serving: { rat: 'NR5G-SA', pci: 516, arfcn: 127490, band: 71, cell_id: '18B1AE035' },
  stale: false, pending_kind: null,
  meta: { sub_id: 1, slot: '1', plmn: '310260', plmn_matched: true }
};

test('lock tab: unlocked state renders serving cell + Lock button', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const tree = component.render.call(vm, h);
  const text = textOf(tree);
  assert.match(text, /PCI/);
  assert.match(text, /516/);
  assert.match(text, /127490/);
  assert.match(text, /Lock to this cell/);
});

test('lock tab: locked state shows Locked badge + Unlock, no Lock button', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.lockData.lock.l5g = { locked: true, pci: 516, freq: 127490, scs: 15, band: 71 };
  vm.lockData.gl = { locked: true, tower: { cellid: 'X', pci: 516 } };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /Locked/);
  assert.match(text, /Unlock/);
  assert.doesNotMatch(text, /Lock to this cell/);
});

test('lock tab: pin target derives from serving cell with SCS default', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const t = vm.pinTarget();
  assert.equal(t.rat, '5g');
  assert.equal(t.pci, 516);
  assert.equal(t.freq, 127490);
  assert.equal(t.band, 71);
  assert.equal(t.scs, 15);          // n71 default, 3GPP TS 38.104
  assert.equal(t.scsAssumed, true); // no scan result to confirm it
});

test('lock tab: cell pending banner renders on lock tab, not bands tab', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.pending = { kind: 'cell', remaining: 42, window: 60,
                 applied: { rat: '5g', pci: 516, freq: 127490 } };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /42s/);
  assert.match(text, /Revert now/);
});

test('bands tab: cell pending does NOT paint the bands banner', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'bands';
  vm.bands = null; vm.bandsLoading = true;   // bands view in loading state
  vm.pending = { kind: 'cell', remaining: 42, window: 60, applied: {} };
  const text = textOf(component.render.call(vm, h));
  assert.doesNotMatch(text, /42s/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/chunk.test.js
```
Expected: the five new tests FAIL (existing ones pass).

- [ ] **Step 3: Implement in `src/views/mudimodem.js`**

3a. `data()` — add:

```js
      lockData: null,       // get_lock result, once fetched
      lockLoading: false,
      lockError: "",
      lockBusy: false,      // a lock/unlock RPC in flight
      lockConfirm: null,    // target awaiting inline confirm ({...target,label})
```

and inside the `freq` block's sibling position add the SCS defaults table:

```js
      // Default NR SS-block SCS per band (kHz), used ONLY when no scan result
      // covers the serving cell. Source: 3GPP TS 38.104 §5.4.3 band tables —
      // FDD low/mid bands are 15 kHz, the TDD mid bands 30 kHz. The confirm
      // text says when this assumption is in play. Encoding (kHz vs index)
      // verified at the supervised milestone before first use.
      SCS_DEFAULT: { 2: 15, 5: 15, 7: 15, 12: 15, 13: 15, 14: 15, 25: 15, 26: 15,
                     29: 15, 30: 15, 38: 30, 41: 30, 48: 30, 66: 15, 70: 15,
                     71: 15, 77: 30, 78: 30, 79: 30 },
```

3b. `watch.tab` — extend:

```js
    tab(t) {
      if (t === "bands" && !this.bands && !this.bandsLoading) this.fetchBands();
      if (t === "lock" && !this.lockData && !this.lockLoading) this.fetchLock();
    }
```

3c. Methods — add (near `fetchBands`):

```js
    fetchLock() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.lockError = "RPC helper unavailable"; return;
      }
      this.lockLoading = true; this.lockError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "get_lock", {}], { timeout: 20000 })
        .then(function (res) { self.lockData = res; })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "request failed"; })
        .then(function () { self.lockLoading = false; });
    },
    scsFor(band) { return this.SCS_DEFAULT[band]; },
    // Build the lock target for the serving cell. SCS: last scan result for
    // this pci+arfcn if we have one, else the band default (flagged assumed).
    pinTarget() {
      var s = this.lockData && this.lockData.serving;
      if (!s || !s.pci || !s.arfcn) return null;
      var isNR = /NR5G/.test(s.rat || "");
      var t = { rat: isNR ? "5g" : "4g", pci: s.pci, freq: s.arfcn,
                band: s.band, label: "current cell PCI " + s.pci };
      if (isNR) {
        var match = (this.scan.towers || []).filter(function (tw) {
          return String(tw.pci) === String(s.pci) && String(tw.freq) === String(s.arfcn);
        })[0];
        if (match && match.scs !== undefined) { t.scs = Number(match.scs); t.scsAssumed = false; }
        else { t.scs = this.scsFor(s.band); t.scsAssumed = true; }
        if (t.scs === undefined) return null;   // unknown band: refuse rather than guess
      }
      return t;
    },
    lockCell(target) {
      var self = this;
      if (this.lockBusy || this.pending || !target) return;
      this.lockBusy = true; this.lockError = "";
      var args = { rat: target.rat, pci: target.pci, freq: target.freq };
      if (target.scs !== undefined) args.scs = target.scs;
      if (target.band !== undefined) args.band = target.band;
      if (target.extra) args.extra = target.extra;
      window.$rpcRequest("call", ["sid", "mudimodem", "set_cell_lock", args], { timeout: 30000 })
        .then(function (res) {
          if (!res || res.error) { self.lockError = (res && res.error) || "lock failed"; return; }
          self.lockConfirm = null;
          self.startCountdown(res.window || 60, res.applied, "cell");
        })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "lock failed"; })
        .then(function () { self.lockBusy = false; });
    },
    unlockCell() {
      var self = this;
      if (this.lockBusy || this.pending) return;
      this.lockBusy = true; this.lockError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "clear_cell_lock", {}], { timeout: 30000 })
        .then(function (res) {
          if (res && res.error) { self.lockError = res.error; return; }
          self.fetchLock();
        })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "unlock failed"; })
        .then(function () { self.lockBusy = false; });
    },
```

(`this.scan` arrives in Task 5; until then add `scan: { towers: [], running: false, error: "", ts: 0 }` to `data()` **in this task** so `pinTarget` works.)

3d. Pending-kind plumbing — three edits:

```js
    // startCountdown gains a kind (default "bands" keeps the bands call sites).
    startCountdown(window_s, applied, kind) {
      var self = this;
      this.clearCountdown();
      this.pending = { kind: kind || "bands", remaining: window_s, window: window_s,
                       applied: applied, done: false };
      this.cdTimer = setInterval(function () {
        if (!self.pending) return;
        self.pending.remaining -= 1;
        if (self.pending.remaining <= 0) {
          var k = self.pending.kind;
          self.clearCountdown();
          self.pending = { kind: k, done: true, reverted: true };
          if (k === "cell") self.fetchLock(); else self.fetchBands();
          setTimeout(function () { self.pending = null; }, 4000);
        }
      }, 1000);
    },
```

In `keepBands` and `revertBands` (they already call the kind-agnostic backend), refetch by kind:

```js
        .then(function () {
          var k = self.pending && self.pending.kind;
          self.pending = null;
          if (k === "cell") self.fetchLock(); else self.fetchBands();
        });
```

(`revertBands` keeps its interim `this.pending = { done: true, reverting: true }` — set it to `{ kind: k, done: true, reverting: true }` where `var k = this.pending.kind;` is read first.)

In `renderRevert`, branch the summary on kind:

```js
      var a = p.applied || {}, bits = [];
      if (p.kind === "cell") {
        bits.push((a.rat === "4g" ? "LTE" : "5G") + " cell PCI " + a.pci + " / ARFCN " + a.freq);
      } else {
        if (a.mode) bits.push("mode " + a.mode);
        // …existing sa/nsa/lte lines unchanged…
      }
```

and its `done` copy: `p.reverted ? (p.kind === "cell" ? "Reverted - cell lock removed." : "Reverted - restored your previous bands.") : ""`.

In `renderBands`, the banner line becomes kind-gated:

```js
        (this.pending && this.pending.kind !== "cell") ? this.renderRevert(h) : null
```

3e. `renderCurrentCell(h)` + `renderLock(h)` (new methods), and wire the panel: replace the `lock:` placeholder entry by adding `else if (this.tab === "lock") { panel = this.renderLock(h); }`.

```js
    renderCurrentCell(h) {
      var self = this, d = this.lockData;
      var s = d.serving || {};
      var l5 = (d.lock && d.lock.l5g) || {}, l4 = (d.lock && d.lock.l4g) || {};
      var locked = !!(l5.locked || l4.locked || (d.gl && d.gl.locked));
      var rows = [];
      var push = function (k, v) { if (v !== undefined && v !== null && v !== "") rows.push([k, v]); };
      push("RAT", s.rat); push("PCI", s.pci); push("ARFCN", s.arfcn);
      push("Band", s.band !== undefined ? ((/NR5G/.test(s.rat || "") ? "n" : "B") + s.band) : null);
      push("Cell ID", s.cell_id);
      push("RSRP", this.serving.rsrp !== undefined ? this.serving.rsrp + " dBm" : null);
      push("SINR", this.serving.sinr !== undefined ? this.serving.sinr + " dB" : null);

      var action;
      if (locked) {
        var lk = l5.locked ? l5 : l4;
        action = h("div", { staticClass: "mm-foot" }, [
          h("span", { staticClass: "mm-hint" }, [
            h("b", { staticStyle: { color: "var(--success)" } }, "Locked"),
            " to PCI " + lk.pci + " / ARFCN " + lk.freq +
            (lk.band ? " (n" + lk.band + ")" : "") + ". The modem will not hand over."
          ]),
          h("button", {
            staticClass: "mm-btn danger",
            attrs: { disabled: this.lockBusy || !!this.pending },
            on: { click: function () { self.unlockCell(); } }
          }, this.lockBusy ? "Unlocking..." : "Unlock")
        ]);
      } else {
        var target = this.pinTarget();
        if (this.lockConfirm && this.lockConfirm.pin) {
          action = h("div", { staticClass: "mm-foot" }, [
            h("span", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)" } },
              "Lock to PCI " + target.pci + "? Network mode switches to " +
              (target.rat === "5g" ? "5G-only" : "4G-preferred") + " until unlocked." +
              (target.scsAssumed ? " SCS " + target.scs + " kHz is assumed from the band." : "") +
              " Auto-reverts in 60s unless kept."),
            h("span", { staticStyle: { flex: "none", display: "flex", gap: "6px" } }, [
              h("button", { staticClass: "mm-btn", on: { click: function () { self.lockConfirm = null; } } }, "Cancel"),
              h("button", {
                staticClass: "mm-btn primary", attrs: { disabled: this.lockBusy },
                on: { click: function () { self.lockCell(target); } }
              }, this.lockBusy ? "Locking..." : "Lock it")
            ])
          ]);
        } else {
          action = h("div", { staticClass: "mm-foot" }, [
            h("span", { staticClass: "mm-hint" },
              "Pin the modem to the cell it is using now - the safest lock target."),
            h("button", {
              staticClass: "mm-btn primary",
              attrs: { disabled: !target || this.lockBusy || !!this.pending },
              on: { click: function () { self.lockConfirm = { pin: true }; } }
            }, "Lock to this cell")
          ]);
        }
      }
      return h("div", { staticClass: "mm-grp" }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, "Current cell"),
          h("span", { staticClass: "mm-hint" }, locked ? "locked" : "serving now")
        ]),
        h("div", { staticClass: "mm-dl" }, rows.map(function (r, i) {
          return h("div", { key: i }, [h("span", { staticClass: "k" }, r[0]), h("b", String(r[1]))]);
        })),
        action
      ]);
    },

    renderLock(h) {
      if (this.lockLoading && !this.lockData)
        return h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-empty" }, "Reading lock state from the modem...")]);
      if (this.lockError && !this.lockData)
        return h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-empty" }, "Couldn't read lock state: " + this.lockError)]);
      if (!this.lockData)
        return h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-empty" }, "...")]);
      var kids = [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Cell lock"),
          h("button", {
            staticClass: "mm-tab", staticStyle: { fontSize: "11.5px", padding: "2px 0", borderBottom: "0" },
            attrs: { disabled: !!this.pending },
            on: { click: this.fetchLock }
          }, this.lockLoading ? "refreshing..." : "refresh")
        ]),
        (this.pending && this.pending.kind === "cell") ? this.renderRevert(h) : null,
        this.lockError && this.lockData
          ? h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } }, this.lockError) : null,
        this.renderCurrentCell(h)
        // Task 5 appends: this.renderScanCard(h)
        // Task 6 appends: stale banner + this.renderRecovery(h)
      ];
      return h("div", { staticClass: "mm-card" }, kids.filter(Boolean));
    },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/chunk.test.js
```
Expected: all pass (old + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "cell-lock: chunk — pending kinds + Current-cell card (pin/unlock)"
```

---

### Task 5: Chunk — scan card (Nearby cells)

**Files:**
- Modify: `src/views/mudimodem.js`
- Modify: `test/chunk.test.js`

**Interfaces:**
- Consumes: `scan_cells` backend (`{towers, ts}` — tower fields per GL: `network_type, pci, freq, band, scs?, cellid, mcc, mnc, carrier?, rsrp?, rsrq?, strength, bandwidth?`), `lockCell(target)` from Task 4, `scan` data field (already added in Task 4).
- Produces: `scanCells()`, `scanConfirm` data flag, `renderScanCard(h)`; scan-row lock targets carry `extra` (the whole tower object) so the backend forwards GL's own fields back to it.

- [ ] **Step 1: Write failing tests — append to `test/chunk.test.js`:**

```js
test('lock tab: scan card empty state is honest about SA + disruption', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /no neighbour list/i);
  assert.match(text, /offline/i);
  assert.match(text, /Scan for cells/);
});

test('lock tab: scan results render rows sorted by strength with Lock buttons', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.scan = { running: false, error: '', ts: 1, towers: [
    { network_type: 'NR5G', pci: 99, freq: 520000, band: 41, scs: 30, cellid: 'A', strength: 2, rsrp: -101 },
    { network_type: 'NR5G', pci: 516, freq: 127490, band: 71, scs: 15, cellid: 'B', strength: 4, rsrp: -98 }
  ] };
  const tree = component.render.call(vm, h);
  const text = textOf(tree);
  // strongest first
  assert.ok(text.indexOf('516') < text.indexOf('99'), 'rows must sort by strength desc');
  const lockBtns = walk(tree).filter((n) => n.tag === 'button' && textOf(n) === 'Lock');
  assert.equal(lockBtns.length, 2);
});

test('lock tab: scan target uses the row scs verbatim', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const row = { network_type: 'NR5G', pci: 99, freq: 520000, band: 41, scs: 30, cellid: 'A' };
  const t = vm.scanTarget(row);
  assert.equal(t.rat, '5g');
  assert.equal(t.scs, 30);
  assert.equal(t.scsAssumed, false);
  assert.deepEqual(t.extra, row);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/chunk.test.js
```
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement in `src/views/mudimodem.js`**

3a. `data()` — add `scanConfirm: false,` (the `scan` object exists since Task 4).

3b. Methods:

```js
    scanCells() {
      var self = this;
      if (this.scan.running) return;
      this.scanConfirm = false;
      this.scan.running = true; this.scan.error = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "scan_cells", {}], { timeout: 600000 })
        .then(function (res) {
          if (!res || res.error) { self.scan.error = (res && res.error) || "scan failed"; return; }
          self.scan.towers = res.towers || [];   // renderScanCard sorts at paint time
          self.scan.ts = res.ts || Date.now();
        })
        .catch(function (e) { self.scan.error = (e && (e.type || e.message)) || "scan failed"; })
        .then(function () { self.scan.running = false; self.fetchLock(); });
    },
    // Lock target from a scan row: GL's own values verbatim, whole row as extra.
    scanTarget(row) {
      var isNR = /5G/.test(row.network_type || "");
      var t = { rat: isNR ? "5g" : "4g", pci: Number(row.pci), freq: Number(row.freq),
                band: row.band !== undefined ? Number(row.band) : undefined,
                label: "scanned cell PCI " + row.pci, extra: row };
      if (isNR) { t.scs = Number(row.scs); t.scsAssumed = false; }
      return t;
    },
```

3c. `renderScanCard(h)`:

```js
    renderScanCard(h) {
      var self = this;
      var locked = this.lockData && ((this.lockData.lock.l5g || {}).locked ||
                                     (this.lockData.lock.l4g || {}).locked);
      var head = h("div", { staticClass: "mm-grp-h" }, [
        h("span", { staticClass: "mm-grp-t" }, "Nearby cells"),
        this.scan.ts
          ? h("span", { staticClass: "mm-hint" },
              "scanned " + Math.max(1, Math.round((Date.now() - this.scan.ts) / 60000)) + " min ago")
          : h("span", { staticClass: "mm-hint" }, "requires a scan")
      ]);
      var body;
      if (this.scan.running) {
        body = h("div", { staticClass: "mm-empty" },
          "Scanning... the modem is offline until this finishes (up to ~10 minutes). Watch the strip.");
      } else if (this.scan.towers.length) {
        var sorted = this.scan.towers.slice().sort(function (a, b) {
          return (b.strength || 0) - (a.strength || 0);
        });
        var rows = sorted.map(function (tw, i) {
          var q = tw.rsrp !== undefined ? (tw.rsrp >= -95 ? "good" : (tw.rsrp >= -105 ? "fair" : "poor")) : "none";
          var confirming = self.lockConfirm && self.lockConfirm.scanIdx === i;
          var target = self.scanTarget(tw);
          return h("div", { key: i, staticClass: "mm-scan-row" }, [
            h("span", { staticClass: "mm-scan-badge" }, tw.network_type || "?"),
            h("span", (tw.carrier || ((tw.mcc || "") + "-" + (tw.mnc || ""))) + "  " + (tw.cellid || "")),
            h("span", (/5G/.test(tw.network_type || "") ? "n" : "B") + (tw.band !== undefined ? tw.band : "?") +
              "  ARFCN " + tw.freq + "  PCI " + tw.pci),
            h("span", { style: { color: self.qColor(q) } },
              tw.rsrp !== undefined ? tw.rsrp + " dBm" : ""),
            confirming
              ? h("span", { staticStyle: { display: "flex", gap: "6px" } }, [
                  h("button", { staticClass: "mm-btn", on: { click: function () { self.lockConfirm = null; } } }, "Cancel"),
                  h("button", { staticClass: "mm-btn primary", attrs: { disabled: self.lockBusy },
                    on: { click: function () { self.lockCell(target); } } },
                    self.lockBusy ? "Locking..." : "Confirm")
                ])
              : h("button", { staticClass: "mm-btn",
                  attrs: { disabled: !!self.pending || self.lockBusy || locked ||
                           (/5G/.test(tw.network_type || "") && tw.scs === undefined) },
                  on: { click: function () { self.lockConfirm = { scanIdx: i }; } } }, "Lock")
          ]);
        });
        body = h("div", rows);
      } else {
        body = h("div", { staticClass: "mm-empty" }, this.scan.error
          ? "Scan failed: " + this.scan.error
          : "5G SA exposes no neighbour list - only the serving cell is visible without a scan.");
      }
      var foot;
      if (!this.scan.running) {
        foot = this.scanConfirm
          ? h("div", { staticClass: "mm-foot" }, [
              h("span", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)" } },
                "Scanning takes the modem OFFLINE for up to ~10 minutes. This connection will drop if it runs over cellular."),
              h("span", { staticStyle: { flex: "none", display: "flex", gap: "6px" } }, [
                h("button", { staticClass: "mm-btn", on: { click: function () { self.scanConfirm = false; } } }, "Cancel"),
                h("button", { staticClass: "mm-btn danger", on: { click: function () { self.scanCells(); } } }, "Scan now")
              ])
            ])
          : h("div", { staticClass: "mm-foot" }, [
              h("span", { staticClass: "mm-hint" }, "Find every cell in range, with lockable details."),
              h("button", { staticClass: "mm-btn",
                attrs: { disabled: !!this.pending || this.lockBusy },
                on: { click: function () { self.scanConfirm = true; } } }, "Scan for cells")
            ]);
      }
      return h("div", { staticClass: "mm-grp" }, [head, body, foot].filter(Boolean));
    },
```

3d. Append `this.renderScanCard(h)` to `renderLock`'s `kids` (replacing the Task 5 comment), and add row CSS to `injectStyle`:

```js
        '.mm-scan-row{display:flex;gap:10px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--divider);font-size:12px}' +
        '.mm-scan-row>span{min-width:0}.mm-scan-row>span:nth-child(2){flex:1}' +
        '.mm-scan-badge{flex:none;font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;color:var(--text-badge)}' +
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/chunk.test.js
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "cell-lock: chunk — Nearby-cells scan card with honest disruption warning"
```

---

### Task 6: Recovery card, stale-reconcile banner, verify.sh, deploy

**Files:**
- Modify: `src/views/mudimodem.js`
- Modify: `test/chunk.test.js`
- Modify: `tools/verify.sh`

**Interfaces:**
- Consumes: `lockData.stale`, `unlockCell()` (which is the reconciler — backend `clear_cell_lock` clears the marker + GL store).
- Produces: `renderRecovery(h)`; stale banner inside `renderLock`; verify.sh asserts the four new backend methods exist and the watchdog handles `KIND=cell`.

- [ ] **Step 1: Write failing tests — append to `test/chunk.test.js`:**

```js
test('lock tab: stale GL store shows reconcile banner', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.lockData.stale = true;
  vm.lockData.gl = { locked: true, tower: { cellid: 'X' } };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /GL('s)? stored lock/i);
  assert.match(text, /Clear it/);
});

test('lock tab: recovery card names the ssh panic path', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /mudimodem-revert panic/);
  assert.match(text, /survives reboot/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/chunk.test.js
```
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement**

3a. In `renderLock`, insert between the revert banner and `renderCurrentCell`:

```js
        (this.lockData.stale)
          ? h("div", { staticClass: "mm-revert" }, [
              h("div", { staticClass: "mm-revert-row" }, [
                h("span", [
                  "The watchdog reverted a lock, but ", h("b", "GL's stored lock"),
                  " still remembers it - GL may re-apply it later. Clear it to reconcile."
                ]),
                h("button", { staticClass: "mm-btn keep", attrs: { disabled: this.lockBusy },
                  on: { click: this.unlockCell } }, "Clear it")
              ])
            ])
          : null,
```

3b. Add `renderRecovery(h)` and append it to `renderLock`'s kids:

```js
    renderRecovery(h) {
      return h("div", { staticClass: "mm-grp" }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, "Recovery"),
          h("span", { staticClass: "mm-hint" }, "read before locking")
        ]),
        h("div", { staticClass: "mm-hint", staticStyle: { lineHeight: "1.6" } }, [
          "A kept cell lock lives in the modem's own NV (survives reboot, reflash and factory reset) ",
          "and in GL's store. Every lock made here auto-reverts in 60s unless you keep it, and the ",
          "watchdog fires even if this page is closed. If the router ever becomes unreachable over ",
          "the web, the ssh way back is: ", h("b", "ssh root@<router> /usr/sbin/mudimodem-revert panic"),
          " - it unlocks both RATs, resets lock persistence, and restores the known-good bands."
        ])
      ]);
    },
```

3c. `tools/verify.sh` — verify.sh's pattern is "push the repo's test file, run it on-device" (see its sections 5–6). Add a section 6b after section 6, inside the same `if [ -f src/sbin/mudimodem-revert ]` block:

```sh
  echo "6b. cell-lock backend + watchdog cell revert (isolation, on-device)"
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-l.test.lua'  < test/backend-lock.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-lw.test.lua' < test/backend-lock-write.test.lua
  ssh -o BatchMode=yes "root@$HOST" 'MM_PLUGIN=/usr/lib/oui-httpd/rpc/mudimodem MUDIMODEM_PENDING=/tmp/mml-p MUDIMODEM_ARMED=/tmp/mml-a MUDIMODEM_STALE=/tmp/mml-s MUDIMODEM_HIST=/tmp/mml-h lua /tmp/mm-l.test.lua >/dev/null && MM_PLUGIN=/usr/lib/oui-httpd/rpc/mudimodem MUDIMODEM_PENDING=/tmp/mml-p MUDIMODEM_ARMED=/tmp/mml-a MUDIMODEM_STALE=/tmp/mml-s MUDIMODEM_BIN=/usr/sbin/mudimodem-revert MUDIMODEM_HIST=/tmp/mml-h lua /tmp/mm-lw.test.lua >/dev/null; rc=$?; rm -rf /tmp/mm-l.test.lua /tmp/mm-lw.test.lua /tmp/mml-p /tmp/mml-a /tmp/mml-s /tmp/mml-h; exit $rc' \
    || fail "cell-lock isolation tests failed on-device"
  ssh -o BatchMode=yes "root@$HOST" 'grep -q "\"\$KIND\" = \"cell\"" /usr/sbin/mudimodem-revert' \
    || fail "deployed watchdog lacks cell revert"
```

Notes: the existing section 6 already re-runs `test/revert.test.sh` on-device, which now includes the cell cases (6–8) — no change needed there. The two Lua isolation tests fully shim `oui.ubus` and define their own global `ngx`, so running them on-device fires nothing real. If `test/backend-lock.test.lua`'s `dofile` of the *deployed* plugin fails only on-device, check that `deploy.sh` pushed the current `src/rpc/mudimodem`.

- [ ] **Step 4: Run the full local suite**

```bash
node --test test/chunk.test.js test/tracking.test.js
for t in backend backend-write backend-lock backend-lock-write; do
  W=$(mktemp -d); MM_PLUGIN=src/rpc/mudimodem MUDIMODEM_PENDING=$W/p MUDIMODEM_ARMED=$W/a \
    MUDIMODEM_STALE=$W/s lua test/$t.test.lua || exit 1
done
sh test/revert.test.sh src/sbin/mudimodem-revert
```
Expected: everything green.

- [ ] **Step 5: Build, deploy, verify on-device (deploy only — nothing fires)**

```bash
./tools/build.sh && ./tools/deploy.sh
ssh root@mudi /etc/init.d/nginx restart
./tools/verify.sh
```
Expected: verify.sh green, including the new cell-lock asserts. Then confirm the read path live (read-only — allowed): load the Modem page, open the Cell lock tab, confirm the Current-cell card shows the live serving cell and `get_lock` returns without error. **Do NOT press any Lock/Scan button.**

If `get_lock` errors with `glc http 404` here, nginx has no `/cgi-bin/glc` location visible to `ngx.location.capture` — check `grep -rn cgi-bin /etc/nginx/` and mirror however `oui-rpc.lua`'s own `glc_call` reaches it (it demonstrably works for GL's `modem` object calls from the browser). Fix before Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js tools/verify.sh
git commit -m "cell-lock: recovery card + stale reconcile + verify.sh asserts"
```

---

### Task 7: ⚠️ Supervised live-fire milestone (Kevin present — the ONLY task that fires set forms)

**Files:**
- Modify: `reference/quectel-at-reference.md` (§6a — record verified scs encoding, towerInfo field names, `get_operator_config` shape)
- Modify: `src/views/mudimodem.js` + `src/rpc/mudimodem` (only if field names/encodings differ from assumptions)

**Preconditions (all must hold before ANY step below):**
- Kevin is present and explicitly says go.
- An ssh session to the box is open and healthy in another terminal.
- `sh test/revert.test.sh src/sbin/mudimodem-revert` green; deployed files current (`./tools/verify.sh` green).
- Panic one-liner ready to paste: `ssh root@mudi /usr/sbin/mudimodem-revert panic`

- [ ] **Step 1 (read-only): capture GL shapes.** From the dev box:

```bash
ssh root@mudi 'ubus call modem.CPU.AT get_result_AT "{\"cmd\":\"AT+QNWLOCK=\\\"common/5g\\\"\",\"timeout\":8,\"sub_id\":1}"'
```
And via the page's browser console: `$rpcRequest("call",["sid","mudimodem","get_lock",{}]).then(console.log)` — record `operator_config`'s real shape into reference §6a.

- [ ] **Step 2 (disruptive, consented): one scan.** Kevin confirms the outage is acceptable *now*. Press **Scan for cells** in the UI. When it returns: record a full tower object verbatim into reference §6a (field names, and the **scs value for the serving cell** — this is the encoding answer). If field names differ from `{network_type,pci,freq,band,scs}`, fix `scanTarget`/`set_cell_lock` payload mapping now, re-test, re-deploy, re-scan only if the fix changes what's sent.

- [ ] **Step 3: pin-current lock cycle.** Verify the SCS shown in the confirm text matches the scanned value (the scan match path should now be active, `scsAssumed:false`). Press **Lock to this cell** → **Lock it**. Within the 60 s window verify:
  - strip stays alive (we locked the serving cell; nothing should drop);
  - `AT+QNWLOCK="common/5g"` (query, other terminal) now returns the locked tuple — **record it in reference §6a**;
  - GL's store agrees: `get_lock` shows `gl.locked:true` and matching pci/freq.
  Then press **Keep**. Confirm pending cleared, UI shows Locked.

- [ ] **Step 4: watchdog drill.** Lock again is impossible (locked) — instead: **Unlock**, verify clean state everywhere, then lock again and this time **let the window expire with the browser tab closed**. After ~70 s reopen: modem must be unlocked (query), `gl-stale` banner must show, **Clear it** must reconcile (GL store empty afterwards). This proves the whole unattended-revert path end-to-end.

- [ ] **Step 5: final clean state.** `get_lock`: both locks `0`, `save_ctrl` back to `0,0`, GL store empty, no stale, `mode_pref` as Kevin wants it (ask — the box may deliberately run `NR5G`). Update reference §6a (mark scs/`<mode>` semantics 🟢 with captured values) and CLAUDE.md §12 (cell-lock tab shipped; open questions 1/6 resolved).

- [ ] **Step 6: Commit**

```bash
git add reference/quectel-at-reference.md CLAUDE.md src/views/mudimodem.js src/rpc/mudimodem
git commit -m "cell-lock: live-fire verified — scs encoding + tower fields recorded; docs updated"
```

---

## Self-review notes (already applied)

- Spec §2 "Lock disabled while operator lock present": implemented as GL-error surfacing (`20002044` propagates through `set_cell_lock` → `lockError`) plus raw `operator_config` in `get_lock`; a hard disabled-state needs the shape captured in Task 7 Step 1 — wire it then if the shape is usable.
- Spec §3 revert-restores-previous-lock: narrowed to "previous state is always unlocked" via the one-lock-at-a-time rule (Global Constraints) — simpler and shell-safe.
- Type check: `pending.kind` values `"bands"`/`"cell"` consistent across backend (`KIND=`) and chunk; `freq` means ARFCN/EARFCN everywhere a lock is built (matching GL's `freq` field name), while the chunk's existing `freq` *table* (MHz labels) is untouched and never sent.
