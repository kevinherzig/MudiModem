#!/usr/bin/env python3
"""Stands in for mudimodem-at.py in backend tests: prints a valid envelope and
echoes its argv so the test can assert clamping/quoting. No modem, no locks."""
import sys
print("MM-AT:ok:5")
print("ARGS:" + " ".join(sys.argv[1:]))
