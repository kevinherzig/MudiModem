#!/usr/bin/env python3
"""Stands in for mudimodem-at.py in backend tests: prints a valid envelope and
echoes its argv so the test can assert clamping/quoting. No modem, no locks.

Branches on the AT cmd (passed through argv unchanged for metachar-free
strings) so the test can exercise at_console's error/fallback paths without a
real modem:
  __BUSY__     -> MM-AT:busy:7          (channel busy)
  __OPENFAIL__ -> MM-AT:openfail:8      (port open failure)
  __GARBAGE__  -> a line with no MM-AT: prefix (envelope parse failure)
  __WEIRD__    -> MM-AT:weird:9         (matches the pattern, unknown status)
  otherwise    -> MM-AT:ok:5 + ARGS:... (existing happy path)
"""
import sys

argv_str = " ".join(sys.argv[1:])

if "__BUSY__" in argv_str:
    print("MM-AT:busy:7")
elif "__OPENFAIL__" in argv_str:
    print("MM-AT:openfail:8")
elif "__GARBAGE__" in argv_str:
    print("Traceback (most recent call last):")
elif "__WEIRD__" in argv_str:
    print("MM-AT:weird:9")
else:
    print("MM-AT:ok:5")
    print("ARGS:" + argv_str)
