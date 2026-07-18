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

    def test_over_256_char_rejected(self):
        self.assertTrue(any("256" in m for m in self.errs(base(cmd="AT+" + "X" * 254))))   # 257
        self.assertTrue(any("256" in m for m in self.errs(base(steps=["AT", "A" + "X" * 256]))))  # step 2 = 257

    def test_exactly_8_steps_and_256_char_accepted(self):
        self.assertEqual(self.errs(base(steps=["AT"] * 8)), [])
        self.assertEqual(self.errs(base(cmd="AT+" + "X" * 253)), [])   # exactly 256


if __name__ == "__main__":
    unittest.main()
