# Speedtest Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Speedtest" tab to MudiModem: on-demand (+ optional scheduled) download/upload/latency test over a chosen outbound interface (Cellular default, Wired WAN alternative), with results persisted across reboots and graphed with per-point radio-state detail.

**Architecture:** A standalone Python script (`tools/mudimodem-speedtest.py`, deployed to `/usr/lib/mudimodem/`) does the actual curl-based test and owns all file I/O (status + history + locking). The Lua RPC backend (`src/rpc/mudimodem`) only resolves/validates the outbound interface and spawns that script detached (mirrors `mudimodem-revert`'s spawn pattern — a fixed-size test takes ~10-20s, too long for one `$rpcRequest`). An optional scheduler daemon (`mudimodem-speedtestd`) invokes the same script on a cadence. The frontend (`src/views/mudimodem-speedtest.js`) is a new lazy-loaded chunk embedded in the main page exactly like the existing Tracking tab, polling status while a test runs and rendering an SVG history graph with a hover/click detail popover.

**Tech Stack:** Python 3 stdlib (no pip) for the script/daemon; Lua (existing `oui.ubus`/`cjson` backend conventions) for RPC; plain Vue 2.6 runtime-only (`render(h)`, no `template:`) for the chunk, matching every other MudiModem view.

## Global Constraints

- No pip / no compiled deps in any Python file — stdlib only (matches `mudimodem-at.py`/`mudimodem-collectd`).
- Never wrap `oui.ubus.call` in `pcall` (cosocket-yield crash — CLAUDE.md §8).
- Persistent files live under `/etc/mudimodem/` (survive reboot); ephemeral status/lock files live under `/tmp/mudimodem/`.
- The device index for any interface (especially the cellular `rmnet_data*` device) must be resolved live via `ubus call network.interface dump` on every run — never hardcoded.
- `curl --interface <device>` is how the outbound interface is enforced.
- Retention: cap `speedtests.jsonl` at the last 500 lines.
- Fixed test sizes: ~20 MiB download, ~8 MiB upload, 5 latency probes.
- Vue chunks are `module.exports = {...}` single-expression files (`eval()`'d by the SPA), runtime-only (`render(h)`, never `template:`).
- Node tests: `node --test test/<file>.test.js`. Python tests: `python3 test/<file>.test.py`. Lua backend tests run **on-device only** (no `oui.ubus`/`cjson`-with-`ngx` locally) via `ssh root@mudi` + `lua`.

---

### Task 1: `tools/mudimodem-speedtest.py` — pure functions

**Files:**
- Create: `tools/mudimodem-speedtest.py`
- Create: `test/speedtest.test.py`

**Interfaces:**
- Produces: `mbps(bytes_per_sec) -> float|None`, `resolve_iface_from_dump(dump, which) -> (device:str|None, up:bool)`, `latency_stats(samples:list[float]) -> (latency_ms:int|None, jitter_ms:int|None)`, `build_snapshot(modem, net, sims) -> dict` — all consumed by Task 2's `main()`.

- [ ] **Step 1: Write the failing tests**

Create `test/speedtest.test.py`:

```python
#!/usr/bin/env python3
"""Unit tests for tools/mudimodem-speedtest.py's pure parts.
Run: python3 test/speedtest.test.py"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ST_SRC = os.path.join(HERE, "..", "tools", "mudimodem-speedtest.py")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


st = load(ST_SRC, "mudimodem_speedtest")


class Mbps(unittest.TestCase):
    def test_bytes_per_sec_to_mbps(self):
        self.assertEqual(st.mbps(1_250_000), 10.0)   # 1.25 MB/s = 10 Mbps

    def test_none_stays_none(self):
        self.assertIsNone(st.mbps(None))


class ResolveIfaceFromDump(unittest.TestCase):
    # Real captured shapes (box, 2026-07-20) -- the cellular device index has
    # been observed to change (rmnet_data0 <-> rmnet_data1) after a modem
    # reconnect, and 'wan' can be down/bridged differently box to box.
    DUMP = {"interface": [
        {"interface": "eth", "proto": "static", "up": True, "device": "eth0", "l3_device": "eth0"},
        {"interface": "lan", "proto": "static", "up": True, "device": "br-lan", "l3_device": "br-lan"},
        {"interface": "modem_cpu", "proto": "rmnet", "up": True, "l3_device": "rmnet_data0"},
        {"interface": "modem_cpu_6", "proto": "rmnet", "up": True, "l3_device": "rmnet_data0"},
        {"interface": "wan", "proto": "dhcp", "up": False, "device": "eth0"},
    ]}

    def test_cellular_prefers_the_non_v6_rmnet_entry(self):
        dev, up = st.resolve_iface_from_dump(self.DUMP, "cellular")
        self.assertEqual(dev, "rmnet_data0")
        self.assertTrue(up)

    def test_wired_down_has_no_usable_device(self):
        dev, up = st.resolve_iface_from_dump(self.DUMP, "wired")
        self.assertFalse(up)

    def test_wired_up_uses_l3_device(self):
        dump = {"interface": [{"interface": "wan", "proto": "dhcp", "up": True,
                                "device": "eth0", "l3_device": "eth0"}]}
        dev, up = st.resolve_iface_from_dump(dump, "wired")
        self.assertEqual(dev, "eth0")
        self.assertTrue(up)

    def test_missing_interface_returns_down(self):
        dev, up = st.resolve_iface_from_dump({"interface": []}, "cellular")
        self.assertIsNone(dev)
        self.assertFalse(up)

    def test_none_dump_is_safe(self):
        dev, up = st.resolve_iface_from_dump(None, "cellular")
        self.assertIsNone(dev)
        self.assertFalse(up)


class LatencyStats(unittest.TestCase):
    def test_median_and_jitter(self):
        # seconds -> ms; median of [.05,.06,.07,.08,.09] = .07 -> 70ms; jitter 40ms
        latency_ms, jitter_ms = st.latency_stats([0.09, 0.05, 0.07, 0.06, 0.08])
        self.assertEqual(latency_ms, 70)
        self.assertEqual(jitter_ms, 40)

    def test_empty_is_none(self):
        self.assertEqual(st.latency_stats([]), (None, None))

    def test_ignores_none_samples(self):
        latency_ms, _ = st.latency_stats([0.1, None, 0.1])
        self.assertEqual(latency_ms, 100)


class BuildSnapshot(unittest.TestCase):
    MODEM = {"modems": [{"bus": "cpu", "current_sim_slot": "1"}]}
    NET = {"networks": [
        {"slot": "1", "cell_info": {"id": "D43B70D", "band": 71, "mode": "NR5G-SA FDD",
                                     "rsrp": "-98", "sinr": "8", "rsrq": "-11"}},
        {"slot": "2", "cell_info": {"id": "AD4B60A", "band": 66, "rsrp": "-113"}}]}
    SIMS = {"sims": [{"slot": "1", "carrier": "T-Mobile"}, {"slot": "2", "carrier": "AT&T"}]}

    def test_active_slot_only(self):
        snap = st.build_snapshot(self.MODEM, self.NET, self.SIMS)
        self.assertEqual(snap["slot"], "1")
        self.assertEqual(snap["carrier"], "T-Mobile")
        self.assertEqual(snap["cell_id"], "D43B70D")
        self.assertEqual(snap["rsrp"], -98)

    def test_no_active_slot_is_empty_dict(self):
        self.assertEqual(st.build_snapshot({"modems": [{}]}, self.NET, self.SIMS), {})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 test/speedtest.test.py`
Expected: FAIL / ERROR — `tools/mudimodem-speedtest.py` does not exist yet.

- [ ] **Step 3: Write the pure functions**

Create `tools/mudimodem-speedtest.py`:

```python
#!/usr/bin/env python3
"""MudiModem's speed test runner — curl-based download/upload/latency test
over a chosen outbound interface, with a signal/carrier/tower snapshot taken
immediately before the test.

Stdlib + curl subprocess only (matches mudimodem-at.py's footing: no pip, no
compiled deps). Deployed standalone to /usr/lib/mudimodem/mudimodem-speedtest.py
and spawned DETACHED by the mudimodem RPC backend (a fixed-size test takes
~10-20s -- too long for one $rpcRequest) or by mudimodem-speedtestd on a
schedule. Persists one JSON line per result to /etc/mudimodem/speedtests.jsonl
(NOT /tmp -- unlike the RF-history telemetry, these must survive a reboot).

Design doc: docs/superpowers/specs/2026-07-20-speedtest-tab-design.md
"""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time

DOWN_URL = os.environ.get("MUDIMODEM_ST_DOWN_URL", "https://speed.cloudflare.com/__down")
UP_URL = os.environ.get("MUDIMODEM_ST_UP_URL", "https://speed.cloudflare.com/__up")
DOWN_BYTES = int(os.environ.get("MUDIMODEM_ST_DOWN_BYTES", 20 * 1024 * 1024))
UP_BYTES = int(os.environ.get("MUDIMODEM_ST_UP_BYTES", 8 * 1024 * 1024))
LATENCY_N = int(os.environ.get("MUDIMODEM_ST_LATENCY_N", 5))
HIST_PATH = os.environ.get("MUDIMODEM_ST_HIST", "/etc/mudimodem/speedtests.jsonl")
STATUS_PATH = os.environ.get("MUDIMODEM_ST_STATUS", "/tmp/mudimodem/speedtest-status.json")
LOCK_PATH = os.environ.get("MUDIMODEM_ST_LOCK", "/tmp/mudimodem/speedtest.lock")
HIST_MAX_LINES = 500


def mbps(bytes_per_sec):
    """curl's speed_download/speed_upload (bytes/sec) -> rounded Mbps."""
    if bytes_per_sec is None:
        return None
    return round(bytes_per_sec * 8 / 1e6, 1)


def resolve_iface_from_dump(dump, which):
    """Pick the live device for 'cellular' or 'wired' out of a `ubus call
    network.interface dump` payload. Never hardcoded -- this box's own eth0
    turned out to be bridged into LAN rather than acting as WAN, and the
    cellular device index has been observed to change (rmnet_data0 <->
    rmnet_data1) after a modem reconnect. Returns (device, up)."""
    ifaces = (dump or {}).get("interface") or []
    if which == "cellular":
        for i in ifaces:
            name = str(i.get("interface") or "")
            if i.get("proto") == "rmnet" and not name.endswith("_6"):
                dev = i.get("l3_device") or i.get("device")
                return dev, bool(i.get("up")) and dev is not None
    elif which == "wired":
        for i in ifaces:
            if i.get("interface") == "wan":
                dev = i.get("l3_device") or i.get("device")
                return dev, bool(i.get("up")) and dev is not None
    return None, False


def latency_stats(samples):
    """samples: seconds (floats, None entries dropped). -> (latency_ms,
    jitter_ms) using the median as the headline number (robust to one slow
    outlier) and max-min as jitter. (None, None) if nothing usable."""
    vals = sorted(s for s in samples if s is not None)
    if not vals:
        return None, None
    mid = len(vals) // 2
    median = vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2
    return round(median * 1000), round((vals[-1] - vals[0]) * 1000)


def build_snapshot(modem, net, sims):
    """Signal/carrier/tower snapshot for the active slot -- the same three
    ubus reads mudimodem-collectd uses (cellular.modem status / cellular.
    network info / cellular.sim status), independently implemented here since
    each deployed MudiModem script is self-contained (mirrors mudimodem-at.py
    / mudimodem-collectd, neither of which share code either). {} if the
    active slot can't be resolved."""
    m = ((modem or {}).get("modems") or [{}])
    m = m[0] if m else {}
    slot = m.get("current_sim_slot")
    if slot is None:
        return {}
    cell = {}
    for n in (net or {}).get("networks") or []:
        if str(n.get("slot")) == str(slot):
            cell = n.get("cell_info") or {}
            break
    carrier = ""
    for s in (sims or {}).get("sims") or []:
        if str(s.get("slot")) == str(slot):
            carrier = s.get("carrier") or ""
            break

    def num(v):
        if v is None or v == "":
            return None
        try:
            f = float(v)
        except (ValueError, TypeError):
            return None
        return int(f) if f == int(f) else f

    return {
        "slot": slot, "carrier": carrier, "band": cell.get("band"),
        "mode": cell.get("mode"), "cell_id": cell.get("id"),
        "rsrp": num(cell.get("rsrp")), "sinr": num(cell.get("sinr")), "rsrq": num(cell.get("rsrq")),
    }


if __name__ == "__main__":
    sys.exit(0)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 test/speedtest.test.py`
Expected: `OK` — all tests pass (Mbps: 2, ResolveIfaceFromDump: 5, LatencyStats: 3, BuildSnapshot: 2).

- [ ] **Step 5: Commit**

```bash
git add tools/mudimodem-speedtest.py test/speedtest.test.py
git commit -m "Add pure functions for the speedtest runner (mbps, iface resolution, latency stats, signal snapshot)"
```

---

### Task 2: `tools/mudimodem-speedtest.py` — CLI orchestration (curl phases, status/history files, locking)

**Files:**
- Modify: `tools/mudimodem-speedtest.py`
- Modify: `test/speedtest.test.py`

**Interfaces:**
- Consumes: `mbps`, `resolve_iface_from_dump`, `latency_stats`, `build_snapshot` (Task 1).
- Produces: `main(argv) -> int` (exit code), `acquire_lock(path) -> file|None`, `append_result(path, result)`, `HIST_MAX_LINES` — all consumed by Task 4's on-device smoke test and by the Lua backend's spawn (Task 4) via subprocess invocation (`--trigger`, `--iface` flags), and by `mudimodem-speedtestd` (Task 3, `--trigger schedule`).

- [ ] **Step 1: Write the failing tests**

Append to `test/speedtest.test.py` (before the `if __name__` block):

```python
import http.server
import tempfile
import threading
from urllib.parse import urlparse, parse_qs


class FakeSpeedHandler(http.server.BaseHTTPRequestHandler):
    """Stands in for speed.cloudflare.com: GET ?bytes=N returns N bytes,
    POST reads+discards the body. Both return 200 so curl's -w json trailer
    reports a real (if instant, since it's loopback) transfer."""
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        n = int((q.get("bytes") or ["0"])[0])
        self.send_response(200)
        self.send_header("Content-Length", str(n))
        self.end_headers()
        if n:
            self.wfile.write(b"x" * n)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


class MainEndToEnd(unittest.TestCase):
    def setUp(self):
        self.server = http.server.HTTPServer(("127.0.0.1", 0), FakeSpeedHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)

    def _base(self):
        return "http://127.0.0.1:%d" % self.port

    def test_happy_path_appends_history_and_writes_done_status(self):
        hist = os.path.join(self.tmp, "speedtests.jsonl")
        status = os.path.join(self.tmp, "status.json")
        lock = os.path.join(self.tmp, "st.lock")
        rc = st.main(["--device", "lo", "--down-url", self._base(), "--up-url", self._base(),
                      "--down-bytes", "10000", "--up-bytes", "10000",
                      "--hist", hist, "--status", status, "--lock", lock,
                      "--trigger", "manual", "--iface", "cellular"])
        self.assertEqual(rc, 0)
        with open(hist) as f:
            lines = [json.loads(l) for l in f if l.strip()]
        self.assertEqual(len(lines), 1)
        r = lines[0]
        self.assertEqual(r["trigger"], "manual")
        self.assertEqual(r["iface"], "cellular")
        self.assertGreater(r["down_mbps"], 0)
        self.assertGreater(r["up_mbps"], 0)
        self.assertIsNotNone(r["latency_ms"])
        with open(status) as f:
            s = json.load(f)
        self.assertEqual(s["phase"], "done")
        self.assertFalse(s["running"])

    def test_lock_busy_refuses_a_second_concurrent_run(self):
        lock = os.path.join(self.tmp, "busy.lock")
        held = st.acquire_lock(lock)
        try:
            rc = st.main(["--device", "lo", "--down-url", self._base(), "--up-url", self._base(),
                          "--hist", os.path.join(self.tmp, "h.jsonl"),
                          "--status", os.path.join(self.tmp, "s.json"), "--lock", lock])
        finally:
            held.close()
        self.assertEqual(rc, 2)

    def test_trims_history_to_max_lines(self):
        hist = os.path.join(self.tmp, "many.jsonl")
        with open(hist, "w") as f:
            for i in range(st.HIST_MAX_LINES + 10):
                f.write(json.dumps({"t": i}) + "\n")
        st.append_result(hist, {"t": 999999})
        with open(hist) as f:
            lines = [json.loads(l) for l in f if l.strip()]
        self.assertEqual(len(lines), st.HIST_MAX_LINES)
        self.assertEqual(lines[-1]["t"], 999999)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 test/speedtest.test.py`
Expected: FAIL — `st.main`, `st.acquire_lock`, `st.append_result`, `st.HIST_MAX_LINES` (as a name usable this way) don't exist as working code yet (only the `sys.exit(0)` stub is there).

- [ ] **Step 3: Implement the CLI orchestration**

Replace the `if __name__ == "__main__": sys.exit(0)` stub at the bottom of `tools/mudimodem-speedtest.py` with:

```python
def ubus_call(obj, method, args=None):
    """Return the parsed ubus result dict, or None on any failure."""
    try:
        cmd = ["ubus", "call", obj, method, json.dumps(args or {})]
        out = subprocess.run(cmd, capture_output=True, timeout=8, text=True)
        if out.returncode != 0 or not out.stdout:
            return None
        return json.loads(out.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def resolve_iface(which):
    return resolve_iface_from_dump(ubus_call("network.interface", "dump"), which)


def curl_probe(url, extra_args, timeout):
    """Run curl, discarding the response body (-o /dev/null), capturing ONLY
    the -w JSON trailer on stdout. Returns the parsed dict, or None on any
    failure (process error, timeout, or bad JSON)."""
    cmd = ["curl", "-s", "-m", str(timeout), "-o", "/dev/null", "-w", "%{json}"] + list(extra_args) + [url]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout.decode(errors="replace"))
    except ValueError:
        return None


def _ok(probe):
    return bool(probe) and 200 <= (probe.get("http_code") or 0) < 300


def run_download(device, cfg):
    r = curl_probe(cfg["down_url"], ["--interface", device, "-G", "--data-urlencode",
                                      "bytes=%d" % cfg["down_bytes"]], cfg["timeout"])
    return mbps(r.get("speed_download")) if _ok(r) else None


def run_upload(device, cfg, upload_path):
    r = curl_probe(cfg["up_url"], ["--interface", device, "--data-binary", "@" + upload_path], cfg["timeout"])
    return mbps(r.get("speed_upload")) if _ok(r) else None


def run_latency(device, cfg):
    samples = []
    for _ in range(LATENCY_N):
        r = curl_probe(cfg["down_url"], ["--interface", device, "-G", "--data-urlencode", "bytes=0"], cfg["timeout"])
        if _ok(r):
            samples.append(r.get("time_starttransfer"))
    return latency_stats(samples)


def acquire_lock(path):
    """Non-blocking flock. Returns the open file handle (caller must close()
    to release), or None if another instance already holds it."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    f = open(path, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def write_status(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(obj))
    os.replace(tmp, path)


def trim_history(path, max_lines=HIST_MAX_LINES):
    try:
        with open(path) as f:
            lines = [l for l in f.readlines() if l.strip()]
    except FileNotFoundError:
        return
    if len(lines) <= max_lines:
        return
    kept = lines[-max_lines:]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(kept)
    os.replace(tmp, path)


def append_result(path, result):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(result) + "\n")
    trim_history(path)


def parse_args(argv):
    """Manual argv parsing (matches mudimodem-at.py's style -- no argparse
    elsewhere in this codebase). --device is a debug/testing override that
    skips ubus resolution entirely; the Lua backend and the scheduler daemon
    never pass it -- only --iface, which is always resolved live."""
    cfg = {
        "trigger": "manual", "iface": "cellular", "timeout": 20.0, "device": None,
        "down_url": DOWN_URL, "up_url": UP_URL,
        "down_bytes": DOWN_BYTES, "up_bytes": UP_BYTES,
        "hist": HIST_PATH, "status": STATUS_PATH, "lock": LOCK_PATH,
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--trigger":
            i += 1; cfg["trigger"] = argv[i]
        elif a == "--iface":
            i += 1; cfg["iface"] = argv[i]
        elif a == "--device":
            i += 1; cfg["device"] = argv[i]
        elif a == "--timeout":
            i += 1; cfg["timeout"] = float(argv[i])
        elif a == "--down-url":
            i += 1; cfg["down_url"] = argv[i]
        elif a == "--up-url":
            i += 1; cfg["up_url"] = argv[i]
        elif a == "--down-bytes":
            i += 1; cfg["down_bytes"] = int(argv[i])
        elif a == "--up-bytes":
            i += 1; cfg["up_bytes"] = int(argv[i])
        elif a == "--hist":
            i += 1; cfg["hist"] = argv[i]
        elif a == "--status":
            i += 1; cfg["status"] = argv[i]
        elif a == "--lock":
            i += 1; cfg["lock"] = argv[i]
        else:
            raise SystemExit("unknown arg: %s" % a)
        i += 1
    if cfg["iface"] not in ("cellular", "wired"):
        raise SystemExit("--iface must be 'cellular' or 'wired'")
    return cfg


def main(argv):
    cfg = parse_args(argv)
    lock = acquire_lock(cfg["lock"])
    if lock is None:
        write_status(cfg["status"], {"running": False, "phase": "error",
                                      "message": "another test is already running"})
        return 2
    try:
        if cfg["device"]:
            device, up = cfg["device"], True
        else:
            device, up = resolve_iface(cfg["iface"])
        if not up or not device:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": cfg["iface"] + " is not connected", "iface": cfg["iface"]})
            return 3

        snapshot = build_snapshot(ubus_call("cellular.modem", "status"),
                                   ubus_call("cellular.network", "info"),
                                   ubus_call("cellular.sim", "status"))

        write_status(cfg["status"], {"running": True, "phase": "download", "iface": cfg["iface"]})
        down = run_download(device, cfg)
        if down is None:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": "download failed", "iface": cfg["iface"]})
            return 4

        write_status(cfg["status"], {"running": True, "phase": "upload", "iface": cfg["iface"]})
        upload_path = tempfile.mktemp(prefix="mudimodem-st-")
        with open(upload_path, "wb") as f:
            f.write(os.urandom(cfg["up_bytes"]))
        try:
            up_mbps = run_upload(device, cfg, upload_path)
        finally:
            try:
                os.remove(upload_path)
            except OSError:
                pass
        if up_mbps is None:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": "upload failed", "iface": cfg["iface"]})
            return 4

        write_status(cfg["status"], {"running": True, "phase": "latency", "iface": cfg["iface"]})
        latency_ms, jitter_ms = run_latency(device, cfg)
        if latency_ms is None:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": "latency probe failed", "iface": cfg["iface"]})
            return 4

        result = {"t": int(time.time() * 1000), "trigger": cfg["trigger"], "iface": cfg["iface"],
                  "down_mbps": down, "up_mbps": up_mbps,
                  "latency_ms": latency_ms, "jitter_ms": jitter_ms}
        result.update(snapshot)
        append_result(cfg["hist"], result)
        write_status(cfg["status"], {"running": False, "phase": "done", "result": result})
        return 0
    finally:
        lock.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 test/speedtest.test.py`
Expected: `OK` — all tests pass, including the three new `MainEndToEnd` cases.

- [ ] **Step 5: Sanity-check the real curl field names against the actual endpoint**

Run: `curl -s -o /dev/null -w '%{json}' 'https://speed.cloudflare.com/__down?bytes=1000'`
Expected: a JSON object containing `"http_code":200` and a numeric `"speed_download"` field — confirms the field names `curl_probe`/`_ok`/`run_download` rely on before this ever runs unattended on the router. If a field name differs, fix `run_download`/`run_upload`/`run_latency` to match before proceeding.

- [ ] **Step 6: Commit**

```bash
git add tools/mudimodem-speedtest.py test/speedtest.test.py
git commit -m "Add speedtest runner CLI: curl phases, status/history files, flock serialization"
```

---

### Task 3: `src/sbin/mudimodem-speedtestd` + `src/etc/init.d/mudimodem-speedtestd` — optional scheduler

**Files:**
- Create: `src/sbin/mudimodem-speedtestd`
- Create: `src/etc/init.d/mudimodem-speedtestd`
- Modify: `test/speedtest.test.py`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (invokes Task 2's script as a subprocess by path, not by import).
- Produces: `is_due(cfg, now_ms) -> bool`, `read_schedule(path) -> dict`, `DEFAULT_SCHEDULE` — consumed by Task 4's Lua `get_speedtest_schedule` default shape (must match: `{enabled, interval_seconds, last_run}`).

- [ ] **Step 1: Write the failing test**

Append to `test/speedtest.test.py` (add the import near the top, alongside the existing ones, and the test class near the bottom, before `if __name__`):

```python
STD_SRC = os.path.join(HERE, "..", "src", "sbin", "mudimodem-speedtestd")
std = load(STD_SRC, "mudimodem_speedtestd")


class IsDue(unittest.TestCase):
    def test_disabled_never_due(self):
        self.assertFalse(std.is_due({"enabled": False, "interval_seconds": 60, "last_run": 0}, 10 ** 9))

    def test_due_when_interval_elapsed(self):
        cfg = {"enabled": True, "interval_seconds": 3600, "last_run": 0}
        self.assertTrue(std.is_due(cfg, 3600 * 1000))
        self.assertFalse(std.is_due(cfg, 3600 * 1000 - 1))

    def test_zero_interval_never_due(self):
        self.assertFalse(std.is_due({"enabled": True, "interval_seconds": 0, "last_run": 0}, 10 ** 9))


class ReadSchedule(unittest.TestCase):
    def test_missing_file_returns_default_off(self):
        cfg = std.read_schedule("/tmp/mm-does-not-exist-speedtest-schedule.json")
        self.assertEqual(cfg, std.DEFAULT_SCHEDULE)

    def test_malformed_file_returns_default_off(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("not json")
            path = f.name
        try:
            self.assertEqual(std.read_schedule(path), std.DEFAULT_SCHEDULE)
        finally:
            os.remove(path)

    def test_partial_file_fills_in_defaults(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write(json.dumps({"enabled": True}))
            path = f.name
        try:
            cfg = std.read_schedule(path)
            self.assertTrue(cfg["enabled"])
            self.assertEqual(cfg["interval_seconds"], std.DEFAULT_SCHEDULE["interval_seconds"])
        finally:
            os.remove(path)
```

Place the `STD_SRC`/`std = load(...)` lines directly under the existing `ST_SRC`/`st = load(...)` lines near the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 test/speedtest.test.py`
Expected: FAIL / ERROR — `src/sbin/mudimodem-speedtestd` does not exist.

- [ ] **Step 3: Write the daemon**

Create `src/sbin/mudimodem-speedtestd`:

```python
#!/usr/bin/env python3
"""mudimodem-speedtestd -- optional background speed-test scheduler.

Off by default. Wakes every WAKE_INTERVAL and re-reads the schedule config
each time (so a UI change to enabled/interval_seconds takes effect without
restarting this service). When due, invokes tools/mudimodem-speedtest.py
(deployed to /usr/lib/mudimodem/) with --trigger schedule --iface cellular
and BLOCKS until it finishes -- this is a single-purpose background process,
so blocking during the ~10-20s test is harmless; the script's own flock is
what actually prevents overlap with a concurrent manual run.

Schedule config: /etc/mudimodem/speedtest-schedule.json =
  {"enabled": bool, "interval_seconds": int, "last_run": <epoch ms>}
"""
import json
import os
import signal
import subprocess
import sys
import time

WAKE_INTERVAL = float(os.environ.get("MUDIMODEM_SPEEDTESTD_WAKE", "60"))
SCHEDULE_PATH = os.environ.get("MUDIMODEM_ST_SCHEDULE", "/etc/mudimodem/speedtest-schedule.json")
SPEEDTEST_BIN = os.environ.get("MUDIMODEM_SPEEDTEST_BIN", "/usr/lib/mudimodem/mudimodem-speedtest.py")

DEFAULT_SCHEDULE = {"enabled": False, "interval_seconds": 6 * 3600, "last_run": 0}


def read_schedule(path):
    """Read the schedule config, tolerating an absent/malformed file (falls
    back to fully off)."""
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return dict(DEFAULT_SCHEDULE)
    out = dict(DEFAULT_SCHEDULE)
    if isinstance(cfg, dict):
        out.update({k: cfg[k] for k in DEFAULT_SCHEDULE if k in cfg})
    return out


def write_last_run(path, cfg, now):
    cfg = dict(cfg)
    cfg["last_run"] = now
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f)
    os.replace(tmp, path)


def is_due(cfg, now_ms):
    """Pure: is a scheduled run due right now?"""
    if not cfg.get("enabled"):
        return False
    interval_ms = int(cfg.get("interval_seconds", 0)) * 1000
    if interval_ms <= 0:
        return False
    return (now_ms - int(cfg.get("last_run", 0))) >= interval_ms


def now_ms():
    return int(time.time() * 1000)


def main():
    state = {"go": True}

    def stop(*_a):
        state["go"] = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while state["go"]:
        try:
            cfg = read_schedule(SCHEDULE_PATH)
            if is_due(cfg, now_ms()):
                subprocess.run(["python3", SPEEDTEST_BIN, "--trigger", "schedule", "--iface", "cellular"],
                                timeout=120)
                write_last_run(SCHEDULE_PATH, cfg, now_ms())
        except Exception as e:                        # never die out of the loop
            sys.stderr.write("speedtestd: %s\n" % e)
            sys.stderr.flush()
        end = time.time() + WAKE_INTERVAL
        while state["go"] and time.time() < end:
            time.sleep(0.5)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 test/speedtest.test.py`
Expected: `OK` — all tests pass (adds `IsDue`: 3, `ReadSchedule`: 3).

- [ ] **Step 5: Write the procd service wrapper**

Create `src/etc/init.d/mudimodem-speedtestd`:

```sh
#!/bin/sh /etc/rc.common
# procd service for the optional MudiModem speed-test scheduler. Off by
# default (see /etc/mudimodem/speedtest-schedule.json). Respawned on crash.

START=96
STOP=10
USE_PROCD=1
PROG=/usr/sbin/mudimodem-speedtestd

start_service() {
	procd_open_instance
	procd_set_param command /usr/bin/python3 "$PROG"
	procd_set_param respawn
	procd_set_param stderr 1
	procd_close_instance
}
```

- [ ] **Step 6: Commit**

```bash
git add src/sbin/mudimodem-speedtestd src/etc/init.d/mudimodem-speedtestd test/speedtest.test.py
git commit -m "Add optional speedtest scheduler daemon (off by default)"
```

---

### Task 4: `src/rpc/mudimodem` — Lua backend additions

**Files:**
- Modify: `src/rpc/mudimodem`
- Create: `test/backend-speedtest.test.lua`

**Interfaces:**
- Consumes: existing `ucall`, `arr`, `cjson` (already in the file from earlier phases).
- Produces: RPC methods `get_speedtest_interfaces`, `run_speedtest`, `get_speedtest_status`, `get_speedtest_history`, `clear_speedtest_history`, `get_speedtest_schedule`, `set_speedtest_schedule` — consumed by Task 7's frontend chunk.

⚠️ This backend cannot be exercised locally: `require "oui.ubus"` fails outside the router (confirmed: `oui.ubus` is not resolvable in a local Lua 5.1 install, while `cjson` is). Every test step below runs **on-device** via `ssh root@mudi`, matching `test/backend-history.test.lua`'s existing convention.

- [ ] **Step 1: Write the on-device test**

Create `test/backend-speedtest.test.lua`:

```lua
-- On-device test for the mudimodem speedtest RPC methods. Runs the REAL
-- plugin against LIVE ubus (for get_speedtest_interfaces / run_speedtest's
-- iface check) plus isolated temp files (for status/history/schedule), using
-- the same native-ubus-shim technique as test/backend.test.lua.
-- Run by tools/verify.sh on the device. Exit 0 = pass, 1 = fail.

local native = require "ubus"
local conn = assert(native.connect(), "ubus connect failed")
package.loaded["oui.ubus"] = {
  call = function(object, method, params) return conn:call(object, method, params or {}) end
}

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M) == "table", "plugin must return a table")
for _, name in ipairs({ "get_speedtest_interfaces", "run_speedtest", "get_speedtest_status",
                         "get_speedtest_history", "clear_speedtest_history",
                         "get_speedtest_schedule", "set_speedtest_schedule" }) do
  assert(type(M[name]) == "function", name .. " missing")
end

-- 1. get_speedtest_interfaces: real ubus data. Cellular MUST resolve on this
-- box (it's the box's only always-up path); wired's device/up may vary
-- (cable may or may not be plugged in) -- assert shape, not a specific value.
local ifaces = M.get_speedtest_interfaces({})
assert(type(ifaces.cellular) == "table", "cellular key present")
assert(type(ifaces.cellular.device) == "string" and ifaces.cellular.device ~= "",
       "cellular device resolves to a real device name, got: " .. tostring(ifaces.cellular.device))
assert(ifaces.cellular.up == true, "cellular must be up on this box")
assert(type(ifaces.wired) == "table", "wired key present")
assert(ifaces.wired.up == true or ifaces.wired.up == false, "wired.up is a boolean")

-- 2. run_speedtest refuses an invalid iface without touching anything.
local bad = M.run_speedtest({ iface = "vpn" })
assert(bad.error, "invalid iface must be refused")

-- 3. get_speedtest_status / get_speedtest_history / clear_speedtest_history
-- against isolated temp files (no real test run -- that's a separate LIVE
-- smoke test in verify.sh, since it costs real cellular data).
local HIST = os.getenv("MUDIMODEM_SPEEDTEST_HIST") or error("set MUDIMODEM_SPEEDTEST_HIST")
os.execute("mkdir -p " .. (HIST:match("(.*/)") or "."))
local f = assert(io.open(HIST, "w"))
f:write('{"t":1000,"iface":"cellular","down_mbps":42.1,"up_mbps":11.3,"latency_ms":61}\n')
f:write('garbage not json\n')
f:write('{"t":2000,"iface":"wired","down_mbps":500.0,"up_mbps":100.0,"latency_ms":8}\n')
f:close()

local all = M.get_speedtest_history({})
assert(#all.results == 2, "expected 2 valid results (1 malformed skipped), got " .. #all.results)
local cellOnly = M.get_speedtest_history({ iface = "cellular" })
assert(#cellOnly.results == 1 and cellOnly.results[1].iface == "cellular", "iface filter works")
local since = M.get_speedtest_history({ since = 1000 })
assert(#since.results == 1 and since.results[1].t == 2000, "since filter works")

local status_absent = M.get_speedtest_status({})
assert(status_absent.running == false, "no status file yet -> not running")

local cleared = M.clear_speedtest_history({})
assert(cleared.ok == true)
local afterClear = M.get_speedtest_history({})
assert(#afterClear.results == 0, "history empty after clear")

-- 4. schedule read/write round trip.
local SCHED = os.getenv("MUDIMODEM_ST_SCHEDULE") or error("set MUDIMODEM_ST_SCHEDULE")
os.execute("rm -f " .. SCHED)
local defaultSched = M.get_speedtest_schedule({})
assert(defaultSched.enabled == false, "default schedule is off")

local badInterval = M.set_speedtest_schedule({ enabled = true, interval_seconds = 42 })
assert(badInterval.error, "non-whitelisted interval must be refused")

local ok = M.set_speedtest_schedule({ enabled = true, interval_seconds = 3600 })
assert(ok.ok == true)
local reread = M.get_speedtest_schedule({})
assert(reread.enabled == true and reread.interval_seconds == 3600, "schedule persisted")

os.execute("rm -f " .. HIST .. " " .. SCHED)
print("backend-speedtest OK: interfaces/run_speedtest-guard/history-filters/clear/schedule all pass")
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
ssh -o BatchMode=yes root@mudi 'cat > /tmp/mm-st.test.lua' < test/backend-speedtest.test.lua
ssh -o BatchMode=yes root@mudi 'MUDIMODEM_SPEEDTEST_HIST=/tmp/mmst-hist.jsonl MUDIMODEM_ST_SCHEDULE=/tmp/mmst-sched.json lua /tmp/mm-st.test.lua'
```
Expected: error — `get_speedtest_interfaces missing` (the currently-deployed backend has none of these methods yet).

- [ ] **Step 3: Add the speedtest methods to the backend**

Add near the end of `src/rpc/mudimodem`, just before the final `return M`:

```lua
-- ============================ Speedtest ============================
-- On-demand (+ optional scheduled) download/upload/latency test. The test
-- itself is pure IP traffic run by tools/mudimodem-speedtest.py, spawned
-- DETACHED (like mudimodem-revert) because a fixed-size test takes ~10-20s --
-- too long for a single $rpcRequest. Results persist in /etc/mudimodem (NOT
-- /tmp, unlike the RF-history telemetry) so they survive a normal reboot.
local SPEEDTEST_BIN      = os.getenv("MUDIMODEM_SPEEDTEST_BIN")      or "/usr/lib/mudimodem/mudimodem-speedtest.py"
local SPEEDTEST_HIST     = os.getenv("MUDIMODEM_SPEEDTEST_HIST")     or "/etc/mudimodem/speedtests.jsonl"
local SPEEDTEST_STATUS   = os.getenv("MUDIMODEM_SPEEDTEST_STATUS")   or "/tmp/mudimodem/speedtest-status.json"
local SPEEDTEST_SCHEDULE = os.getenv("MUDIMODEM_ST_SCHEDULE")        or "/etc/mudimodem/speedtest-schedule.json"

-- Allowed schedule cadences (seconds) -- the UI's fixed dropdown (30m/1h/2h/
-- 6h/12h/24h); set_speedtest_schedule refuses anything else.
local SCHEDULE_SECONDS = { [1800] = true, [3600] = true, [7200] = true,
                           [21600] = true, [43200] = true, [86400] = true }

local function nullish(v) return v == nil or v == cjson.null end

-- Resolve an outbound interface ("cellular"|"wired") to its LIVE Linux device
-- via ubus network.interface dump -- NEVER hardcoded. This box's own eth0 is
-- bridged into LAN rather than acting as WAN, and the cellular device index
-- has been observed to change (rmnet_data0 <-> rmnet_data1) after a modem
-- reconnect, so resolving fresh every call is the only correct approach.
-- Returns { device = <string|nil>, up = <bool> }.
local function resolve_iface(which)
  local dump = ucall("network.interface", "dump", {})
  local ifaces = (dump and dump.interface) or {}
  local function pick(dev)
    if nullish(dev) then return nil end
    return dev
  end
  if which == "cellular" then
    for _, i in ipairs(ifaces) do
      local name = tostring(i.interface or "")
      if i.proto == "rmnet" and not name:match("_6$") then
        local dev = pick(i.l3_device) or pick(i.device)
        return { device = dev, up = (i.up == true) and dev ~= nil }
      end
    end
  elseif which == "wired" then
    for _, i in ipairs(ifaces) do
      if i.interface == "wan" then
        local dev = pick(i.l3_device) or pick(i.device)
        return { device = dev, up = (i.up == true) and dev ~= nil }
      end
    end
  end
  return { device = nil, up = false }
end

function M.get_speedtest_interfaces(args)
  return { cellular = resolve_iface("cellular"), wired = resolve_iface("wired") }
end

local function read_json_file(path, default)
  local f = io.open(path, "r")
  if not f then return default end
  local raw = f:read("*a")
  f:close()
  local ok, obj = pcall(cjson.decode, raw)   -- cjson.decode can't yield; pcall is safe here
  if not ok or type(obj) ~= "table" then return default end
  return obj
end

function M.run_speedtest(args)
  local iface = (args and args.iface) or "cellular"
  if iface ~= "cellular" and iface ~= "wired" then
    return { error = "iface must be 'cellular' or 'wired'" }
  end
  local info = resolve_iface(iface)
  if not info.up or not info.device then
    return { error = "iface_down", iface = iface }
  end

  local st = read_json_file(SPEEDTEST_STATUS, nil)
  if st and st.running then return { running = true } end

  os.execute("mkdir -p /etc/mudimodem /tmp/mudimodem 2>/dev/null")
  local quoted_bin = "'" .. SPEEDTEST_BIN:gsub("'", "'\\''") .. "'"
  os.execute("python3 " .. quoted_bin .. " --trigger manual --iface " .. iface .. " >/dev/null 2>&1 &")
  return { started = true }
end

function M.get_speedtest_status(args)
  return read_json_file(SPEEDTEST_STATUS, { running = false })
end

function M.get_speedtest_history(args)
  local since = args and tonumber(args.since) or nil
  local iface = args and args.iface or nil
  local limit = args and tonumber(args.limit) or nil
  local out = {}
  local fh = io.open(SPEEDTEST_HIST, "r")
  if fh then
    for line in fh:lines() do
      if #line > 1 then
        local ok, obj = pcall(cjson.decode, line)
        if ok and type(obj) == "table" and obj.t then
          if (not since or obj.t > since) and (not iface or obj.iface == iface) then
            out[#out + 1] = obj
          end
        end
      end
    end
    fh:close()
  end
  if limit and #out > limit then
    local trimmed = {}
    for i = #out - limit + 1, #out do trimmed[#trimmed + 1] = out[i] end
    out = trimmed
  end
  return { results = arr(out) }
end

function M.clear_speedtest_history(args)
  os.execute("mkdir -p /etc/mudimodem 2>/dev/null")
  local f = io.open(SPEEDTEST_HIST, "w")
  if f then f:close() end
  return { ok = true }
end

function M.get_speedtest_schedule(args)
  return read_json_file(SPEEDTEST_SCHEDULE, { enabled = false, interval_seconds = 21600, last_run = 0 })
end

function M.set_speedtest_schedule(args)
  local enabled = (args and args.enabled) and true or false
  local interval = tonumber(args and args.interval_seconds)
  if not interval or not SCHEDULE_SECONDS[interval] then
    return { error = "interval_seconds must be one of 1800/3600/7200/21600/43200/86400" }
  end
  local cur = M.get_speedtest_schedule({})
  os.execute("mkdir -p /etc/mudimodem 2>/dev/null")
  local f = io.open(SPEEDTEST_SCHEDULE, "w")
  if not f then return { error = "cannot write schedule config" } end
  f:write(cjson.encode({ enabled = enabled, interval_seconds = interval, last_run = cur.last_run or 0 }))
  f:close()
  return { ok = true, enabled = enabled, interval_seconds = interval }
end
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
ssh -o BatchMode=yes root@mudi 'cat > /usr/lib/oui-httpd/rpc/mudimodem' < src/rpc/mudimodem
ssh -o BatchMode=yes root@mudi 'cat > /tmp/mm-st.test.lua' < test/backend-speedtest.test.lua
ssh -o BatchMode=yes root@mudi 'MUDIMODEM_SPEEDTEST_HIST=/tmp/mmst-hist.jsonl MUDIMODEM_ST_SCHEDULE=/tmp/mmst-sched.json lua /tmp/mm-st.test.lua; rc=$?; rm -f /tmp/mm-st.test.lua; exit $rc'
```
Expected: `backend-speedtest OK: interfaces/run_speedtest-guard/history-filters/clear/schedule all pass`

- [ ] **Step 5: Commit**

```bash
git add src/rpc/mudimodem test/backend-speedtest.test.lua
git commit -m "Add speedtest RPC methods to the mudimodem backend (interface resolution, run/status/history/schedule)"
```

---

### Task 5: `src/views/mudimodem-speedtest.js` + `src/menu/mudimodem-speedtest.json` — core component

**Files:**
- Create: `src/views/mudimodem-speedtest.js`
- Create: `src/menu/mudimodem-speedtest.json`
- Create: `test/speedtest-chunk.test.js`

**Interfaces:**
- Consumes: RPC methods from Task 4 (`get_speedtest_interfaces`, `run_speedtest`, `get_speedtest_status`, `get_speedtest_history`, `get_speedtest_schedule`, `set_speedtest_schedule`, `clear_speedtest_history`) via `window.$rpcRequest`.
- Produces: component named `mudimodem-speedtest`, prop `embedded`, data fields `results`/`status`/`ifaces`/`schedule`/`runIface`/`filterIface` — consumed by Task 6 (extends this same file) and Task 7 (`mudimodem.js` renders it as `h(this.speedtestComp, {props:{embedded:true}})`).

- [ ] **Step 1: Write the failing tests**

Create `test/speedtest-chunk.test.js`:

```js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-speedtest.js');

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
function makeVm(component) {
  const vm = Object.assign({}, component.data());
  for (const [k, fn] of Object.entries(component.methods || {})) vm[k] = fn.bind(vm);
  for (const [k, fn] of Object.entries(component.computed || {})) {
    Object.defineProperty(vm, k, { get: fn.bind(vm), configurable: true });
  }
  return vm;
}
function stubRpc(replies) {
  const calls = [];
  global.window = {
    $rpcRequest(method, params, opts) {
      calls.push({ method, params, opts });
      const r = replies.shift();
      return (r instanceof Error) ? Promise.reject(r) : Promise.resolve(r);
    }
  };
  return calls;
}
function unstubRpc() { delete global.window; }

test('chunk evals to a render-only component named mudimodem-speedtest', () => {
  const c = loadChunk();
  assert.strictEqual(c.name, 'mudimodem-speedtest');
  assert.strictEqual(c.template, undefined, 'template: is forbidden');
  assert.strictEqual(typeof c.render, 'function');
});

test('renders an honest empty state before data arrives', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.resultsLoading = true;
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Run speed test/);
  assert.match(txt, /Loading history/);
});

test('runTest(): calls run_speedtest with the picked interface, sets running state', async () => {
  const calls = stubRpc([{ started: true }]);
  try {
    const vm = makeVm(loadChunk());
    vm.runIface = 'wired';
    vm.runTest();
    assert.strictEqual(vm.status.running, true, 'optimistic running state set immediately');
    await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(calls[0].params, ['sid', 'mudimodem', 'run_speedtest', { iface: 'wired' }]);
  } finally { unstubRpc(); }
});

test('runTest(): iface_down surfaces as a friendly error, not a crash', async () => {
  const calls = stubRpc([{ error: 'iface_down', iface: 'wired' }]);
  try {
    const vm = makeVm(loadChunk());
    vm.runIface = 'wired';
    vm.runTest();
    await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(vm.status.running, false);
    assert.match(vm.status.message, /Wired WAN is not connected/);
  } finally { unstubRpc(); calls; }
});

test('runTest(): no-ops while a test is already running', () => {
  const vm = makeVm(loadChunk());
  vm.status = { running: true, phase: 'download' };
  const calls = stubRpc([]);
  try {
    vm.runTest();
    assert.strictEqual(calls.length, 0, 'must not start a second test');
  } finally { unstubRpc(); }
});

test('fetchStatus(): a finished test stops polling and refreshes history', async () => {
  const calls = stubRpc([{ running: false, phase: 'done' }, { results: [{ t: 1, down_mbps: 1 }] }]);
  try {
    const vm = makeVm(loadChunk());
    vm.statusPoll = setInterval(() => {}, 100000);
    vm.fetchStatus(false);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(vm.statusPoll, null, 'poll cleared once the test is done');
    assert.strictEqual(calls[1].params[2], 'get_speedtest_history', 'history refetched after completion');
  } finally { unstubRpc(); }
});

test('setSchedule(): posts enabled+interval, then re-fetches', async () => {
  const calls = stubRpc([{ ok: true }, { enabled: true, interval_seconds: 3600, last_run: 0 }]);
  try {
    const vm = makeVm(loadChunk());
    vm.setSchedule(true, 3600);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(calls[0].params, ['sid', 'mudimodem', 'set_speedtest_schedule',
      { enabled: true, interval_seconds: 3600 }]);
    assert.strictEqual(calls[1].params[2], 'get_speedtest_schedule');
  } finally { unstubRpc(); }
});

test('clearHistory(): empties the local results list', async () => {
  const calls = stubRpc([{ ok: true }]);
  try {
    const vm = makeVm(loadChunk());
    vm.results = [{ t: 1 }];
    vm.clearHistory();
    await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(vm.results, []);
    assert.strictEqual(calls[0].params[2], 'clear_speedtest_history');
  } finally { unstubRpc(); }
});

test('filtered: only shows results matching filterIface', () => {
  const vm = makeVm(loadChunk());
  vm.results = [{ t: 1, iface: 'cellular' }, { t: 2, iface: 'wired' }];
  vm.filterIface = 'cellular';
  assert.strictEqual(vm.filtered.length, 1);
  assert.strictEqual(vm.filtered[0].t, 1);
});

test('interface dropdown marks a down interface as not connected', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.ifaces = { cellular: { device: 'rmnet_data0', up: true }, wired: { device: null, up: false } };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Wired WAN \(not connected\)/);
});

test('the chunk never issues raw AT and never calls tracking/console RPC objects', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /get_result_AT|modem\.CPU\.AT|at_console/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/speedtest-chunk.test.js`
Expected: FAIL — `src/views/mudimodem-speedtest.js` does not exist.

- [ ] **Step 3: Write the core component**

Create `src/menu/mudimodem-speedtest.json`:

```json
{
    "view": "mudimodem-speedtest",
    "level": 0
}
```

Create `src/views/mudimodem-speedtest.js`:

```js
// MudiModem — Speedtest tab. A hidden /mudimodem-speedtest route, loaded the
// same way as Tracking: eval()'d by GL's SPA (module.exports = {...}), and
// lazy-loaded + embedded by the main page's "Speedtest" tab (props.embedded
// drops the "← Modem" breadcrumb since the tab bar is already visible).
//
// The test itself runs device-side (tools/mudimodem-speedtest.py, spawned
// detached by mudimodem.run_speedtest because a fixed-size download+upload+
// latency test takes ~10-20s -- too long for one $rpcRequest). This page
// polls mudimodem.get_speedtest_status roughly once a second while a test is
// in flight, then refetches history. Results persist in /etc/mudimodem (NOT
// /tmp, unlike the RF-history telemetry) so they survive a normal reboot.
//
// Vue is runtime-only here too: render(h) only, never template:.
module.exports = (function () {
  "use strict";

  var IFACES = [["cellular", "Cellular"], ["wired", "Wired WAN"]];
  var INTERVALS = [[1800, "30 min"], [3600, "1 hour"], [7200, "2 hours"],
    [21600, "6 hours"], [43200, "12 hours"], [86400, "24 hours"]];
  var PHASE_TEXT = { download: "Testing download…", upload: "Testing upload…",
    latency: "Testing latency…" };

  var component = {
    name: "mudimodem-speedtest",
    props: { embedded: { type: Boolean, default: false } },

    data: function () {
      return {
        styleId: "mms-css",
        results: [], resultsLoading: true, resultsErr: "",
        ifaces: null, ifacesErr: "",
        runIface: "cellular",
        filterIface: "cellular",
        status: { running: false },
        statusPoll: null,
        schedule: null, scheduleErr: "", scheduleSaving: false,
        cursor: null, pinned: null, width: 900
      };
    },

    computed: {
      filtered: function () {
        var f = this.filterIface;
        return this.results.filter(function (r) { return r.iface === f; });
      }
    },

    created: function () { this.injectStyle(); },
    mounted: function () {
      var self = this;
      if (typeof window === "undefined") return;
      this.measure();
      this._onResize = function () { self.measure(); };
      window.addEventListener("resize", this._onResize);
      this.fetchInterfaces();
      this.fetchHistory();
      this.fetchSchedule();
      this.fetchStatus(true);
    },
    beforeDestroy: function () {
      if (this.statusPoll) clearInterval(this.statusPoll);
      if (typeof window !== "undefined" && this._onResize) window.removeEventListener("resize", this._onResize);
    },

    methods: {
      measure: function () {
        if (this.$refs && this.$refs.graph && this.$refs.graph.clientWidth)
          this.width = this.$refs.graph.clientWidth;
      },
      rpc: function (method, params) {
        if (typeof window === "undefined" || !window.$rpcRequest) return Promise.reject(new Error("RPC unavailable"));
        return window.$rpcRequest("call", ["sid", "mudimodem", method, params || {}]);
      },
      fetchInterfaces: function () {
        var self = this;
        this.rpc("get_speedtest_interfaces", {})
          .then(function (r) { self.ifaces = r; self.ifacesErr = ""; })
          .catch(function (e) { self.ifacesErr = (e && (e.message || e.type)) || "could not check interfaces"; });
      },
      fetchHistory: function () {
        var self = this;
        this.resultsLoading = true;
        this.rpc("get_speedtest_history", {})
          .then(function (r) {
            self.results = (r && r.results) || [];
            self.resultsErr = ""; self.resultsLoading = false;
          })
          .catch(function (e) {
            self.resultsErr = (e && (e.message || e.type)) || "could not load history";
            self.resultsLoading = false;
          });
      },
      fetchSchedule: function () {
        var self = this;
        this.rpc("get_speedtest_schedule", {})
          .then(function (r) { self.schedule = r; })
          .catch(function () { /* leave schedule null -> honest "unavailable" */ });
      },
      fetchStatus: function (startPollIfRunning) {
        var self = this;
        this.rpc("get_speedtest_status", {})
          .then(function (r) {
            self.status = r || { running: false };
            if (self.status.running && startPollIfRunning) self.startPoll();
            if (!self.status.running && self.statusPoll) self.stopPollAndRefresh();
          })
          .catch(function () { /* transient -- next poll tick tries again */ });
      },
      startPoll: function () {
        var self = this;
        if (this.statusPoll) return;
        this.statusPoll = setInterval(function () { self.fetchStatus(false); }, 1000);
      },
      stopPollAndRefresh: function () {
        clearInterval(this.statusPoll);
        this.statusPoll = null;
        this.fetchHistory();
      },
      runTest: function () {
        var self = this;
        if (this.status.running) return;
        this.status = { running: true, phase: "download", iface: this.runIface };
        this.rpc("run_speedtest", { iface: this.runIface })
          .then(function (r) {
            if (r && r.error === "iface_down") {
              self.status = { running: false, phase: "error",
                message: (self.runIface === "cellular" ? "Cellular" : "Wired WAN") + " is not connected" };
              return;
            }
            if (r && r.error) { self.status = { running: false, phase: "error", message: r.error }; return; }
            self.startPoll();
          })
          .catch(function (e) {
            self.status = { running: false, phase: "error", message: (e && (e.message || e.type)) || "could not start" };
          });
      },
      setSchedule: function (enabled, intervalSeconds) {
        var self = this;
        this.scheduleSaving = true;
        this.rpc("set_speedtest_schedule", { enabled: enabled, interval_seconds: intervalSeconds })
          .then(function () { self.scheduleSaving = false; self.fetchSchedule(); })
          .catch(function (e) {
            self.scheduleSaving = false;
            self.scheduleErr = (e && (e.message || e.type)) || "could not save schedule";
          });
      },
      clearHistory: function () {
        var self = this;
        this.rpc("clear_speedtest_history", {}).then(function () { self.results = []; });
      },
      clock: function (t) {
        var d = new Date(t), p = function (n) { return (n < 10 ? "0" : "") + n; };
        return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
      },

      // ---- render ----
      renderControls: function (h) {
        var self = this;
        var ifaceSel = h("select", {
          domProps: { value: this.runIface },
          attrs: { disabled: this.status.running },
          on: { change: function (ev) { self.runIface = ev.target.value; } }
        }, IFACES.map(function (i) {
          var down = self.ifaces && self.ifaces[i[0]] && !self.ifaces[i[0]].up;
          return h("option", { attrs: { value: i[0] }, key: i[0] }, i[1] + (down ? " (not connected)" : ""));
        }));
        var runBtn = h("button", {
          staticClass: "mms-btn primary",
          attrs: { disabled: this.status.running },
          on: { click: function () { self.runTest(); } }
        }, this.status.running ? (PHASE_TEXT[this.status.phase] || "Testing…") : "Run speed test");
        var err = (!this.status.running && this.status.phase === "error")
          ? h("span", { staticClass: "mms-err" }, this.status.message) : null;
        return h("div", { staticClass: "mms-controls" }, [ifaceSel, runBtn, err].filter(Boolean));
      },
      renderSchedule: function (h) {
        var self = this;
        if (!this.schedule) return null;
        var toggle = h("label", { staticClass: "mms-sched-toggle" }, [
          h("input", {
            attrs: { type: "checkbox", checked: this.schedule.enabled },
            domProps: { checked: this.schedule.enabled },
            on: { change: function (ev) { self.setSchedule(ev.target.checked, self.schedule.interval_seconds); } }
          }),
          "Automatic background tests"
        ]);
        var sel = h("select", {
          attrs: { disabled: !this.schedule.enabled },
          domProps: { value: this.schedule.interval_seconds },
          on: { change: function (ev) { self.setSchedule(self.schedule.enabled, parseInt(ev.target.value, 10)); } }
        }, INTERVALS.map(function (iv) { return h("option", { attrs: { value: iv[0] }, key: iv[0] }, "Every " + iv[1]); }));
        return h("div", { staticClass: "mms-sched" }, [toggle, sel]);
      },
      renderHistoryList: function (h) {
        if (this.resultsLoading) return h("div", { staticClass: "mms-empty" }, "Loading history…");
        if (this.resultsErr) return h("div", { staticClass: "mms-empty" }, "Couldn't load history: " + this.resultsErr);
        if (!this.filtered.length) return h("div", { staticClass: "mms-empty" },
          "No results yet for this interface. Run a speed test above.");
        return null;   // Task 6 replaces this with the graph once results exist.
      },
      injectStyle: function () {
        if (typeof document === "undefined" || document.getElementById(this.styleId)) return;
        var css =
          '.mms{color:var(--text-regular)}' +
          '.mms-card{background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);padding:12px 14px;margin-bottom:11px}' +
          '.mms-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}' +
          '.mms-crumb{background:none;border:0;font:inherit;font-size:12px;color:var(--primary);cursor:pointer;padding:0}' +
          '.mms-title{font-size:14px;font-weight:600;color:var(--text-title)}' +
          '.mms-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
          '.mms-btn{font-size:12px;font-weight:600;border-radius:3px;padding:7px 14px;cursor:pointer;font-family:inherit;border:1px solid var(--border);background:var(--background-card);color:var(--text-regular)}' +
          '.mms-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}' +
          '.mms-btn:disabled{opacity:.6;cursor:default}' +
          '.mms-err{color:var(--error);font-size:12px}' +
          '.mms-sched{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px}' +
          '.mms-sched-toggle{display:flex;align-items:center;gap:6px;cursor:pointer}' +
          '.mms-empty{padding:24px 0;text-align:center;color:var(--text-hint);font-size:12.5px}';
        var el = document.createElement("style");
        el.id = this.styleId; el.textContent = css;
        document.head.appendChild(el);
      },
      renderPage: function (h) {
        var self = this;
        var head = h("div", { staticClass: "mms-head" }, [
          this.embedded ? null : h("button", { staticClass: "mms-crumb", on: { click: function () {
            if (self.$router) self.$router.push("/mudimodem"); } } }, "← Modem"),
          h("span", { staticClass: "mms-title" }, "Speedtest")
        ].filter(Boolean));
        var ifaceFilterSel = h("select", {
          domProps: { value: this.filterIface },
          on: { change: function (ev) { self.filterIface = ev.target.value; } }
        }, IFACES.map(function (i) { return h("option", { attrs: { value: i[0] }, key: i[0] }, i[1]); }));
        return h("div", { staticClass: "mms" }, [
          h("div", { staticClass: "mms-card" }, [head, this.renderControls(h), this.renderSchedule(h)]),
          h("div", { staticClass: "mms-card" }, [
            h("div", { staticClass: "mms-controls" }, [
              h("span", "History"), ifaceFilterSel,
              h("button", { staticClass: "mms-btn", on: { click: function () { self.clearHistory(); } } }, "Clear history")
            ]),
            this.renderHistoryList(h)
          ])
        ]);
      }
    },

    render: function (h) { return this.renderPage(h); }
  };
  return component;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/speedtest-chunk.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem-speedtest.js src/menu/mudimodem-speedtest.json test/speedtest-chunk.test.js
git commit -m "Add Speedtest chunk core: run button, interface picker, status polling, schedule controls"
```

---

### Task 6: `src/views/mudimodem-speedtest.js` — history graph + hover/click detail popover

**Files:**
- Modify: `src/views/mudimodem-speedtest.js`
- Modify: `test/speedtest-chunk.test.js`

**Interfaces:**
- Consumes: `this.filtered` (computed, Task 5), `this.width` (Task 5's `measure()`).
- Produces: `renderGraph(h)` replacing `renderHistoryList(h)` in `renderPage`; `data.cursor`/`data.pinned` now driven by mouse interaction.

- [ ] **Step 1: Write the failing tests**

Append to `test/speedtest-chunk.test.js` (before the final "never issues raw AT" test):

```js
const RESULTS = [
  { t: 1000, iface: 'cellular', down_mbps: 40, up_mbps: 10, latency_ms: 60, jitter_ms: 5,
    carrier: 'T-Mobile', slot: 1, band: 71, mode: 'NR5G-SA FDD', cell_id: 'ABC', rsrp: -98, sinr: 8, rsrq: -11 },
  { t: 2000, iface: 'cellular', down_mbps: 55, up_mbps: 12, latency_ms: 58, jitter_ms: 4,
    carrier: 'T-Mobile', slot: 1, band: 71, mode: 'NR5G-SA FDD', cell_id: 'ABC', rsrp: -95, sinr: 9, rsrq: -10 },
  { t: 3000, iface: 'wired', down_mbps: 500, up_mbps: 100, latency_ms: 8, jitter_ms: 1 }
];

test('renderGraph: draws a line for cellular results only when filtered', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = RESULTS;
  vm.filterIface = 'cellular';
  const svg = walk(c.render.call(vm, h)).find((n) => n.tag === 'svg');
  assert.ok(svg, 'graph renders an svg once results exist');
  const paths = walk(svg).filter((n) => n.tag === 'path');
  assert.ok(paths.length >= 2, 'at least a download and upload line');
});

test('renderGraph: hovering picks the nearest result and shows a full snapshot popover', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = RESULTS;
  vm.filterIface = 'cellular';
  vm.width = 400;
  vm.cursor = 1;   // simulate onMove having picked index 1
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /55 Mbps/);
  assert.match(txt, /12 Mbps/);
  assert.match(txt, /58 ms/);
  assert.match(txt, /T-Mobile/);
  assert.match(txt, /n71/);
  assert.match(txt, /-95 dBm/);
});

test('renderGraph: clicking pins the cursor; clicking again unpins', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = RESULTS;
  vm.filterIface = 'cellular';
  vm.width = 400;
  const graphDiv = walk(c.render.call(vm, h)).find((n) => n.data.staticClass === 'mms-graph');
  assert.ok(graphDiv.data.on && graphDiv.data.on.click, 'graph wires a click handler');
  graphDiv.data.on.click({ clientX: 0, currentTarget: null });
  assert.notStrictEqual(vm.pinned, null, 'click pins a cursor position');
  const pinnedAt = vm.pinned;
  graphDiv.data.on.click({ clientX: 0, currentTarget: null });
  assert.strictEqual(vm.pinned, null, 'second click unpins');
  pinnedAt;
});

test('renderGraph: empty-for-this-interface state is honest, no crash', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = [RESULTS[2]];        // only a wired result
  vm.filterIface = 'cellular';
  vm.resultsLoading = false;
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /No results yet for this interface/);
});
```

Note: the click test stubs `this.$refs.graph` indirectly by having `onMove`/`onClick` fall back safely when `getBoundingClientRect` is unavailable in the jsdom-less test environment — implement `nearestIdx`/`onMove` defensively (see Step 3) so a missing `$refs.graph` still lets `onClick` set `pinned` to the current `cursor` (defaulting to index 0) rather than throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/speedtest-chunk.test.js`
Expected: FAIL — no `<svg>` is rendered yet (Task 5 only renders `renderHistoryList`'s empty-state text once there are results, `null` otherwise).

- [ ] **Step 3: Implement the graph**

In `src/views/mudimodem-speedtest.js`, replace the `renderHistoryList` method with `renderGraph`:

```js
      renderGraph: function (h) {
        var self = this, results = this.filtered;
        if (this.resultsLoading) return h("div", { staticClass: "mms-empty" }, "Loading history…");
        if (this.resultsErr) return h("div", { staticClass: "mms-empty" }, "Couldn't load history: " + this.resultsErr);
        if (!results.length) return h("div", { staticClass: "mms-empty" },
          "No results yet for this interface. Run a speed test above.");

        var W = this.width, PADL = 34, PADR = 12, PLOT_H = 160, LAT_H = 40, GAP = 14;
        var plotTop = 10, plotBot = plotTop + PLOT_H;
        var latTop = plotBot + GAP, latBot = latTop + LAT_H;
        var t0 = results[0].t, t1 = results[results.length - 1].t;
        var span = Math.max(1, t1 - t0);
        var xOf = function (t) { return PADL + (t - t0) / span * (W - PADL - PADR); };

        var maxMbps = 1;
        results.forEach(function (r) {
          if (r.down_mbps > maxMbps) maxMbps = r.down_mbps;
          if (r.up_mbps > maxMbps) maxMbps = r.up_mbps;
        });
        var yMax = maxMbps * 1.15;
        var yOf = function (v) { return plotBot - (Math.max(0, v || 0) / yMax) * PLOT_H; };
        var maxLatency = 1;
        results.forEach(function (r) { if (r.latency_ms > maxLatency) maxLatency = r.latency_ms; });
        var latYOf = function (v) { return latBot - (Math.max(0, v || 0) / (maxLatency * 1.15)) * LAT_H; };

        var kids = [];
        kids.push(h("rect", { attrs: { x: PADL, y: 0, width: 10, height: 3, fill: "var(--primary)" } }));
        kids.push(h("text", { attrs: { x: PADL + 14, y: 6, "font-size": 9.5, fill: "var(--text-badge)" } }, "Download"));
        kids.push(h("rect", { attrs: { x: PADL + 78, y: 0, width: 10, height: 3, fill: "var(--success)" } }));
        kids.push(h("text", { attrs: { x: PADL + 92, y: 6, "font-size": 9.5, fill: "var(--text-badge)" } }, "Upload"));

        [plotTop, plotBot].forEach(function (yy) {
          kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yy, y2: yy,
            stroke: "var(--divider)", "stroke-width": 1 } }));
        });

        function linePath(key, color) {
          var d = "", pen = false;
          results.forEach(function (r) {
            var v = r[key];
            if (v == null) { pen = false; return; }
            d += (pen ? "L" : "M") + xOf(r.t).toFixed(1) + " " + yOf(v).toFixed(1) + " ";
            pen = true;
          });
          return d ? h("path", { attrs: { fill: "none", stroke: color, "stroke-width": 1.75, d: d.trim() } }) : null;
        }
        var downLine = linePath("down_mbps", "var(--primary)");
        var upLine = linePath("up_mbps", "var(--success)");
        if (downLine) kids.push(downLine);
        if (upLine) kids.push(upLine);
        results.forEach(function (r) {
          kids.push(h("circle", { attrs: { cx: xOf(r.t).toFixed(1), cy: yOf(r.down_mbps).toFixed(1), r: 2.5, fill: "var(--primary)" } }));
          kids.push(h("circle", { attrs: { cx: xOf(r.t).toFixed(1), cy: yOf(r.up_mbps).toFixed(1), r: 2.5, fill: "var(--success)" } }));
        });

        kids.push(h("text", { attrs: { x: 4, y: latTop + LAT_H / 2 + 3, "font-size": 9, fill: "var(--text-badge)" } }, "MS"));
        kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: latBot, y2: latBot,
          stroke: "var(--divider)", "stroke-width": 1 } }));
        var latD = "", penL = false;
        results.forEach(function (r) {
          if (r.latency_ms == null) { penL = false; return; }
          latD += (penL ? "L" : "M") + xOf(r.t).toFixed(1) + " " + latYOf(r.latency_ms).toFixed(1) + " ";
          penL = true;
        });
        if (latD) kids.push(h("path", { attrs: { fill: "none", stroke: "var(--warning)", "stroke-width": 1.5, d: latD.trim() } }));

        if (this.cursor != null && results[this.cursor]) {
          var cx = xOf(results[this.cursor].t);
          kids.push(h("line", { attrs: { x1: cx.toFixed(1), x2: cx.toFixed(1), y1: plotTop, y2: latBot,
            stroke: this.pinned != null ? "var(--primary)" : "var(--text-weak)", "stroke-width": 1 } }));
        }

        var svg = h("svg", { ref: "svg", attrs: { viewBox: "0 0 " + W + " " + (latBot + 4),
          width: W, height: latBot + 4, preserveAspectRatio: "none" } }, kids);

        var nearestIdx = function (evX) {
          var best = 0, bestD = Infinity;
          results.forEach(function (r, i) {
            var d = Math.abs(xOf(r.t) - evX);
            if (d < bestD) { bestD = d; best = i; }
          });
          return best;
        };
        var onMove = function (e) {
          if (self.pinned != null) return;
          var el = self.$refs && self.$refs.graph;
          if (!el || !el.getBoundingClientRect) { self.cursor = results.length - 1; return; }
          var rect = el.getBoundingClientRect();
          if (!rect.width) { self.cursor = results.length - 1; return; }
          var ux = ((e.clientX || 0) - rect.left) * self.width / rect.width;
          self.cursor = nearestIdx(ux);
        };
        var onLeave = function () { if (self.pinned == null) self.cursor = null; };
        var onClick = function (e) {
          if (self.pinned != null) { self.pinned = null; return; }
          onMove(e);
          if (self.cursor == null) self.cursor = results.length - 1;
          self.pinned = self.cursor;
        };

        var tip = null;
        if (this.cursor != null && results[this.cursor]) {
          var r = results[this.cursor];
          var rows = [
            ["Down", r.down_mbps == null ? "—" : r.down_mbps + " Mbps"],
            ["Up", r.up_mbps == null ? "—" : r.up_mbps + " Mbps"],
            ["Latency", r.latency_ms == null ? "—" : r.latency_ms + " ms (±" + (r.jitter_ms == null ? "—" : r.jitter_ms) + ")"],
            ["Carrier", (r.carrier || "—") + " · SIM " + (r.slot == null ? "—" : r.slot)],
            ["Band", r.band == null ? "—" : (r.mode && /NR5G/.test(r.mode) ? "n" : "B") + r.band],
            ["Cell", r.cell_id == null ? "—" : r.cell_id],
            ["RSRP", r.rsrp == null ? "—" : r.rsrp + " dBm"],
            ["SINR", r.sinr == null ? "—" : r.sinr + " dB"],
            ["RSRQ", r.rsrq == null ? "—" : r.rsrq + " dB"]
          ];
          tip = h("div", { staticClass: "mms-tip" }, [
            h("div", { staticClass: "t" }, this.clock(r.t) + (this.pinned != null ? " · pinned" : ""))
          ].concat(rows.map(function (row) {
            return h("div", { staticClass: "mms-tip-row" }, [h("span", row[0]), h("b", row[1])]);
          })));
        }

        return h("div", { ref: "graph", staticClass: "mms-graph",
          on: { mousemove: onMove, mouseleave: onLeave, click: onClick } }, [svg, tip]);
      },
```

Update `renderPage` to call `this.renderGraph(h)` in place of `this.renderHistoryList(h)`:

```js
            this.renderGraph(h)
```

Add the graph/tooltip CSS to `injectStyle`'s `css` string (append before the closing `;`):

```js
          '.mms-graph{position:relative;cursor:crosshair}.mms-graph svg{display:block;width:100%}' +
          '.mms-tip{position:absolute;top:8px;left:8px;pointer-events:none;z-index:5;background:var(--background-card);border:1px solid var(--border);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:8px 10px;min-width:170px}' +
          '.mms-tip .t{font-size:10.5px;color:var(--text-badge);margin-bottom:5px}' +
          '.mms-tip-row{display:flex;justify-content:space-between;gap:14px;font-size:11.5px;padding:1px 0}' +
          '.mms-tip-row b{font-weight:600;color:var(--text-title)}' +
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/speedtest-chunk.test.js`
Expected: all tests pass, including the four new graph tests.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem-speedtest.js test/speedtest-chunk.test.js
git commit -m "Add Speedtest history graph with hover/click detail popover"
```

---

### Task 7: `src/views/mudimodem.js` — add the Speedtest tab

**Files:**
- Modify: `src/views/mudimodem.js`
- Modify: `test/chunk.test.js`

**Interfaces:**
- Consumes: `src/views/mudimodem-speedtest.js` (Task 6) as a lazy-loaded chunk, fetched the same way `mudimodem-tracking.js` already is.
- Produces: `data.speedtestComp`/`speedtestLoading`/`speedtestErr`, `methods.openSpeedtest`/`loadSpeedtest`, a `["speedtest", "Speedtest"]` entry in `TABS`.

- [ ] **Step 1: Write the failing test**

Append to `test/chunk.test.js` (near the existing `'AT console is an in-page tab...'` test, same file, same conventions):

```js
test('Speedtest is an in-page tab: lazy-loads its own chunk, embedded like Tracking', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /gl-sdk4-ui-mudimodem-speedtest\.common\.js/, 'lazy-loads the speedtest chunk');
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'speedtest';
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Loading the speed test/, 'loading state before the chunk arrives');
  const fake = { name: 'mudimodem-speedtest', render() {} };
  vm.speedtestComp = fake;
  const node = walk(c.render.call(vm, h)).find((n) => n.tag === fake);
  assert.ok(node, 'renders the loaded speedtest component as a child vnode');
  assert.strictEqual(node.data.props.embedded, true, 'passes embedded:true');
});

test('Speedtest tab appears in the tab bar', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  const on = walk(c.render.call(vm, h))
    .filter((n) => n.data.staticClass && /\bmm-tab\b/.test(n.data.staticClass))
    .map(textOf);
  assert.ok(on.includes('Speedtest'), 'Speedtest tab rendered alongside the others');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/chunk.test.js`
Expected: FAIL — no `speedtestComp`/`openSpeedtest`, no `speedtest` tab yet.

- [ ] **Step 3: Wire up the tab**

In `src/views/mudimodem.js`, add to `data()` alongside the existing `consoleComp`/`consoleLoading`/`consoleErr` fields (around line 62-64):

```js
      // Speedtest tab: same lazy-chunk pattern as Tracking/AT console.
      speedtestComp: null,
      speedtestLoading: false,
      speedtestErr: "",
```

Add methods alongside `loadTracking`/`openTracking` (near line 297-317), following the exact same shape:

```js
    // Open the in-page Speedtest tab, lazy-loading its chunk on first use.
    openSpeedtest() { this.tab = "speedtest"; this.loadSpeedtest(); },
    loadSpeedtest() {
      var self = this;
      if (this.speedtestComp || this.speedtestLoading) return;
      if (typeof window === "undefined" || !window.$axios) return;
      this.speedtestLoading = true; this.speedtestErr = "";
      window.$axios.get("/views/gl-sdk4-ui-mudimodem-speedtest.common.js?_t=" + Date.now())
        .then(function (res) {
          var module = { exports: {} };            // eslint-disable-line no-unused-vars
          var comp = eval(res.data);
          if (!comp || typeof comp.render !== "function") throw new Error("bad chunk");
          self.speedtestComp = comp; self.speedtestLoading = false;
        })
        .catch(function (e) {
          self.speedtestLoading = false;
          self.speedtestErr = (e && (e.message || e.type)) || "could not load the speed test";
        });
    },
```

Update the `TABS` array (around line 1584-1585) to add the entry:

```js
    var TABS = [["diag", "Diagnostics"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"], ["tracking", "Tracking"], ["speedtest", "Speedtest"]];
```

Update the tab-bar click handler (around line 1589) to special-case `speedtest` like `tracking`:

```js
        on: { click: function () {
          if (t[0] === "tracking") self.openTracking();
          else if (t[0] === "speedtest") self.openSpeedtest();
          else self.tab = t[0];
        } }
```

Add a panel branch alongside the existing `tracking`/`at` branches (around line 1612-1629):

```js
    } else if (this.tab === "speedtest") {
      if (this.speedtestComp) {
        panel = h(this.speedtestComp, { props: { embedded: true } });
      } else {
        panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" },
          this.speedtestErr ? "Couldn't load the speed test: " + this.speedtestErr
            : "Loading the speed test…")]);
      }
```

(Insert this `else if` branch before the final `} else {` "Unknown tab." fallback.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/chunk.test.js`
Expected: all tests pass, including the two new Speedtest ones. Then run the full suite: `node --test test/` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Add Speedtest tab to the main Modem page (lazy-loaded, embedded like Tracking)"
```

---

### Task 8: `tools/build.sh` + `tools/deploy.sh` — wire up the new files

**Files:**
- Modify: `tools/build.sh`
- Modify: `tools/deploy.sh`

**Interfaces:**
- Consumes: all files from Tasks 1-7.
- Produces: `build/gl-sdk4-ui-mudimodem-speedtest.common.js.gz` and the deployed/enabled `mudimodem-speedtestd` service, ready for Task 9's `verify.sh`.

- [ ] **Step 1: Add the new chunk to the build**

In `tools/build.sh`, append after the existing console-chunk line:

```sh
gzip -9 -n -c src/views/mudimodem-speedtest.js > build/gl-sdk4-ui-mudimodem-speedtest.common.js.gz
cp src/menu/mudimodem-speedtest.json build/mudimodem-speedtest.json 2>/dev/null || true
```

- [ ] **Step 2: Run the build and confirm the artifact exists**

Run: `./tools/build.sh`
Expected: `build/gl-sdk4-ui-mudimodem-speedtest.common.js.gz` listed in the `ls -l build/` output at the end.

- [ ] **Step 3: Add the deploy steps**

In `tools/deploy.sh`, after the existing "console chunk + AT library + AT tool deployed" block (and before the watchdog block, since it belongs with the other view-chunk pushes), add:

```sh
# Phase: Speedtest chunk + menu + own-script runner + optional scheduler.
ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem-speedtest.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem-speedtest.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/share/oui/menu.d/mudimodem-speedtest.json' \
  < src/menu/mudimodem-speedtest.json
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /usr/lib/mudimodem && cat > /usr/lib/mudimodem/mudimodem-speedtest.py && chmod 0755 /usr/lib/mudimodem/mudimodem-speedtest.py' \
  < tools/mudimodem-speedtest.py
echo "speedtest chunk + menu + runner deployed"

if [ -f src/sbin/mudimodem-speedtestd ]; then
  ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/sbin/mudimodem-speedtestd && chmod 0755 /usr/sbin/mudimodem-speedtestd' \
    < src/sbin/mudimodem-speedtestd
  ssh -o BatchMode=yes "root@$HOST" 'cat > /etc/init.d/mudimodem-speedtestd && chmod 0755 /etc/init.d/mudimodem-speedtestd' \
    < src/etc/init.d/mudimodem-speedtestd
  ssh -o BatchMode=yes "root@$HOST" '/etc/init.d/mudimodem-speedtestd enable; /etc/init.d/mudimodem-speedtestd restart' 2>/dev/null || true
  echo "speedtest scheduler deployed + service (re)started (off by default)"
fi
```

Add the new paths to the existing `/etc/sysupgrade.conf` registration loop's `for p in ...` list (append these lines to the existing list, before the closing `; do`):

```sh
  /www/views/gl-sdk4-ui-mudimodem-speedtest.common.js.gz \
  /usr/share/oui/menu.d/mudimodem-speedtest.json \
  /usr/lib/mudimodem/mudimodem-speedtest.py \
  /usr/sbin/mudimodem-speedtestd \
  /etc/init.d/mudimodem-speedtestd \
```

Note: the backend deploy block (`src/rpc/mudimodem` → `/usr/lib/oui-httpd/rpc/mudimodem` + nginx restart) already exists from earlier phases and needs no change — it deploys whatever is currently in `src/rpc/mudimodem`, which now includes the Task 4 methods.

- [ ] **Step 4: Deploy and confirm no errors**

Run: `./tools/deploy.sh`
Expected: output ends with `sysupgrade.conf registered` / `deployed to mudi`, no SSH or file-transfer errors, and includes the new `speedtest chunk + menu + runner deployed` / `speedtest scheduler deployed + service (re)started (off by default)` lines.

- [ ] **Step 5: Commit**

```bash
git add tools/build.sh tools/deploy.sh
git commit -m "Wire the Speedtest chunk, backend, and scheduler into build/deploy"
```

---

### Task 9: `tools/verify.sh` — verification, including a live smoke test

**Files:**
- Modify: `tools/verify.sh`

**Interfaces:**
- Consumes: the fully deployed feature from Task 8.
- Produces: an on-device assertion pass covering files, menu JSON, chunk eval, backend round trip, scheduler service state, and one real end-to-end speed test.

⚠️ Step 3 below performs one REAL speed test against the live cellular link (per the design's fixed ~20 MiB/~8 MiB sizes) — this uses real cellular data, same tier of live check as the existing AT-tool smoke test (verify.sh step 8d). Do not add a loop around it or run it more than once per verify pass.

- [ ] **Step 1: Add the static checks**

Append to `tools/verify.sh`, following the existing numbered-section convention (after the `at_console` validator section, i.e. as a new "10."):

```sh
echo "10. Speedtest: files present, menu valid, chunk evals"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-speedtest.common.js.gz' \
  || fail "speedtest chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem-speedtest.json' \
  || fail "speedtest menu json missing"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\"); local f=io.open(\"/usr/share/oui/menu.d/mudimodem-speedtest.json\"); c.decode(f:read(\"*a\"))"' \
  || fail "speedtest menu json does not parse (would break ui.get_menu_list for EVERY page)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/lib/mudimodem/mudimodem-speedtest.py' \
  || fail "speedtest runner script missing or not executable"

STBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-speedtest.common.js?_t=1" | gzip -dc')
printf '%s' "$STBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-speedtest"){console.error("FAIL: speedtest chunk eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    if(!/"run_speedtest"/.test(s)){console.error("FAIL: does not call run_speedtest");process.exit(1);}
    console.log("   speedtest chunk eval OK ->", c.name);
  })' || fail "speedtest chunk eval failed"

echo "10a. Speedtest backend round trip (on-device)"
ssh -o BatchMode=yes "root@$HOST" 'cat > /tmp/mm-st.test.lua' < test/backend-speedtest.test.lua
ssh -o BatchMode=yes "root@$HOST" 'MUDIMODEM_SPEEDTEST_HIST=/tmp/mmst-hist.jsonl MUDIMODEM_ST_SCHEDULE=/tmp/mmst-sched.json lua /tmp/mm-st.test.lua; rc=$?; rm -f /tmp/mm-st.test.lua; exit $rc' \
  || fail "speedtest backend test failed on-device"

echo "10b. Speedtest scheduler service present (off by default)"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/sbin/mudimodem-speedtestd' \
  || fail "speedtestd not installed (run ./tools/deploy.sh)"
ssh -o BatchMode=yes "root@$HOST" 'pgrep -f mudimodem-speedtestd >/dev/null' \
  || fail "speedtestd process not running (/etc/init.d/mudimodem-speedtestd start)"
```

- [ ] **Step 2: Run the static checks**

Run: `./tools/verify.sh`
Expected: sections 1-10b pass (the file/menu/eval/backend/service checks). Section 10c (below) not yet added.

- [ ] **Step 3: Add the live end-to-end smoke test**

Append immediately after step 10b's block:

```sh
echo "10c. LIVE: one real speed test end-to-end over Cellular"
ssh -o BatchMode=yes "root@$HOST" 'rm -f /tmp/mudimodem/speedtest-status.json'
ssh -o BatchMode=yes "root@$HOST" \
  'python3 /usr/lib/mudimodem/mudimodem-speedtest.py --trigger manual --iface cellular --hist /tmp/mmv-speedtests.jsonl'
ssh -o BatchMode=yes "root@$HOST" 'test -s /tmp/mmv-speedtests.jsonl' \
  || fail "live speed test produced no result"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\");local f=io.open(\"/tmp/mmv-speedtests.jsonl\");local d=c.decode(f:read(\"*l\"));assert(d.down_mbps and d.down_mbps>0,\"down_mbps\");assert(d.up_mbps and d.up_mbps>0,\"up_mbps\");assert(d.latency_ms,\"latency_ms\");assert(d.carrier,\"carrier\")"' \
  || fail "live speed test result missing expected fields (down_mbps/up_mbps/latency_ms/carrier)"
RESULT=$(ssh -o BatchMode=yes "root@$HOST" 'cat /tmp/mmv-speedtests.jsonl')
echo "   live result: $RESULT"
ssh -o BatchMode=yes "root@$HOST" 'rm -f /tmp/mmv-speedtests.jsonl'

echo "ALL CHECKS PASSED"
```

(This block runs the runner script directly with an isolated `--hist` path — not through the RPC backend/detached-spawn path — so `verify.sh` gets a synchronous pass/fail rather than needing to poll a background process. The RPC spawn path itself is exercised by the frontend in normal use and by test 10a's `run_speedtest` invalid-iface-refusal check.)

Note: remove the old bare `echo "ALL CHECKS PASSED"` line that currently sits at the end of the file (it's superseded by the one just added at the end of this new block).

- [ ] **Step 4: Run the full verify suite**

Run: `./tools/verify.sh`
Expected: `ALL CHECKS PASSED`, with section 10c printing a real `down_mbps`/`up_mbps`/`latency_ms`/`carrier` line for whichever SIM is currently active.

- [ ] **Step 5: Run the complete local test suite once more as a final gate**

Run: `node --test test/` and `python3 test/speedtest.test.py`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add tools/verify.sh
git commit -m "Add Speedtest verification: files/menu/eval, backend round trip, scheduler state, live smoke test"
```

---

## Out of scope (carried over from the design spec)

Live-updating gauge mid-test; iperf3 as a test method; per-test size selector; time-based (vs count-based) retention; multi-SIM comparison views; VPN tunnels as selectable interfaces; a per-schedule interface setting; `/etc/sysupgrade.conf` full-installer registration beyond the idempotent list already maintained by `deploy.sh`.
