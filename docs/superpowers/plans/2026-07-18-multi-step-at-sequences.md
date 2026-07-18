# Multi-step AT sequences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single Send in the AT console run an ordered sequence of AT commands (the "set, then commit/save" pattern), from either a curated library entry (`steps` array) or free-typed multi-line input, with uniform stop-on-error.

**Architecture:** The whole sequence rides one `mudimodem.at_console` RPC → one `mudimodem-at.py` invocation, which holds the flock + `gl_modem` SIGSTOP across every step (GL can't wake between a setter and its commit). The RPC param shape is unchanged — `cmd` simply may now contain newlines; the backend splits on them. The Python tool emits one envelope frame per step and stops emitting after the first error/timeout.

**Tech Stack:** Plain JS Vue 2.6 render-only chunk (no build), Lua oui RPC backend, CPython stdlib AT tool, Node `node:test`, Python `unittest`, on-device Lua tests over ssh.

## Global Constraints

- **Vue is runtime-only** — chunk uses `render(h)` only; `template:` is forbidden (CLAUDE.md §5).
- **Chunk is a single expression** — `module.exports = {…}`; it is `eval`'d with `module` in scope.
- **Python: stdlib only** — no pyserial, no third-party deps (`mudimodem-at.py`, `lib-validate.py`).
- **No scp** — deploy/copy to the box with `ssh root@mudi 'cat > /path' < file` (no sftp-server).
- **The dev box has Node 20 + Python 3, but NO lua** — JS and Python tests run locally; Lua backend tests run on-device over ssh (CLAUDE.md §8).
- **Never `pcall` an `oui.ubus.call`** — cosocket yields across a C boundary (CLAUDE.md §8). (Not touched here, but the backend file is shared.)
- **Wire param shape stays `{cmd, timeout}`** — `cmd` carries newlines; do NOT add a `steps` array RPC param (avoids oui array validation).
- **Max 8 steps per sequence; each step ≤ 256 chars.**
- **Free-typed always sends** (no risk gate); `set`/`nv` **library** entries need the "Enable higher-risk commands" checkbox.
- **Envelope status vocabulary:** `ok` | `error` | `timeout` per step; `busy` | `openfail` channel-level (no step index).
- Spec: `docs/superpowers/specs/2026-07-18-multi-step-at-sequences-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tools/mudimodem-at.py` | AT transport | `send()` returns terminator *kind*; envelope mode runs all cmds with per-step frames + stop-on-error |
| `test/at-tool.test.py` | transport tests | update 3 existing assertions; add multi-step + stop-on-error CLI tests |
| `src/rpc/mudimodem` | RPC backend | `M.at_console`: split-not-collapse, step/char caps, per-step envelope parse, new return shape |
| `test/fake-at-tool.py` | fake transport for backend test | emit per-step frames; add `__ERR__` (stop-on-error) branch |
| `test/backend-console.test.lua` | backend test | rewrite assertions to the `{requested,ran,aborted,steps}` shape |
| `tools/lib-validate.py` | library schema/build | `cmd` XOR `steps`; union placeholder coverage; decode-forbidden-with-steps; max-8 |
| `test/lib-validate.test.py` | schema tests (new) | validate() unit tests for the new rules |
| `src/views/mudimodem-console.js` | console chunk | multi-step assembly + timeout scaling + per-step transcript (Task 4); auto-expand textarea + detail steps (Task 5) |
| `test/console-chunk.test.js` | chunk tests | add send-path and input-UX cases |
| `tools/verify.sh` | on-device integration | live single-step frame format; new multi-line `/rpc` round-trip |

---

## Task 1: Transport — per-step envelope + terminator kind

**Files:**
- Modify: `tools/mudimodem-at.py` (`ATChannel.send`, `main` envelope + human paths)
- Test: `test/at-tool.test.py`

**Interfaces:**
- Produces: `ATChannel.send(cmd, timeout) -> (text: str, kind: str)` where `kind ∈ {"ok","error","timeout"}` (was `(text, bool)`).
- Produces: envelope stdout — per step `MM-AT:<kind>:<ms>:<idx>/<count>\n<raw response>`; channel-level `MM-AT:busy:<ms>` / `MM-AT:openfail:<ms>` (2-field, unchanged).

- [ ] **Step 1: Update the two existing `send()` tests to assert on kind**

In `test/at-tool.test.py`, replace the body of `test_send_ok_sees_terminator` and `test_send_timeout_reports_no_terminator`:

```python
    def test_send_ok_sees_terminator(self):
        fm = FakeModem(b"\r\n+QSPN: \"T-Mobile\"\r\n\r\nOK\r\n")
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, kind = ch.send("AT+QSPN", timeout=3)
        finally:
            ch.close()
        self.assertEqual(kind, "ok", "OK terminator must classify as ok")
        self.assertIn("T-Mobile", text)

    def test_send_error_terminator_is_kind_error(self):
        fm = FakeModem(b"\r\nERROR\r\n")
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, kind = ch.send("AT+BAD", timeout=3)
        finally:
            ch.close()
        self.assertEqual(kind, "error", "ERROR terminator must classify as error")

    def test_send_timeout_reports_no_terminator(self):
        fm = FakeModem(reply=b"")           # never answers
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, kind = ch.send("AT", timeout=0.4)
        finally:
            ch.close()
        self.assertEqual(kind, "timeout")
        self.assertEqual(text, "")
```

- [ ] **Step 2: Add multi-step + stop-on-error CLI tests**

Append these methods to `ATToolTest` in `test/at-tool.test.py`:

```python
    def test_cli_envelope_multistep_ok(self):
        # A modem that answers EVERY command with OK (serves in a loop).
        fm = FakeModem(b"\r\nOK\r\n"); fm.loop = True
        r = subprocess.run(
            [sys.executable, TOOL, "--envelope", "--timeout", "3",
             "--port", fm.path, "--lock", self.lock, "--no-glsleep",
             "AT+ONE", "AT+TWO"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        heads = [l for l in r.stdout.splitlines() if l.startswith("MM-AT:")]
        self.assertRegex(heads[0], r"^MM-AT:ok:\d+:1/2$")
        self.assertRegex(heads[1], r"^MM-AT:ok:\d+:2/2$")

    def test_cli_envelope_stop_on_error(self):
        # First command ERRORs -> second must never run (no 2/2 frame).
        fm = FakeModem(b"\r\nERROR\r\n"); fm.loop = True
        r = subprocess.run(
            [sys.executable, TOOL, "--envelope", "--timeout", "3",
             "--port", fm.path, "--lock", self.lock, "--no-glsleep",
             "AT+BAD", "AT+NEVER"],
            capture_output=True, text=True, timeout=15)
        heads = [l for l in r.stdout.splitlines() if l.startswith("MM-AT:")]
        self.assertRegex(heads[0], r"^MM-AT:error:\d+:1/2$")
        self.assertEqual(len(heads), 1, "no frame after an errored step")
```

Update `FakeModem` so it can answer more than one command. Replace its `_serve` with a looping variant:

```python
    def __init__(self, reply=b"\r\nOK\r\n", delay=0.0):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        self.path = os.ttyname(self.slave)
        self.reply, self.delay, self.loop = reply, delay, False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        buf = b""
        while True:
            try:
                b = os.read(self.master, 64)
            except OSError:
                return
            if not b:
                return
            buf += b
            while b"\r" in buf:
                buf = buf.split(b"\r", 1)[1]
                if self.delay:
                    time.sleep(self.delay)
                if self.reply:
                    os.write(self.master, self.reply)
                if not self.loop:
                    return
```

- [ ] **Step 3: Update `test_cli_envelope_ok` for the new single-step frame**

The single-command envelope frame gains `:1/1`. In `test_cli_envelope_ok` change the regex line:

```python
        self.assertRegex(first, r"^MM-AT:ok:\d+:1/1$")
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `python3 test/at-tool.test.py -v`
Expected: FAIL — `send()` still returns a bool; envelope frames lack `:idx/count`.

- [ ] **Step 5: Make `send()` return a kind**

In `tools/mudimodem-at.py`, replace `ATChannel.send`:

```python
    def send(self, cmd, timeout=8):
        """Send one AT command. Returns (raw_text, kind) where kind is
        'ok' (OK terminator), 'error' (ERROR/+CME/+CMS), or 'timeout'."""
        self._drain()
        os.write(self.fd, (cmd + "\r").encode())
        buf, kind, deadline = b"", "timeout", time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([self.fd], [], [], max(0, deadline - time.time()))
            if not r:
                break
            try:
                chunk = os.read(self.fd, 4096)
            except OSError:
                break
            if not chunk:
                continue
            buf += chunk
            t = buf.decode(errors="replace")
            if "\nERROR\r" in t or "+CME ERROR" in t or "+CMS ERROR" in t:
                kind = "error"; break
            if "\nOK\r" in t:
                kind = "ok"; break
        return buf.decode(errors="replace"), kind
```

Update `lines()` — it ignores the second value, so only rename for clarity:

```python
    def lines(self, cmd, timeout=8):
        """send(), returned as clean lines with URCs filtered out."""
        resp, _kind = self.send(cmd, timeout)
        out = [l.strip() for l in resp.replace("\r", "\n").split("\n") if l.strip()]
        return [l for l in out if not l.startswith(URC_PREFIXES)]
```

- [ ] **Step 6: Rewrite the envelope + human loops in `main()` for multi-step**

In `tools/mudimodem-at.py`, replace the `with GlModemSleep(glsleep):` block body:

```python
            with GlModemSleep(glsleep):
                count = len(cmds)
                if envelope:
                    for idx, cmd in enumerate(cmds, 1):
                        resp, kind = ch.send(cmd, timeout)
                        print("MM-AT:%s:%d:%d/%d" % (kind, ms(), idx, count))
                        sys.stdout.write(resp)
                        if not resp.endswith("\n"):
                            sys.stdout.write("\n")
                        if kind != "ok":
                            break          # stop-on-error: emit no further frames
                    return 0
                for cmd in cmds:
                    t1 = time.time()
                    resp, kind = ch.send(cmd, timeout)
                    for l in [x.strip() for x in resp.replace("\r", "\n").split("\n")
                              if x.strip() and not x.strip().startswith(URC_PREFIXES)]:
                        print("    " + l)
                    print(">>> %s   (%.2fs) [%s]" % (cmd, time.time() - t1, kind))
                    if kind != "ok":
                        break              # stop-on-error in the shell path too
                return 0
```

(The `OSError` `except` block below it and the `busy`/`openfail` paths above are unchanged — those stay 2-field channel-level frames.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `python3 test/at-tool.test.py -v`
Expected: PASS (all, including the new multi-step and stop-on-error cases).

- [ ] **Step 8: Commit**

```bash
git add tools/mudimodem-at.py test/at-tool.test.py
git commit -m "feat(at-tool): per-step envelope frames + terminator kind, stop-on-error"
```

---

## Task 2: Backend — split, cap, parse per-step, new return shape

**Files:**
- Modify: `src/rpc/mudimodem` (`M.at_console`, lines ~759-791)
- Modify: `test/fake-at-tool.py`
- Test: `test/backend-console.test.lua`

**Interfaces:**
- Consumes: envelope frames from Task 1 (`MM-AT:<kind>:<ms>:<idx>/<count>` + `MM-AT:busy|openfail:<ms>`).
- Produces: `M.at_console({cmd, timeout}) -> { ok=true, requested=N, ran=M, aborted=bool, steps={ {cmd,status,response,elapsed_ms}, … } }` on success, or `{ error=… }` on channel/validation failure.

- [ ] **Step 1: Teach the fake tool to emit per-step frames + a stop-on-error branch**

Replace `test/fake-at-tool.py` entirely:

```python
#!/usr/bin/env python3
"""Stands in for mudimodem-at.py in backend tests: emits per-step envelope
frames and echoes argv so the test can assert clamping/quoting. No modem.

Channel-level branches (first AT cmd triggers them):
  __BUSY__     -> MM-AT:busy:7          (2-field, channel-level)
  __OPENFAIL__ -> MM-AT:openfail:8
  __GARBAGE__  -> a line with no MM-AT: prefix (envelope parse failure)
  __WEIRD__    -> MM-AT:weird:9:1/1     (matches per-step shape, unknown status)
Per-step: every AT cmd gets MM-AT:ok:5:<idx>/<count> + ARGS:<full argv>, EXCEPT
a cmd containing __ERR__ -> MM-AT:error:5:<idx>/<count> and STOP (stop-on-error).
"""
import sys

argv = sys.argv[1:]
argv_str = " ".join(argv)
# The AT commands are the positional args (everything that isn't a flag or its
# value). They all start with "AT"; flags start with "--" or are numeric.
cmds = [a for a in argv if a.upper().startswith("AT")]

if "__BUSY__" in argv_str:
    print("MM-AT:busy:7")
elif "__OPENFAIL__" in argv_str:
    print("MM-AT:openfail:8")
elif "__GARBAGE__" in argv_str:
    print("Traceback (most recent call last):")
elif "__WEIRD__" in argv_str:
    print("MM-AT:weird:9:1/1")
    print("ARGS:" + argv_str)
else:
    count = len(cmds)
    for idx, c in enumerate(cmds, 1):
        if "__ERR__" in c:
            print("MM-AT:error:5:%d/%d" % (idx, count))
            print("ERROR")
            break
        print("MM-AT:ok:5:%d/%d" % (idx, count))
        print("ARGS:" + argv_str)
```

- [ ] **Step 2: Rewrite the backend test to the new return shape**

Replace `test/backend-console.test.lua` entirely:

```lua
-- On-device test for mudimodem.at_console (split/cap + per-step envelope parse),
-- run against a FAKE tool (test/fake-at-tool.py) so no modem traffic happens.
-- Env: MM_PLUGIN=<plugin path>  MUDIMODEM_AT_TOOL=<fake tool path>
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
assert(M.at_console({ cmd = "\n\n" }).error, "blank-only lines must error")
assert(M.at_console({ cmd = string.rep("A", 300) }).error, "over-long step must error")
assert(M.at_console({ cmd = "AT\n" .. string.rep("A", 300) }).error, "any over-long step must error")

-- Nine steps exceeds the max of 8.
local many = {}
for i = 1, 9 do many[i] = "AT+C" .. i end
assert(M.at_console({ cmd = table.concat(many, "\n") }).error, "over-8 steps must error")

-- Happy path, SINGLE step: shape + timeout clamp + cmd passthrough.
local r = M.at_console({ cmd = 'AT+QNWPREFCFG="nr5g_band"', timeout = 999 })
assert(r.ok == true, "expected ok, got: " .. tostring(r.error))
assert(r.requested == 1 and r.ran == 1 and r.aborted == false, "single-step counts")
assert(#r.steps == 1, "one step returned")
assert(r.steps[1].status == "ok", "status from the envelope")
assert(type(r.steps[1].elapsed_ms) == "number", "elapsed_ms is a number")
assert(r.steps[1].cmd == 'AT+QNWPREFCFG="nr5g_band"', "step cmd echoed back")
assert(r.steps[1].response:find("--timeout 60", 1, true), "timeout clamps to 60")
assert(r.steps[1].response:find('AT+QNWPREFCFG="nr5g_band"', 1, true), "inner quotes intact")

-- Timeout clamps low and defaults to 8.
local r2 = M.at_console({ cmd = "AT", timeout = 0 })
assert(r2.ok and r2.steps[1].response:find("--timeout 1", 1, true), "timeout clamps up to 1")
local r3 = M.at_console({ cmd = "AT" })
assert(r3.ok and r3.steps[1].response:find("--timeout 8", 1, true), "timeout defaults to 8")

-- MULTI step happy path: two frames parsed, in order.
local rm = M.at_console({ cmd = "AT+ONE\nAT+TWO" })
assert(rm.ok and rm.requested == 2 and rm.ran == 2 and rm.aborted == false, "two steps ran")
assert(rm.steps[1].cmd == "AT+ONE" and rm.steps[2].cmd == "AT+TWO", "step order preserved")

-- STOP on error: second step never ran; aborted flag + counts reflect it.
local re = M.at_console({ cmd = "AT+BAD__ERR__\nAT+NEVER" })
assert(re.ok, "an errored sequence still returns ok=true (transport succeeded)")
assert(re.requested == 2 and re.ran == 1 and re.aborted == true, "aborted after step 1")
assert(re.steps[1].status == "error", "first step marked error")
assert(#re.steps == 1, "no frame for the skipped step")

-- Single quotes survive shell quoting.
local r5 = M.at_console({ cmd = "AT+X='y'" })
assert(r5.ok and r5.steps[1].response:find("AT+X='y'", 1, true), "single quotes survive")

-- Channel-level failures still return {error}, never steps.
local rb = M.at_console({ cmd = "AT__BUSY__" })
assert(rb.error and not rb.ok and rb.error:lower():find("busy", 1, true), "busy errors")
local ro = M.at_console({ cmd = "AT__OPENFAIL__" })
assert(ro.error and ro.error:find("cannot open", 1, true), "openfail errors")
local rg = M.at_console({ cmd = "AT__GARBAGE__" })
assert(rg.error and rg.error:find("no envelope", 1, true), "no-envelope errors")
local rw = M.at_console({ cmd = "AT__WEIRD__" })
assert(rw.error and rw.error:find("unexpected status", 1, true), "unknown status errors")

print("at_console backend OK")
```

- [ ] **Step 3: Run the backend test on-device to verify it fails**

The dev box has no lua; run against the working-copy backend over ssh:

```bash
ssh root@mudi 'cat > /tmp/mm.lua' < src/rpc/mudimodem
ssh root@mudi 'cat > /tmp/fake.py' < test/fake-at-tool.py
ssh root@mudi 'cat > /tmp/t.lua' < test/backend-console.test.lua
ssh root@mudi 'MM_PLUGIN=/tmp/mm.lua MUDIMODEM_AT_TOOL=/tmp/fake.py lua /tmp/t.lua'
```
Expected: FAIL (old `at_console` collapses newlines and returns the flat `{response=…}` shape).

- [ ] **Step 4: Rewrite `M.at_console`**

Replace `function M.at_console(args) … end` in `src/rpc/mudimodem` (currently ~759-791):

```lua
function M.at_console(args)
  local raw = args and args.cmd
  if type(raw) ~= "string" then return { error = "cmd required" } end
  -- Split into steps on newlines; trim each, drop blanks. (Was: collapse to a
  -- space. Now each line is its own AT command in one held channel window.)
  local steps = {}
  for line in (raw .. "\n"):gmatch("(.-)\n") do
    line = line:gsub("[\r]+", ""):match("^%s*(.-)%s*$")
    if line ~= "" then steps[#steps + 1] = line end
  end
  if #steps == 0 then return { error = "cmd required" } end
  if #steps > 8 then return { error = "too many steps (max 8)" } end
  for _, s in ipairs(steps) do
    if #s > 256 then return { error = "command too long (max 256 chars)" } end
  end

  local timeout = tonumber(args and args.timeout) or 8
  if timeout < 1 then timeout = 1 end
  if timeout > 60 then timeout = 60 end
  timeout = math.floor(timeout)

  -- POSIX single-quote escaping: ' -> '\''. Build one invocation, all steps.
  local function q(s) return "'" .. s:gsub("'", "'\\''") .. "'" end
  local parts = { "python3", q(AT_TOOL), "--envelope", "--timeout", tostring(timeout) }
  for _, s in ipairs(steps) do parts[#parts + 1] = q(s) end
  local f = io.popen(table.concat(parts, " ") .. " 2>/dev/null")
  if not f then return { error = "failed to spawn the AT tool" } end
  local out = f:read("*a") or ""
  f:close()

  -- Channel-level failure: a 2-field frame (no /count) as the first line.
  local cstatus = out:match("^MM%-AT:(%w+):%d+%s*\n") or out:match("^MM%-AT:(%w+):%d+%s*$")
  if cstatus == "busy" then return { error = "channel busy - another command in flight" } end
  if cstatus == "openfail" then return { error = "cannot open the AT port (/dev/at_mdm0)" } end

  -- Parse per-step frames: header line then response lines up to the next header.
  local out_steps, cur = {}, nil
  for line in (out .. "\n"):gmatch("(.-)\n") do
    local st, msv, idx, cnt = line:match("^MM%-AT:(%w+):(%d+):(%d+)/(%d+)$")
    if st then
      cur = { status = st, elapsed_ms = tonumber(msv), idx = tonumber(idx),
              count = tonumber(cnt), response = "" }
      out_steps[#out_steps + 1] = cur
    elseif cur then
      cur.response = cur.response .. line .. "\n"
    end
  end

  if #out_steps == 0 then
    return { error = "AT tool returned no envelope (is " .. AT_TOOL .. " deployed?)" }
  end

  local result = { ok = true, requested = #steps, ran = #out_steps,
                   aborted = (#out_steps < #steps), steps = {} }
  for i, s in ipairs(out_steps) do
    if s.status ~= "ok" and s.status ~= "error" and s.status ~= "timeout" then
      return { error = "AT tool returned unexpected status: " .. s.status }
    end
    result.steps[i] = { cmd = steps[i] or "", status = s.status,
                        response = s.response, elapsed_ms = s.elapsed_ms }
  end
  return result
end
```

- [ ] **Step 5: Run the backend test on-device to verify it passes**

```bash
ssh root@mudi 'cat > /tmp/mm.lua' < src/rpc/mudimodem
ssh root@mudi 'cat > /tmp/fake.py' < test/fake-at-tool.py
ssh root@mudi 'cat > /tmp/t.lua' < test/backend-console.test.lua
ssh root@mudi 'MM_PLUGIN=/tmp/mm.lua MUDIMODEM_AT_TOOL=/tmp/fake.py lua /tmp/t.lua; rc=$?; rm -f /tmp/mm.lua /tmp/fake.py /tmp/t.lua; exit $rc'
```
Expected: `at_console backend OK`

- [ ] **Step 6: Commit**

```bash
git add src/rpc/mudimodem test/fake-at-tool.py test/backend-console.test.lua
git commit -m "feat(backend): at_console runs a multi-step sequence, stop-on-error"
```

---

## Task 3: Library schema — `cmd` XOR `steps`

**Files:**
- Modify: `tools/lib-validate.py` (`REQUIRED`, `STR_REQUIRED`, `validate`)
- Test: `test/lib-validate.test.py` (new)

**Interfaces:**
- Produces: `validate(entries) -> list[str]` (error messages; empty = valid). An entry has **exactly one** of `cmd` (non-empty string) or `steps` (non-empty list of non-empty strings, ≤ 8). Placeholders come from the union across `steps`/`cmd`. `decode` is rejected when `steps` is present.

- [ ] **Step 1: Write the failing schema tests**

Create `test/lib-validate.test.py`:

```python
#!/usr/bin/env python3
"""Unit tests for tools/lib-validate.py validate() — the cmd/steps schema."""
import importlib.util, os, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
spec = importlib.util.spec_from_file_location(
    "libvalidate", os.path.join(ROOT, "tools", "lib-validate.py"))
lv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lv)


def base(**over):
    e = {"id": "x.y", "cat": "C", "title": "T", "risk": "read", "vendor": "v",
         "verified": [], "summary": "s", "source": "src", "by": "me"}
    e.update(over)
    return e


class SchemaTest(unittest.TestCase):
    def errs(self, entry):
        return lv.validate([entry])

    def test_single_cmd_ok(self):
        self.assertEqual(self.errs(base(cmd="AT+CSQ")), [])

    def test_steps_ok(self):
        self.assertEqual(self.errs(base(steps=["AT+FOO", "AT&W"])), [])

    def test_neither_cmd_nor_steps_fails(self):
        self.assertTrue(any("cmd" in m and "steps" in m for m in self.errs(base())))

    def test_both_cmd_and_steps_fails(self):
        e = base(cmd="AT", steps=["AT&W"])
        self.assertTrue(any("exactly one" in m for m in self.errs(e)))

    def test_steps_must_be_nonempty_strings(self):
        self.assertTrue(self.errs(base(steps=[])))
        self.assertTrue(self.errs(base(steps=["AT", ""])))

    def test_steps_max_8(self):
        self.assertTrue(any("8" in m for m in self.errs(base(steps=["AT"] * 9))))

    def test_placeholder_union_across_steps(self):
        # {{a}} in step 1, {{b}} in step 2 -> params must cover both.
        ok = base(steps=["AT={{a}}", "AT2={{b}}"],
                  params=[{"name": "a", "hint": "h"}, {"name": "b", "hint": "h"}])
        self.assertEqual(self.errs(ok), [])
        bad = base(steps=["AT={{a}}", "AT2={{b}}"],
                   params=[{"name": "a", "hint": "h"}])
        self.assertTrue(any("placeholder" in m for m in self.errs(bad)))

    def test_decode_forbidden_with_steps(self):
        e = base(steps=["AT+FOO"], decode={"prefix": "+FOO", "fields": ["x"]})
        self.assertTrue(any("decode" in m and "steps" in m for m in self.errs(e)))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the schema tests to verify they fail**

Run: `python3 test/lib-validate.test.py -v`
Expected: FAIL — `cmd` is still unconditionally required; `steps` is unknown.

- [ ] **Step 3: Update `validate()` for the XOR schema**

In `tools/lib-validate.py`:

Change `REQUIRED` and `STR_REQUIRED` so `cmd` is no longer unconditional:

```python
REQUIRED = ["id", "cat", "title", "risk", "vendor", "verified", "summary", "source", "by"]
STR_REQUIRED = ["id", "cat", "title", "vendor", "summary", "source", "by"]
MAX_STEPS = 8
```

Then, inside `validate`'s `for e in entries:` loop, **replace** the current `cmd`/placeholder block (the lines from `cmd = e.get("cmd")` through the `for p in e.get("params", []):` loop and the `decode`+`params` block) with:

```python
        # Exactly one of cmd / steps.
        has_cmd = "cmd" in e
        has_steps = "steps" in e
        if has_cmd and has_steps:
            errs.append("%s: an entry must have exactly one of 'cmd' or 'steps', not both" % eid)
        elif not has_cmd and not has_steps:
            errs.append("%s: an entry needs 'cmd' or 'steps'" % eid)

        if has_cmd and not (isinstance(e["cmd"], str) and e["cmd"]):
            errs.append("%s: field 'cmd' must be a non-empty string" % eid)

        step_texts = []
        if has_steps:
            steps = e["steps"]
            if not (isinstance(steps, list) and steps):
                errs.append("%s: 'steps' must be a non-empty list" % eid)
            else:
                if len(steps) > MAX_STEPS:
                    errs.append("%s: at most %d steps (has %d)" % (eid, MAX_STEPS, len(steps)))
                for s in steps:
                    if not (isinstance(s, str) and s.strip()):
                        errs.append("%s: every step must be a non-empty string" % eid)
                    else:
                        step_texts.append(s)
        elif has_cmd and isinstance(e["cmd"], str):
            step_texts = [e["cmd"]]

        # Placeholder coverage over the UNION across cmd/steps.
        ph = set()
        for txt in step_texts:
            ph |= set(PLACEHOLDER.findall(txt))
        pnames = set(p.get("name") for p in e.get("params", []))
        if ph != pnames:
            errs.append("%s: params %s must exactly cover placeholders %s"
                        % (eid, sorted(n for n in pnames if n), sorted(ph)))
        for p in e.get("params", []):
            if not p.get("name") or not p.get("hint"):
                errs.append("%s: every param needs name + hint" % eid)

        # decode is only meaningful on a single literal cmd (matched by string).
        if e.get("decode") and has_steps:
            errs.append("%s: 'decode' is not allowed with 'steps' "
                        "(multi-step entries are actions, not reads)" % eid)
        if e.get("decode") and e.get("params"):
            errs.append("%s: an entry cannot have both params and decode "
                        "(the substituted command never matches the template, so decode would silently no-op)" % eid)
        d = e.get("decode")
        if d is not None:
            if not (isinstance(d.get("prefix"), str) and d.get("prefix")):
                errs.append("%s: decode.prefix must be a non-empty string" % eid)
            if not (isinstance(d.get("fields"), list) and d.get("fields")):
                errs.append("%s: decode.fields must be a non-empty list" % eid)
```

- [ ] **Step 4: Run the schema tests to verify they pass**

Run: `python3 test/lib-validate.test.py -v`
Expected: PASS.

- [ ] **Step 5: Verify the real library still builds**

Run: `python3 tools/lib-validate.py`
Expected: `at-library: N entries from 2 files -> …/build/at-library.json` (existing `cmd` entries still valid).

- [ ] **Step 6: Commit**

```bash
git add tools/lib-validate.py test/lib-validate.test.py
git commit -m "feat(at-library): schema supports steps[] as an alternative to cmd"
```

---

## Task 4: Frontend — multi-step assembly, timeout scaling, per-step transcript

**Files:**
- Modify: `src/views/mudimodem-console.js` (`computed`, `send`)
- Test: `test/console-chunk.test.js`

**Interfaces:**
- Consumes: backend `at_console` return `{ ok, requested, ran, aborted, steps:[{cmd,status,response,elapsed_ms}] }`.
- Produces: `stepLines` (computed) → array of trimmed non-empty command lines; `assembled` now substitutes params over `cmd` **or** `steps.join("\n")`; `send()` sends `steps.join("\n")` as `cmd`, scales the RPC timeout by step count, and renders each returned step + `skipped` notes.

- [ ] **Step 1: Write the failing frontend tests**

Add to `test/console-chunk.test.js`. First extend the `LIB` fixture with a `steps` entry (insert into the `LIB` array):

```javascript
  { id: 'demo.set-commit', cat: 'Bands', title: 'Set + commit', risk: 'nv',
    vendor: 'any', verified: [], summary: 'sum', warn: 'warn', source: 'src', by: 'kevin',
    steps: ['AT+QNWPREFCFG="nr5g_band",{{bands}}', 'AT+QNWPREFCFG="nr5g_band"'],
    params: [{ name: 'bands', hint: 'colon-separated', example: '41:71' }] }
```

Then add these tests:

```javascript
test('assembled substitutes params across all steps of a steps[] entry', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB.find((e) => e.id === 'demo.set-commit'));
  vm.params.bands = '41:71';
  assert.strictEqual(vm.assembled,
    'AT+QNWPREFCFG="nr5g_band",41:71\nAT+QNWPREFCFG="nr5g_band"');
  assert.deepStrictEqual(vm.stepLines,
    ['AT+QNWPREFCFG="nr5g_band",41:71', 'AT+QNWPREFCFG="nr5g_band"']);
});

test('stepLines drops blank lines from free-typed multi-line input', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.prompt = 'AT+ONE\n\n   \nAT+TWO';
  vm.selId = null;
  assert.deepStrictEqual(vm.stepLines, ['AT+ONE', 'AT+TWO']);
});

test('send(): a multi-step sequence renders every returned step in order', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.resolve({
      ok: true, requested: 2, ran: 2, aborted: false, steps: [
        { cmd: 'AT+ONE', status: 'ok', response: 'OK\r\n', elapsed_ms: 3 },
        { cmd: 'AT+TWO', status: 'ok', response: '+X: 1\r\nOK\r\n', elapsed_ms: 4 }
      ] }) };
    vm.prompt = 'AT+ONE\nAT+TWO'; vm.selId = null;
    await vm.send();
  } finally { global.window = saved; }
  const cmds = vm.lines.filter((l) => l.kind === 'cmd').map((l) => l.text);
  assert.deepStrictEqual(cmds, ['AT+ONE', 'AT+TWO'], 'both step commands shown');
  assert.ok(vm.lines.some((l) => l.text === '+X: 1'), 'second step response shown');
});

test('send(): aborted sequence marks the remaining steps skipped', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.resolve({
      ok: true, requested: 2, ran: 1, aborted: true, steps: [
        { cmd: 'AT+BAD', status: 'error', response: 'ERROR\r\n', elapsed_ms: 3 }
      ] }) };
    vm.prompt = 'AT+BAD\nAT+NEVER'; vm.selId = null;
    await vm.send();
  } finally { global.window = saved; }
  assert.ok(vm.lines.some((l) => l.kind === 'note' && /skipped/.test(l.text)),
    'skipped note for the step that never ran');
});

test('send(): RPC timeout scales with the number of steps', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  let seenOpts = null;
  try {
    global.window = { $rpcRequest: (_m, _p, opts) => { seenOpts = opts;
      return Promise.resolve({ ok: true, requested: 3, ran: 3, aborted: false, steps: [
        { cmd: 'A', status: 'ok', response: 'OK\r\n' },
        { cmd: 'B', status: 'ok', response: 'OK\r\n' },
        { cmd: 'C', status: 'ok', response: 'OK\r\n' } ] }); } };
    vm.prompt = 'A\nB\nC'; vm.selId = null;
    await vm.send();
  } finally { global.window = saved; }
  assert.strictEqual(seenOpts.timeout, (8 * 3 + 10) * 1000, '3 steps -> 8*3+10 s');
});
```

- [ ] **Step 2: Run the frontend tests to verify they fail**

Run: `node --test test/console-chunk.test.js`
Expected: FAIL — `stepLines` undefined, `assembled` ignores `steps`, `send` uses the flat `response`.

- [ ] **Step 3: Add `stepLines` and teach `assembled` about `steps`**

In `src/views/mudimodem-console.js`, replace the `assembled()` computed and add `stepLines()`:

```javascript
    // The command text that would be sent: the entry's cmd OR its steps joined
    // by newline, with {{params}} substituted (unfilled ones stay visible).
    assembled() {
      if (!this.sel || !this.paramMode) return this.prompt;
      var base = this.sel.steps ? this.sel.steps.join("\n") : this.sel.cmd;
      var p = this.params;
      return base.replace(/\{\{(\w+)\}\}/g, function (m, name) {
        var v = ((p[name] || "") + "").trim();
        return v !== "" ? v : m;
      });
    },
    // The wire command split into individual AT steps (trimmed, blanks dropped).
    stepLines() {
      var v = ((this.paramMode ? this.assembled : this.prompt) || "").trim();
      if (!v) return [];
      return v.split(/\r?\n/).map(function (s) { return s.trim(); })
              .filter(function (s) { return s !== ""; });
    },
```

- [ ] **Step 4: Rewrite `send()` for the multi-step contract**

Replace `send()` in `src/views/mudimodem-console.js`:

```javascript
    send() {
      var self = this;
      var entry = this.sel;
      var steps = this.stepLines;
      if (!steps.length || this.sending) return;
      if (steps.some(function (s) { return /\{\{/.test(s); })) {
        this.note("fill in every parameter before sending"); return;
      }
      if (this.gateBlocked) {
        this.note('this is a ' + entry.risk + ' entry — tick "Enable higher-risk commands" in the banner to send it');
        return;
      }
      var wire = steps.join("\n");
      steps.forEach(function (s) { self.push("cmd", s); });
      this.history.push(wire); this.histIdx = null;
      this.decodeRows = null;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.push("err", "RPC unavailable"); return;
      }
      var TOOL_T = 8;   // per-step deadline; rpc timeout = TOOL_T*steps + 10 s
      this.sending = true;
      return window.$rpcRequest("call", ["sid", "mudimodem", "at_console",
                                         { cmd: wire, timeout: TOOL_T }],
                         { timeout: (TOOL_T * steps.length + 10) * 1000 })
        .then(function (r) {
          self.sending = false;
          if (r && r.error) { self.push("err", r.error); return; }
          var got = (r && r.steps) || [];
          var combined = "";
          got.forEach(function (st) {
            var resp = (st.response || "");
            combined += resp + "\n";
            resp.replace(/\r/g, "\n").split("\n").forEach(function (l) {
              l = l.trim();
              if (l) self.push(self.classifyLine(l), l);
            });
            if (st.status === "timeout") {
              self.push("err", "no terminator after " + TOOL_T +
                "s — the response may still arrive; the channel is drained on the next send");
            }
          });
          if (r && r.aborted) {
            var skipped = (r.requested || steps.length) - (r.ran || got.length);
            for (var i = 0; i < skipped; i++) self.note("skipped — previous step failed");
          }
          self.applyDecode(entry, wire, combined);
        })
        .catch(function (e) {
          self.sending = false;
          self.push("err", (e && (e.message || e.type)) || "request failed");
        });
    },
```

- [ ] **Step 5: Run the frontend tests to verify they pass**

Run: `node --test test/console-chunk.test.js`
Expected: PASS (new tests + all existing send/gate/param/decode tests).

- [ ] **Step 6: Commit**

```bash
git add src/views/mudimodem-console.js test/console-chunk.test.js
git commit -m "feat(console): assemble and render multi-step sequences, scale timeout"
```

---

## Task 5: Frontend — auto-expand multi-line prompt + steps in the detail card

**Files:**
- Modify: `src/views/mudimodem-console.js` (`data`, `pick`, `onPromptInput`, `promptKey`, `computed`, `render`, `injectStyle`)
- Test: `test/console-chunk.test.js`

**Interfaces:**
- Consumes: `stepLines`/`assembled` from Task 4.
- Produces: `promptMultiline` (computed) drives `<textarea>` vs `<input>`; `multiline` data flag set by newline input, Shift+Enter, or picking a `steps` entry; Enter (no shift) sends, Shift+Enter inserts a newline; the detail card lists a `steps` entry's commands.

- [ ] **Step 1: Write the failing UX tests**

Add to `test/console-chunk.test.js`:

```javascript
test('typing a newline morphs the prompt to multi-line', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.onPromptInput('AT+ONE\nAT+TWO');
  assert.strictEqual(vm.multiline, true);
  assert.strictEqual(vm.promptMultiline, true);
});

test('Shift+Enter inserts a newline and does not send', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  let sent = false;
  try {
    global.window = { $rpcRequest: () => { sent = true; return Promise.resolve({ ok: true, steps: [] }); } };
    vm.prompt = 'AT+ONE'; vm.selId = null;
    vm.promptKey({ key: 'Enter', shiftKey: true, preventDefault() {} });
    assert.strictEqual(sent, false, 'Shift+Enter must not send');
    assert.strictEqual(vm.multiline, true, 'morphed to multi-line');
    assert.match(vm.prompt, /\n$/, 'a newline was appended');
  } finally { global.window = saved; }
});

test('Enter (no shift) sends', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  let sent = false;
  try {
    global.window = { $rpcRequest: () => { sent = true;
      return Promise.resolve({ ok: true, requested: 1, ran: 1, aborted: false,
        steps: [{ cmd: 'ATI', status: 'ok', response: 'OK\r\n' }] }); } };
    vm.prompt = 'ATI'; vm.selId = null;
    vm.promptKey({ key: 'Enter', shiftKey: false, preventDefault() {} });
    assert.strictEqual(sent, true);
  } finally { global.window = saved; }
});

test('picking a steps[] entry lists its commands in the detail card', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB.find((e) => e.id === 'demo.set-commit'));
  assert.strictEqual(vm.multiline, true, 'steps entry is multi-line');
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /AT\+QNWPREFCFG="nr5g_band"/, 'a step command is listed');
});

test('multi-line prompt renders a textarea, single-line an input', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.prompt = 'ATI'; vm.selId = null;
  assert.ok(walk(c.render.call(vm, h)).some((n) => n.tag === 'input'
    && n.data.attrs && n.data.attrs['aria-label'] === 'AT command'),
    'single-line uses <input>');
  vm.onPromptInput('AT+ONE\nAT+TWO');
  assert.ok(walk(c.render.call(vm, h)).some((n) => n.tag === 'textarea'),
    'multi-line uses <textarea>');
});
```

- [ ] **Step 2: Run the UX tests to verify they fail**

Run: `node --test test/console-chunk.test.js`
Expected: FAIL — `multiline`/`promptMultiline` undefined, no textarea, detail card has no steps list.

- [ ] **Step 3: Add the `multiline` flag and update `pick`/`onPromptInput`/`promptKey`**

In `src/views/mudimodem-console.js`:

Add `multiline: false` to `data()` (next to `prompt: ""`):

```javascript
      prompt: "",
      multiline: false,
```

Replace `pick`:

```javascript
    pick(e) {
      this.selId = e.id;
      var ps = {};
      (e.params || []).forEach(function (p) { ps[p.name] = ""; });
      this.params = ps;               // fresh object => later key writes are reactive
      var base = e.steps ? e.steps.join("\n") : e.cmd;
      this.prompt = (e.params && e.params.length) ? "" : base;
      this.multiline = !!e.steps || base.indexOf("\n") >= 0;
      this.decodeRows = null; this.decodeSrc = "";
    },
```

Replace `onPromptInput`:

```javascript
    onPromptInput(v) {
      this.prompt = v;
      if (v.indexOf("\n") >= 0) this.multiline = true;
      // Hand-editing away from the entry's text = free-typing (gate no longer
      // applies; the entry stops claiming the prompt).
      var base = this.sel ? (this.sel.steps ? this.sel.steps.join("\n") : this.sel.cmd) : null;
      if (this.sel && !this.paramMode && v !== base) this.selId = null;
    },
```

Replace `promptKey`:

```javascript
    promptKey(ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        if (ev.preventDefault) ev.preventDefault();
        this.send(); return;
      }
      if (ev.key === "Enter" && ev.shiftKey) {
        // Morph an <input> into a multi-line block; in a <textarea> the browser
        // inserts the newline itself, so only seed it on the first transition.
        if (!this.promptMultiline && !this.paramMode) {
          if (ev.preventDefault) ev.preventDefault();
          this.multiline = true;
          this.prompt = (this.prompt || "") + "\n";
        }
        return;
      }
      if ((ev.key === "ArrowUp" || ev.key === "ArrowDown")
          && !this.paramMode && !this.promptMultiline) {
        if (!this.history.length) return;
        if (ev.preventDefault) ev.preventDefault();
        var i = this.histIdx === null ? this.history.length : this.histIdx;
        i += (ev.key === "ArrowUp" ? -1 : 1);
        if (i < 0) i = 0;
        if (i >= this.history.length) { this.histIdx = null; this.prompt = ""; return; }
        this.histIdx = i;
        this.prompt = this.history[i];
        this.selId = null;
      }
    },
```

- [ ] **Step 4: Add the `promptMultiline` computed**

Add to `computed` (after `stepLines`):

```javascript
    promptMultiline() {
      if (this.multiline) return true;
      var v = this.paramMode ? this.assembled : this.prompt;
      return (v || "").indexOf("\n") >= 0;
    },
```

- [ ] **Step 5: Render `<textarea>` vs `<input>` and list steps in the detail card**

In `render(h)`, replace the `promptRow` definition:

```javascript
    var multi = this.promptMultiline;
    var promptCtl = h(multi ? "textarea" : "input", {
      staticClass: multi ? "mmc-ta" : "",
      attrs: {
        placeholder: "AT+…", "aria-label": "AT command",
        readonly: this.paramMode || null,
        rows: multi ? Math.min(8, Math.max(2, this.stepLines.length)) : null
      },
      domProps: { value: this.paramMode ? this.assembled : this.prompt },
      on: {
        input: function (ev) { if (!self.paramMode) self.onPromptInput(ev.target.value); },
        keydown: function (ev) { self.promptKey(ev); }
      }
    });
    var promptRow = h("div", { staticClass: "mmc-prompt" }, [
      h("span", ">"),
      promptCtl,
      h("button", {
        staticClass: "mmc-send",
        attrs: { disabled: this.sending || (this.paramMode && !this.paramsFilled) },
        on: { click: function () { self.send(); } }
      }, this.sending ? "Sending…" : "Send")
    ]);
```

In the entry detail card (`if (e) { detail = … }`), add a steps list right after the summary `h("div", …)` block — insert this element into the detail card's children array (after the summary div, before `mmc-meta`):

```javascript
        e.steps ? h("div", { staticClass: "mmc-steps" }, e.steps.map(function (s, i) {
          return h("code", { key: i, staticClass: "mmc-step" }, s);
        })) : null,
```

(The detail children array already uses `.filter(Boolean)` is NOT present — wrap the array in `.filter(Boolean)` if adding a possibly-null child. Change `h("div", { staticClass: "mmc-card mmc-detail" }, [ … ])` to `h("div", { staticClass: "mmc-card mmc-detail" }, [ … ].filter(Boolean))`.)

- [ ] **Step 6: Add textarea + steps-list CSS**

In `injectStyle`, add these rules to the `css` string (before the closing `@media(prefers-reduced-motion…)`):

```javascript
        '.mmc-ta{flex:1;font-family:monospace;font-size:12px;padding:6px 9px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular);resize:vertical;line-height:1.5}' +
        '.mmc-ta:focus{outline:0;border-color:var(--primary)}' +
        '.mmc-steps{margin-top:8px;display:flex;flex-direction:column;gap:3px}' +
        '.mmc-step{font-family:monospace;font-size:11px;color:var(--text-weak);background:var(--bg-title);border-radius:3px;padding:4px 8px}' +
```

- [ ] **Step 7: Run all frontend tests to verify they pass**

Run: `node --test test/console-chunk.test.js`
Expected: PASS (UX tests + Task-4 tests + all pre-existing tests, incl. arrow-up history).

- [ ] **Step 8: Commit**

```bash
git add src/views/mudimodem-console.js test/console-chunk.test.js
git commit -m "feat(console): auto-expanding multi-line prompt + steps in detail card"
```

---

## Task 6: On-device integration — verify.sh live frame + multi-line /rpc round-trip

**Files:**
- Modify: `tools/verify.sh` (step 8d; new step 9b round-trip)

**Interfaces:**
- Consumes: the deployed backend + tool + validator from Tasks 1-5.
- Produces: a `verify.sh` that proves (a) the live single-step frame now carries `:1/1`, and (b) a two-line `cmd` survives the oui validator over real `/rpc` and both steps run — the trap the on-device `dofile` tests cannot catch (CLAUDE.md §3).

- [ ] **Step 1: Build + deploy the changed files to the box**

```bash
./tools/build.sh
./tools/deploy.sh
```
Expected: build lists the gz artifacts; deploy is model-guarded on E5800 and pushes over ssh `cat`.

- [ ] **Step 2: Update the live single-step frame assertion (8d)**

In `tools/verify.sh`, change the 8d grep so it accepts (and requires) the per-step suffix:

```sh
echo "8d. LIVE: one read-only AT through the real tool (per-step envelope + gl_modem sleep)"
ssh -o BatchMode=yes "root@$HOST" \
  'python3 /usr/lib/mudimodem/mudimodem-at.py --envelope --timeout 6 "AT" | head -1 | grep -qE "^MM-AT:ok:[0-9]+:1/1$"' \
  || fail "live AT through /dev/at_mdm0 did not return a per-step MM-AT:ok frame"
```

- [ ] **Step 3: Add the multi-line /rpc round-trip (new step 9b)**

In `tools/verify.sh`, after step 9 (validator) and before `echo "ALL CHECKS PASSED"`, add:

```sh
# 9b. LIVE /rpc round-trip: a TWO-LINE cmd must pass the oui validator AND run
#     both steps. This is the layer the on-device dofile tests (8c) bypass — a
#     newline-bearing cmd could -32602 at /rpc even though the backend is fine.
echo "9b. multi-line cmd survives /rpc and runs both steps"
SID=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -X POST https://127.0.0.1/rpc -H "Content-Type: application/json" \
     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"login\",\"params\":{\"username\":\"root\",\"password\":\"'"$MM_PW"'\"}}" \
   | sed -n "s/.*\"sid\":\"\([^\"]*\)\".*/\1/p"')
[ -n "$SID" ] || fail "login for /rpc round-trip failed (set MM_PW to the admin password)"
RESP=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -X POST https://127.0.0.1/rpc -H "Content-Type: application/json" \
     -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"call\",\"params\":[\"'"$SID"'\",\"mudimodem\",\"at_console\",{\"cmd\":\"AT\nATI\",\"timeout\":6}]}"')
printf '%s' "$RESP" | grep -q '"ran":2' \
  || fail "multi-line /rpc did not run 2 steps (validator -32602? got: $RESP)"
printf '%s' "$RESP" | grep -q -- '-32602' \
  && fail "multi-line cmd was rejected by the arg validator (-32602)"
echo "   /rpc ran both steps of a multi-line cmd"
```

Add a note near the top of `verify.sh` (by the other env vars) documenting `MM_PW`:

```sh
# MM_PW: admin password, required only for step 9b's /rpc round-trip login.
```

- [ ] **Step 4: Run verify.sh end-to-end**

Run: `MM_PW='<admin-password>' ./tools/verify.sh`
Expected: every step prints its check and the script ends with `ALL CHECKS PASSED`. Critically 8e (gl_modem not left in state T), 9 (validator), and 9b (`/rpc ran both steps`) all pass.

- [ ] **Step 5: Commit**

```bash
git add tools/verify.sh
git commit -m "test(verify): live per-step frame + multi-line /rpc round-trip"
```

---

## Self-Review Notes

- **Spec coverage:** §2 schema → Task 3; §3 wire/validator → Tasks 2 (split) + 6 (round-trip); §4 backend return → Task 2; §5 transport → Task 1; §6 frontend → Tasks 4-5; §7 testing table → tests distributed across all tasks; §8 files-touched → all files present; §9 non-goals honored (no `continueOnError`, no per-step risk, no decode on steps, no new RPC param).
- **Type consistency:** `send()`→`(text, kind:str)` used identically in Tasks 1-2; backend return `{requested, ran, aborted, steps:[{cmd,status,response,elapsed_ms}]}` produced in Task 2 and consumed byte-for-byte in Task 4; `stepLines`/`assembled`/`promptMultiline` defined in Task 4-5 and used in the same tasks' render.
- **Env vars:** on-device Lua tests use `MM_PLUGIN` + `MUDIMODEM_AT_TOOL` (already supported by the backend and test harness); `MM_PW` is new, documented in Task 6.
- **Deploy:** all copies use `ssh 'cat > …' < file` (no scp); deploy.sh is model-guarded.
