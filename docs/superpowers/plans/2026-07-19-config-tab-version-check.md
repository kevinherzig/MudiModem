# Config Tab + MudiModem Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Config** tab to the MudiModem page showing device model/CPU/modem-type and the installed MudiModem version, with an on-open update check against GitHub `main` and a one-click on-device self-update.

**Architecture:** Device model/CPU come from GL's undotted `system.board` RPC (browser-direct); modem type is already free over `global_sockets`. A new `mudimodem.app_version` backend method compares `/etc/mudimodem/version.json` (installed) against `version.json` on GitHub `main` (latest). Self-update runs the existing idempotent `install.sh` from a **detached, lockdir-guarded** script (`mudimodem-selfupdate`) so it survives the nginx restart the installer triggers; the frontend polls `update_status` for the result.

**Tech Stack:** Plain-JS Vue 2.6 runtime-only chunk (`render(h)`, no template), Lua oui-httpd RPC plugin, POSIX sh, Node `node:test` for the chunk, on-device Lua/sh isolation tests via `tools/verify.sh`.

## Global Constraints

Copied verbatim from CLAUDE.md / the spec. Every task's requirements implicitly include these:

- **Chunk is Vue 2.6 runtime-only:** `render(h)` only, **never `template:`**. The file must be a single expression: `module.exports = { ... };`.
- **Never wrap `oui.ubus.call` in `pcall`** (cosocket yields across a C-call boundary). The new methods use **no ubus**, so `pcall(cjson.decode, …)` is safe — cjson is a plain C function that cannot yield.
- **Deploy transfer is `ssh host 'cat > /path' < file`** — the box has no sftp-server; `scp` fails.
- **Model guard:** any on-box write path must confirm `/proc/device-tree/model` contains `E5800` (192.168.8.1 on this LAN can be a different GL router). `install.sh` already guards; the self-update script inherits the guard by running `install.sh`.
- **After editing the Lua backend, nginx must be RESTARTED, not reloaded** (`reload` leaves stale per-worker plugin copies serving `-32601` for new methods). `deploy.sh`/`install.sh` already do `/etc/init.d/nginx restart`.
- **Shell commands built in Lua/sh must never interpolate an RPC argument.** The GitHub URL is a fixed constant.
- **Durable state lives in `/etc/mudimodem`** and must be registered in `/etc/sysupgrade.conf` (survives firmware upgrade; factory reset wipes regardless).
- **Fail-silent on network errors:** a failed version check sets `error` / `checked=false` and the UI shows only the installed version — no banner, matching `library_status`.
- **Repo raw base:** `https://raw.githubusercontent.com/kevinherzig/MudiModem/main`.

---

## File Structure

| File | Responsibility |
|---|---|
| `version.json` (repo root) | **new** — `{"version":"1.0.0"}`. The single source of truth for the app version. |
| `src/rpc/mudimodem` | **modify** — add `app_version`, `self_update`, `update_status` methods (append after `refresh_library`, before `return M`). |
| `src/sbin/mudimodem-selfupdate` | **new** — detached, lockdir-guarded runner of `install.sh`; writes a result file. |
| `src/views/mudimodem.js` | **modify** — add the `config` tab, its data fields, the tab-open watcher, `renderConfig(h)`, and the fetch/check/update methods. |
| `install.sh` | **modify** — install `version.json` → `/etc/mudimodem/version.json`; install `mudimodem-selfupdate`; register both in `sysupgrade.conf`. |
| `tools/deploy.sh` | **modify** — push `version.json` and `mudimodem-selfupdate` (dev-loop parity). |
| `test/backend-version.test.lua` | **new** — on-device isolation test for `app_version`. |
| `test/selfupdate.test.sh` | **new** — on-device isolation test for the self-update script + `self_update`/`update_status`. |
| `test/backend.test.lua` | **modify** — add the three new methods to the `ALLOWED` whitelist + assert they exist. |
| `test/chunk.test.js` | **modify** — Config-tab render tests (device fields, version line up-to-date + update-available, self-update confirm gate). |
| `tools/verify.sh` | **modify** — assert new methods present, `version.json` installed, selfupdate script present + isolation tests run. |

---

## Task 1: Verify `system.board` on-device (decision gate)

**No code.** This is a required spike: it decides whether device model/CPU come from GL's `system.board` (spec's assumed path) or a fallback backend method. Do it before any frontend work.

**Files:** none (records a decision in this plan).

- [ ] **Step 1: Probe the RPC as root (no web sid needed)**

Run:
```bash
ssh -o BatchMode=yes root@mudi 'ubus call gl-session call '"'"'{"module":"system","func":"board","params":{}}'"'"'' 2>&1 | head -40
# Fallback probe if the above object/func shape differs on this box:
ssh -o BatchMode=yes root@mudi 'ubus call system board 2>&1 | head -40'
```

Expected: JSON containing at least `model` (e.g. `"GL.iNet GL-E5800"` or similar) and `system` (a CPU description string, e.g. `"ARMv8 Processor rev 4 (v8l)"`).

- [ ] **Step 2: Record the decision in this file**

If `system.board` returns `model` + `system`:
- Frontend calls `window.$rpcRequest("call", ["sid", "system", "board", {}])` directly. **No new backend for device info.** Proceed with Task 4 as written.

If it does NOT expose those fields (or `system` object isn't web-callable through `$rpcRequest`):
- Add a `mudimodem.device_info` method to Task 2 that returns `{model, cpu}` by reading `/proc/device-tree/model` (strip NULs) and the first `model name`/`Hardware`/`Processor` line of `/proc/cpuinfo`. Task 4's `fetchDeviceInfo` then calls `["sid","mudimodem","device_info",{}]` instead of `system.board`. Add it to the `ALLOWED` list in Task 5.

Write one line under this task: `DECISION: <system.board | device_info fallback> — <fields observed>`.

**DECISION (2026-07-19): `device_info` fallback.** The browser-facing `system` oui-httpd rpc object
(a Lua plugin) exposes `get_info`/`get_status`/… but **no `board` method** — `board` is only
reachable via ubus from a shell, not through `/rpc`/`$rpcRequest`. And `/proc/cpuinfo` on this
aarch64 box has no `model name`/`Hardware`/`Processor` line (only `CPU part`/`CPU implementer`), so
the readable CPU string must come from `ubus call system board` (`.system` = `"ARMv8 Processor rev 0"`;
`.model` = `"GL.iNet E5800, Qualcomm Technologies, Inc. SDXPINN IDP MBB"`). Therefore `device_info`
is implemented as a **server-side ubus `system board` call** (Task 2), and Task 4's `fetchDeviceInfo`
calls `mudimodem.device_info` (reading `r.model`/`r.cpu`), not `system.board`.

- [ ] **Step 3: Commit the decision note**

```bash
git add docs/superpowers/plans/2026-07-19-config-tab-version-check.md
git commit -m "docs(plan): record system.board probe decision for Config tab"
```

---

## Task 2: `version.json` + `app_version` backend method

**Files:**
- Create: `version.json` (repo root)
- Modify: `src/rpc/mudimodem` (append new method block before the final `return M`)
- Modify: `install.sh` (install + register `version.json`)
- Modify: `tools/deploy.sh` (push `version.json`)
- Test: `test/backend-version.test.lua` (new)

**Interfaces:**
- Produces:
  - `mudimodem.app_version(args) → { installed, latest, update_available, checked, error? }` where `installed`/`latest` are strings (or `installed="unknown"`), `update_available`/`checked` are booleans, `error` is a string present only on failure. Consumed by the frontend in Task 4 and asserted in Task 5's ALLOWED list.
  - `mudimodem.device_info(args) → { model, cpu }` (both strings, `""` on failure) via a server-side ubus `system board` call (per Task 1's decision). Consumed by Task 4's `fetchDeviceInfo`; added to Task 5's ALLOWED list.

- [ ] **Step 1: Create `version.json`**

Create `version.json` at the repo root:
```json
{"version": "1.0.0"}
```

- [ ] **Step 2: Write the failing backend test**

Create `test/backend-version.test.lua`. It stubs `oui.ubus` (the plugin `require`s it at load), points the version-file and curl at test doubles, and asserts each branch. `MUDIMODEM_CURL` is set to a wrapper script the test writes, which ignores its args and prints a fixture — so no network is touched.

```lua
-- On-device isolation test for mudimodem.app_version + device_info.
-- dofiles the REAL plugin with oui.ubus shimmed (app_version uses no ubus;
-- device_info calls ubus system board, which the shim answers). Overrides
-- VERSION_FILE + CURL via env so the check is deterministic and offline.
-- Run by verify.sh. Exit 0 = pass.
package.loaded["oui.ubus"] = { call = function(obj, method)
  if obj == "system" and method == "board" then
    return { model = "GL.iNet E5800 TEST", system = "ARMv8 TEST" }
  end
  return nil, "unused"
end }

local TMP = os.getenv("MM_TMP") or "/tmp/mm-ver-test"
os.execute("rm -rf " .. TMP .. "; mkdir -p " .. TMP)

-- A fake curl: ignores every arg, prints whatever is in $TMP/remote.json.
local curl = TMP .. "/curl.sh"
local cf = assert(io.open(curl, "w"))
cf:write("#!/bin/sh\ncat " .. TMP .. "/remote.json\n")
cf:close()
os.execute("chmod +x " .. curl)

local function writef(path, s) local f = assert(io.open(path, "w")); f:write(s); f:close() end

-- Env (MUDIMODEM_VERSION_FILE, MUDIMODEM_CURL, MM_PLUGIN) is set by the ssh
-- wrapper in verify.sh; the plugin reads it via os.getenv at load + call time.
local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.app_version) == "function", "app_version missing")

-- Case A: installed != latest  -> update_available true, checked true.
writef(os.getenv("MUDIMODEM_VERSION_FILE"), '{"version":"1.0.0"}')
writef(TMP .. "/remote.json", '{"version":"1.0.2"}')
local a = M.app_version({})
assert(a.installed == "1.0.0", "A installed: " .. tostring(a.installed))
assert(a.latest == "1.0.2", "A latest: " .. tostring(a.latest))
assert(a.checked == true, "A checked")
assert(a.update_available == true, "A update_available")
assert(a.error == nil, "A no error")

-- Case B: installed == latest  -> update_available false.
writef(TMP .. "/remote.json", '{"version":"1.0.0"}')
local b = M.app_version({})
assert(b.update_available == false, "B up to date")
assert(b.checked == true, "B checked")

-- Case C: malformed remote     -> fail-silent (error set, not checked).
writef(TMP .. "/remote.json", 'not json')
local c = M.app_version({})
assert(c.checked == false, "C not checked")
assert(c.update_available == false, "C no update on failure")
assert(type(c.error) == "string", "C error string")
assert(c.installed == "1.0.0", "C still reports installed")

-- Case D: missing local version file -> installed "unknown".
os.remove(os.getenv("MUDIMODEM_VERSION_FILE"))
writef(TMP .. "/remote.json", '{"version":"1.0.2"}')
local d = M.app_version({})
assert(d.installed == "unknown", "D installed unknown: " .. tostring(d.installed))

-- Case E: device_info returns model + cpu from the ubus board shim.
assert(type(M.device_info) == "function", "device_info missing")
local dv = M.device_info({})
assert(dv.model == "GL.iNet E5800 TEST", "E device_info model: " .. tostring(dv.model))
assert(dv.cpu == "ARMv8 TEST", "E device_info cpu: " .. tostring(dv.cpu))

os.execute("rm -rf " .. TMP)
print("backend-version OK")
```

- [ ] **Step 3: Run the test — verify it fails**

The plugin has no `app_version` yet, so it must fail at the first assertion. Run on-device (deploy the current plugin first if needed):
```bash
ssh -o BatchMode=yes root@mudi 'cat > /tmp/mm-ver.test.lua' < test/backend-version.test.lua
ssh -o BatchMode=yes root@mudi 'MM_TMP=/tmp/mm-ver-test MUDIMODEM_VERSION_FILE=/tmp/mm-ver-test/local.json MUDIMODEM_CURL=/tmp/mm-ver-test/curl.sh lua /tmp/mm-ver.test.lua; rc=$?; rm -f /tmp/mm-ver.test.lua; exit $rc'
```
Expected: FAIL with `app_version missing`.

- [ ] **Step 4: Implement `app_version` in the backend**

In `src/rpc/mudimodem`, immediately **before** the final `return M` line, append:

```lua
-- ======================= Phase 5: MudiModem version check ====================
-- app_version reads the installed version from a local file and the latest from
-- version.json on GitHub main. No ubus here (a plain file read + a curl
-- subprocess), so pcall(cjson.decode, ...) is safe (§8: pcall is only unsafe
-- around a ubus cosocket call). The URL is a fixed constant — no RPC arg reaches
-- the shell. Fail-silent: any network/parse failure sets error + checked=false.
local VERSION_FILE = os.getenv("MUDIMODEM_VERSION_FILE") or "/etc/mudimodem/version.json"
local VERSION_URL  = os.getenv("MUDIMODEM_VERSION_URL")
  or "https://raw.githubusercontent.com/kevinherzig/MudiModem/main/version.json"
local CURL         = os.getenv("MUDIMODEM_CURL") or "curl"

local function read_version_file()
  local f = io.open(VERSION_FILE, "r")
  if not f then return "unknown" end
  local s = f:read("*a") or ""
  f:close()
  local ok, obj = pcall(cjson.decode, s)   -- cjson.decode can't yield; pcall safe (§8)
  if ok and type(obj) == "table" and obj.version then return tostring(obj.version) end
  return "unknown"
end

function M.app_version(args)
  local out = { installed = read_version_file(), latest = nil,
                update_available = false, checked = false }
  -- Fixed URL, shell-escaped defensively even though it never contains user input.
  local q = "'" .. VERSION_URL:gsub("'", "'\\''") .. "'"
  local f = io.popen(CURL .. " -fsS --max-time 8 " .. q .. " 2>/dev/null")
  if not f then out.error = "curl spawn failed"; return out end
  local body = f:read("*a") or ""
  f:close()
  local ok, obj = pcall(cjson.decode, body)
  if not ok or type(obj) ~= "table" or not obj.version then
    out.error = "remote version.json unreachable or malformed"
    return out
  end
  out.latest = tostring(obj.version)
  out.checked = true
  out.update_available = (out.latest ~= out.installed)
  return out
end

-- device_info: model + CPU for the Config tab. The browser-facing `system` rpc
-- object has no `board` method, so we read it server-side via ubus. This IS a
-- ubus call — NEVER wrap it in pcall (§8: cosocket yields across the C-call
-- boundary). ubus.call returns (nil, err) on failure without throwing.
function M.device_info(args)
  local r = ubus.call("system", "board", {})
  if type(r) ~= "table" then return { model = "", cpu = "" } end
  return { model = r.model or "", cpu = r.system or "" }
end
```

- [ ] **Step 5: Deploy the backend and re-run the test — verify it passes**

```bash
ssh -o BatchMode=yes root@mudi 'cat > /usr/lib/oui-httpd/rpc/mudimodem' < src/rpc/mudimodem
ssh -o BatchMode=yes root@mudi 'cat > /tmp/mm-ver.test.lua' < test/backend-version.test.lua
ssh -o BatchMode=yes root@mudi 'MM_TMP=/tmp/mm-ver-test MUDIMODEM_VERSION_FILE=/tmp/mm-ver-test/local.json MUDIMODEM_CURL=/tmp/mm-ver-test/curl.sh lua /tmp/mm-ver.test.lua; rc=$?; rm -f /tmp/mm-ver.test.lua; exit $rc'
```
Expected: `backend-version OK`.

- [ ] **Step 6: Wire `version.json` into `install.sh`**

In `install.sh`, in the `echo "installing view chunks + menu + library:"` block (after the `gz_install` lines, near line 39), add:
```sh
cp_install version.json /etc/mudimodem/version.json 0644
```
Then add `/etc/mudimodem/version.json` to the `for p in \ … ; do` sysupgrade registration list (near line 68), on its own continuation line:
```sh
  /etc/mudimodem/version.json \
```

- [ ] **Step 7: Wire `version.json` into `tools/deploy.sh`**

In `tools/deploy.sh`, near the library-tool push, add:
```sh
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /etc/mudimodem && cat > /etc/mudimodem/version.json' \
  < version.json
echo "version.json deployed (/etc/mudimodem/version.json)"
```
Also add `/etc/mudimodem/version.json` to deploy.sh's own `sysupgrade.conf` `for p in` list (mirrors install.sh).

- [ ] **Step 8: Deploy version.json and confirm a real (network) check works**

```bash
ssh -o BatchMode=yes root@mudi 'mkdir -p /etc/mudimodem && cat > /etc/mudimodem/version.json' < version.json
# Note: this will report update_available=true until version.json is pushed to GitHub main.
ssh -o BatchMode=yes root@mudi 'lua -e '"'"'local u=require"oui.ubus"'"'"' 2>/dev/null; echo skip-direct'
```
The authoritative live check happens through `/rpc` in Task 5's verify step; here just confirm the file is in place:
```bash
ssh -o BatchMode=yes root@mudi 'cat /etc/mudimodem/version.json'
```
Expected: `{"version": "1.0.0"}`.

- [ ] **Step 9: Commit**

```bash
git add version.json src/rpc/mudimodem test/backend-version.test.lua install.sh tools/deploy.sh
git commit -m "feat(backend): app_version — installed vs GitHub-main version check"
```

---

## Task 3: `mudimodem-selfupdate` script + `self_update`/`update_status` backend

**Files:**
- Create: `src/sbin/mudimodem-selfupdate`
- Modify: `src/rpc/mudimodem` (append two methods before `return M`)
- Modify: `install.sh` (install + register the script)
- Modify: `tools/deploy.sh` (push the script)
- Test: `test/selfupdate.test.sh` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `mudimodem.self_update(args) → { ok = true, started = true }` (launches the detached script, returns immediately).
  - `mudimodem.update_status(args) → { in_progress = <bool>, result = <table|nil> }` where `result` (when present) is `{ ok = <bool>, finished_at = <string>, error? = <string> }`.
  - `/usr/sbin/mudimodem-selfupdate` — detached script; on completion writes `update-result.json` and removes the lockdir. Env overrides: `MUDIMODEM_UPDATE_LOCK`, `MUDIMODEM_UPDATE_RESULT`, `MUDIMODEM_UPDATE_LOG`, `MUDIMODEM_UPDATE_CMD`.

- [ ] **Step 1: Write the failing script isolation test**

Create `test/selfupdate.test.sh`. It runs the script with all paths + the install command overridden to a test double, and asserts: success writes a result with `"ok":true`; a second concurrent run is blocked by the lockdir; a failing command writes `"ok":false` with an error.

```sh
#!/bin/sh
# Isolation test for mudimodem-selfupdate. All paths + the install command are
# overridden via env so nothing real is fetched or installed. $1 = script path.
set -u
SCRIPT="${1:-/usr/sbin/mudimodem-selfupdate}"
T=$(mktemp -d)
LOCK="$T/lock.d"; RESULT="$T/result.json"; LOG="$T/update.log"
fail() { echo "FAIL: $1" >&2; rm -rf "$T"; exit 1; }

# --- success path: command exits 0 -> result ok:true, lock cleaned up ---
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="true" \
  sh "$SCRIPT"
[ -f "$RESULT" ] || fail "no result file after success"
grep -q '"ok":true' "$RESULT" || fail "success did not record ok:true ($(cat "$RESULT"))"
[ -d "$LOCK" ] && fail "lockdir not removed after success"

# --- failure path: command exits nonzero -> result ok:false + error ---
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="sh -c 'echo boom >&2; exit 7'" \
  sh "$SCRIPT"
grep -q '"ok":false' "$RESULT" || fail "failure did not record ok:false ($(cat "$RESULT"))"
grep -q '"error"' "$RESULT" || fail "failure did not record an error field"

# --- concurrency: a pre-existing lockdir makes the script a no-op ---
mkdir -p "$LOCK"
rm -f "$RESULT"
MUDIMODEM_UPDATE_LOCK="$LOCK" MUDIMODEM_UPDATE_RESULT="$RESULT" \
MUDIMODEM_UPDATE_LOG="$LOG" MUDIMODEM_UPDATE_CMD="true" \
  sh "$SCRIPT"
[ -f "$RESULT" ] && fail "second run ran despite existing lockdir"
rmdir "$LOCK"

rm -rf "$T"
echo "selfupdate OK"
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
ssh -o BatchMode=yes root@mudi 'cat > /tmp/mm-su.test.sh' < test/selfupdate.test.sh
ssh -o BatchMode=yes root@mudi 'sh /tmp/mm-su.test.sh /usr/sbin/mudimodem-selfupdate; rc=$?; rm -f /tmp/mm-su.test.sh; exit $rc'
```
Expected: FAIL (script does not exist yet — `sh: can't open` or a missing-result failure).

- [ ] **Step 3: Write the script**

Create `src/sbin/mudimodem-selfupdate`:

```sh
#!/bin/sh
# /usr/sbin/mudimodem-selfupdate — detached MudiModem self-update.
#
# Runs the idempotent, model-guarded install.sh from GitHub main. Launched
# DETACHED by the mudimodem.self_update RPC method: install.sh ends with an
# nginx restart, which would kill the /rpc connection if run in-handler.
#
# An atomic lockdir (mkdir is atomic) guards against double-click / concurrency.
# The result is written to a state file the mudimodem.update_status method polls.
# The install URL is a FIXED constant — no RPC argument reaches this shell.
set -u

LOCK="${MUDIMODEM_UPDATE_LOCK:-/etc/mudimodem/update.lock.d}"
RESULT="${MUDIMODEM_UPDATE_RESULT:-/etc/mudimodem/update-result.json}"
LOG="${MUDIMODEM_UPDATE_LOG:-/var/log/mudimodem-update.log}"
CMD="${MUDIMODEM_UPDATE_CMD:-curl -fsSL https://raw.githubusercontent.com/kevinherzig/MudiModem/main/install.sh | sh}"

# Atomic lock: if the dir already exists another update is in flight — no-op.
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
# Always release the lock, however we exit.
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

: > "$LOG"
if sh -c "$CMD" >> "$LOG" 2>&1; then
  printf '{"ok":true,"finished_at":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$RESULT"
else
  rc=$?
  # Escape the log tail for JSON: drop double-quotes and backslashes, collapse newlines.
  tail=$(tail -n 3 "$LOG" 2>/dev/null | tr '\n' ' ' | tr -d '"\\')
  printf '{"ok":false,"finished_at":"%s","error":"install failed (rc=%s): %s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$rc" "$tail" > "$RESULT"
fi
```

- [ ] **Step 4: Run the script test — verify it passes**

```bash
ssh -o BatchMode=yes root@mudi 'cat > /usr/sbin/mudimodem-selfupdate && chmod 0755 /usr/sbin/mudimodem-selfupdate' < src/sbin/mudimodem-selfupdate
ssh -o BatchMode=yes root@mudi 'cat > /tmp/mm-su.test.sh' < test/selfupdate.test.sh
ssh -o BatchMode=yes root@mudi 'sh /tmp/mm-su.test.sh /usr/sbin/mudimodem-selfupdate; rc=$?; rm -f /tmp/mm-su.test.sh; exit $rc'
```
Expected: `selfupdate OK`.

- [ ] **Step 5: Add `self_update` + `update_status` to the backend**

In `src/rpc/mudimodem`, before the final `return M` (after the `app_version` block from Task 2), append:

```lua
-- self_update launches the detached self-update script and returns at once
-- (install.sh restarts nginx; running it in-handler would drop this connection).
-- update_status polls the lockdir + result file the script writes. No ubus here,
-- so no cosocket concern. The script path is a fixed constant.
local SELFUPDATE_BIN = os.getenv("MUDIMODEM_SELFUPDATE_BIN") or "/usr/sbin/mudimodem-selfupdate"
local UPDATE_LOCK    = os.getenv("MUDIMODEM_UPDATE_LOCK")   or "/etc/mudimodem/update.lock.d"
local UPDATE_RESULT  = os.getenv("MUDIMODEM_UPDATE_RESULT") or "/etc/mudimodem/update-result.json"

function M.self_update(args)
  os.execute("mkdir -p /etc/mudimodem 2>/dev/null")
  -- Fresh run: clear any stale result so update_status reflects THIS attempt.
  os.remove(UPDATE_RESULT)
  os.execute(SELFUPDATE_BIN .. " >/dev/null 2>&1 &")
  return { ok = true, started = true }
end

function M.update_status(args)
  -- lockdir present => an update is running.
  local lock = io.open(UPDATE_LOCK .. "/.", "r")
  local in_progress = false
  if lock then lock:close(); in_progress = true
  else
    -- io.open on a directory path is unreliable; probe with a shell test instead.
    in_progress = (os.execute("[ -d '" .. UPDATE_LOCK .. "' ]") == 0
                or os.execute("[ -d '" .. UPDATE_LOCK .. "' ]") == true)
  end
  local result = nil
  local f = io.open(UPDATE_RESULT, "r")
  if f then
    local s = f:read("*a") or ""; f:close()
    local ok, obj = pcall(cjson.decode, s)
    if ok and type(obj) == "table" then result = obj end
  end
  return { in_progress = in_progress, result = result }
end
```

Note: `os.execute` return convention differs between Lua 5.1 (returns exit code number, `0`=success) and 5.2+ (returns `true`/`nil` plus signal). The `== 0 or == true` covers both. The box runs the OpenWrt Lua build; the `[ -d ]` probe is the reliable directory test regardless.

- [ ] **Step 6: Deploy the backend and smoke-test the two methods on-device**

```bash
ssh -o BatchMode=yes root@mudi 'cat > /usr/lib/oui-httpd/rpc/mudimodem' < src/rpc/mudimodem
# Isolate paths so this does NOT trigger a real install; assert update_status shape.
ssh -o BatchMode=yes root@mudi 'MUDIMODEM_UPDATE_LOCK=/tmp/mmu-lock.d MUDIMODEM_UPDATE_RESULT=/tmp/mmu-result.json lua -e '\''package.loaded["oui.ubus"]={call=function()end}; local M=dofile("/usr/lib/oui-httpd/rpc/mudimodem"); local s=M.update_status({}); assert(type(s)=="table" and s.in_progress==false and s.result==nil, "update_status shape"); print("update_status OK")'\'''
```
Expected: `update_status OK`.

- [ ] **Step 7: Wire the script into `install.sh` and `tools/deploy.sh`**

In `install.sh`, in the `echo "installing watchdog + validator + backend:"` block (alongside `mudimodem-revert`, before the backend), add:
```sh
cp_install src/sbin/mudimodem-selfupdate /usr/sbin/mudimodem-selfupdate 0755
```
Add `/usr/sbin/mudimodem-selfupdate` to install.sh's sysupgrade `for p in` list.

In `tools/deploy.sh`, next to the `mudimodem-revert` push, add:
```sh
if [ -f src/sbin/mudimodem-selfupdate ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/sbin/mudimodem-selfupdate && chmod 0755 /usr/sbin/mudimodem-selfupdate' \
    < src/sbin/mudimodem-selfupdate
  echo "self-update script installed (/usr/sbin/mudimodem-selfupdate)"
fi
```
Add `/usr/sbin/mudimodem-selfupdate` to deploy.sh's sysupgrade `for p in` list.

- [ ] **Step 8: Commit**

```bash
git add src/sbin/mudimodem-selfupdate src/rpc/mudimodem test/selfupdate.test.sh install.sh tools/deploy.sh
git commit -m "feat(backend): self_update + update_status via detached lockdir-guarded script"
```

---

## Task 4: Config tab frontend

**Files:**
- Modify: `src/views/mudimodem.js` (data fields, `TABS`, tab watcher, `renderConfig`, methods)
- Test: `test/chunk.test.js` (new Config-tab tests)

**Interfaces:**
- Consumes: `mudimodem.app_version`, `mudimodem.self_update`, `mudimodem.update_status` (Tasks 2–3); GL's `system.board` (Task 1 decision) or `mudimodem.device_info` fallback; `moduleStatus("cellular.modems_info").modems[0].name` (already in the store).
- Produces: a rendered `config` tab. No downstream consumers.

- [ ] **Step 1: Write the failing chunk tests**

In `test/chunk.test.js`, after the existing tests, add. These use the existing `makeVm`, `stubRpc`, `h`, `textOf`, `walk`, `LIVE` helpers already in the file.

```js
test('config tab renders device info from the store + system.board', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);           // modem name RG650V-NA is in modems_info
  vm.tab = 'config';
  vm.deviceInfo = { model: 'GL.iNet GL-E5800', cpu: 'ARMv8 Processor rev 4' };
  vm.appVer = { installed: '1.0.0', latest: null, update_available: false, checked: false };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /GL-E5800/, 'shows the device model');
  assert.match(txt, /ARMv8/, 'shows the CPU');
  assert.match(txt, /RG650V-NA/, 'shows the modem type from modems_info');
});

test('config tab shows installed version alone when up to date / not yet checked', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'config';
  vm.appVer = { installed: '1.0.0', latest: '1.0.0', update_available: false, checked: true };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /MudiModem v1\.0\.0/, 'shows installed version');
  assert.doesNotMatch(txt, /available/, 'no update clause when up to date');
});

test('config tab shows the update-available clause + Update now', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'config';
  vm.appVer = { installed: '1.0.0', latest: '1.0.2', update_available: true, checked: true };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /MudiModem v1\.0\.0/, 'installed version');
  assert.match(txt, /1\.0\.2 available/, 'latest version clause');
  assert.match(txt, /Update now/, 'offers the update action');
});

test('config tab: failed version check shows installed only (fail-silent)', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'config';
  vm.appVer = { installed: '1.0.0', latest: null, update_available: false, checked: false, error: 'offline' };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /MudiModem v1\.0\.0/, 'still shows installed');
  assert.doesNotMatch(txt, /available/, 'no update clause on failed check');
  assert.doesNotMatch(txt, /offline/, 'never surfaces the error text');
});

test('config tab: Update now arms a confirm step before calling self_update', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'config';
  vm.appVer = { installed: '1.0.0', latest: '1.0.2', update_available: true, checked: true };
  // First click arms confirm — no RPC yet.
  vm.armUpdate();
  assert.strictEqual(vm.updateConfirm, true, 'first click arms confirm');
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /confirm/i, 'shows the confirm affordance');
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
node --test test/chunk.test.js 2>&1 | grep -E "config tab|fail" | head
```
Expected: the five new `config tab …` tests FAIL (`vm.tab='config'` renders "Unknown tab"; `armUpdate` undefined).

- [ ] **Step 3: Add the data fields**

In `src/views/mudimodem.js`, inside `data()`'s returned object (near the other tab state, e.g. after the SIM block around line 84), add:
```js
      // ---- Config tab (Phase 5) ----
      deviceInfo: null,       // { model, cpu } — fetched once via system.board
      deviceErr: "",
      appVer: null,           // app_version result { installed, latest, update_available, checked, error? }
      updateConfirm: false,   // "Update now" armed, awaiting a second click
      updateConfirmTimer: null,
      updating: false,        // self_update in flight / polling
      updateMsg: "",          // final status line after an update attempt
      updatePollTimer: null,
```

- [ ] **Step 4: Register the tab**

In the `render`, extend `TABS` (around line 1818):
```js
    var TABS = [["tracking", "Tracking"], ["sim", "SIM"], ["lock", "Cell lock"],
      ["bands", "Bands"], ["at", "AT console"], ["config", "Config"]];
```

- [ ] **Step 5: Dispatch the panel**

In `render`'s panel dispatch (near line 1851, alongside the `sim` branch), add before the final `else`:
```js
    } else if (this.tab === "config") {
      panel = this.renderConfig(h);
```

- [ ] **Step 6: Fetch on tab open**

In the `watch.tab(t)` handler (around line 254), add:
```js
      if (t === "config") {
        if (!this.deviceInfo && !this.deviceErr) this.fetchDeviceInfo();
        this.checkAppVersion();   // re-check every open, per spec
      }
```

- [ ] **Step 7: Add the methods**

In `methods`, add (place near the other fetch methods). Per Task 1's decision, `fetchDeviceInfo`
calls our own `mudimodem.device_info` (the browser-facing `system` rpc has no `board` method).

```js
    modemName() {
      return (this.modem && this.modem.name) || "";   // this.modem already exists (computed)
    },
    fetchDeviceInfo() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return Promise.resolve();
      return window.$rpcRequest("call", ["sid", "mudimodem", "device_info", {}], { timeout: 8000 })
        .then(function (r) {
          self.deviceInfo = { model: (r && r.model) || "", cpu: (r && r.cpu) || "" };
        })
        .catch(function (e) { self.deviceErr = (e && (e.message || e.type)) || "unavailable"; });
    },
    checkAppVersion() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return Promise.resolve();
      return window.$rpcRequest("call", ["sid", "mudimodem", "app_version", {}], { timeout: 12000 })
        .then(function (r) { self.appVer = r || null; })
        .catch(function () { /* fail-silent: keep whatever we had, show installed only */ });
    },
    armUpdate() {
      var self = this;
      if (this.updateConfirm) return;         // already armed
      this.updateConfirm = true;
      if (this.updateConfirmTimer) clearTimeout(this.updateConfirmTimer);
      this.updateConfirmTimer = setTimeout(function () { self.updateConfirm = false; }, 5000);
    },
    confirmUpdate() {
      var self = this;
      this.updateConfirm = false;
      if (this.updateConfirmTimer) { clearTimeout(this.updateConfirmTimer); this.updateConfirmTimer = null; }
      if (this.updating || typeof window === "undefined" || !window.$rpcRequest) return Promise.resolve();
      this.updating = true; this.updateMsg = "Updating…";
      return window.$rpcRequest("call", ["sid", "mudimodem", "self_update", {}], { timeout: 12000 })
        .then(function () { self.pollUpdate(); })
        .catch(function (e) {
          self.updating = false;
          self.updateMsg = "Couldn't start update: " + ((e && (e.message || e.type)) || "error");
        });
    },
    pollUpdate() {
      var self = this;
      if (this.updatePollTimer) clearTimeout(this.updatePollTimer);
      this.updatePollTimer = setTimeout(function () {
        window.$rpcRequest("call", ["sid", "mudimodem", "update_status", {}], { timeout: 8000 })
          .then(function (s) {
            if (s && s.result) {
              self.updating = false;
              if (s.result.ok) {
                var v = (self.appVer && self.appVer.latest) || "";
                self.updateMsg = "Updated" + (v ? " to v" + v : "") + " — reload the page to load the new version.";
              } else {
                self.updateMsg = "Update failed: " + (s.result.error || "unknown") +
                  " — see /var/log/mudimodem-update.log";
              }
            } else {
              self.pollUpdate();   // still running (or nginx mid-restart) — keep polling
            }
          })
          .catch(function () { self.pollUpdate(); });   // nginx restart drops a request; retry
      }, 3000);
    },
```

- [ ] **Step 8: Add `renderConfig`**

Add to `methods`. Uses GL theme tokens via the existing `mm-card` classes already defined in the chunk's stylesheet.

```js
    renderConfig(h) {
      var self = this;
      var row = function (label, value) {
        return h("div", { staticClass: "mm-kv" }, [
          h("span", { staticClass: "mm-k" }, label),
          h("span", { staticClass: "mm-v" }, value || "—")
        ]);
      };

      // --- Device card ---
      var di = this.deviceInfo || {};
      var device = h("div", { staticClass: "mm-card" }, [
        h("div", { staticClass: "mm-card-h" }, "Device"),
        row("Model", di.model),
        row("CPU", di.cpu),
        row("Modem", this.modemName())
      ]);

      // --- MudiModem / version card ---
      var av = this.appVer || {};
      var installed = av.installed || "unknown";
      var verNodes = [h("span", {}, "MudiModem "
        + (installed === "unknown" ? "(version unknown)" : "v" + installed))];
      if (av.checked && av.update_available && av.latest) {
        verNodes.push(h("span", { staticClass: "mm-upd" }, [
          " (v" + av.latest + " available — ",
          this.updateConfirm
            ? h("a", { staticClass: "mm-link mm-warn", attrs: { href: "#" },
                on: { click: function (e) { if (e.preventDefault) e.preventDefault(); self.confirmUpdate(); } } },
                "click to confirm — briefly restarts the admin panel")
            : h("a", { staticClass: "mm-link", attrs: { href: "#" },
                on: { click: function (e) { if (e.preventDefault) e.preventDefault(); self.armUpdate(); } } },
                "Update now"),
          ")"
        ]));
      }
      var verLine = h("div", { staticClass: "mm-kv" }, verNodes);

      var cardKids = [h("div", { staticClass: "mm-card-h" }, "MudiModem"), verLine];
      if (this.updateMsg) {
        cardKids.push(h("div", { staticClass: "mm-note" }, this.updateMsg));
      }
      var app = h("div", { staticClass: "mm-card" }, cardKids);

      return h("div", {}, [device, app]);
    },
```

- [ ] **Step 9: Clean up timers on destroy**

In `beforeDestroy` (line 276), extend:
```js
  beforeDestroy() {
    this.clearCountdown(); this.clearSwitchState();
    if (this.updateConfirmTimer) clearTimeout(this.updateConfirmTimer);
    if (this.updatePollTimer) clearTimeout(this.updatePollTimer);
  },
```

- [ ] **Step 10: Add minimal styles**

Find the chunk's CSS string (search for `.mm-card{` / the `injectStyle` block) and add these rules to it (reuse existing tokens; the `mm-card`/`mm-card-h` classes already exist — only add what's new):
```css
.mm-kv{display:flex;gap:12px;padding:4px 0;font-size:14px}
.mm-k{color:var(--text-hint);min-width:64px}
.mm-v{color:var(--text)}
.mm-link{color:var(--primary);cursor:pointer;text-decoration:underline}
.mm-warn{color:var(--warning)}
.mm-upd{color:var(--text-hint)}
.mm-note{margin-top:8px;color:var(--text-hint);font-size:13px}
```
(If `.mm-k`/`.mm-v`/`.mm-note` already exist in the stylesheet, skip the duplicates — check first with a search.)

- [ ] **Step 11: Run the chunk tests — verify they pass**

```bash
node --test test/chunk.test.js 2>&1 | tail -20
```
Expected: all tests pass, including the five new `config tab …` tests.

- [ ] **Step 12: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "feat(ui): Config tab — device info + version check + self-update"
```

---

## Task 5: verify.sh assertions + full deploy + on-device acceptance

**Files:**
- Modify: `test/backend.test.lua` (ALLOWED whitelist)
- Modify: `tools/verify.sh` (new assertions)

**Interfaces:**
- Consumes: everything from Tasks 2–4.

- [ ] **Step 1: Extend the backend method whitelist**

In `test/backend.test.lua`, update the `ALLOWED` table (around line 22) to include the three new methods, and add existence assertions after the `get_bands` one:
```lua
local ALLOWED = { get_bands = true, set_bands = true, confirm = true, revert_now = true, get_history = true, at_console = true,
                  get_lock = true, set_cell_lock = true, clear_cell_lock = true, scan_cells = true,
                  library_status = true, refresh_library = true,
                  app_version = true, device_info = true, self_update = true, update_status = true }
```
And after `assert(type(M.get_bands) == "function", "get_bands missing")`:
```lua
assert(type(M.app_version) == "function", "app_version missing")
assert(type(M.device_info) == "function", "device_info missing")
assert(type(M.self_update) == "function", "self_update missing")
assert(type(M.update_status) == "function", "update_status missing")
```

- [ ] **Step 2: Add verify.sh assertions (new section 10)**

At the end of `tools/verify.sh` (before any final success echo), add:
```sh
# 10. Phase 5: Config tab / version check / self-update.
echo "10. Phase 5: version check + self-update"
ssh -o BatchMode=yes "root@$HOST" 'test -s /etc/mudimodem/version.json' \
  || fail "version.json not installed (run ./tools/deploy.sh)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-selfupdate' \
  || fail "self-update script not installed"
ssh -o BatchMode=yes "root@$HOST" 'grep -q "function M.app_version" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.device_info" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.self_update" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.update_status" /usr/lib/oui-httpd/rpc/mudimodem' \
  || fail "backend missing app_version/device_info/self_update/update_status"

echo "10a. app_version isolation test (offline, fake curl)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-ver.test.lua' < test/backend-version.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MM_TMP=/tmp/mm-ver-test MUDIMODEM_VERSION_FILE=/tmp/mm-ver-test/local.json MUDIMODEM_CURL=/tmp/mm-ver-test/curl.sh lua /tmp/mm-ver.test.lua; rc=$?; rm -rf /tmp/mm-ver.test.lua /tmp/mm-ver-test; exit $rc' \
  || fail "app_version isolation test failed"

echo "10b. self-update script isolation test (no real install)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-su.test.sh' < test/selfupdate.test.sh
ssh -o BatchMode=yes "root@$HOST" 'sh /tmp/mm-su.test.sh /usr/sbin/mudimodem-selfupdate; rc=$?; rm -f /tmp/mm-su.test.sh; exit $rc' \
  || fail "self-update isolation test failed"

echo "10c. app_version answers over /rpc (real network; fail-silent tolerated)"
ssh -o BatchMode=yes "root@$HOST" 'lua -e '\''package.loaded["oui.ubus"]={call=function()end}; local M=dofile("/usr/lib/oui-httpd/rpc/mudimodem"); local r=M.app_version({}); assert(type(r)=="table" and r.installed~=nil, "app_version shape"); print("app_version live shape OK: installed="..tostring(r.installed).." checked="..tostring(r.checked))'\''' \
  || fail "app_version live shape check failed"
```

- [ ] **Step 3: Full deploy**

```bash
./tools/deploy.sh
```
Expected: pushes all files (including `version.json` and `mudimodem-selfupdate`), restarts nginx, no errors.

- [ ] **Step 4: Run the full verification suite**

```bash
./tools/verify.sh
```
Expected: all sections pass, including the new section 10 (and the existing section 5 backend test, now with the extended ALLOWED list).

- [ ] **Step 5: Manual browser acceptance**

Reload the GL admin, open **Modem → Config**. Confirm:
- Device card shows Model, CPU, Modem (RG650V-NA).
- MudiModem line shows `v1.0.0`. (Until `version.json` is pushed to GitHub `main`, the check may show an "available" clause or none, depending on what `main` currently holds — that's expected pre-publish.)
- Clicking **Update now** shows the confirm affordance; it reverts after ~5 s if not clicked again. **Do not confirm the real update** during acceptance unless intentionally testing the full install (it restarts nginx and re-pulls from `main`).

- [ ] **Step 6: Commit**

```bash
git add test/backend.test.lua tools/verify.sh
git commit -m "test(verify): assert version-check + self-update backend, scripts, isolation"
```

- [ ] **Step 7: Publish `version.json` to GitHub main (release step)**

Once merged, ensure `version.json` is present on `main` so installed devices' checks resolve. Bump its `version` on each release-worthy change thereafter. (This is the manual release discipline the spec calls for — no automation.)

---

## Self-Review

**Spec coverage:**
- Config tab with Device + MudiModem sections → Task 4 (`renderConfig`). ✅
- Device model/CPU via `system.board` (+ fallback) → Task 1 decision + Task 4 `fetchDeviceInfo`. ✅
- Modem type free from `modems_info` → Task 4 `modemName()`. ✅
- Installed vs latest version, `version.json` on main, `app_version` fail-silent → Task 2. ✅
- Check on every tab open → Task 4 Step 6 watcher. ✅
- Version line format `v1.0.0 (v1.0.2 available — Update now)` → Task 4 `renderConfig` + tests. ✅
- Self-update: detached lockdir script + `self_update`/`update_status`, two-step confirm, poll, no auto-reload → Task 3 + Task 4. ✅
- `install.sh`/`deploy.sh` install + `sysupgrade.conf` registration → Tasks 2–3. ✅
- Tests: chunk, verify, backend ALLOWED → Tasks 2–5. ✅
- String-inequality (no semver) simplification → carried in `app_version` (Task 2 Step 4), matches spec. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `app_version` returns `{installed, latest, update_available, checked, error?}` — used identically in Task 4's `checkAppVersion`/`renderConfig` and Task 5's checks. `update_status` returns `{in_progress, result}` with `result={ok, finished_at, error?}` — matches the script's output (Task 3 Step 3) and the poll consumer (Task 4 `pollUpdate`). `fetchDeviceInfo` reads `r.model`/`r.system` (system.board) → stores `{model, cpu}`; fallback reads `r.model`/`r.cpu` — both normalize to `deviceInfo.{model,cpu}`, consumed once in `renderConfig`. `armUpdate`/`confirmUpdate`/`updateConfirm` names consistent across methods, tests, and render. ✅
