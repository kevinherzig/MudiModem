#!/usr/bin/env python3
"""Stands in for mudimodem-lib in backend tests: prints canned JSON per mode.
  check         -> a check envelope with update_available true
  refresh       -> an ok refresh envelope
  __GARBAGE__…  -> (any other first arg) non-JSON, to test the parse-fail path
"""
import json, sys
mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode == "check":
    print(json.dumps({"local_revision": "old111", "remote_revision": "new222",
                      "update_available": True, "checked": True}))
elif mode == "refresh":
    print(json.dumps({"ok": True, "revision": "new222", "count": 7}))
else:
    print("not json")
