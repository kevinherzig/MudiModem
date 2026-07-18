#!/usr/bin/env python3
"""Unit tests for mudimodem-collectd's pure parts (build_sample, trim).
Run: python3 -m unittest test.collectd.test  (or python3 test/collectd.test.py)"""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src", "sbin", "mudimodem-collectd")
spec = importlib.util.spec_from_loader("collectd", loader=None)
collectd = importlib.util.module_from_spec(spec)
with open(SRC) as f:
    exec(compile(f.read(), SRC, "exec"), collectd.__dict__)

# Real captured shapes (box, 2026-07-17).
MODEM = {"modems": [{"bus": "cpu", "status": 0, "current_sim_slot": "1"}]}
NET = {"networks": [
    {"bus": "cpu", "slot": "1", "cell_info": {
        "id": "D43B70D", "band": 2, "mode": "LTE FDD",
        "rsrp": "-118", "rsrp_level": 1, "rsrq": "-16", "rsrq_level": 1,
        "rssi": "-88", "sinr": "10", "sinr_level": 3,
        "dl_bandwidth": "5MHz", "tx_channel": "8701"}},
    {"bus": "cpu", "slot": "2", "cell_info": {
        "id": "AD4B60A", "band": 2, "mode": "LTE FDD", "rsrp": "-113"}}]}
SIMS = {"sims": [
    {"slot": "1", "bus": "cpu", "carrier": "T-Mobile"},
    {"slot": "2", "bus": "cpu", "carrier": "AT&T"}]}


class BuildSample(unittest.TestCase):
    def test_active_slot_cell_and_carrier(self):
        s = collectd.build_sample(MODEM, NET, SIMS, t=1000)
        self.assertEqual(s["slot"], "1")
        self.assertEqual(s["id"], "D43B70D")        # active slot's cell, not slot 2
        self.assertEqual(s["carrier"], "T-Mobile")
        self.assertEqual(s["tx_channel"], "8701")

    def test_metric_strings_parsed_to_numbers(self):
        s = collectd.build_sample(MODEM, NET, SIMS, t=1000)
        self.assertEqual(s["rsrp"], -118)           # "-118" -> int
        self.assertEqual(s["sinr"], 10)
        self.assertEqual(s["rsrp_level"], 1)         # level buckets preserved

    def test_active_slot_2_picks_the_other_cell(self):
        modem2 = {"modems": [{"bus": "cpu", "current_sim_slot": "2"}]}
        s = collectd.build_sample(modem2, NET, SIMS, t=1000)
        self.assertEqual(s["id"], "AD4B60A")
        self.assertEqual(s["carrier"], "AT&T")

    def test_unregistered_active_slot_yields_null_metrics_not_none(self):
        net = {"networks": [{"bus": "cpu", "slot": "1"}]}   # no cell_info
        s = collectd.build_sample(MODEM, net, SIMS, t=1000)
        self.assertIsNotNone(s, "still a sample (gap), not dropped")
        self.assertIsNone(s["rsrp"])
        self.assertEqual(s["slot"], "1")

    def test_no_active_slot_returns_none(self):
        self.assertIsNone(collectd.build_sample({"modems": [{}]}, NET, SIMS))
        self.assertIsNone(collectd.build_sample({}, NET, SIMS))


class Trim(unittest.TestCase):
    def _write(self, path, ts):
        with open(path, "w") as f:
            for t in ts:
                f.write(json.dumps({"t": t, "rsrp": -100}) + "\n")

    def test_drops_lines_older_than_max_age(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "s.jsonl")
            self._write(p, [1000, 5000, 9000])       # ref 10000, max_age 5000 -> keep >=5000
            collectd.trim(p, max_age_ms=5000, max_lines=100, ref_ms=10000)
            kept = [json.loads(l)["t"] for l in open(p)]
            self.assertEqual(kept, [5000, 9000])

    def test_caps_line_count(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "s.jsonl")
            self._write(p, list(range(1, 11)))
            collectd.trim(p, max_age_ms=10 ** 12, max_lines=3, ref_ms=100)
            kept = [json.loads(l)["t"] for l in open(p)]
            self.assertEqual(kept, [8, 9, 10])       # last 3

    def test_skips_malformed_lines_and_tolerates_missing_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "s.jsonl")
            with open(p, "w") as f:
                f.write('{"t":9000}\n')
                f.write("not json\n")
                f.write('{"t":9500}\n')
            collectd.trim(p, max_age_ms=5000, max_lines=100, ref_ms=10000)
            kept = [json.loads(l)["t"] for l in open(p)]
            self.assertEqual(kept, [9000, 9500])
            collectd.trim(os.path.join(d, "absent.jsonl"), 5000, 100)  # no raise


if __name__ == "__main__":
    unittest.main()
