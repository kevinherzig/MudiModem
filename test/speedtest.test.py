#!/usr/bin/env python3
"""Unit tests for tools/mudimodem-speedtest.py's pure parts.
Run: python3 test/speedtest.test.py"""
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ST_SRC = os.path.join(HERE, "..", "tools", "mudimodem-speedtest.py")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None:
        # Handle files without .py extension (Python 3.13+)
        loader = importlib.machinery.SourceFileLoader(name, path)
        spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


st = load(ST_SRC, "mudimodem_speedtest")

STD_SRC = os.path.join(HERE, "..", "src", "sbin", "mudimodem-speedtestd")
std = load(STD_SRC, "mudimodem_speedtestd")


class Mbps(unittest.TestCase):
    def test_bytes_per_sec_to_mbps(self):
        self.assertEqual(st.mbps(1_250_000), 10.0)   # 1.25 MB/s = 10 Mbps

    def test_none_stays_none(self):
        self.assertIsNone(st.mbps(None))


class ParseArgs(unittest.TestCase):
    def test_trailing_trigger_flag_raises_systemexit_not_indexerror(self):
        with self.assertRaises(SystemExit):
            st.parse_args(["--trigger"])

    def test_trailing_iface_flag_raises_systemexit_not_indexerror(self):
        with self.assertRaises(SystemExit):
            st.parse_args(["--iface"])


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


import http.server
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
        self.server.server_close()

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


class IsDue(unittest.TestCase):
    def test_disabled_never_due(self):
        self.assertFalse(std.is_due({"enabled": False, "interval_seconds": 60, "last_run": 0}, 10 ** 9))

    def test_due_when_interval_elapsed(self):
        cfg = {"enabled": True, "interval_seconds": 3600, "last_run": 0}
        self.assertTrue(std.is_due(cfg, 3600 * 1000))
        self.assertFalse(std.is_due(cfg, 3600 * 1000 - 1))

    def test_zero_interval_never_due(self):
        self.assertFalse(std.is_due({"enabled": True, "interval_seconds": 0, "last_run": 0}, 10 ** 9))


class AttemptRun(unittest.TestCase):
    def test_write_last_run_happens_even_when_subprocess_times_out(self):
        """A hung/timed-out scheduled run must still be recorded as attempted --
        otherwise the daemon would retry it on its very next 60s wake, looping
        a stuck run forever and burning cellular data."""
        calls = []

        def fake_run(*a, **kw):
            raise std.subprocess.TimeoutExpired(cmd="x", timeout=120)

        def fake_write_last_run(path, now):
            calls.append((path, now))

        orig_run, orig_write = std.subprocess.run, std.write_last_run
        std.subprocess.run = fake_run
        std.write_last_run = fake_write_last_run
        try:
            std.attempt_run("python3", "/fake/bin.py", 120)
        finally:
            std.subprocess.run = orig_run
            std.write_last_run = orig_write

        self.assertEqual(len(calls), 1, "write_last_run must be called even after a timeout")


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

    def test_write_last_run_preserves_concurrent_edits(self):
        """Prove read-modify-write: concurrent edits to enabled/interval_seconds
        made while a test was running must not be clobbered."""
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            # Start with enabled=true, interval_seconds=3600
            f.write(json.dumps({"enabled": True, "interval_seconds": 3600, "last_run": 0}))
            path = f.name
        try:
            # Simulate a concurrent edit: the user disables the schedule via the UI
            # while the test is running
            with open(path, "w") as f:
                json.dump({"enabled": False, "interval_seconds": 3600, "last_run": 0}, f)

            # Now write_last_run() is called after the test finishes
            # It should preserve enabled:false (the concurrent edit), not clobber it back to true
            now = 999999
            std.write_last_run(path, now)

            # Verify the result preserves the concurrent edit
            result = std.read_schedule(path)
            self.assertFalse(result["enabled"], "enabled should still be False after concurrent edit")
            self.assertEqual(result["last_run"], now, "last_run should be updated to the new timestamp")
            self.assertEqual(result["interval_seconds"], 3600, "interval_seconds should be preserved")
        finally:
            os.remove(path)


if __name__ == "__main__":
    unittest.main()
