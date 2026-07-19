#!/usr/bin/env python3
"""Hermetic tests for tools/mudimodem-lib. No network: a temp dir served via
file:// URLs (curl reads file://), temp cache, model-guard bypassed."""
import gzip, importlib.util, json, os, subprocess, sys, tempfile, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
TOOL = os.path.join(ROOT, "tools", "mudimodem-lib")


def run(mode, url_dir, cache, extra_env=None):
    env = dict(os.environ)
    env["MUDIMODEM_LIB_URL"] = "file://" + url_dir
    env["MUDIMODEM_CACHE"] = cache
    env["MUDIMODEM_SKIP_MODEL_GUARD"] = "1"
    if extra_env:
        env.update(extra_env)
    p = subprocess.run([sys.executable, TOOL, mode], capture_output=True, text=True, env=env)
    return p.returncode, json.loads(p.stdout)


def write_cache(path, revision, n=1):
    with gzip.open(path, "wb") as f:
        f.write(json.dumps({"version": 1, "revision": revision,
                            "entries": [{"id": "x"} for _ in range(n)]}).encode())


def write_remote(url_dir, revision, n=1):
    os.makedirs(url_dir, exist_ok=True)
    with open(os.path.join(url_dir, "version.json"), "w") as f:
        json.dump({"revision": revision, "count": n}, f)
    with open(os.path.join(url_dir, "at-library.json"), "w") as f:
        json.dump({"version": 1, "revision": revision,
                   "entries": [{"id": "e%d" % i} for i in range(n)]}, f)


class LibToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.url = os.path.join(self.tmp, "dist")
        self.cache = os.path.join(self.tmp, "at-library.json.gz")

    def test_check_up_to_date(self):
        write_cache(self.cache, "abc123")
        write_remote(self.url, "abc123")
        rc, r = run("check", self.url, self.cache)
        self.assertTrue(r["checked"]); self.assertFalse(r["update_available"])
        self.assertEqual(r["local_revision"], "abc123")
        self.assertEqual(r["remote_revision"], "abc123")

    def test_check_update_available(self):
        write_cache(self.cache, "old111")
        write_remote(self.url, "new222")
        rc, r = run("check", self.url, self.cache)
        self.assertTrue(r["checked"]); self.assertTrue(r["update_available"])

    def test_check_offline_fail_silent(self):
        write_cache(self.cache, "abc123")           # remote dir absent -> curl fails
        rc, r = run("check", self.url, self.cache)
        self.assertFalse(r["checked"]); self.assertFalse(r["update_available"])
        self.assertIn("error", r); self.assertEqual(r["local_revision"], "abc123")

    def test_check_no_local_cache(self):
        write_remote(self.url, "new222")            # no cache file
        rc, r = run("check", self.url, self.cache)
        self.assertEqual(r["local_revision"], "unknown")
        self.assertTrue(r["update_available"])

    def test_refresh_writes_cache(self):
        write_remote(self.url, "fresh9", n=3)
        rc, r = run("refresh", self.url, self.cache)
        self.assertEqual(rc, 0); self.assertTrue(r["ok"])
        self.assertEqual(r["revision"], "fresh9"); self.assertEqual(r["count"], 3)
        with gzip.open(self.cache) as f:
            self.assertEqual(json.load(f)["revision"], "fresh9")

    def test_refresh_rejects_empty_entries(self):
        os.makedirs(self.url, exist_ok=True)
        with open(os.path.join(self.url, "at-library.json"), "w") as f:
            json.dump({"version": 1, "revision": "x", "entries": []}, f)
        rc, r = run("refresh", self.url, self.cache)
        self.assertNotEqual(rc, 0); self.assertFalse(r["ok"]); self.assertIn("sanity", r["error"])

    def test_refresh_model_guard_refuses(self):
        write_remote(self.url, "fresh9")
        rc, r = run("refresh", self.url, self.cache, extra_env={"MUDIMODEM_SKIP_MODEL_GUARD": "0"})
        # dev box has no /proc/device-tree/model -> not E5800 -> refuse
        self.assertFalse(r["ok"]); self.assertIn("E5800", r["error"])

    def test_check_malformed_remote_fail_silent(self):
        write_cache(self.cache, "abc123")
        os.makedirs(self.url, exist_ok=True)
        with open(os.path.join(self.url, "version.json"), "w") as f:
            f.write("[]")                       # valid JSON, wrong shape
        rc, r = run("check", self.url, self.cache)
        self.assertFalse(r["checked"]); self.assertFalse(r["update_available"])
        self.assertIn("error", r); self.assertEqual(r["local_revision"], "abc123")

    def test_check_truncated_local_cache_is_unknown(self):
        with open(self.cache, "wb") as f:
            f.write(b"\x1f\x8b\x08\x00broken-not-a-real-gzip")   # truncated gz
        write_remote(self.url, "new222")
        rc, r = run("check", self.url, self.cache)
        self.assertEqual(r["local_revision"], "unknown")         # must not crash
        self.assertTrue(r["update_available"])

    def test_refresh_missing_version_rejected(self):
        os.makedirs(self.url, exist_ok=True)
        with open(os.path.join(self.url, "at-library.json"), "w") as f:
            json.dump({"revision": "x", "entries": [{"id": "e"}]}, f)   # no "version"
        rc, r = run("refresh", self.url, self.cache)
        self.assertFalse(r["ok"]); self.assertIn("sanity", r["error"])

    def test_refresh_keeps_cache_world_readable(self):
        write_remote(self.url, "fresh9", n=2)
        rc, r = run("refresh", self.url, self.cache)
        self.assertTrue(r["ok"])
        mode = os.stat(self.cache).st_mode & 0o777
        self.assertEqual(mode & 0o044, 0o044, "cache must stay group/other-readable, got %o" % mode)

    def test_refresh_rejects_oversized(self):
        os.makedirs(self.url, exist_ok=True)
        big = {"version": 1, "revision": "big1", "entries": [{"id": "e", "pad": "x" * (1 << 21)}]}
        with open(os.path.join(self.url, "at-library.json"), "w") as f:
            json.dump(big, f)                   # > 1 MiB
        rc, r = run("refresh", self.url, self.cache)
        self.assertFalse(r["ok"]); self.assertIn("large", r["error"])

    def test_check_missing_curl_fail_silent(self):
        write_cache(self.cache, "abc123")
        write_remote(self.url, "abc123")
        rc, r = run("check", self.url, self.cache,
                    extra_env={"MUDIMODEM_CURL": "/nonexistent-curl-xyz"})
        self.assertFalse(r["checked"]); self.assertIn("error", r)   # OSError, not a crash
        self.assertEqual(r["local_revision"], "abc123")

    def test_refresh_missing_curl_errors_cleanly(self):
        write_remote(self.url, "fresh9")
        rc, r = run("refresh", self.url, self.cache,
                    extra_env={"MUDIMODEM_CURL": "/nonexistent-curl-xyz"})
        self.assertFalse(r["ok"]); self.assertIn("fetch failed", r["error"])


if __name__ == "__main__":
    unittest.main()
