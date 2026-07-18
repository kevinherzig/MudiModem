# AT Console + Community AT Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 3 — a raw AT console tab (own channel `/dev/at_mdm0`) plus a searchable, risk-badged, community-contributable AT command library with response decoding, per `docs/superpowers/specs/2026-07-18-at-console-library-design.md`.

**Architecture:** A new lazy-loaded chunk (`mudimodem-console`) renders inside the existing `mudimodem` view's "AT console" tab (same pattern as Tracking). It sends commands via a new `at_console` RPC method, which spawns `mudimodem-at.py` (flock-serialized, `gl_modem` SIGSTOPped during the send with guaranteed CONT + recovery). The library is static JSON built from `src/at-library/*.json`, served at `/mudimodem/at-library.json` via `gzip_static`, fetched with `$axios`.

**Tech Stack:** Plain ES5-ish JS (Vue 2.6.12 runtime-only, `render(h)`), Lua (oui RPC plugin), Python 3 stdlib, POSIX sh, Node built-in test runner (dev box only).

## Global Constraints

- Chunk files MUST be a single expression: `module.exports = {…};` — they are `eval`'d by the SPA. `template:` is forbidden; `render(h)` only (Vue 2.6.12 runtime-only).
- NEVER wrap `oui.ubus.call` in `pcall` (cosocket yield across C-call boundary — CLAUDE.md §8). `at_console` must not touch ubus at all.
- All UI colour via GL theme tokens (`var(--primary)` etc.), never hand-picked colours.
- File transfer to the box: `ssh root@mudi 'cat > /path' < file` — there is no sftp-server, `scp` fails. Never inline Lua/AT/JSON into `ssh '…'` quoting; push a file, then run it.
- Deploys are model-guarded on `E5800` (`tools/deploy.sh` does this — always deploy through it).
- The console channel has **no `sub_id`** — it answers for the active subscription only. Never send `sub_id=0` anywhere (CLAUDE.md §6).
- During dev, only run query (`?`) / test (`=?`) AT forms unprompted. Never `restore_band`. Don't reboot the Mudi.
- Timeout chain (spec §2): tool `select()` deadline (1–60 s, default 8) < backend `io.popen` block (tool self-limits) < frontend `$rpcRequest` timeout (tool + 10 s).
- After editing the Lua backend on the box, `/etc/init.d/nginx restart` (not reload) — deploy.sh does it.
- Library `risk` values are exactly `read` | `set` | `nv`; every `set`/`nv` entry needs `warn`; nothing ever auto-runs.
- Node is dev-only; nothing extra ships to the router beyond the five Phase-3 artifacts (console chunk .gz, at-library.json.gz, mudimodem-at.py, updated rpc/mudimodem, updated menu-less scripts).
- Commit at the end of every task (Kevin has approved plan-driven commits for this phase).

**Worktree:** all work happens in `/home/kevin/MudiModem/.worktrees/at-console` (branch `at-console`). All paths below are relative to that root.

---

### Task 1: Upgrade `tools/mudimodem-at.py` — envelope CLI, flock, gl_modem sleep

The Python tool becomes the transport the backend spawns. New capabilities: `--envelope` machine output (`MM-AT:<status>:<elapsed_ms>` + raw response), `fcntl.flock` serialization, SIGSTOP/SIGCONT of `gl_modem` with startup recovery, and `send()` now reports whether a terminator was seen.

**Files:**
- Modify: `tools/mudimodem-at.py` (full rewrite below; keeps `ATChannel` + `lines()` API)
- Test: `test/at-tool.test.py` (new; pty plays the modem — no hardware needed)

**Interfaces:**
- Produces (CLI, consumed by Task 2's Lua): `python3 mudimodem-at.py --envelope --timeout N [--port P] [--lock PATH] [--lock-wait S] [--no-glsleep] 'CMD'` → stdout line 1 `MM-AT:<ok|timeout|busy|openfail>:<elapsed_ms>`, then the raw response bytes (may be empty). Exit 0 on ok/timeout, 2 busy, 3 openfail.
- Produces (module): `ATChannel(port, lock, lock_wait)` (raises `ChannelBusy`), `.send(cmd, timeout) -> (text, terminator_seen)`, `.lines(cmd, timeout)`, `recover_stopped()`, `GlModemSleep(enabled)` context manager, `gl_modem_pids()`, `proc_state(pid)`.

- [ ] **Step 1: Write the failing test**

Create `test/at-tool.test.py`:

```python
#!/usr/bin/env python3
"""Local tests for tools/mudimodem-at.py. No modem needed: a pty plays the
modem (raw mode, so no line-discipline mangling; the tool never does termios,
matching the real /dev/at_mdm0 which is not a tty)."""
import importlib.util, os, subprocess, sys, tempfile, threading, time, tty, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
TOOL = os.path.join(ROOT, "tools", "mudimodem-at.py")

spec = importlib.util.spec_from_file_location("mudimodem_at", TOOL)
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)


class FakeModem:
    """Answers the first AT command written to the pty with a canned reply."""
    def __init__(self, reply=b"\r\nOK\r\n", delay=0.0):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)          # raw byte stream, like the real port
        self.path = os.ttyname(self.slave)
        self.reply, self.delay = reply, delay
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        buf = b""
        while b"\r" not in buf:
            try:
                b = os.read(self.master, 64)
            except OSError:
                return
            if not b:
                return
            buf += b
        if self.delay:
            time.sleep(self.delay)
        if self.reply:
            os.write(self.master, self.reply)


class ATToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.lock = os.path.join(self.tmp, "at.lock")

    def test_send_ok_sees_terminator(self):
        fm = FakeModem(b"\r\n+QSPN: \"T-Mobile\"\r\n\r\nOK\r\n")
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, ok = ch.send("AT+QSPN", timeout=3)
        finally:
            ch.close()
        self.assertTrue(ok, "terminator must be recognised")
        self.assertIn("OK", text)
        self.assertIn("T-Mobile", text)

    def test_send_timeout_reports_no_terminator(self):
        fm = FakeModem(reply=b"")           # never answers
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, ok = ch.send("AT", timeout=0.4)
        finally:
            ch.close()
        self.assertFalse(ok)
        self.assertEqual(text, "")

    def test_lines_filters_urcs(self):
        fm = FakeModem(b"\r\n+QIND: SMS DONE\r\n+QSPN: \"T\"\r\nOK\r\n")
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            out = ch.lines("AT+QSPN", timeout=3)
        finally:
            ch.close()
        self.assertNotIn("+QIND: SMS DONE", out)
        self.assertTrue(any("QSPN" in l for l in out))
        self.assertIn("OK", out)

    def test_flock_busy(self):
        fm = FakeModem()
        holder = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            with self.assertRaises(mm.ChannelBusy):
                mm.ATChannel(port=fm.path, lock=self.lock, lock_wait=0.3)
        finally:
            holder.close()

    def test_recover_stopped_is_safe_without_gl_modem(self):
        mm.recover_stopped()                # dev box has no gl_modem: no-op, no raise
        self.assertEqual(mm.gl_modem_pids(), [])

    def test_glmodem_sleep_noop_without_daemon(self):
        with mm.GlModemSleep(True) as s:
            self.assertEqual(s.stopped, [])

    def test_cli_envelope_ok(self):
        fm = FakeModem(b"\r\nRG650VNA\r\n\r\nOK\r\n")
        r = subprocess.run(
            [sys.executable, TOOL, "--envelope", "--timeout", "3",
             "--port", fm.path, "--lock", self.lock, "--no-glsleep", "ATI"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        first, _, rest = r.stdout.partition("\n")
        self.assertRegex(first, r"^MM-AT:ok:\d+$")
        self.assertIn("RG650VNA", rest)
        self.assertIn("OK", rest)

    def test_cli_envelope_busy(self):
        fm = FakeModem()
        holder = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            r = subprocess.run(
                [sys.executable, TOOL, "--envelope", "--timeout", "2",
                 "--port", fm.path, "--lock", self.lock, "--lock-wait", "0.3",
                 "--no-glsleep", "AT"],
                capture_output=True, text=True, timeout=15)
        finally:
            holder.close()
        self.assertEqual(r.returncode, 2)
        self.assertRegex(r.stdout.splitlines()[0], r"^MM-AT:busy:\d+$")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 test/at-tool.test.py`
Expected: FAIL — `AttributeError: module 'mudimodem_at' has no attribute 'ChannelBusy'` (and/or `ATChannel.__init__() got an unexpected keyword argument 'lock'`).

- [ ] **Step 3: Rewrite `tools/mudimodem-at.py`**

Replace the whole file with:

```python
#!/usr/bin/env python3
"""MudiModem's own AT channel — an independent, compile-free AT client.

Talks to the modem over /dev/at_mdm0, a free, world-accessible AT port SEPARATE
from GL's /dev/smd9 (which GL's modem_AT holds). Because it's our own channel,
responses never cross with GL's background polling — the failure that garbles
`ubus call modem.CPU.AT` when the modem is churning (reference §8).

CPython stdlib only (os, select, fcntl, signal). No pyserial, no compiler — the
box ships Python 3.11. This is the transport for the Phase 3 AT console.

Backend usage (one command per invocation):
    python3 mudimodem-at.py --envelope --timeout 8 'AT+QSPN'
  stdout line 1:  MM-AT:<status>:<elapsed_ms>     status: ok|timeout|busy|openfail
  then:           the raw response, verbatim (URCs included; may be empty)
  exit code:      0 ok/timeout, 2 busy, 3 openfail

Serialization + GL coexistence:
  - fcntl.flock on /tmp/mudimodem/at.lock serializes concurrent invocations
    (nginx has 4 workers). Lock not acquired within --lock-wait (5 s) => busy.
  - While sending, every `gl_modem` process (GL's AT traffic source) is
    SIGSTOPped, and SIGCONTed in a finally. On startup, any gl_modem already
    in state T is CONTed first — recovery from a killed predecessor. modem_AT
    and cellular_manager are deliberately left alone (spec 2026-07-18 §2).
  - /dev/at_mdm0 is also held by GL's port-bridge (USB-AT passthrough). Probed
    coexistence is clean; drain-before-send + strict terminator matching are
    the defense against stray bytes.

⚠️ Caveats (reference §8):
  - Open BLOCKING: the SMD channel returns EBUSY on a non-blocking write.
  - /dev/at_mdm0 is NOT a tty, so no termios setup (it's a raw byte stream).
  - No sub_id: the direct port operates in the ACTIVE subscription's context
    only (probed 2026-07-18: no subscription selector exists on this port).
    For per-SIM data (the other SIM's policy_band) use GL's modem.CPU.AT.
  - Writes hit modem NV the same as any AT path — and GL re-applies its own
    stored config on cellular_manager restart, so raw-AT band writes are not
    durable on their own (reference §9).
"""
import fcntl, os, select, signal, sys, time

DEFAULT_PORT = "/dev/at_mdm0"
DEFAULT_LOCK = "/tmp/mudimodem/at.lock"
# Unsolicited result codes that arrive unprompted, unrelated to our command.
URC_PREFIXES = ("RDY", "+CPIN:", "+QUSIM:", "+QUSIM", "+CPINDS:", "+QIND:",
                "+CFUN:", "+CGEV:", "+QNETDEVSTATUS:", "POWERED DOWN")


def gl_modem_pids():
    """PIDs of GL's gl_modem daemon(s) — the AT traffic source we quiet."""
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/comm" % name) as f:
                if f.read().strip() == "gl_modem":
                    pids.append(int(name))
        except OSError:
            pass
    return pids


def proc_state(pid):
    """Single-letter process state from /proc/<pid>/stat (comm-safe split)."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().rsplit(") ", 1)[1].split()[0]
    except (OSError, IndexError):
        return None


def recover_stopped():
    """CONT any gl_modem left stopped by a killed predecessor. Run at startup —
    a stopped gl_modem that never wakes is worse than a crossed response."""
    for pid in gl_modem_pids():
        if proc_state(pid) == "T":
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass


class GlModemSleep:
    """SIGSTOP gl_modem for the duration of the send; ALWAYS SIGCONT on exit."""
    def __init__(self, enabled=True):
        self.enabled, self.stopped = enabled, []

    def __enter__(self):
        if self.enabled:
            for pid in gl_modem_pids():
                try:
                    os.kill(pid, signal.SIGSTOP)
                    self.stopped.append(pid)
                except OSError:
                    pass
        return self

    def __exit__(self, *exc):
        for pid in self.stopped:
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass
        self.stopped = []
        return False


class ChannelBusy(Exception):
    """Another invocation holds the AT channel lock."""


class ATChannel:
    def __init__(self, port=DEFAULT_PORT, lock=DEFAULT_LOCK, lock_wait=5.0):
        self.lockf = None
        if lock:
            d = os.path.dirname(lock)
            if d:
                os.makedirs(d, exist_ok=True)
            self.lockf = open(lock, "w")
            deadline = time.time() + lock_wait
            while True:
                try:
                    fcntl.flock(self.lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() >= deadline:
                        self.lockf.close()
                        self.lockf = None
                        raise ChannelBusy()
                    time.sleep(0.2)
        # BLOCKING open (non-blocking writes return EBUSY on this SMD channel);
        # reads are gated by select() for the timeout.
        try:
            self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY)
        except OSError:
            if self.lockf:
                self.lockf.close()
                self.lockf = None
            raise

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass
        if self.lockf:
            try:
                self.lockf.close()
            except OSError:
                pass
            self.lockf = None

    def _drain(self):
        while select.select([self.fd], [], [], 0)[0]:
            try:
                if not os.read(self.fd, 4096):
                    break
            except OSError:
                break

    def send(self, cmd, timeout=8):
        """Send one AT command. Returns (raw_text, terminator_seen)."""
        self._drain()
        os.write(self.fd, (cmd + "\r").encode())
        buf, ok, deadline = b"", False, time.time() + timeout
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
            if any(k in t for k in ("\nOK\r", "\nERROR\r", "+CME ERROR", "+CMS ERROR")):
                ok = True
                break
        return buf.decode(errors="replace"), ok

    def lines(self, cmd, timeout=8):
        """send(), returned as clean lines with URCs filtered out."""
        resp, _ok = self.send(cmd, timeout)
        out = [l.strip() for l in resp.replace("\r", "\n").split("\n") if l.strip()]
        return [l for l in out if not l.startswith(URC_PREFIXES)]


def main(argv):
    envelope, timeout, port = False, 8, DEFAULT_PORT
    lock, lock_wait, glsleep = DEFAULT_LOCK, 5.0, True
    cmds, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--envelope":
            envelope = True
        elif a == "--timeout":
            i += 1
            timeout = max(1, min(60, int(float(argv[i]))))
        elif a == "--port":
            i += 1
            port = argv[i]
        elif a == "--lock":
            i += 1
            lock = argv[i] or None
        elif a == "--lock-wait":
            i += 1
            lock_wait = float(argv[i])
        elif a == "--no-glsleep":
            glsleep = False
        else:
            cmds.append(a)
        i += 1
    if not cmds:
        print("usage: mudimodem-at.py [--envelope] [--timeout N] [--port P]"
              " [--lock PATH] [--lock-wait S] [--no-glsleep] CMD...", file=sys.stderr)
        return 1

    recover_stopped()
    t0 = time.time()

    def ms():
        return int((time.time() - t0) * 1000)

    try:
        ch = ATChannel(port, lock, lock_wait)
    except ChannelBusy:
        if envelope:
            print("MM-AT:busy:%d" % ms())
        else:
            print("busy: another command holds the AT channel", file=sys.stderr)
        return 2
    except OSError as e:
        if envelope:
            print("MM-AT:openfail:%d" % ms())
        else:
            print("cannot open %s: %s" % (port, e), file=sys.stderr)
        return 3

    try:
        with GlModemSleep(glsleep):
            if envelope:
                resp, ok = ch.send(cmds[0], timeout)
                print("MM-AT:%s:%d" % ("ok" if ok else "timeout", ms()))
                sys.stdout.write(resp)
                return 0
            for cmd in cmds:
                t1 = time.time()
                for l in ch.lines(cmd, timeout):
                    print("    " + l)
                print(">>> %s   (%.2fs)" % (cmd, time.time() - t1))
            return 0
    finally:
        ch.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 test/at-tool.test.py`
Expected: `OK` with 8 tests passed. Also smoke the old CLI shape still works: `python3 tools/mudimodem-at.py 2>&1 | grep -q usage && echo usage-ok` → `usage-ok` (exit 1 with usage on no args).

- [ ] **Step 5: Commit**

```bash
git add tools/mudimodem-at.py test/at-tool.test.py
git commit -m "Phase 3: AT tool grows envelope CLI, flock, gl_modem sleep + recovery"
```

---
### Task 2: Backend `at_console` method + on-device tests

One new Lua method in the existing plugin: clamp args, spawn the tool, parse the envelope. It must never touch ubus. Tested on the box (the repo's established pattern — the dev box has no Lua) with a **fake** tool, so no modem traffic and no deploy is needed yet.

**Files:**
- Modify: `src/rpc/mudimodem` (add `at_console` near the end, before `return M`)
- Modify: `test/backend.test.lua:20` (ALLOWED list)
- Test: `test/backend-console.test.lua` (new), `test/fake-at-tool.py` (new)

**Interfaces:**
- Consumes: Task 1's envelope CLI (`MM-AT:<status>:<elapsed_ms>` + raw response).
- Produces (RPC, consumed by Task 4's chunk): `mudimodem.at_console{cmd: string, timeout?: number}` → `{ok: true, status: "ok"|"timeout", response: string, elapsed_ms: number}` or `{error: string}`. Note `{error}` comes back as a *resolved* result (GL's `$rpcRequest` only rejects on `err_msg`/`err_code`), so the frontend must check `r.error`.

- [ ] **Step 1: Write the fake tool and the failing test**

Create `test/fake-at-tool.py`:

```python
#!/usr/bin/env python3
"""Stands in for mudimodem-at.py in backend tests: prints a valid envelope and
echoes its argv so the test can assert clamping/quoting. No modem, no locks."""
import sys
print("MM-AT:ok:5")
print("ARGS:" + " ".join(sys.argv[1:]))
```

Create `test/backend-console.test.lua`:

```lua
-- On-device test for mudimodem.at_console (arg clamping + envelope parsing),
-- run against a FAKE tool (test/fake-at-tool.py) so no modem traffic happens.
-- Env: MM_PLUGIN=<plugin path>  MUDIMODEM_AT_TOOL=<fake tool path>
-- at_console must never touch ubus — the stub below makes any call fatal.
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
assert(M.at_console({ cmd = string.rep("A", 300) }).error, "over-long cmd must error")

-- Happy path through the fake tool: envelope parsed, args passed through.
local r = M.at_console({ cmd = 'AT+QNWPREFCFG="nr5g_band"', timeout = 999 })
assert(r.ok == true, "expected ok, got: " .. tostring(r.error))
assert(r.status == "ok", "status must come from the envelope")
assert(type(r.elapsed_ms) == "number", "elapsed_ms must be a number")
assert(r.response:find("--timeout 60", 1, true), "timeout must clamp to 60, got: " .. r.response)
assert(r.response:find('AT+QNWPREFCFG="nr5g_band"', 1, true),
  "cmd must pass through with inner quotes intact")

-- Timeout clamps low too, and defaults to 8.
local r2 = M.at_console({ cmd = "AT", timeout = 0 })
assert(r2.ok and r2.response:find("--timeout 1", 1, true), "timeout must clamp up to 1")
local r3 = M.at_console({ cmd = "AT" })
assert(r3.ok and r3.response:find("--timeout 8", 1, true), "timeout must default to 8")

-- Newlines collapse: one command per send, no injection of a second line.
local r4 = M.at_console({ cmd = "AT\nATZ" })
assert(r4.ok, "collapsed cmd must still run")
assert(r4.response:find("AT ATZ", 1, true), "newline must collapse to a space")
assert(not r4.response:find("\nATZ", 1, true), "no second command line")

-- Single quotes in cmd must not break the shell quoting.
local r5 = M.at_console({ cmd = "AT+X='y'" })
assert(r5.ok and r5.response:find("AT+X='y'", 1, true), "single quotes survive")

print("at_console backend OK")
```

- [ ] **Step 2: Run it to verify it fails**

```bash
ssh root@mudi 'mkdir -p /tmp/mmtest'
ssh root@mudi 'cat > /tmp/mmtest/plugin'      < src/rpc/mudimodem
ssh root@mudi 'cat > /tmp/mmtest/fake-at.py'  < test/fake-at-tool.py
ssh root@mudi 'cat > /tmp/mmtest/t.lua'       < test/backend-console.test.lua
ssh root@mudi 'MM_PLUGIN=/tmp/mmtest/plugin MUDIMODEM_AT_TOOL=/tmp/mmtest/fake-at.py lua /tmp/mmtest/t.lua'
```
Expected: FAIL with `at_console missing`.

- [ ] **Step 3: Implement `at_console`**

In `src/rpc/mudimodem`, insert immediately before the final `return M`:

```lua
-- ============================ Phase 3: AT console ============================
-- Raw AT over OUR OWN channel (/dev/at_mdm0), NOT GL's modem.CPU.AT. The heavy
-- lifting — flock serialization, gl_modem SIGSTOP with paired SIGCONT +
-- startup recovery, drain/terminator read loop, timeout — lives in the Python
-- tool; this method only clamps args, spawns it, and parses the one-line
-- envelope (MM-AT:<status>:<elapsed_ms>). The port has NO sub_id: it answers
-- for the ACTIVE subscription only (spec 2026-07-18 §0).
--
-- io.popen blocks this nginx worker until the tool exits. The tool self-limits
-- to timeout + lock-wait, so the block is bounded (consistent with the
-- existing os.execute use in set_bands). No ubus in here, so no cosocket, so
-- this is safe even though it blocks.
local AT_TOOL = os.getenv("MUDIMODEM_AT_TOOL") or "/usr/lib/mudimodem/mudimodem-at.py"

function M.at_console(args)
  local cmd = args and args.cmd
  if type(cmd) ~= "string" then return { error = "cmd required" } end
  -- One command per send: collapse CR/LF, trim. Raw otherwise (it's a console).
  cmd = cmd:gsub("[\r\n]+", " "):match("^%s*(.-)%s*$")
  if cmd == "" then return { error = "cmd required" } end
  if #cmd > 256 then return { error = "command too long (max 256 chars)" } end
  local timeout = tonumber(args and args.timeout) or 8
  if timeout < 1 then timeout = 1 end
  if timeout > 60 then timeout = 60 end
  timeout = math.floor(timeout)

  -- POSIX shell single-quote escaping: ' -> '\''
  local quoted = "'" .. cmd:gsub("'", "'\\''") .. "'"
  local f = io.popen("python3 " .. AT_TOOL .. " --envelope --timeout " ..
                     timeout .. " " .. quoted .. " 2>/dev/null")
  if not f then return { error = "failed to spawn the AT tool" } end
  local out = f:read("*a") or ""
  f:close()

  local status, ms, rest = out:match("^MM%-AT:(%w+):(%d+)\r?\n?(.*)$")
  if not status then
    return { error = "AT tool returned no envelope (is " .. AT_TOOL .. " deployed?)" }
  end
  if status == "busy" then return { error = "channel busy - another command in flight" } end
  if status == "openfail" then return { error = "cannot open the AT port (/dev/at_mdm0)" } end
  return { ok = true, status = status, response = rest, elapsed_ms = tonumber(ms) }
end
```

Also update `test/backend.test.lua` line 20 so the method-surface check admits the new method:

```lua
local ALLOWED = { get_bands = true, set_bands = true, confirm = true, revert_now = true, get_history = true, at_console = true }
```

- [ ] **Step 4: Run the test to verify it passes**

Re-push and run (same commands as Step 2, re-pushing `/tmp/mmtest/plugin` from the edited `src/rpc/mudimodem`).
Expected: `at_console backend OK`. Clean up: `ssh root@mudi 'rm -rf /tmp/mmtest'`.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/mudimodem test/backend.test.lua test/backend-console.test.lua test/fake-at-tool.py
git commit -m "Phase 3: at_console RPC — clamp, spawn AT tool, parse envelope"
```

---

### Task 3: The AT library — entries, schema doc, build-time validator

Pure data: two vendor files, a README documenting the schema for contributors, and a validator that merges them into `build/at-library.json` and fails the build on schema violations. Content is corrected against `reference/quectel-at-reference.md` (QENG includes `tac`; QNWLOCK syntax is the verified box capture; QCAINFO ships without decode; `restore_band`/`QPRTPARA` excluded — spec §3).

**Files:**
- Create: `src/at-library/quectel.json`, `src/at-library/3gpp.json`, `src/at-library/README.md`, `tools/lib-validate.py`
- Modify: `tools/build.sh`

**Interfaces:**
- Produces (consumed by Task 4's chunk via axios): `build/at-library.json` → `{"version": 1, "entries": [...]}` with entries sorted by `(cat, title)`. Entry fields per spec §3: `id cat title cmd risk vendor verified summary source by` (+ optional `warn params decode`). `params[]`: `{name, hint, example?, values?}`. `decode`: `{prefix, fields, hi?, enums?}`.

- [ ] **Step 1: Write the validator**

Create `tools/lib-validate.py`:

```python
#!/usr/bin/env python3
"""Merge + validate the AT library: src/at-library/*.json -> build/at-library.json

Schema: docs/superpowers/specs/2026-07-18-at-console-library-design.md §3.
Run by tools/build.sh; exits 1 with per-entry messages on any violation, so a
bad community PR can never ship. Python 3 stdlib only; dev-box only (the router
receives the merged, gzipped result)."""
import glob, json, os, re, sys

RISKS = {"read", "set", "nv"}
REQUIRED = ["id", "cat", "title", "cmd", "risk", "vendor", "verified", "summary", "source", "by"]
PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def fail(msgs):
    for m in msgs:
        print("at-library: " + m, file=sys.stderr)
    sys.exit(1)


def validate(entries):
    errs, seen = [], set()
    for e in entries:
        eid = e.get("id", "<missing id>")
        for k in REQUIRED:
            if k not in e:
                errs.append("%s: missing field '%s'" % (eid, k))
        if e.get("risk") not in RISKS:
            errs.append("%s: risk must be one of %s" % (eid, sorted(RISKS)))
        if e.get("risk") in ("set", "nv") and not e.get("warn"):
            errs.append("%s: set/nv entries need a 'warn' stating the consequence" % eid)
        if eid in seen:
            errs.append("%s: duplicate id" % eid)
        seen.add(eid)
        if not isinstance(e.get("verified"), list):
            errs.append("%s: verified must be a list (empty = 'nobody yet')" % eid)
        ph = set(PLACEHOLDER.findall(e.get("cmd", "")))
        pnames = set(p.get("name") for p in e.get("params", []))
        if ph != pnames:
            errs.append("%s: params %s must exactly cover placeholders %s"
                        % (eid, sorted(pnames), sorted(ph)))
        for p in e.get("params", []):
            if not p.get("name") or not p.get("hint"):
                errs.append("%s: every param needs name + hint" % eid)
        d = e.get("decode")
        if d is not None:
            if not d.get("prefix"):
                errs.append("%s: decode needs a prefix" % eid)
            if not d.get("fields"):
                errs.append("%s: decode.fields must be non-empty" % eid)
    return errs


def main():
    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    files = sorted(glob.glob(os.path.join(root, "src", "at-library", "*.json")))
    if not files:
        fail(["no library files in src/at-library/"])
    entries = []
    for path in files:
        with open(path) as f:
            try:
                data = json.load(f)
            except ValueError as e:
                fail(["%s: invalid JSON: %s" % (path, e)])
        if not isinstance(data, list):
            fail(["%s: top level must be a list of entries" % path])
        entries += data
    errs = validate(entries)
    if errs:
        fail(errs)
    entries.sort(key=lambda e: (e["cat"], e["title"]))
    out = os.path.join(root, "build", "at-library.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump({"version": 1, "entries": entries}, f, indent=1)
    print("at-library: %d entries from %d files -> %s" % (len(entries), len(files), out))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it to verify it fails (no library yet)**

Run: `python3 tools/lib-validate.py`
Expected: exit 1, `at-library: no library files in src/at-library/`.

- [ ] **Step 3: Write the library entries**

Create `src/at-library/quectel.json` (a JSON **list**; every fact below is from `reference/quectel-at-reference.md` — QENG field order and QNWLOCK syntax are 🟢 box-verified):

```json
[
  { "id": "quectel.serving-cell", "cat": "Diagnostics", "title": "Serving cell details",
    "cmd": "AT+QENG=\"servingcell\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "Everything about the cell you're camped on — PCI, ARFCN, band, and the three numbers that matter (RSRP, RSRQ, SINR).",
    "source": "RG50xQ&RM5xxQ manual §5.11 format; NR5G-SA field order verified on box 2026-07-17",
    "by": "kevin",
    "decode": {
      "prefix": "+QENG: \"servingcell\"",
      "fields": ["state", "rat", "duplex", "mcc", "mnc", "cell_id", "pci", "tac",
                 "arfcn", "band", "dl_bandwidth", "rsrp", "rsrq", "sinr", "tx_power", "srxlev"],
      "hi": ["rsrp", "rsrq", "sinr"],
      "enums": { "dl_bandwidth": { "0": "5 MHz", "1": "10 MHz", "2": "15 MHz", "3": "20 MHz",
                                   "4": "25 MHz", "5": "30 MHz", "6": "40 MHz", "7": "50 MHz",
                                   "8": "60 MHz", "9": "80 MHz", "10": "90 MHz", "11": "100 MHz",
                                   "12": "200 MHz", "13": "400 MHz" } } } },
  { "id": "quectel.operator", "cat": "Diagnostics", "title": "Operator name (from the SIM)",
    "cmd": "AT+QSPN", "risk": "read", "vendor": "quectel", "verified": ["RG650V-NA"],
    "summary": "Service provider name as the SIM reports it — not what the tower advertises. The last field is the registered PLMN.",
    "source": "verified on box 2026-07-17", "by": "kevin",
    "decode": { "prefix": "+QSPN:",
                "fields": ["full_name", "short_name", "spn", "alphabet", "rplmn"] } },
  { "id": "quectel.firmware", "cat": "Diagnostics", "title": "Modem firmware version",
    "cmd": "AT+QGMR", "risk": "read", "vendor": "quectel", "verified": ["RG650V-NA"],
    "summary": "Full firmware build string. Quote this when reporting AT behaviour — AT command sets are firmware-specific.",
    "source": "verified on box 2026-07-16", "by": "kevin" },
  { "id": "quectel.ca-info", "cat": "Diagnostics", "title": "Carrier aggregation",
    "cmd": "AT+QCAINFO", "risk": "read", "vendor": "quectel", "verified": ["RG650V-NA"],
    "summary": "Which carriers are aggregated right now. No field decode yet: this box returns pcell_state=5, which the (5-series) manual says can't happen — don't trust positional decodes until that's resolved.",
    "source": "manual §5.13; pcell_state anomaly captured on box 2026-07-17", "by": "kevin" },
  { "id": "quectel.policy-band", "cat": "Bands", "title": "Which bands the carrier permits",
    "cmd": "AT+QNWPREFCFG=\"policy_band\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "The carrier's per-SIM allowlist — the list no router UI shows you. What the modem actually uses is your config ∩ this. On this box T-Mobile permits 6 of the 18 SA bands the module supports.",
    "source": "verified on box 2026-07-17 (both SIMs)", "by": "kevin" },
  { "id": "quectel.ue-capability-band", "cat": "Bands", "title": "Bands the modem actually advertises",
    "cmd": "AT+QNWPREFCFG=\"ue_capability_band\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "The end result: config ∩ policy. If a band you configured is missing here, carrier policy silently dropped it.",
    "source": "verified on box 2026-07-17", "by": "kevin" },
  { "id": "quectel.nr5g-band-get", "cat": "Bands", "title": "Configured 5G SA bands",
    "cmd": "AT+QNWPREFCFG=\"nr5g_band\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "Your configured SA allowlist, colon-separated. A lone 0 means EMPTY, not all.",
    "source": "verified on box 2026-07-17", "by": "kevin" },
  { "id": "quectel.nsa-band-get", "cat": "Bands", "title": "Configured 5G NSA bands",
    "cmd": "AT+QNWPREFCFG=\"nsa_nr5g_band\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "The NSA allowlist — separate from SA, and easy to forget.",
    "source": "verified on box 2026-07-17", "by": "kevin" },
  { "id": "quectel.lte-band-get", "cat": "Bands", "title": "Configured LTE bands",
    "cmd": "AT+QNWPREFCFG=\"lte_band\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "The LTE allowlist. On this box two configured bands (7, 38) are silently dropped by carrier policy — compare with policy_band.",
    "source": "verified on box 2026-07-17", "by": "kevin" },
  { "id": "quectel.mode-pref", "cat": "Bands", "title": "Preferred network mode",
    "cmd": "AT+QNWPREFCFG=\"mode_pref\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "AUTO, NR5G, LTE, or a colon-combination.",
    "source": "verified on box 2026-07-17", "by": "kevin" },
  { "id": "quectel.nr5g-band-set", "cat": "Bands", "title": "Set the 5G SA allowlist",
    "cmd": "AT+QNWPREFCFG=\"nr5g_band\",{{bands}}", "risk": "nv", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "Restrict the modem to these SA bands.",
    "warn": "Writes NV immediately — there is no commit step; it survives reboot, reflash and factory reset. GL re-applies its own stored config on cellular_manager restart, so prefer the Bands tab (confirm-or-revert + durable) over this raw form. Lock onto a band with no coverage and you lose the link.",
    "source": "verified on box 2026-07-17", "by": "kevin",
    "params": [ { "name": "bands",
                  "hint": "Colon-separated band numbers, e.g. 41:66:71. Only policy-permitted bands ever take (see policy_band).",
                  "example": "41:66:71" } ] },
  { "id": "quectel.lock-status-4g", "cat": "Cell lock", "title": "LTE cell-lock status",
    "cmd": "AT+QNWLOCK=\"common/4g\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "Query the LTE cell lock. \",0\" means not locked.",
    "source": "AT+QNWLOCK=? + query captured on box 2026-07-17 (reference §6a)", "by": "kevin" },
  { "id": "quectel.lock-status-5g", "cat": "Cell lock", "title": "NR cell-lock status",
    "cmd": "AT+QNWLOCK=\"common/5g\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "Query the NR cell lock. \",0\" means not locked. Note: a band lock (QNWPREFCFG) is a different mechanism and won't show here.",
    "source": "AT+QNWLOCK=? + query captured on box 2026-07-17 (reference §6a)", "by": "kevin" },
  { "id": "quectel.lock-4g", "cat": "Cell lock", "title": "Lock to an LTE cell",
    "cmd": "AT+QNWLOCK=\"common/4g\",{{mode}},{{earfcn}},{{pci}}", "risk": "nv",
    "vendor": "quectel", "verified": [],
    "summary": "Pin the modem to one LTE cell: mode, then EARFCN, then PCI.",
    "warn": "Set-side semantics are NOT fully mapped on the RG650V (mode 0-10 meaning, persistence vs save_ctrl). If that cell goes away, so does your connection. Syntax is from the box's own test form; nobody has verified a successful set yet.",
    "source": "AT+QNWLOCK=? test form captured on box 2026-07-17 (reference §6a)", "by": "kevin",
    "params": [
      { "name": "mode",   "hint": "Lock strength 0-10 — exact meaning not yet mapped on this module", "example": "1" },
      { "name": "earfcn", "hint": "EARFCN of the target cell (from the serving-cell/neighbour reads)", "example": "67036" },
      { "name": "pci",    "hint": "Physical cell ID of the target cell", "example": "42" } ] },
  { "id": "quectel.lock-5g", "cat": "Cell lock", "title": "Lock to a 5G cell",
    "cmd": "AT+QNWLOCK=\"common/5g\",{{pci}},{{arfcn}},{{scs}},{{band}}", "risk": "nv",
    "vendor": "quectel", "verified": [],
    "summary": "Pin the modem to one NR cell. PCI comes FIRST — an earlier community guess had it second, which would lock to a nonexistent cell.",
    "warn": "Set-side semantics are NOT fully mapped (scs encoding, persistence). If that cell goes away, so does your connection. Syntax is from the box's own test form; nobody has verified a successful set yet.",
    "source": "AT+QNWLOCK=? test form captured on box 2026-07-17 (reference §6a)", "by": "kevin",
    "params": [
      { "name": "pci",   "hint": "Physical cell ID of the target cell", "example": "721" },
      { "name": "arfcn", "hint": "NR-ARFCN of the target cell", "example": "127490" },
      { "name": "scs",   "hint": "Subcarrier spacing — encoding not yet mapped (likely an index for 15/30/60 kHz)", "example": "0" },
      { "name": "band",  "hint": "NR band number, without the n prefix", "example": "71" } ] },
  { "id": "quectel.lock-clear", "cat": "Cell lock", "title": "Clear a cell lock",
    "cmd": "AT+QNWLOCK=\"common/4g\",0", "risk": "nv", "vendor": "quectel", "verified": [],
    "summary": "Release the LTE cell lock and let the modem roam again — the other half of any lock experiment.",
    "warn": "Set-side UNVERIFIED. The query form returns \",0\" when unlocked, so \",0\" to clear is plausible — confirm on a box you can reach out-of-band before relying on it.",
    "source": "inferred from the query form — unverified", "by": "community" },
  { "id": "quectel.lock-save-ctrl", "cat": "Cell lock", "title": "Cell-lock persistence flags",
    "cmd": "AT+QNWLOCK=\"save_ctrl\"", "risk": "read", "vendor": "quectel",
    "verified": ["RG650V-NA"],
    "summary": "Two 0/1 flags controlling whether cell locks persist (exact mapping unconfirmed; this box reads 0,0). Unlike band config, cell lock appears to have a non-persist option.",
    "source": "captured on box 2026-07-17 (reference §6a)", "by": "kevin" }
]
```

Create `src/at-library/3gpp.json`:

```json
[
  { "id": "3gpp.identity", "cat": "Diagnostics", "title": "Modem identity",
    "cmd": "ATI", "risk": "read", "vendor": "any", "verified": ["RG650V-NA"],
    "summary": "Manufacturer, model and revision. The universal 'what am I talking to'.",
    "source": "ITU V.250 §6.1.3", "by": "kevin" },
  { "id": "3gpp.signal", "cat": "Diagnostics", "title": "Signal quality (universal)",
    "cmd": "AT+CSQ", "risk": "read", "vendor": "any", "verified": ["RG650V-NA"],
    "summary": "The one signal read every modem ever made understands. RSSI 0-31 (99 = unknown), bit error rate.",
    "source": "3GPP TS 27.007 §8.5", "by": "kevin",
    "decode": { "prefix": "+CSQ:", "fields": ["rssi", "ber"],
                "enums": { "rssi": { "99": "unknown" }, "ber": { "99": "unknown" } } } },
  { "id": "3gpp.registration-5g", "cat": "Diagnostics", "title": "5G network registration",
    "cmd": "AT+C5GREG?", "risk": "read", "vendor": "any", "verified": ["RG650V-NA"],
    "summary": "Whether you're registered on 5G. Second number: 1 = home, 5 = roaming, 2 = searching, 3 = denied.",
    "source": "3GPP TS 27.007 §10.1.35", "by": "kevin" },
  { "id": "3gpp.radio", "cat": "Power", "title": "Radio off / on",
    "cmd": "AT+CFUN={{fun}}", "risk": "set", "vendor": "any", "verified": ["RG650V-NA"],
    "summary": "Airplane mode at the modem. 0 is off, 1 is full function. Forces re-registration on the way back up.",
    "warn": "Runtime only — a reboot restores the radio — but you WILL drop the cellular link (and possibly this admin session) for ~20 seconds.",
    "source": "3GPP TS 27.007 §8.2", "by": "kevin",
    "params": [ { "name": "fun", "hint": "0 = radio off, 1 = full function",
                  "example": "1", "values": ["0", "1"] } ] }
]
```

Create `src/at-library/README.md`:

```markdown
# The MudiModem AT command library

Community-contributed AT snippets, shipped on the router and rendered by the
AT-console tab. Pure data — you can contribute without writing a line of JS.
Send a PR adding/editing entries in `<vendor>.json` here; `tools/lib-validate.py`
(run by every build) enforces this schema.

## Entry schema

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique, `vendor.slug` |
| `cat` | yes | grouping shown in the rail (Diagnostics, Bands, Cell lock, Power, …) |
| `title` | yes | short human title |
| `cmd` | yes | the AT command; `{{name}}` placeholders for parameters |
| `risk` | yes | `read` (query only) · `set` (runtime state, gone on reboot) · `nv` (writes NV — survives reboot, reflash AND factory reset) |
| `warn` | for set/nv | the concrete consequence, plainly stated |
| `vendor` | yes | `quectel`, `any`, … — AT is vendor- and firmware-specific |
| `verified` | yes | list of module names this was confirmed on. `[]` renders as "nobody yet" — entries are never hidden for being unverified, but never pretend either |
| `summary` | yes | one or two plain-language sentences |
| `source` | yes | where this knowledge comes from (manual §, box capture, forum post) |
| `by` | yes | contributor handle |
| `params` | iff `cmd` has `{{…}}` | `[{name, hint, example?, values?}]` — drives the fill-in form; `values` renders a dropdown |
| `decode` | optional | `{prefix, fields, hi?, enums?}` — response lines starting with `prefix` are split (quote-aware) and labelled with `fields`; `hi` names get highlighted; `enums` maps raw values to labels (a raw `2` can mean `15 MHz` — never show an enum raw) |

## House rules

- Nothing ever auto-runs; entries only fill the console prompt.
- `risk` maps to real consequences, not vibes. When in doubt, rate it higher.
- No entry for commands that are actions disguised as queries (`restore_band`)
  or whose argument mapping is unverified and dangerous (`QPRTPARA`).
- If you verified an entry on your module, add the module name to `verified`
  in a PR — that's the whole review process.
```

- [ ] **Step 4: Wire the validator into the build**

In `tools/build.sh`, append after the tracking-chunk lines (keep the existing lines unchanged):

```sh
# Phase 3: merge + validate the AT library, then gzip for gzip_static.
python3 tools/lib-validate.py
gzip -9 -n -c build/at-library.json > build/at-library.json.gz
```

- [ ] **Step 5: Run the validator + build; verify both pass and the guard actually guards**

Run: `python3 tools/lib-validate.py`
Expected: `at-library: 21 entries from 2 files -> …/build/at-library.json`

Run: `./tools/build.sh`
Expected: exits 0, `build/at-library.json.gz` listed.

Negative check (the validator must fail loudly on a bad entry):

```bash
printf '[{"id":"x.bad","cat":"T","title":"t","cmd":"AT+X={{a}}","risk":"scary","vendor":"x","verified":[],"summary":"s","source":"s","by":"me"}]' > src/at-library/zz-bad.json
python3 tools/lib-validate.py; echo "exit=$?"
rm src/at-library/zz-bad.json
```
Expected: messages about `risk must be one of` and `params [] must exactly cover placeholders ['a']`, then `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add src/at-library tools/lib-validate.py tools/build.sh
git commit -m "Phase 3: community AT library — entries, schema README, build validator"
```

---

### Task 4: The console chunk (`mudimodem-console`)

The whole tab UI: library rail + transcript + param strip + prompt + decode grid + detail card, per the `console.html` mockup and spec §4. Rendered as a child component by the main view (Task 5), so this chunk has no strip/tab bar of its own.

**Files:**
- Create: `src/views/mudimodem-console.js`
- Test: `test/console-chunk.test.js` (new; same harness style as `test/chunk.test.js`)

**Interfaces:**
- Consumes: `mudimodem.at_console` (Task 2 shape — remember `{error}` arrives *resolved*), `/mudimodem/at-library.json` (Task 3 shape), `moduleStatus("cellular.modems_status"/"cellular.sims_status")` from the Vuex store.
- Produces: a Vue options object named `mudimodem-console` with `render(h)`, loaded by Task 5 via eval. No props required.

- [ ] **Step 1: Write the failing tests**

Create `test/console-chunk.test.js`:

```js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-console.js');

// Mirror the loader in the main chunk: eval with `module` in scope.
function loadChunk() {
  const module = { exports: {} };
  const source = fs.readFileSync(SRC, 'utf8');
  return eval(source);
}

function h(tag, data, children) {
  if (Array.isArray(data) || typeof data === 'string') { children = data; data = {}; }
  return { tag, data: data || {}, children };
}
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}
function walk(node, out) {
  out = out || [];
  if (node == null || typeof node === 'string') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  walk(node.children, out);
  return out;
}
function makeVm(component, statusMap) {
  const vm = Object.assign({}, component.data());
  vm.$store = { getters: { moduleStatus(name) { return (statusMap && statusMap[name]) || {}; } } };
  for (const [k, fn] of Object.entries(component.methods || {})) vm[k] = fn.bind(vm);
  for (const [k, fn] of Object.entries(component.computed || {})) {
    Object.defineProperty(vm, k, { get: fn.bind(vm), configurable: true });
  }
  return vm;
}

const LIB = [
  { id: 'quectel.serving-cell', cat: 'Diagnostics', title: 'Serving cell details',
    cmd: 'AT+QENG="servingcell"', risk: 'read', vendor: 'quectel', verified: ['RG650V-NA'],
    summary: 'sum', source: 'src', by: 'kevin',
    decode: { prefix: '+QENG: "servingcell"',
      fields: ['state', 'rat', 'duplex', 'mcc', 'mnc', 'cell_id', 'pci', 'tac',
               'arfcn', 'band', 'dl_bandwidth', 'rsrp', 'rsrq', 'sinr', 'tx_power', 'srxlev'],
      hi: ['rsrp', 'rsrq', 'sinr'],
      enums: { dl_bandwidth: { 2: '15 MHz' } } } },
  { id: 'quectel.nr5g-band-set', cat: 'Bands', title: 'Set the 5G SA allowlist',
    cmd: 'AT+QNWPREFCFG="nr5g_band",{{bands}}', risk: 'nv', vendor: 'quectel',
    verified: ['RG650V-NA'], summary: 'sum', warn: 'warn', source: 'src', by: 'kevin',
    params: [{ name: 'bands', hint: 'colon-separated', example: '41:66:71' }] },
  { id: '3gpp.radio', cat: 'Power', title: 'Radio off / on', cmd: 'AT+CFUN={{fun}}',
    risk: 'set', vendor: 'any', verified: [], summary: 'sum', warn: 'warn',
    source: 'src', by: 'kevin',
    params: [{ name: 'fun', hint: '0 off, 1 on', values: ['0', '1'] }] }
];

// Genuinely captured on the box 2026-07-17 (NR5G-SA, includes <tac>).
const CAPTURED = '+QENG: "servingcell","NOCONN","NR5G-SA","FDD",310,260,187461035,721,870100,127490,71,2,-99,-13,4,0,-';

test('chunk evals to a render-only component named mudimodem-console', () => {
  const c = loadChunk();
  assert.ok(c && typeof c === 'object');
  assert.strictEqual(c.name, 'mudimodem-console');
  assert.strictEqual(c.template, undefined, 'template: is forbidden');
  assert.strictEqual(typeof c.render, 'function');
});

test('renders without store or library (honest empty states, no throw)', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Raw AT/, 'console card renders');
  assert.match(txt, /at_mdm0/, 'truth line names the channel even with no store');
});

test('truth line shows the ACTIVE SIM from the websocket store', () => {
  const c = loadChunk();
  const vm = makeVm(c, {
    'cellular.modems_status': { modems: [{ bus: 'cpu', current_sim_slot: '1' }] },
    'cellular.sims_status': { sims: [{ slot: '1', carrier: 'T-Mobile', status: 6 },
                                     { slot: '2', carrier: 'AT&T', status: 6 }] }
  });
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /T-Mobile/, 'active carrier');
  assert.match(txt, /slot 1/, 'active slot');
  assert.doesNotMatch(txt, /AT&T/, 'never the other SIM');
});

test('splitFields respects quoted commas', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  assert.deepStrictEqual(vm.splitFields('"a,b",c,"d",7'), ['a,b', 'c', 'd', '7']);
  assert.deepStrictEqual(vm.splitFields(''), ['']);
});

test('classifyLine: ok / err / urc / resp', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  assert.strictEqual(vm.classifyLine('OK'), 'ok');
  assert.strictEqual(vm.classifyLine('ERROR'), 'err');
  assert.strictEqual(vm.classifyLine('+CME ERROR: 100'), 'err');
  assert.strictEqual(vm.classifyLine('+QIND: SMS DONE'), 'urc');
  assert.strictEqual(vm.classifyLine('+QSPN: "T-Mobile"'), 'resp');
});

test('risk gate blocks set/nv LIBRARY sends and explains itself', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[1]);                       // nv entry with params
  vm.params.bands = '41:71';
  vm.riskOK = false;
  vm.send();
  const last = vm.lines[vm.lines.length - 1];
  assert.strictEqual(last.kind, 'note', 'blocked send explains via transcript note');
  assert.match(last.text, /Enable higher-risk/);
  assert.ok(!vm.lines.some((l) => l.kind === 'cmd'), 'command was NOT sent');
  vm.riskOK = true;
  vm.send();
  assert.ok(vm.lines.some((l) => l.kind === 'cmd' && /41:71/.test(l.text)),
    'gate on: assembled command line pushed');
});

test('free-typed commands always send, gate off or on', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.riskOK = false;
  vm.prompt = 'AT+QNWLOCK="common/4g",0';   // typed by hand — raw console
  vm.selId = null;
  vm.send();
  assert.ok(vm.lines.some((l) => l.kind === 'cmd'), 'free-typed cmd pushed');
  assert.ok(!vm.lines.some((l) => l.kind === 'note'), 'no gate note for free typing');
});

test('param strip: assembly, fill-gate, Send disabled until filled', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[1]);
  assert.strictEqual(vm.paramMode, true);
  assert.match(vm.assembled, /\{\{bands\}\}/, 'placeholder shown until filled');
  assert.strictEqual(vm.paramsFilled, false);
  vm.send();
  assert.match(vm.lines[vm.lines.length - 1].text, /parameter/, 'refuses to send unfilled');
  // Send button disabled while unfilled. NB: the Copy button shares the
  // mmc-send class and appears earlier in the tree — select by text too.
  const sendBtn = (tree) => walk(tree).find((n) =>
    n.data.staticClass && /mmc-send/.test(n.data.staticClass) && /^Send/.test(textOf(n)));
  let btn = sendBtn(c.render.call(vm, h));
  assert.ok(btn.data.attrs.disabled, 'Send disabled until params filled');
  vm.params.bands = '41:71';
  assert.strictEqual(vm.assembled, 'AT+QNWPREFCFG="nr5g_band",41:71');
  assert.strictEqual(vm.paramsFilled, true);
  btn = sendBtn(c.render.call(vm, h));
  assert.ok(!btn.data.attrs.disabled, 'Send arms once filled');
});

test('params with values render a dropdown', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[2]);                        // AT+CFUN={{fun}} with values 0|1
  const sel = walk(c.render.call(vm, h)).find((n) => n.tag === 'select');
  assert.ok(sel, 'values param renders a <select>');
});

test('decode labels the captured QENG line, tac included, enum mapped', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.applyDecode(LIB[0], 'AT+QENG="servingcell"', CAPTURED + '\r\nOK\r\n');
  assert.ok(vm.decodeRows && vm.decodeRows.length === 1, 'one matched line');
  const row = vm.decodeRows[0];
  const get = (f) => row.find((x) => x.f === f);
  assert.strictEqual(get('tac').v, '870100', 'tac present (the field the mockup once dropped)');
  assert.strictEqual(get('arfcn').v, '127490');
  assert.strictEqual(get('dl_bandwidth').v, '15 MHz', 'enum mapped — raw 2 never shown');
  assert.strictEqual(get('rsrp').v, '-99');
  assert.strictEqual(get('rsrp').hi, true, 'rsrp highlighted');
});

test('decode also matches a free-typed command against the library', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.applyDecode(null, 'AT+QENG="servingcell"', CAPTURED);
  assert.ok(vm.decodeRows, 'library matched by exact cmd string');
  assert.strictEqual(vm.decodeSrc, 'quectel.serving-cell');
});

test('library rail renders categories, titles, risk badges; search filters', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  let txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Diagnostics/); assert.match(txt, /Bands/); assert.match(txt, /Power/);
  assert.match(txt, /Serving cell details/);
  const badges = walk(c.render.call(vm, h)).filter((n) =>
    n.data.staticClass && /mmc-risk/.test(n.data.staticClass));
  assert.ok(badges.some((n) => /nv/.test(n.data.staticClass)), 'nv badge present');
  vm.q = 'allowlist';
  txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Set the 5G SA allowlist/);
  assert.doesNotMatch(txt, /Serving cell details/, 'search filters the rail');
});

test('detail card: unverified renders "nobody yet", never hides', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[2]);                        // verified: []
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /nobody yet/, 'honest unverified state');
  assert.match(txt, /Radio off \/ on/, 'entry still fully shown');
});

test('arrow-up recalls history', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.history = ['AT', 'ATI'];
  vm.promptKey({ key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(vm.prompt, 'ATI');
  vm.promptKey({ key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(vm.prompt, 'AT');
});

test('the chunk speaks only at_console — never GL AT paths', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /"at_console"/, 'sends via mudimodem.at_console');
  assert.doesNotMatch(src, /modem\.CPU\.AT|get_result_AT|send_at_command/,
    'never GL AT surfaces');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/console-chunk.test.js`
Expected: FAIL — `ENOENT … src/views/mudimodem-console.js`.

- [ ] **Step 3: Write the chunk**

Create `src/views/mudimodem-console.js`:

```js
// MudiModem — Phase 3: AT console + community AT library.
//
// Loaded lazily by the main mudimodem chunk into its "AT console" tab (same
// mechanism the SPA uses for views): axios GET + eval with `module` in scope,
// so this file MUST be a single expression (module.exports = {...}).
// Vue is runtime-only: render(h) only, never `template:`.
//
// Transport: mudimodem.at_console — OUR OWN channel (/dev/at_mdm0), which
// answers for the ACTIVE subscription only (no sub_id exists on that port;
// probed 2026-07-18). The library is static JSON at /mudimodem/at-library.json
// (gzip_static), fetched with $axios. Entries only ever FILL the prompt —
// nothing auto-runs. set/nv entries need the banner checkbox to Send;
// free-typed commands always send (Kevin's call, spec §1).
module.exports = {
  name: "mudimodem-console",

  data() {
    return {
      styleId: "mudimodem-console-css",
      lib: null,            // library entries once fetched
      libLoading: false,
      libErr: "",
      q: "",                // rail search text
      selId: null,          // selected entry id; null = free-typing
      riskOK: false,        // "Enable higher-risk commands" (localStorage)
      lines: [],            // transcript { t, kind: cmd|resp|ok|err|urc|note, text }
      LINES_MAX: 400,
      history: [],
      histIdx: null,
      prompt: "",
      params: {},           // param values for the selected entry
      sending: false,
      decodeRows: null,     // [[{f,v,hi},…] per matched response line]
      decodeSrc: ""
    };
  },

  computed: {
    ms() {
      var s = this.$store && this.$store.getters;
      return (s && s.moduleStatus) ? s.moduleStatus : function () { return {}; };
    },
    activeSlot() {
      var m = (this.ms("cellular.modems_status").modems || [])[0] || {};
      return m.current_sim_slot;
    },
    activeCarrier() {
      var self = this;
      var sims = this.ms("cellular.sims_status").sims || [];
      var s = sims.filter(function (x) { return String(x.slot) === String(self.activeSlot); })[0] || {};
      return s.carrier || "";
    },
    // The port answers for the active subscription ONLY — say so, always.
    truthLine() {
      var who = this.activeCarrier
        ? this.activeCarrier + " (slot " + this.activeSlot + ")"
        : (this.activeSlot ? "slot " + this.activeSlot : "resolving…");
      return "own channel /dev/at_mdm0 · active SIM: " + who;
    },
    entries() {
      var lib = this.lib || [];
      var q = this.q.toLowerCase();
      if (!q) return lib;
      return lib.filter(function (e) {
        return (e.title + " " + e.cmd + " " + e.summary + " " + e.cat)
          .toLowerCase().indexOf(q) !== -1;
      });
    },
    cats() {
      var seen = [];
      this.entries.forEach(function (e) {
        if (seen.indexOf(e.cat) === -1) seen.push(e.cat);
      });
      return seen;
    },
    sel() {
      var id = this.selId;
      return (this.lib || []).filter(function (e) { return e.id === id; })[0] || null;
    },
    selParams() { return (this.sel && this.sel.params) || []; },
    paramMode() { return this.selParams.length > 0; },
    // The command that would be sent: entry cmd with {{params}} substituted
    // (unfilled ones stay visible as {{name}}), or the free prompt.
    assembled() {
      if (!this.sel || !this.paramMode) return this.prompt;
      var p = this.params;
      return this.sel.cmd.replace(/\{\{(\w+)\}\}/g, function (m, name) {
        var v = ((p[name] || "") + "").trim();
        return v !== "" ? v : m;
      });
    },
    paramsFilled() {
      var p = this.params;
      return this.selParams.every(function (x) {
        return ((p[x.name] || "") + "").trim() !== "";
      });
    },
    gateBlocked() { return !!(this.sel && this.sel.risk !== "read" && !this.riskOK); }
  },

  created() {
    this.injectStyle();
    if (typeof window !== "undefined" && window.localStorage) {
      this.riskOK = window.localStorage.getItem("mudimodem.riskEnabled") === "1";
    }
    this.fetchLib();
  },

  methods: {
    fetchLib() {
      var self = this;
      if (this.libLoading) return;
      if (typeof window === "undefined" || !window.$axios) return;
      this.libLoading = true; this.libErr = "";
      window.$axios.get("/mudimodem/at-library.json?_t=" + Date.now())
        .then(function (res) {
          self.lib = (res.data && res.data.entries) || [];
          self.libLoading = false;
        })
        .catch(function (e) {
          self.libLoading = false;
          self.libErr = (e && e.message) || "load failed";
        });
    },
    toggleGate() {
      this.riskOK = !this.riskOK;
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("mudimodem.riskEnabled", this.riskOK ? "1" : "0");
      }
    },
    pick(e) {
      this.selId = e.id;
      var ps = {};
      (e.params || []).forEach(function (p) { ps[p.name] = ""; });
      this.params = ps;               // fresh object => later key writes are reactive
      this.prompt = (e.params && e.params.length) ? "" : e.cmd;
      this.decodeRows = null; this.decodeSrc = "";
    },
    onPromptInput(v) {
      this.prompt = v;
      // Hand-editing away from the entry's command = free-typing (gate no
      // longer applies; the entry stops claiming the prompt).
      if (this.sel && !this.paramMode && v !== this.sel.cmd) this.selId = null;
    },
    promptKey(ev) {
      if (ev.key === "Enter") { this.send(); return; }
      if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && !this.paramMode) {
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
    stamp() {
      var d = new Date();
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    push(kind, text) {
      this.lines.push({ t: this.stamp(), kind: kind, text: text });
      if (this.lines.length > this.LINES_MAX) {
        this.lines.splice(0, this.lines.length - this.LINES_MAX);
      }
    },
    note(text) { this.push("note", text); },
    classifyLine(l) {
      var URCS = ["RDY", "+CPIN:", "+QUSIM", "+CPINDS:", "+QIND:", "+CFUN:",
                  "+CGEV:", "+QNETDEVSTATUS:", "POWERED DOWN"];
      if (l === "OK") return "ok";
      if (l === "ERROR" || l.indexOf("+CME ERROR") === 0 || l.indexOf("+CMS ERROR") === 0) return "err";
      for (var i = 0; i < URCS.length; i++) if (l.indexOf(URCS[i]) === 0) return "urc";
      return "resp";
    },
    // Quote-aware CSV split: '"a,b",c' -> ['a,b','c'] (AT responses quote text).
    splitFields(s) {
      var out = [], cur = "", inQ = false;
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch === '"') { inQ = !inQ; cur += ch; }
        else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(function (x) { return x.trim().replace(/^"|"$/g, ""); });
    },
    // Label matched response lines with the entry's decode fields. `entry` may
    // be null (free-typed): fall back to an exact cmd match in the library.
    applyDecode(entry, cmd, resp) {
      var e = (entry && entry.cmd === cmd) ? entry : null;
      if (!e) {
        e = (this.lib || []).filter(function (x) { return x.cmd === cmd; })[0] || null;
      }
      if (!e || !e.decode) { this.decodeRows = null; this.decodeSrc = ""; return; }
      var d = e.decode, self = this, rows = [];
      resp.replace(/\r/g, "\n").split("\n").forEach(function (line) {
        line = line.trim();
        if (!line || line.indexOf(d.prefix) !== 0) return;
        var rest = line.slice(d.prefix.length).replace(/^[,\s]+/, "");
        var parts = self.splitFields(rest);
        rows.push(d.fields.map(function (f, i) {
          var v = (parts[i] !== undefined && parts[i] !== "") ? parts[i] : "—";
          var en = (d.enums || {})[f];
          // An enum field is NOT its own value — raw 2 means 15 MHz, not 2 MHz.
          if (en && en[v] !== undefined) v = en[v];
          return { f: f, v: v, hi: (d.hi || []).indexOf(f) !== -1 };
        }));
      });
      this.decodeRows = rows.length ? rows : null;
      this.decodeSrc = e.id;
    },
    send() {
      var self = this;
      var entry = this.sel;
      var cmd = ((this.paramMode ? this.assembled : this.prompt) || "").trim();
      if (!cmd || this.sending) return;
      if (/\{\{/.test(cmd)) { this.note("fill in every parameter before sending"); return; }
      if (this.gateBlocked) {
        this.note('this is a ' + entry.risk + ' entry — tick "Enable higher-risk commands" in the banner to send it');
        return;
      }
      this.push("cmd", cmd);
      this.history.push(cmd); this.histIdx = null;
      this.decodeRows = null;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.push("err", "RPC unavailable");
        return;
      }
      var TOOL_T = 8;   // tool deadline; rpc timeout = tool + 10 s (spec §2 chain)
      this.sending = true;
      window.$rpcRequest("call", ["sid", "mudimodem", "at_console",
                                  { cmd: cmd, timeout: TOOL_T }],
                         { timeout: (TOOL_T + 10) * 1000 })
        .then(function (r) {
          self.sending = false;
          // Backend {error:…} arrives RESOLVED ($rpcRequest only rejects on
          // err_msg/err_code) — check it first.
          if (r && r.error) { self.push("err", r.error); return; }
          var resp = (r && r.response) || "";
          resp.replace(/\r/g, "\n").split("\n").forEach(function (l) {
            l = l.trim();
            if (l) self.push(self.classifyLine(l), l);
          });
          if (r && r.status === "timeout") {
            self.push("err", "no terminator after " + TOOL_T +
              "s — the response may still arrive; the channel is drained on the next send");
          }
          self.applyDecode(entry, cmd, resp);
        })
        .catch(function (e) {
          self.sending = false;
          self.push("err", (e && (e.message || e.type)) || "request failed");
        });
    },
    copyTranscript() {
      var txt = this.lines.map(function (l) { return l.t + "  " + l.text; }).join("\n");
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
      }
    },
    riskText(r) {
      return { read: "safe — reads only",
               set: "changes runtime state — gone on reboot",
               nv: "WRITES MODEM NV — survives factory reset" }[r] || r;
    },
    injectStyle() {
      if (typeof document === "undefined" || document.getElementById(this.styleId)) return;
      var css =
        '.mmc{color:var(--text-regular)}' +
        '.mmc-caution{display:flex;gap:8px;align-items:baseline;background:var(--error-bg);border:1px solid var(--error-100);border-radius:3px;padding:8px 10px;font-size:11.5px;color:var(--error-700);margin-bottom:11px;flex-wrap:wrap}' +
        '.mmc-caution b{color:var(--error);flex:none}' +
        '.mmc-gate{margin-left:auto;display:flex;gap:5px;align-items:center;white-space:nowrap;cursor:pointer;font-size:11.5px}' +
        '.mmc-split{display:grid;grid-template-columns:270px 1fr;gap:10px}' +
        '@media(max-width:820px){.mmc-split{grid-template-columns:1fr}}' +
        '.mmc-card{background:var(--bg-card);border-radius:4px;box-shadow:0 1px 5px var(--shadow);padding:11px 12px}' +
        '.mmc-sect{font-size:13px;font-weight:600;color:var(--text-title)}' +
        '.mmc-hint{font-size:11.5px;color:var(--text-badge)}' +
        '.mmc-row{display:flex;justify-content:space-between;align-items:center;gap:12px}' +
        '.mmc-search{width:100%;font:12px inherit;padding:5px 9px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular);margin-top:8px}' +
        '.mmc-search:focus{outline:0;border-color:var(--primary)}' +
        '.mmc-libbody{overflow-y:auto;max-height:430px;margin:6px -12px 0;padding:0}' +
        '.mmc-cat{font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-badge);padding:8px 12px 4px}' +
        '.mmc-snip{display:block;width:100%;text-align:left;background:none;border:0;cursor:pointer;padding:6px 12px;border-left:2px solid transparent;font:inherit;color:inherit}' +
        '.mmc-snip:hover{background:var(--bg-title)}' +
        '.mmc-snip.on{background:var(--primary-bg);border-left-color:var(--primary)}' +
        '.mmc-snip:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}' +
        '.mmc-snip-t{display:flex;align-items:center;gap:6px}' +
        '.mmc-snip-t b{font-size:12px;font-weight:600;color:var(--text-title)}' +
        '.mmc-snip code{display:block;font-family:monospace;font-size:10.5px;color:var(--text-weak);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.mmc-risk{font-size:8.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:2px;padding:1px 4px;flex:none}' +
        '.mmc-risk.read{background:var(--success-bg);color:var(--success-700);border:1px solid var(--success-100)}' +
        '.mmc-risk.set{background:var(--warning-bg);color:var(--warning-700);border:1px solid var(--warning-100)}' +
        '.mmc-risk.nv{background:var(--error-bg);color:var(--error-700);border:1px solid var(--error-100)}' +
        '.mmc-term{background:var(--bg-title);border:1px solid var(--divider);border-radius:3px;padding:9px 11px;font-family:monospace;font-size:11.5px;line-height:1.6;height:224px;overflow:auto;margin-top:9px}' +
        '.mmc-l-cmd{color:var(--primary)}.mmc-l-ok{color:var(--success-700)}' +
        '.mmc-l-err{color:var(--error)}.mmc-l-resp{color:var(--text-weak)}' +
        '.mmc-l-urc{color:var(--text-hint)}.mmc-l-note{color:var(--warning-700)}' +
        '.mmc-t{color:var(--text-hint);margin-right:6px}' +
        '.mmc-urctag{font-size:8.5px;border:1px solid var(--divider);border-radius:2px;padding:0 3px;margin-left:5px;color:var(--text-hint)}' +
        '.mmc-pstrip{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}' +
        '.mmc-pstrip label{display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--text-badge)}' +
        '.mmc-pstrip input,.mmc-pstrip select{font-family:monospace;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular);width:130px}' +
        '.mmc-prompt{display:flex;gap:7px;margin-top:9px}' +
        '.mmc-prompt>span{font-family:monospace;font-size:12px;color:var(--primary);padding-top:6px}' +
        '.mmc-prompt input{flex:1;font-family:monospace;font-size:12px;padding:6px 9px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular)}' +
        '.mmc-prompt input:focus{outline:0;border-color:var(--primary)}' +
        '.mmc-send{font-size:11.5px;font-weight:600;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:3px;padding:6px 13px;cursor:pointer;font-family:inherit}' +
        '.mmc-send:disabled{opacity:.5;cursor:default}' +
        '.mmc-send:focus-visible{outline:2px solid var(--primary);outline-offset:2px}' +
        '.mmc-dec{margin-top:9px;border:1px solid var(--divider);border-radius:3px;overflow:hidden}' +
        '.mmc-dec-h{background:var(--bg-title);padding:5px 10px;display:flex;justify-content:space-between;align-items:center}' +
        '.mmc-dec-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:1px;background:var(--divider)}' +
        '.mmc-dc{background:var(--bg-card);padding:6px 9px}' +
        '.mmc-dc span{display:block;font-size:8.5px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mmc-dc b{font-size:12px;font-weight:600;font-family:monospace;color:var(--text-title)}' +
        '.mmc-dc.hi b{color:var(--success)}' +
        '.mmc-detail{margin-top:10px}' +
        '.mmc-meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}' +
        '.mmc-meta span{display:block;font-size:9px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mmc-meta b{font-size:11.5px;font-weight:600;color:var(--text-title)}' +
        '.mmc-warn{color:var(--error-700)}' +
        '@media(prefers-reduced-motion:reduce){.mmc *{transition:none!important}}';
      var el = document.createElement("style");
      el.id = this.styleId;
      el.textContent = css;
      document.head.appendChild(el);
    }
  },

  render(h) {
    var self = this;

    // ---- caution banner + risk gate ----
    var banner = h("div", { staticClass: "mmc-caution" }, [
      h("b", "Sharp edge."),
      h("span", "Commands go straight to the RG650V-NA. Nothing is validated. " +
        "Entries marked nv write modem memory that survives a factory reset."),
      h("label", { staticClass: "mmc-gate" }, [
        h("input", {
          attrs: { type: "checkbox", checked: this.riskOK },
          domProps: { checked: this.riskOK },
          on: { change: function () { self.toggleGate(); } }
        }),
        "Enable higher-risk commands"
      ])
    ]);

    // ---- library rail ----
    var libKids = [
      h("div", { staticClass: "mmc-row" }, [
        h("span", { staticClass: "mmc-sect" }, "Library"),
        h("span", { staticClass: "mmc-hint" },
          this.lib ? String(this.entries.length) + " commands" : "")
      ]),
      h("input", {
        staticClass: "mmc-search",
        attrs: { placeholder: "Search — band, lock, signal…", "aria-label": "Search library" },
        domProps: { value: this.q },
        on: { input: function (ev) { self.q = ev.target.value; } }
      })
    ];
    var body;
    if (this.libLoading) {
      body = h("div", { staticClass: "mmc-hint", staticStyle: { padding: "10px 0" } }, "Loading the library…");
    } else if (this.libErr) {
      body = h("div", { staticStyle: { padding: "10px 0" } }, [
        h("div", { staticClass: "mmc-hint" }, "Couldn't load the library: " + this.libErr + " "),
        h("button", { staticClass: "mmc-send", staticStyle: { marginTop: "6px" },
          on: { click: function () { self.fetchLib(); } } }, "Retry")
      ]);
    } else if (!this.lib) {
      body = h("div", { staticClass: "mmc-hint", staticStyle: { padding: "10px 0" } }, "Library not loaded.");
    } else if (!this.entries.length) {
      body = h("div", { staticClass: "mmc-hint", staticStyle: { padding: "10px 0" } }, "No matches.");
    } else {
      var items = [];
      this.cats.forEach(function (cat) {
        items.push(h("div", { staticClass: "mmc-cat", key: "cat-" + cat }, cat));
        self.entries.filter(function (e) { return e.cat === cat; }).forEach(function (e) {
          items.push(h("button", {
            key: e.id,
            staticClass: "mmc-snip" + (self.selId === e.id ? " on" : ""),
            on: { click: function () { self.pick(e); } }
          }, [
            h("span", { staticClass: "mmc-snip-t" }, [
              h("b", e.title),
              h("span", { staticClass: "mmc-risk " + e.risk }, e.risk)
            ]),
            h("code", e.cmd)
          ]));
        });
      });
      body = h("div", { staticClass: "mmc-libbody" }, items);
    }
    libKids.push(body);
    var rail = h("div", { staticClass: "mmc-card" }, libKids);

    // ---- transcript ----
    var termKids = this.lines.length
      ? this.lines.map(function (l, i) {
          return h("div", { key: i, staticClass: "mmc-l-" + l.kind }, [
            h("span", { staticClass: "mmc-t" }, l.t),
            l.text,
            l.kind === "urc" ? h("span", { staticClass: "mmc-urctag" }, "URC") : null
          ]);
        })
      : [h("div", { staticClass: "mmc-hint" },
          "ready. Pick a command from the library, or type one.")];
    var term = h("div", { staticClass: "mmc-term" }, termKids);

    // ---- param strip ----
    var pstrip = null;
    if (this.paramMode) {
      pstrip = h("div", { staticClass: "mmc-pstrip" }, this.selParams.map(function (p) {
        var field;
        if (p.values && p.values.length) {
          field = h("select", {
            domProps: { value: self.params[p.name] || "" },
            on: { change: function (ev) { self.params[p.name] = ev.target.value; } }
          }, [h("option", { attrs: { value: "" } }, "—")].concat(
            p.values.map(function (v) { return h("option", { attrs: { value: v }, key: v }, v); })));
        } else {
          field = h("input", {
            attrs: { placeholder: p.example || "", title: p.hint },
            domProps: { value: self.params[p.name] || "" },
            on: { input: function (ev) { self.params[p.name] = ev.target.value; } }
          });
        }
        return h("label", { key: p.name }, [p.name + " — " + p.hint, field]);
      }));
    }

    // ---- prompt + send ----
    var promptRow = h("div", { staticClass: "mmc-prompt" }, [
      h("span", ">"),
      h("input", {
        attrs: {
          placeholder: "AT+…", "aria-label": "AT command",
          readonly: this.paramMode || null
        },
        domProps: { value: this.paramMode ? this.assembled : this.prompt },
        on: {
          input: function (ev) { if (!self.paramMode) self.onPromptInput(ev.target.value); },
          keydown: function (ev) { self.promptKey(ev); }
        }
      }),
      h("button", {
        staticClass: "mmc-send",
        attrs: { disabled: this.sending || (this.paramMode && !this.paramsFilled) },
        on: { click: function () { self.send(); } }
      }, this.sending ? "Sending…" : "Send")
    ]);

    // ---- decode grid ----
    var dec = null;
    if (this.decodeRows) {
      dec = h("div", { staticClass: "mmc-dec" }, [
        h("div", { staticClass: "mmc-dec-h" }, [
          h("span", { staticClass: "mmc-hint" }, "Decoded — field names from the library entry"),
          h("span", { staticClass: "mmc-hint" }, this.decodeSrc)
        ])
      ].concat(this.decodeRows.map(function (row, ri) {
        return h("div", { staticClass: "mmc-dec-g", key: ri }, row.map(function (cell) {
          return h("div", { staticClass: "mmc-dc" + (cell.hi ? " hi" : ""), key: cell.f }, [
            h("span", cell.f.replace(/_/g, " ")),
            h("b", String(cell.v))
          ]);
        }));
      })));
    }

    // ---- console card ----
    var con = h("div", { staticClass: "mmc-card" }, [
      h("div", { staticClass: "mmc-row" }, [
        h("span", { staticClass: "mmc-sect" }, "Raw AT"),
        h("span", { staticClass: "mmc-row" }, [
          h("button", {
            staticClass: "mmc-send", staticStyle: { background: "transparent",
              color: "var(--text-weak)", borderColor: "var(--border)", fontWeight: "400" },
            attrs: { title: "Copy the transcript" },
            on: { click: function () { self.copyTranscript(); } }
          }, "Copy"),
          h("span", { staticClass: "mmc-hint" }, this.truthLine)
        ])
      ]),
      term, pstrip, promptRow, dec
    ].filter(Boolean));

    // ---- entry detail card ----
    var detail = null;
    var e = this.sel;
    if (e) {
      detail = h("div", { staticClass: "mmc-card mmc-detail" }, [
        h("div", { staticClass: "mmc-row" }, [
          h("span", { staticClass: "mmc-sect" }, e.title),
          h("span", [
            h("span", { staticClass: "mmc-risk " + e.risk }, e.risk),
            h("span", { staticClass: "mmc-hint", staticStyle: { marginLeft: "6px" } },
              this.riskText(e.risk))
          ])
        ]),
        h("div", { staticClass: "mmc-hint", staticStyle: { marginTop: "3px", fontSize: "12px" } }, [
          e.summary + " ",
          e.warn ? h("span", { staticClass: "mmc-warn" }, e.warn) : null
        ]),
        h("div", { staticClass: "mmc-meta" }, [
          h("div", [h("span", "Vendor"), h("b", e.vendor)]),
          h("div", [h("span", "Verified on"),
            h("b", e.verified && e.verified.length ? e.verified.join(", ") : "— nobody yet")]),
          h("div", [h("span", "Source"), h("b", e.source)]),
          h("div", [h("span", "Contributed by"), h("b", e.by)])
        ])
      ]);
    }

    return h("div", { staticClass: "mmc" }, [
      banner,
      h("div", { staticClass: "mmc-split" }, [rail, con]),
      detail
    ].filter(Boolean));
  }
};
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/console-chunk.test.js`
Expected: all 15 tests PASS. Also run the whole suite to check nothing else broke: `node --test test/` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem-console.js test/console-chunk.test.js
git commit -m "Phase 3: AT console chunk — rail, transcript, param strip, gate, decode"
```

---

### Task 5: Wire the Console tab into the main view

Replace the "AT console — Phase 3" placeholder with the lazy-loaded chunk, mirroring the Tracking pattern exactly (deliberately duplicating `loadTracking`'s ~15 lines rather than refactoring — the existing tests assert on the literal tracking URL string, and two similar methods beat one clever one here).

**Files:**
- Modify: `src/views/mudimodem.js` (data ~line 48, watch ~line 151, methods after `loadTracking`, render panel ~line 730, `soon` map ~line 731)
- Modify: `test/chunk.test.js` (append one test)

**Interfaces:**
- Consumes: Task 4's chunk at `/views/gl-sdk4-ui-mudimodem-console.common.js` (cache-busted, eval'd with `module` in scope).

- [ ] **Step 1: Append the failing test to `test/chunk.test.js`**

```js
test('AT console is an in-page tab: lazy-loads its own chunk', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /gl-sdk4-ui-mudimodem-console\.common\.js/, 'lazy-loads the console chunk');
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'at';
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Loading the AT console/, 'loading state before the chunk arrives');
  assert.doesNotMatch(txt, /Phase 3/, 'placeholder copy is gone');
  const fake = { name: 'mudimodem-console', render() {} };
  vm.consoleComp = fake;
  const node = walk(c.render.call(vm, h)).find((n) => n.tag === fake);
  assert.ok(node, 'renders the loaded console component as a child vnode');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/chunk.test.js`
Expected: the new test FAILS (`gl-sdk4-ui-mudimodem-console` not found in src); all pre-existing tests still pass.

- [ ] **Step 3: Edit `src/views/mudimodem.js`** (four small edits)

(a) In `data()`, directly under `trackingErr: "",` add:

```js
      // AT console tab: same lazy-chunk pattern as Tracking.
      consoleComp: null,
      consoleLoading: false,
      consoleErr: "",
```

(b) In `watch`, extend the `tab(t)` handler:

```js
    tab(t) {
      if (t === "bands" && !this.bands && !this.bandsLoading) this.fetchBands();
      if (t === "at" && !this.consoleComp && !this.consoleLoading) this.loadConsole();
    },
```

(c) In `methods`, directly after the `loadTracking()` method's closing brace, add (mirror of `loadTracking`, including its `.catch` shape — copy that shape exactly as it exists in the file):

```js
    // Fetch + eval the AT-console chunk exactly like loadTracking above.
    loadConsole() {
      var self = this;
      if (this.consoleComp || this.consoleLoading) return;
      if (typeof window === "undefined" || !window.$axios) return;
      this.consoleLoading = true; this.consoleErr = "";
      window.$axios.get("/views/gl-sdk4-ui-mudimodem-console.common.js?_t=" + Date.now())
        .then(function (res) {
          var module = { exports: {} };            // eslint-disable-line no-unused-vars
          var comp = eval(res.data);               // chunk is `module.exports = {...}`
          if (!comp || typeof comp.render !== "function") throw new Error("bad chunk");
          self.consoleComp = comp; self.consoleLoading = false;
        })
        .catch(function (e) {
          self.consoleLoading = false;
          self.consoleErr = (e && e.message) || "load failed";
        });
    },
```

(d) In `render(h)`'s panel selection, insert a branch before the final `else`, and remove the `at:` line from the `soon` map:

```js
    } else if (this.tab === "at") {
      if (this.consoleComp) {
        panel = h(this.consoleComp);
      } else {
        panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" },
          this.consoleErr ? "Couldn't load the AT console: " + this.consoleErr
            : "Loading the AT console…")]);
      }
    } else {
      var soon = {
        lock: "Cell lock - Phase 2.",
        sim: "SIM / APN - Phase 4."
      }[this.tab];
      panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" }, soon)]);
    }
```

- [ ] **Step 4: Run the full local suite**

Run: `node --test test/`
Expected: everything passes, including the new console-tab test and all pre-existing tracking/bands tests.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 3: AT console becomes a live in-page tab (lazy chunk)"
```

---

### Task 6: Build, deploy, verify — ship it to the box

Three new deployed artifacts (console chunk .gz, library .gz, the Python tool) plus the updated backend. Verification includes the two live checks the spec demands: a real read-only `AT` through the tool, and **no `gl_modem` left in state `T` afterwards**.

**Files:**
- Modify: `tools/build.sh`, `tools/deploy.sh`, `tools/verify.sh`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces (on the box): `/www/views/gl-sdk4-ui-mudimodem-console.common.js.gz`, `/www/mudimodem/at-library.json.gz`, `/usr/lib/mudimodem/mudimodem-at.py`, updated `/usr/lib/oui-httpd/rpc/mudimodem`.

- [ ] **Step 1: build.sh — gzip the console chunk**

In `tools/build.sh`, after the Phase-3 library lines added in Task 3, add:

```sh
gzip -9 -n -c src/views/mudimodem-console.js > build/gl-sdk4-ui-mudimodem-console.common.js.gz
```

Run `./tools/build.sh`; expected: exits 0, `build/` lists `gl-sdk4-ui-mudimodem-console.common.js.gz` and `at-library.json.gz`.

- [ ] **Step 2: deploy.sh — push the three new artifacts**

In `tools/deploy.sh`, after the tracking block (`echo "tracking chunk + menu deployed"`), add:

```sh
# Phase 3: AT console chunk + community library + our own AT channel tool.
ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem-console.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /www/mudimodem && cat > /www/mudimodem/at-library.json.gz' \
  < build/at-library.json.gz
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /usr/lib/mudimodem && cat > /usr/lib/mudimodem/mudimodem-at.py' \
  < tools/mudimodem-at.py
echo "console chunk + AT library + AT tool deployed"
```

And extend the sysupgrade.conf `for p in` list with three more paths (before the `; do`):

```sh
  /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz \
  /www/mudimodem/at-library.json.gz \
  /usr/lib/mudimodem/mudimodem-at.py \
```

- [ ] **Step 3: verify.sh — section 8**

Append to `tools/verify.sh` before the final `echo "ALL CHECKS PASSED"`:

```sh
# 8. Phase 3: AT console chunk + community library + own-channel AT tool.
echo "8. Phase 3: console chunk + AT library + AT tool"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-console.common.js.gz' \
  || fail "console chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/mudimodem/at-library.json.gz' \
  || fail "at-library .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/lib/mudimodem/mudimodem-at.py' \
  || fail "AT tool missing"

echo "8a. library gz parses on-device and is served via gzip_static"
ssh -o BatchMode=yes "root@$HOST" 'gzip -dc /www/mudimodem/at-library.json.gz > /tmp/mm-lib.json && lua -e "local c=require(\"cjson\"); local f=io.open(\"/tmp/mm-lib.json\"); local d=c.decode(f:read(\"*a\")); assert(type(d.entries)==\"table\" and #d.entries>0)"; rc=$?; rm -f /tmp/mm-lib.json; exit $rc' \
  || fail "at-library.json.gz is not valid gzipped JSON with entries"
ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/mudimodem/at-library.json?_t=1" | gzip -dc | grep -q "\"entries\""' \
  || fail "library not served via gzip_static"

echo "8b. console chunk serves + evals (render-only, speaks at_console)"
CONBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-console.common.js?_t=1" | gzip -dc')
printf '%s' "$CONBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-console"){console.error("FAIL: console eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    if(!/"at_console"/.test(s)){console.error("FAIL: does not speak at_console");process.exit(1);}
    if(/modem\.CPU\.AT|send_at_command/.test(s)){console.error("FAIL: touches GL AT surfaces");process.exit(1);}
    console.log("   console chunk eval OK ->", c.name);
  })' || fail "console chunk eval failed"

echo "8c. at_console backend (clamps + envelope, against the fake tool)"
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /tmp/mmtest'
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mmtest/fake-at.py' < test/fake-at-tool.py
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mmtest/t.lua' < test/backend-console.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_AT_TOOL=/tmp/mmtest/fake-at.py lua /tmp/mmtest/t.lua >/dev/null; rc=$?; rm -rf /tmp/mmtest; exit $rc' \
  || fail "at_console backend test failed on-device"

echo "8d. LIVE: one read-only AT through the real tool (envelope + gl_modem sleep)"
ssh -o BatchMode=yes "root@$HOST" \
  'python3 /usr/lib/mudimodem/mudimodem-at.py --envelope --timeout 6 "AT" | head -1 | grep -q "^MM-AT:ok"' \
  || fail "live AT through /dev/at_mdm0 did not return MM-AT:ok"

echo "8e. gl_modem alive and NOT left stopped (the one failure that must never survive)"
ssh -o BatchMode=yes "root@$HOST" \
  'pids=$(pidof gl_modem); [ -n "$pids" ] || exit 1; for p in $pids; do s=$(cut -d" " -f3 "/proc/$p/stat"); [ "$s" = "T" ] && exit 1; done; exit 0' \
  || fail "gl_modem missing or left in state T after the AT call"
```

- [ ] **Step 4: Deploy + verify live**

```bash
./tools/deploy.sh
./tools/verify.sh
```
Expected: `deployed to mudi` then every section up to `ALL CHECKS PASSED`, including `8d`/`8e`. If 8e ever fails: immediately run `ssh root@mudi 'for p in $(pidof gl_modem); do kill -CONT $p; done'` and investigate before proceeding — never leave `gl_modem` stopped.

Manual browser check (do it, it's 60 seconds): open the admin → Modem → AT console. Confirm: library renders with badges; clicking *Serving cell details* fills and Send returns a decoded grid; an `nv` entry refuses to Send until the banner checkbox is ticked; a free-typed `ATI` sends regardless.

- [ ] **Step 5: Commit**

```bash
git add tools/build.sh tools/deploy.sh tools/verify.sh
git commit -m "Phase 3: build/deploy/verify — console chunk, library, AT tool live"
```

---

### Task 7: Documentation — CLAUDE.md + AT reference

Record what this phase settled so nobody re-derives it (the repo's standing rule: trust the box, then fix the doc).

**Files:**
- Modify: `CLAUDE.md` (§7a, §10 phase table, §12)
- Modify: `reference/quectel-at-reference.md` (§10 — the AT-channel section)

- [ ] **Step 1: Update CLAUDE.md**

(a) §10 phase table, row 3 → `**3** | AT console + community library | ✅ done (2026-07-18). Own channel via /usr/lib/mudimodem/mudimodem-at.py; gl_modem slept during sends; library at /www/mudimodem/at-library.json.gz.`

(b) §12: move Phase 3 from **Next** to a ✅ bullet:

```markdown
- ✅ **Phase 3 done (2026-07-18)** — AT console tab (lazy chunk `mudimodem-console`) + community
  library (`src/at-library/*.json` → `/www/mudimodem/at-library.json.gz`, build-validated).
  Transport: `mudimodem.at_console` spawns `/usr/lib/mudimodem/mudimodem-at.py` — flock-serialized,
  `gl_modem` SIGSTOPped during the send (paired CONT + startup recovery; verify.sh 8e asserts no
  stopped daemon survives). Gate: set/nv library entries need the banner checkbox; free-typed always
  sends. Spec: `docs/superpowers/specs/2026-07-18-at-console-library-design.md`.
```

(c) §12 open questions: replace item 9's text with:

```markdown
9. ✅ **RESOLVED (2026-07-18): the direct port CANNOT target a sub_id.** No subscription selector
   exists on `/dev/at_mdm0` (`QSIMSWITCH`/`QDSDS`/`QMSIMCFG` all ERROR; `QCFG=?`/`QNWPREFCFG=?`
   list nothing sub-related). GL's `sub_id` is a QMI-layer thing behind `modem_AT`. Cross-SIM data
   stays on GL's `modem.CPU.AT`; the console is active-SIM only and labeled as such.
```

(d) §12 session findings: add:

```markdown
### Session findings 2026-07-18
- **`/dev/at_mdm0` is held by GL's `port-bridge`** (`port-bridge at_mdm0 at_usb0 0` — the USB-AT
  passthrough). Coexistence probed clean; the tool keeps drain-before-send + strict terminator
  matching as the defense.
- **`gl_modem` is the AT traffic source** (`/usr/bin/gl_modem -B cpu -S 1 connect-auto`);
  `modem_AT` is the ubus AT *server* — sleep the former during console sends, never the latter.
- T-Mobile `nr5g_band` read `25:41:48:66:71:77` (full policy set), NOT the documented n71-only
  lock — GL's stored config or an experiment widened it. Flagged to Kevin, not "fixed".
```

(e) §7a: append one line at the end: `✅ Built 2026-07-18 — see §12 and the Phase-3 spec/plan.`

- [ ] **Step 2: Update `reference/quectel-at-reference.md` §10** (the device/channel section) — append:

```markdown
### 2026-07-18 probes (Phase 3)
- 🟢 **No sub_id on `/dev/at_mdm0`, confirmed.** `AT+QSIMSWITCH=?`, `AT+QDSDS=?`, `AT+QMSIMCFG=?`
  → ERROR; `AT+QCFG=?` has no sim/sub entry; `AT+QNWPREFCFG=?` lists no sub parameter. The port
  answers in the active subscription's context (QSPN → T-Mobile). GL's `sub_id` is QMI-layer.
- 🟢 **`port-bridge` holds `at_mdm0` permanently** (modem end of the USB-AT passthrough,
  `/usr/bin/port-bridge at_mdm0 at_usb0 0`). Multiple clean full responses probed alongside it.
- 🟢 `AT+QCFG=?` on this port lists 19 entries (rrc, lte/bandprior, usbnet, …) — none SIM-related.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md reference/quectel-at-reference.md
git commit -m "Phase 3 docs: console/library shipped; sub_id question resolved; port-bridge finding"
```

---

## Done criteria (whole plan)

- `node --test test/` green (chunk + console-chunk + tracking tests).
- `python3 test/at-tool.test.py` green.
- `./tools/verify.sh` green through section 8e on the live box.
- Browser: Modem → AT console works end-to-end (decode grid, gate, free typing).
- `gl_modem` running and un-stopped after every AT send.
