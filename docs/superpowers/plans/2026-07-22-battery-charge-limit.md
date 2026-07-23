# Battery Charge Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mudi charge limit configurable from the Config tab (toggle + GUI % target, dual-scale status), with MudiModem shipping the full `glbattlimit` stack driven by `/etc/mudimodem/battlimit.json`.

**Architecture:** Durable policy lives in `battlimit.json`. Backend methods `get_battlimit` / `set_battlimit` read/write that file and spawn `/usr/bin/glbattlimit` for live apply/status. Hotplug + init scripts read the same JSON and re-apply on plug/boot when enabled. Config tab card calls the RPC on open and on every user change.

**Tech Stack:** Plain-JS Vue 2.6 runtime-only chunk (`render(h)`), Lua oui-httpd RPC plugin, POSIX ash (`glbattlimit` + hotplug + init), Node `node:test` for chunk tests, on-device Lua/sh isolation tests via `tools/verify.sh`.

**Spec:** `docs/superpowers/specs/2026-07-22-battery-charge-limit-design.md`

## Global Constraints

- **Chunk is Vue 2.6 runtime-only:** `render(h)` only, never `template:`. File is a single expression: `module.exports = { ... };`.
- **Never wrap `oui.ubus.call` in `pcall`.** These methods use **no ubus** (subprocess + file I/O only); `pcall(cjson.decode, …)` is fine.
- **Deploy transfer:** `ssh host 'cat > /path' < file` — no sftp-server.
- **Model guard:** E5800 only (install/deploy already guard).
- **After editing the Lua backend, nginx must be RESTARTED** (not reloaded).
- **Shell commands built in Lua must never interpolate unvalidated RPC input.** `limit_gui` is validated as an integer 20–100 before it touches a command line; `enabled` is boolean only.
- **Durable state in `/etc/mudimodem/`** and registered in `/etc/sysupgrade.conf`.
- **Default policy: disabled.** Never enable by default on missing/malformed config.
- **Do not rewrite ChiliApple gating logic** — vendor the script, keep CLI compatible.
- **Before replacing a running `glbattlimit` binary under an active watcher, run `off` first.**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sbin/glbattlimit` | **new** — vendored ChiliApple tool → `/usr/bin/glbattlimit` |
| `src/hotplug/20-glbattlimit` | **new** — config-aware i2c hotplug → `/etc/hotplug.d/i2c/20-glbattlimit` |
| `src/etc/init.d/glbattlimit` | **new** — config-aware boot apply → `/etc/init.d/glbattlimit` |
| `src/rpc/mudimodem` | **modify** — `get_battlimit`, `set_battlimit` |
| `src/views/mudimodem.js` | **modify** — Config card UI + fetch/set methods |
| `install.sh` | **modify** — install stack + default JSON if absent + sysupgrade lines + enable init |
| `uninstall.sh` | **modify** — `off`, remove stack + JSON, de-register |
| `tools/deploy.sh` | **modify** — push stack + register sysupgrade |
| `test/backend-battlimit.test.lua` | **new** — isolation tests for RPC |
| `test/battlimit-hotplug.test.sh` | **new** — hotplug/init config behaviour with stub bin |
| `test/backend.test.lua` | **modify** — ALLOWED whitelist for new methods |
| `test/chunk.test.js` | **modify** — Config card render + set payload |
| `tools/verify.sh` | **modify** — assert files + run isolation tests |

---

### Task 1: Vendor `glbattlimit` into the repo

**Files:**
- Create: `src/sbin/glbattlimit`
- Test: local syntax check + optional on-box `status`

**Interfaces:**
- Produces: POSIX script with CLI `on [pct] [gui]`, `off`, `status`, `_watch` (unchanged ChiliApple contract). Consumed by Tasks 2–4.

- [ ] **Step 1: Pull the on-box binary (authoritative for this unit) into the repo**

```bash
mkdir -p src/sbin src/hotplug
ssh -o BatchMode=yes root@mudi 'cat /usr/bin/glbattlimit' > src/sbin/glbattlimit
chmod 0755 src/sbin/glbattlimit
# Sanity: file is shell, not truncated
head -5 src/sbin/glbattlimit
wc -c src/sbin/glbattlimit   # expect ~6400+ bytes
sh -n src/sbin/glbattlimit && echo SYNTAX_OK
```

Expected: shebang `#!/bin/sh`, header mentioning `glbattlimit` / Mudi 7 / ChiliApple, `SYNTAX_OK`.

If the box is unreachable, fetch upstream instead:

```bash
curl -fsSL https://raw.githubusercontent.com/ChiliApple/mudi7-battery-limit/main/glbattlimit \
  -o src/sbin/glbattlimit
chmod 0755 src/sbin/glbattlimit
sh -n src/sbin/glbattlimit && echo SYNTAX_OK
```

- [ ] **Step 2: Confirm attribution in the header**

If the file lacks an upstream URL/license pointer, add a one-line comment near the top (do not change logic):

```sh
# Vendored for MudiModem from https://github.com/ChiliApple/mudi7-battery-limit (MIT)
```

- [ ] **Step 3: Commit**

```bash
git add src/sbin/glbattlimit
git commit -m "feat(battlimit): vendor glbattlimit charge-limit tool"
```

---

### Task 2: Config-aware hotplug + init scripts

**Files:**
- Create: `src/hotplug/20-glbattlimit`
- Create: `src/etc/init.d/glbattlimit`
- Test: `test/battlimit-hotplug.test.sh`

**Interfaces:**
- Consumes: `/etc/mudimodem/battlimit.json` with `{enabled, limit_gui}`; `/usr/bin/glbattlimit`
- Produces: on plug/boot when enabled + charger online + watcher not already running → `glbattlimit on <limit_gui> gui`

- [ ] **Step 1: Write the failing hotplug isolation test**

Create `test/battlimit-hotplug.test.sh`:

```sh
#!/bin/sh
# Isolation test for config-aware glbattlimit hotplug/init glue.
# Uses a stub glbattlimit that records its argv; never touches real sysfs.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

STUB="$TMP/glbattlimit"
LOG="$TMP/calls.log"
CFG="$TMP/battlimit.json"
HOTPLUG="$ROOT/src/hotplug/20-glbattlimit"
INIT="$ROOT/src/etc/init.d/glbattlimit"

cat > "$STUB" <<'EOF'
#!/bin/sh
echo "$*" >> "$CALL_LOG"
exit 0
EOF
chmod +x "$STUB"

# ---- helpers that inject CFG/BIN/CHG into the scripts under test ----
# The production scripts must honour:
#   MUDIMODEM_BATTLIMIT_FILE, MUDIMODEM_BATTLIMIT_BIN, MUDIMODEM_BATTLIMIT_CHG_ONLINE
# (env overrides for tests; production defaults to the real paths / sysfs read).

run_hotplug() {
  CALL_LOG="$LOG" \
  MUDIMODEM_BATTLIMIT_FILE="$CFG" \
  MUDIMODEM_BATTLIMIT_BIN="$STUB" \
  MUDIMODEM_BATTLIMIT_CHG_ONLINE="$1" \
  DRIVER=cw221X \
  sh "$HOTPLUG"
}

# Case A: missing config → no-op (defaults disabled)
rm -f "$CFG" "$LOG"
run_hotplug 1
[ ! -f "$LOG" ] || { echo "FAIL A: expected no call"; cat "$LOG"; exit 1; }

# Case B: enabled false → no-op
echo '{"enabled":false,"limit_gui":80}' > "$CFG"
run_hotplug 1
[ ! -f "$LOG" ] || { echo "FAIL B: expected no call"; cat "$LOG"; exit 1; }

# Case C: enabled true, charger offline → no-op
echo '{"enabled":true,"limit_gui":80}' > "$CFG"
run_hotplug 0
[ ! -f "$LOG" ] || { echo "FAIL C: expected no call when offline"; cat "$LOG"; exit 1; }

# Case D: enabled true, charger online → on 80 gui
echo '{"enabled":true,"limit_gui":80}' > "$CFG"
rm -f "$LOG"
run_hotplug 1
grep -qx 'on 80 gui' "$LOG" || { echo "FAIL D: expected 'on 80 gui'"; cat "$LOG"; exit 1; }

# Case E: init start with enabled + online
echo '{"enabled":true,"limit_gui":75}' > "$CFG"
rm -f "$LOG"
CALL_LOG="$LOG" \
MUDIMODEM_BATTLIMIT_FILE="$CFG" \
MUDIMODEM_BATTLIMIT_BIN="$STUB" \
MUDIMODEM_BATTLIMIT_CHG_ONLINE=1 \
sh -c '. "'"$INIT"'"; start'
grep -qx 'on 75 gui' "$LOG" || { echo "FAIL E: init start"; cat "$LOG"; exit 1; }

echo "battlimit-hotplug OK"
```

- [ ] **Step 2: Run the test — expect FAIL (scripts missing)**

```bash
chmod +x test/battlimit-hotplug.test.sh
sh test/battlimit-hotplug.test.sh
```

Expected: fail (file not found).

- [ ] **Step 3: Implement hotplug**

Create `src/hotplug/20-glbattlimit`:

```sh
#!/bin/sh
# Re-apply MudiModem charge limit on charger-related i2c hotplug events.
# Reads /etc/mudimodem/battlimit.json (GUI-scale target). No-op when disabled
# or when a watcher is already running.
# Spec: docs/superpowers/specs/2026-07-22-battery-charge-limit-design.md

CFG="${MUDIMODEM_BATTLIMIT_FILE:-/etc/mudimodem/battlimit.json}"
BIN="${MUDIMODEM_BATTLIMIT_BIN:-/usr/bin/glbattlimit}"
PIDF=/tmp/glbattlimit.pid

case "$DRIVER" in
    cw221X|cw2217|aw35615|sgm41542*|qpnp*|pmic*) ;;
    *) exit 0 ;;
esac

# Charger online? Env override for tests; else sysfs.
if [ -n "${MUDIMODEM_BATTLIMIT_CHG_ONLINE+x}" ]; then
    [ "$MUDIMODEM_BATTLIMIT_CHG_ONLINE" = "1" ] || exit 0
else
    [ "$(cat /sys/class/power_supply/charger/online 2>/dev/null)" = "1" ] || exit 0
fi

# Already watching?
p=$(cat "$PIDF" 2>/dev/null)
[ -n "$p" ] && kill -0 "$p" 2>/dev/null && exit 0

# Defaults: disabled
enabled=false
limit_gui=80
if [ -f "$CFG" ]; then
    # Minimal extract for our fixed shape { "enabled": bool, "limit_gui": N }
    e=$(sed -n 's/.*"enabled"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$CFG" | head -n1)
    g=$(sed -n 's/.*"limit_gui"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CFG" | head -n1)
    [ -n "$e" ] && enabled=$e
    [ -n "$g" ] && limit_gui=$g
fi

[ "$enabled" = "true" ] || exit 0

# Sanity range (GUI 20–100); refuse garbage rather than call the tool wrong
case "$limit_gui" in
    ''|*[!0-9]*) exit 0 ;;
esac
[ "$limit_gui" -ge 20 ] && [ "$limit_gui" -le 100 ] || exit 0

[ -x "$BIN" ] || exit 0
"$BIN" on "$limit_gui" gui >/dev/null 2>&1
```

- [ ] **Step 4: Implement init**

Create `src/etc/init.d/glbattlimit`:

```sh
#!/bin/sh /etc/rc.common
# Boot-time apply for MudiModem charge limit when already on charger power.
# Same policy file as the hotplug path.

START=99

CFG="${MUDIMODEM_BATTLIMIT_FILE:-/etc/mudimodem/battlimit.json}"
BIN="${MUDIMODEM_BATTLIMIT_BIN:-/usr/bin/glbattlimit}"

start() {
    if [ -n "${MUDIMODEM_BATTLIMIT_CHG_ONLINE+x}" ]; then
        [ "$MUDIMODEM_BATTLIMIT_CHG_ONLINE" = "1" ] || return 0
    else
        [ "$(cat /sys/class/power_supply/charger/online 2>/dev/null)" = "1" ] || return 0
    fi

    enabled=false
    limit_gui=80
    if [ -f "$CFG" ]; then
        e=$(sed -n 's/.*"enabled"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$CFG" | head -n1)
        g=$(sed -n 's/.*"limit_gui"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CFG" | head -n1)
        [ -n "$e" ] && enabled=$e
        [ -n "$g" ] && limit_gui=$g
    fi
    [ "$enabled" = "true" ] || return 0
    case "$limit_gui" in ''|*[!0-9]*) return 0 ;; esac
    [ "$limit_gui" -ge 20 ] && [ "$limit_gui" -le 100 ] || return 0
    [ -x "$BIN" ] || return 0
    "$BIN" on "$limit_gui" gui >/dev/null 2>&1
}
```

- [ ] **Step 5: Run the hotplug test — expect PASS**

```bash
sh test/battlimit-hotplug.test.sh
```

Expected: `battlimit-hotplug OK`

- [ ] **Step 6: Commit**

```bash
git add src/hotplug/20-glbattlimit src/etc/init.d/glbattlimit test/battlimit-hotplug.test.sh
git commit -m "feat(battlimit): config-aware hotplug and boot apply"
```

---

### Task 3: Backend `get_battlimit` / `set_battlimit`

**Files:**
- Modify: `src/rpc/mudimodem`
- Create: `test/backend-battlimit.test.lua`
- Modify: `test/backend.test.lua` (ALLOWED list)

**Interfaces:**
- Produces:
  - `M.get_battlimit(args) → { enabled, limit_gui, limit_gauge, active, active_gauge, capacity_gauge, capacity_gui, charger_online, available, error? }`
  - `M.set_battlimit({ enabled, limit_gui }) → same shape after write+apply`
- Env: `MUDIMODEM_BATTLIMIT_FILE`, `MUDIMODEM_BATTLIMIT_BIN`

- [ ] **Step 1: Write the failing backend isolation test**

Create `test/backend-battlimit.test.lua`:

```lua
-- Isolation tests for mudimodem.get_battlimit / set_battlimit.
-- Stubs glbattlimit via a shell script; overrides config path via env.
package.loaded["oui.ubus"] = { call = function() return nil, "unused" end }

local TMP = os.getenv("MM_TMP") or "/tmp/mm-batt-test"
os.execute("rm -rf " .. TMP .. "; mkdir -p " .. TMP)

local CFG = TMP .. "/battlimit.json"
local BIN = TMP .. "/glbattlimit"
local LOG = TMP .. "/calls.log"

local function writef(path, s)
  local f = assert(io.open(path, "w")); f:write(s); f:close()
end

-- Stub: logs "on …" / "off" / "status"; status prints a fixed block.
writef(BIN, string.format([[#!/bin/sh
echo "$*" >> "%s"
if [ "$1" = "status" ]; then
  cat <<'ST'
Limit     : off
Capacity  : 72 %% gauge / ~81 %% GUI (estimated)
Voltage   : 4024 mV
Current   : -288 mA  (+charging -discharging 0=blocked)
Charger   : online=0
Pump      : charge_en=0  (0=off 1=bypass 2=2:1)
Buck vreg : 4400000 uV  (factory 4400000)
ST
  exit 0
fi
exit 0
]], LOG))
os.execute("chmod +x " .. BIN)

-- Env must be set BEFORE dofile if the plugin reads getenv at load;
-- these methods re-read getenv on each call (same pattern as VERSION_FILE).
local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.get_battlimit) == "function", "get_battlimit missing")
assert(type(M.set_battlimit) == "function", "set_battlimit missing")

-- Point plugin at our stubs (plugin must re-read these each call).
-- The test harness sets them in the environment before invoking lua:
--   MUDIMODEM_BATTLIMIT_FILE, MUDIMODEM_BATTLIMIT_BIN

-- Case A: missing config → defaults disabled, available true, status parsed
os.remove(CFG)
os.remove(LOG)
local a = M.get_battlimit({})
assert(a.enabled == false, "A enabled default")
assert(a.limit_gui == 80, "A limit_gui default")
assert(a.available == true, "A available")
assert(a.capacity_gauge == 72, "A capacity_gauge: " .. tostring(a.capacity_gauge))
assert(a.capacity_gui == 81, "A capacity_gui: " .. tostring(a.capacity_gui))
assert(a.charger_online == false, "A charger")
assert(a.active == false, "A active")

-- Case B: set enable + 80 → writes file + calls on 80 gui when status says online
-- Re-stub status with online=1 for apply path. Easiest: rewrite BIN mid-test.
writef(BIN, string.format([[#!/bin/sh
echo "$*" >> "%s"
if [ "$1" = "status" ]; then
  if [ -f "%s/force_online" ]; then
    echo "Limit     : active (71 %% gauge / ~80 %% GUI, PID 9)"
    echo "Capacity  : 70 %% gauge / ~78 %% GUI (estimated)"
    echo "Voltage   : 4100 mV"
    echo "Current   : 0 mA  (+charging -discharging 0=blocked)"
    echo "Charger   : online=1"
    echo "Pump      : charge_en=0  (0=off 1=bypass 2=2:1)"
    echo "Buck vreg : 3900000 uV  (factory 4400000)"
  else
    echo "Limit     : off"
    echo "Capacity  : 72 %% gauge / ~81 %% GUI (estimated)"
    echo "Voltage   : 4024 mV"
    echo "Current   : -288 mA"
    echo "Charger   : online=0"
    echo "Pump      : charge_en=0"
    echo "Buck vreg : 4400000 uV  (factory 4400000)"
  fi
  exit 0
fi
exit 0
]], LOG, TMP))
os.execute("chmod +x " .. BIN)
os.execute("touch " .. TMP .. "/force_online")
os.remove(LOG)

local b = M.set_battlimit({ enabled = true, limit_gui = 80 })
assert(b.enabled == true, "B enabled")
assert(b.limit_gui == 80, "B limit_gui")
local cf = assert(io.open(CFG, "r")); local body = cf:read("*a"); cf:close()
assert(body:find('"enabled"%s*:%s*true'), "B file enabled: " .. body)
assert(body:find('"limit_gui"%s*:%s*80'), "B file limit: " .. body)
-- Apply should have called: on 80 gui
local lf = assert(io.open(LOG, "r")); local calls = lf:read("*a"); lf:close()
assert(calls:find("on 80 gui", 1, true), "B called on 80 gui: " .. calls)

-- Case C: disable → off
os.remove(LOG)
local c = M.set_battlimit({ enabled = false, limit_gui = 80 })
assert(c.enabled == false, "C enabled")
lf = assert(io.open(LOG, "r")); calls = lf:read("*a"); lf:close()
assert(calls:find("off", 1, true), "C called off: " .. calls)

-- Case D: invalid limit_gui → error, no write of invalid
local before = body
local d = M.set_battlimit({ enabled = true, limit_gui = 5 })
assert(type(d.error) == "string", "D error")
cf = assert(io.open(CFG, "r")); local after = cf:read("*a"); cf:close()
assert(not after:find('"limit_gui"%s*:%s*5'), "D must not persist 5: " .. after)

-- Case E: missing binary → available false
local bad = TMP .. "/missing-bin"
-- Point at non-executable path via env is process-level; for this case the
-- plugin should treat non-executable BIN as unavailable. Temporarily rename.
os.execute("mv " .. BIN .. " " .. BIN .. ".bak")
local e = M.get_battlimit({})
assert(e.available == false, "E available false")
os.execute("mv " .. BIN .. ".bak " .. BIN)

os.execute("rm -rf " .. TMP)
print("backend-battlimit OK")
```

Note for the implementer: `verify.sh` must export:

```sh
export MUDIMODEM_BATTLIMIT_FILE="$TMP/battlimit.json"
export MUDIMODEM_BATTLIMIT_BIN="$TMP/glbattlimit"
export MM_PLUGIN=/usr/lib/oui-httpd/rpc/mudimodem   # or the deployed test path
export MM_TMP=$TMP
```

before `lua test/backend-battlimit.test.lua`. The plugin methods must call `os.getenv` **on each invocation**, not only at load.

- [ ] **Step 2: Run test — expect FAIL (methods missing)**

```bash
# Locally if lua+plugin loadable; otherwise on-box via verify later.
# Expect: get_battlimit missing
```

- [ ] **Step 3: Implement helpers + methods in `src/rpc/mudimodem`**

Append before `return M` (near the other Config methods). Core logic:

```lua
-- ---- Battery charge limit (Config tab) ------------------------------------
-- Policy file + glbattlimit CLI. No ubus. Spec:
-- docs/superpowers/specs/2026-07-22-battery-charge-limit-design.md

local function battlimit_file()
  return os.getenv("MUDIMODEM_BATTLIMIT_FILE") or "/etc/mudimodem/battlimit.json"
end
local function battlimit_bin()
  return os.getenv("MUDIMODEM_BATTLIMIT_BIN") or "/usr/bin/glbattlimit"
end

local function batt_defaults()
  return { enabled = false, limit_gui = 80 }
end

local function read_batt_policy()
  local p = batt_defaults()
  local f = io.open(battlimit_file(), "r")
  if not f then return p end
  local body = f:read("*a") or ""; f:close()
  local ok, obj = pcall(cjson.decode, body)
  if not ok or type(obj) ~= "table" then return p end
  if type(obj.enabled) == "boolean" then p.enabled = obj.enabled end
  local g = tonumber(obj.limit_gui)
  if g and g == math.floor(g) and g >= 20 and g <= 100 then p.limit_gui = g end
  return p
end

local function write_batt_policy(enabled, limit_gui)
  os.execute("mkdir -p /etc/mudimodem 2>/dev/null")
  local path = battlimit_file()
  local tmp = path .. ".tmp." .. tostring(os.time())
  local f, err = io.open(tmp, "w")
  if not f then return false, err or "open failed" end
  -- cjson encodes booleans correctly; keep pretty-min for ash sed extract.
  f:write(string.format('{"enabled":%s,"limit_gui":%d}\n',
    enabled and "true" or "false", limit_gui))
  f:close()
  local ok = os.rename(tmp, path)
  if not ok then os.remove(tmp); return false, "rename failed" end
  return true
end

local function run_glbattlimit(args)
  -- args is a shell-safe string already built from validated integers / fixed words
  local bin = battlimit_bin()
  local f = io.popen(bin .. " " .. args .. " 2>/dev/null")
  if not f then return nil end
  local out = f:read("*a") or ""
  f:close()
  return out
end

local function bin_available()
  local bin = battlimit_bin()
  -- executable check
  return (os.execute("[ -x '" .. bin:gsub("'", "'\\''") .. "' ]") == 0)
      or (os.execute("[ -x '" .. bin:gsub("'", "'\\''") .. "' ]") == true)
end

-- Parse `glbattlimit status` human text. Tolerant of small format drift.
local function parse_status(text)
  local s = {
    active = false, active_gauge = nil,
    capacity_gauge = nil, capacity_gui = nil,
    charger_online = false,
  }
  if not text or text == "" then return s end
  if text:find("Limit%s*:%s*active", 1) then
    s.active = true
    local ag = text:match("active %((%d+)%s*%%%s*gauge")
    if ag then s.active_gauge = tonumber(ag) end
  end
  local cg, cgui = text:match("Capacity%s*:%s*(%d+)%s*%%%s*gauge%s*/%s*~(%d+)%s*%%%s*GUI")
  if cg then s.capacity_gauge = tonumber(cg) end
  if cgui then s.capacity_gui = tonumber(cgui) end
  local on = text:match("Charger%s*:%s*online=(%d)")
  if on == "1" then s.charger_online = true end
  return s
end

-- GUI→gauge using the same integer formula as the tool (gui2gauge).
local function gui_to_gauge(gui)
  local GUI_M, GUI_B = 13867, 189300
  return math.floor((gui * 10000 + GUI_B + GUI_M / 2) / GUI_M)
end

local function snapshot_battlimit()
  local pol = read_batt_policy()
  local out = {
    enabled = pol.enabled,
    limit_gui = pol.limit_gui,
    limit_gauge = gui_to_gauge(pol.limit_gui),
    active = false,
    active_gauge = nil,
    capacity_gauge = nil,
    capacity_gui = nil,
    charger_online = false,
    available = false,
    error = nil,
  }
  if not bin_available() then
    out.error = "glbattlimit not installed"
    return out
  end
  out.available = true
  local text = run_glbattlimit("status")
  if not text or text == "" or text:find("ERROR:", 1, true) then
    out.available = false
    out.error = "glbattlimit status failed"
    return out
  end
  local st = parse_status(text)
  out.active = st.active
  out.active_gauge = st.active_gauge
  out.capacity_gauge = st.capacity_gauge
  out.capacity_gui = st.capacity_gui
  out.charger_online = st.charger_online
  return out
end

function M.get_battlimit(args)
  return snapshot_battlimit()
end

function M.set_battlimit(args)
  args = args or {}
  local enabled = args.enabled
  local limit_gui = tonumber(args.limit_gui)
  if type(enabled) ~= "boolean"
     or not limit_gui or limit_gui ~= math.floor(limit_gui)
     or limit_gui < 20 or limit_gui > 100 then
    local out = snapshot_battlimit()
    out.error = "invalid params"
    return out
  end
  local ok, err = write_batt_policy(enabled, limit_gui)
  if not ok then
    local out = snapshot_battlimit()
    out.error = err or "write failed"
    return out
  end
  if not bin_available() then
    local out = snapshot_battlimit()
    out.error = "glbattlimit not installed"
    return out
  end
  if not enabled then
    run_glbattlimit("off")
  else
    -- Only apply when charger is online; status tells us.
    local st = parse_status(run_glbattlimit("status") or "")
    if st.charger_online then
      run_glbattlimit("on " .. tostring(limit_gui) .. " gui")
    end
  end
  return snapshot_battlimit()
end
```

- [ ] **Step 4: Add methods to `test/backend.test.lua` ALLOWED whitelist**

Find the `ALLOWED` set and add `"get_battlimit"` and `"set_battlimit"`.

- [ ] **Step 5: Run backend-battlimit test (on-box or local with plugin path)**

```bash
# Example on-box after deploy of plugin only — or use verify.sh step added in Task 5.
```

Expected: `backend-battlimit OK`

- [ ] **Step 6: Commit**

```bash
git add src/rpc/mudimodem test/backend-battlimit.test.lua test/backend.test.lua
git commit -m "feat(battlimit): RPC get/set_battlimit for charge limit policy"
```

---

### Task 4: Config tab UI

**Files:**
- Modify: `src/views/mudimodem.js`
- Modify: `test/chunk.test.js`

**Interfaces:**
- Consumes: `mudimodem.get_battlimit` / `set_battlimit` via `$rpcRequest`
- Produces: third Config card with toggle, GUI % input, dual-scale status

- [ ] **Step 1: Extend chunk test for the battery card**

In `test/chunk.test.js`, add cases after existing Config tests:

```js
// Battery charge limit card
{
  name: "config shows battery card when battlimit loaded",
  run(vm, h) {
    vm.tab = "config";
    vm.battLimit = {
      enabled: false, limit_gui: 80, limit_gauge: 71,
      active: false, capacity_gauge: 72, capacity_gui: 81,
      charger_online: false, available: true, error: null
    };
    // Force renderConfig path — assert text nodes include Limit charging / GUI
    const vnode = vm.renderConfig(h);
    const text = JSON.stringify(vnode);
    if (!/Limit charging/.test(text) && !/charge limit/i.test(text)) {
      throw new Error("missing battery card labels: " + text.slice(0, 400));
    }
    if (!/80/.test(text)) throw new Error("missing limit_gui in render");
  }
}
```

Adapt to the actual test harness patterns already used for Config (read existing Config cases and mirror structure — same `eval` of chunk + stub `h`).

- [ ] **Step 2: Run chunk tests — expect FAIL**

```bash
node --test test/chunk.test.js
```

Expected: new case fails (no battery card).

- [ ] **Step 3: Add data + methods + render in `src/views/mudimodem.js`**

**data()** (near other Config fields):

```js
battLimit: null,       // get_battlimit result
battLimitBusy: false,
battLimitErr: "",
battLimitDraft: 80,    // local number input while editing
```

**watcher / tab open** (alongside deviceInfo + app_version):

```js
if (this.tab === "config") {
  this.fetchBattLimit();
}
```

**methods:**

```js
fetchBattLimit() {
  var self = this;
  if (typeof window === "undefined" || !window.$rpcRequest) return Promise.resolve();
  return window.$rpcRequest("call", ["sid", "mudimodem", "get_battlimit", {}], { timeout: 8000 })
    .then(function (r) {
      self.battLimit = r || null;
      if (r && typeof r.limit_gui === "number") self.battLimitDraft = r.limit_gui;
      self.battLimitErr = (r && r.error) || "";
    })
    .catch(function (e) {
      self.battLimitErr = (e && (e.message || e.type)) || "request failed";
    });
},
applyBattLimit(patch) {
  var self = this;
  if (this.battLimitBusy || typeof window === "undefined" || !window.$rpcRequest) return;
  var cur = this.battLimit || { enabled: false, limit_gui: 80 };
  var enabled = (patch && typeof patch.enabled === "boolean") ? patch.enabled : !!cur.enabled;
  var limit_gui = (patch && patch.limit_gui != null) ? Number(patch.limit_gui) : Number(this.battLimitDraft || cur.limit_gui);
  if (!(limit_gui >= 20 && limit_gui <= 100)) {
    this.battLimitErr = "Target must be 20–100 % GUI";
    return;
  }
  this.battLimitBusy = true;
  this.battLimitErr = "";
  return window.$rpcRequest("call", ["sid", "mudimodem", "set_battlimit",
    { enabled: enabled, limit_gui: limit_gui }], { timeout: 15000 })
    .then(function (r) {
      self.battLimitBusy = false;
      self.battLimit = r || null;
      if (r && typeof r.limit_gui === "number") self.battLimitDraft = r.limit_gui;
      if (r && r.error) self.battLimitErr = r.error;
    })
    .catch(function (e) {
      self.battLimitBusy = false;
      self.battLimitErr = (e && (e.message || e.type)) || "request failed";
    });
},
```

**`renderConfig(h)`** — after the MudiModem card, append battery card:

```js
// --- Battery charge limit card ---
var bl = this.battLimit;
var battKids = [h("div", { staticClass: "mm-card-h" }, "Battery charge limit")];
if (!bl) {
  battKids.push(h("div", { staticClass: "mm-note" }, "Loading…"));
} else if (bl.available === false) {
  battKids.push(h("div", { staticClass: "mm-note" },
    "Charge limit not available on this device."));
} else {
  var self = this;
  battKids.push(h("div", { staticClass: "mm-kv" }, [
    h("label", { staticClass: "mm-k" }, [
      h("input", {
        attrs: { type: "checkbox", disabled: !!self.battLimitBusy },
        domProps: { checked: !!bl.enabled },
        on: {
          change: function (e) {
            self.applyBattLimit({ enabled: !!(e.target && e.target.checked) });
          }
        }
      }),
      " Limit charging"
    ])
  ]));
  battKids.push(h("div", { staticClass: "mm-kv" }, [
    h("span", { staticClass: "mm-k" }, "Target"),
    h("span", { staticClass: "mm-v" }, [
      h("input", {
        attrs: {
          type: "number", min: 20, max: 100, step: 1,
          disabled: !bl.enabled || !!self.battLimitBusy
        },
        domProps: { value: self.battLimitDraft },
        on: {
          input: function (e) {
            self.battLimitDraft = Number(e.target && e.target.value);
          },
          change: function () { self.applyBattLimit({ limit_gui: self.battLimitDraft }); }
        }
      }),
      " % GUI",
      h("span", { staticClass: "mm-note" },
        "  (≈ " + (bl.limit_gauge != null ? bl.limit_gauge : "—") + "% gauge)")
    ])
  ]));
  var statusLine;
  if (bl.active) {
    statusLine = "Active · " + (bl.active_gauge != null ? bl.active_gauge + "% gauge" : "on")
      + " · " + (bl.capacity_gauge != null ? bl.capacity_gauge + "% gauge" : "—")
      + " / ~" + (bl.capacity_gui != null ? bl.capacity_gui + "% GUI" : "—");
  } else if (bl.enabled) {
    statusLine = "Armed · will apply when charger connects · "
      + (bl.capacity_gauge != null ? bl.capacity_gauge + "% gauge" : "—")
      + " / ~" + (bl.capacity_gui != null ? bl.capacity_gui + "% GUI" : "—");
  } else {
    statusLine = "Off · "
      + (bl.capacity_gauge != null ? bl.capacity_gauge + "% gauge" : "—")
      + " / ~" + (bl.capacity_gui != null ? bl.capacity_gui + "% GUI" : "—");
  }
  battKids.push(row("Status", statusLine));
  battKids.push(row("Charger", bl.charger_online ? "Plugged in" : "Unplugged"));
  if (this.battLimitErr) {
    battKids.push(h("div", { staticClass: "mm-note" }, this.battLimitErr));
  }
}
var batt = h("div", { staticClass: "mm-card" }, battKids);
return h("div", {}, [device, app, batt]);
```

Adjust class names if the chunk already has checkbox/input styles; reuse existing ones rather than inventing new colours.

- [ ] **Step 4: Run chunk tests — expect PASS**

```bash
node --test test/chunk.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "feat(battlimit): Config tab charge-limit card"
```

---

### Task 5: Install, deploy, uninstall, verify

**Files:**
- Modify: `install.sh`
- Modify: `uninstall.sh`
- Modify: `tools/deploy.sh`
- Modify: `tools/verify.sh`

- [ ] **Step 1: `install.sh` — install stack + default JSON + sysupgrade + enable init**

After other sbin installs, add:

```sh
echo "installing battery charge limit:"
mkdir -p /etc/hotplug.d/i2c
cp_install src/sbin/glbattlimit           /usr/bin/glbattlimit                 0755
cp_install src/hotplug/20-glbattlimit     /etc/hotplug.d/i2c/20-glbattlimit    0755
cp_install src/etc/init.d/glbattlimit     /etc/init.d/glbattlimit              0755
# Default policy only if absent — never clobber user settings on upgrade.
if [ ! -f /etc/mudimodem/battlimit.json ]; then
  echo '{"enabled":false,"limit_gui":80}' > /etc/mudimodem/battlimit.json
  chmod 0644 /etc/mudimodem/battlimit.json
  echo "  /etc/mudimodem/battlimit.json (default disabled)"
fi
/etc/init.d/glbattlimit enable 2>/dev/null || true
# Do NOT start a limit on install (default disabled; start would no-op anyway).
```

Add to the sysupgrade `for p in` list:

```
  /usr/bin/glbattlimit \
  /etc/hotplug.d/i2c/20-glbattlimit \
  /etc/init.d/glbattlimit \
  /etc/mudimodem/battlimit.json \
```

- [ ] **Step 2: `tools/deploy.sh` — push the same files**

```sh
if [ -f src/sbin/glbattlimit ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/bin/glbattlimit && chmod 0755 /usr/bin/glbattlimit' \
    < src/sbin/glbattlimit
  ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /etc/hotplug.d/i2c; cat > /etc/hotplug.d/i2c/20-glbattlimit && chmod 0755 /etc/hotplug.d/i2c/20-glbattlimit' \
    < src/hotplug/20-glbattlimit
  ssh -o BatchMode=yes "root@$HOST" 'cat > /etc/init.d/glbattlimit && chmod 0755 /etc/init.d/glbattlimit' \
    < src/etc/init.d/glbattlimit
  ssh -o BatchMode=yes "root@$HOST" '
    [ -f /etc/mudimodem/battlimit.json ] || echo "{\"enabled\":false,\"limit_gui\":80}" > /etc/mudimodem/battlimit.json
    /etc/init.d/glbattlimit enable 2>/dev/null || true
  '
  echo "battery charge limit stack deployed"
fi
```

Extend the sysupgrade registration loop with the four paths above.

- [ ] **Step 3: `uninstall.sh` — off + remove**

Before removing files:

```sh
if [ -x /usr/bin/glbattlimit ]; then
  /usr/bin/glbattlimit off 2>/dev/null || true
  echo "charge limit released"
fi
if [ -x /etc/init.d/glbattlimit ]; then
  /etc/init.d/glbattlimit disable 2>/dev/null || true
fi
```

Add to `FILES=`:

```
/usr/bin/glbattlimit
/etc/hotplug.d/i2c/20-glbattlimit
/etc/init.d/glbattlimit
/etc/mudimodem/battlimit.json
```

(Note: `rm -rf /etc/mudimodem` already clears JSON if that line remains; listing the path still helps sysupgrade de-register.)

- [ ] **Step 4: `tools/verify.sh` — assertions + isolation tests**

Add a section:

```sh
echo "== battery charge limit =="
[ -x /usr/bin/glbattlimit ] || fail "glbattlimit missing"
[ -x /etc/hotplug.d/i2c/20-glbattlimit ] || fail "hotplug glbattlimit missing"
[ -x /etc/init.d/glbattlimit ] || fail "init glbattlimit missing"
[ -f /etc/mudimodem/battlimit.json ] || fail "battlimit.json missing"
# Methods present on dofile'd plugin (reuse existing lua stub harness if any)
# Run isolation tests:
#   push test/backend-battlimit.test.lua + test/battlimit-hotplug.test.sh
#   set MUDIMODEM_BATTLIMIT_* env, run lua + sh
```

Mirror how `backend-version.test.lua` is invoked (copy that block, change names/env).

- [ ] **Step 5: Deploy and verify on the box**

```bash
./tools/deploy.sh
ssh -o BatchMode=yes root@mudi 'sh -s' < tools/verify.sh
```

Expected: battlimit section green; no regression in prior sections.

- [ ] **Step 6: Manual smoke (on box, charger optional)**

```bash
ssh root@mudi '/usr/bin/glbattlimit status'
# Via RPC after login, or dofile test:
# set_battlimit enabled=true limit_gui=80 → file written; if plugged, watcher active
# set_battlimit enabled=false → off
```

In the browser: open Modem → Config → Battery card shows capacity; toggle on with charger unplugged → Status “Armed…”; plug in → within one hotplug/poll, Active.

- [ ] **Step 7: Commit**

```bash
git add install.sh uninstall.sh tools/deploy.sh tools/verify.sh
git commit -m "feat(battlimit): install, deploy, uninstall, and verify wiring"
```

---

### Task 6: Docs touch-up (optional, same PR)

**Files:**
- Modify: `CLAUDE.md` §12 current status — note charge-limit Config card shipped
- Modify: `README.md` only if it lists Config features

- [ ] **Step 1: One short bullet under Current status**

```
- ✅ **Battery charge limit (2026-07-22)** — Config tab toggle + GUI % target; ships
  glbattlimit + config-aware hotplug/init; default disabled. Spec:
  docs/superpowers/specs/2026-07-22-battery-charge-limit-design.md
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: note Config battery charge limit"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Toggle + percent | Task 4 |
| Full stack shipped | Tasks 1–2, 5 |
| GUI primary + gauge secondary | Tasks 3–4 (`limit_gauge`, status lines) |
| Default disabled / limit_gui 80 | Tasks 2–3, 5 (default JSON) |
| Apply if plugged; save-only if not | Task 3 `set_battlimit` |
| `battlimit.json` | Tasks 2–3, 5 |
| `get_battlimit` / `set_battlimit` | Task 3 |
| Config card UI | Task 4 |
| install/deploy/uninstall/sysupgrade | Task 5 |
| Tests | Tasks 2–5 |
| No hardcoded 70 | Task 2 |

No TBD placeholders. Method names consistent: `get_battlimit` / `set_battlimit` / `battlimit.json` / `limit_gui`.
