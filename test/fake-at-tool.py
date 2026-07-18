#!/usr/bin/env python3
"""Stands in for mudimodem-at.py in backend tests: emits per-step envelope
frames and echoes argv so the test can assert clamping/quoting. No modem.

Channel-level branches (first AT cmd triggers them):
  __BUSY__     -> MM-AT:busy:7          (2-field, channel-level)
  __OPENFAIL__ -> MM-AT:openfail:8
  __GARBAGE__  -> a line with no MM-AT: prefix (envelope parse failure)
  __WEIRD__    -> MM-AT:weird:9:1/1     (matches per-step shape, unknown status)
Per-step: every AT cmd gets MM-AT:ok:5:<idx>/<count> + ARGS:<full argv>, EXCEPT
a cmd containing __ERR__ -> MM-AT:error:5:<idx>/<count> and STOP (stop-on-error).
"""
import sys

argv = sys.argv[1:]
argv_str = " ".join(argv)
# The AT commands are the positional args (everything that isn't a flag or its
# value). They all start with "AT"; flags start with "--" or are numeric.
cmds = [a for a in argv if a.upper().startswith("AT")]

if "__BUSY__" in argv_str:
    print("MM-AT:busy:7")
elif "__OPENFAIL__" in argv_str:
    print("MM-AT:openfail:8")
elif "__GARBAGE__" in argv_str:
    print("Traceback (most recent call last):")
elif "__WEIRD__" in argv_str:
    print("MM-AT:weird:9:1/1")
    print("ARGS:" + argv_str)
else:
    count = len(cmds)
    for idx, c in enumerate(cmds, 1):
        if "__ERR__" in c:
            print("MM-AT:error:5:%d/%d" % (idx, count))
            print("ERROR")
            break
        print("MM-AT:ok:5:%d/%d" % (idx, count))
        print("ARGS:" + argv_str)
