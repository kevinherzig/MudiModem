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
