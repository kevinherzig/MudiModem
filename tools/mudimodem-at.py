#!/usr/bin/env python3
"""MudiModem's own AT channel — an independent, compile-free AT client.

Talks to the modem over /dev/at_mdm0, a free, world-accessible AT port SEPARATE
from GL's /dev/smd9 (which GL's modem_AT holds). Because it's our own channel,
responses never cross with GL's background polling — the failure that garbles
`ubus call modem.CPU.AT` when the modem is churning (reference §8).

CPython stdlib only (os, select). No pyserial, no compiler — the box ships
Python 3.11. This is the intended transport for the Phase 3 AT console.

Usage:
    python3 mudimodem-at.py 'AT+QNWPREFCFG="nr5g_band"' 'ATI'      # CLI
    from mudimodem_at import ATChannel                            # module

⚠️ Caveats (reference §8):
  - Open BLOCKING: the SMD channel returns EBUSY on a non-blocking write.
  - /dev/at_mdm0 is NOT a tty, so no termios setup (it's a raw byte stream).
  - No sub_id: the direct port operates in the ACTIVE subscription's context
    only. For per-SIM data (the other SIM's policy_band) use GL's modem.CPU.AT.
  - Writes hit modem NV the same as any AT path — and GL re-applies its own
    stored config on cellular_manager restart, so raw-AT band writes are not
    durable on their own (reference §9).
"""
import os, select, sys, time

DEFAULT_PORT = "/dev/at_mdm0"
# Unsolicited result codes that arrive unprompted, unrelated to our command.
URC_PREFIXES = ("RDY", "+CPIN:", "+QUSIM:", "+QUSIM", "+CPINDS:", "+QIND:",
                "+CFUN:", "+CGEV:", "+QNETDEVSTATUS:", "POWERED DOWN")


class ATChannel:
    def __init__(self, port=DEFAULT_PORT):
        # BLOCKING open (non-blocking writes return EBUSY on this SMD channel);
        # reads are gated by select() for the timeout.
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass

    def _drain(self):
        while select.select([self.fd], [], [], 0)[0]:
            try:
                if not os.read(self.fd, 4096):
                    break
            except OSError:
                break

    def send(self, cmd, timeout=8):
        """Send one AT command, return the raw response text (incl. OK/ERROR)."""
        self._drain()
        os.write(self.fd, (cmd + "\r").encode())
        buf, deadline = b"", time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([self.fd], [], [], max(0, deadline - time.time()))
            if not r:
                break
            try:
                chunk = os.read(self.fd, 4096)
            except OSError:
                break
            if not chunk:
                continue
            buf += chunk
            t = buf.decode(errors="replace")
            if any(k in t for k in ("\nOK\r", "\nERROR\r", "+CME ERROR", "+CMS ERROR")):
                break
        return buf.decode(errors="replace")

    def lines(self, cmd, timeout=8):
        """send(), returned as clean lines with URCs filtered out."""
        resp = self.send(cmd, timeout)
        out = [l.strip() for l in resp.replace("\r", "\n").split("\n") if l.strip()]
        return [l for l in out if not l.startswith(URC_PREFIXES)]


def main(argv):
    ch = ATChannel()
    try:
        for cmd in argv:
            t0 = time.time()
            for l in ch.lines(cmd):
                print("    " + l)
            print(">>> %s   (%.2fs)" % (cmd, time.time() - t0))
    finally:
        ch.close()


if __name__ == "__main__":
    main(sys.argv[1:])
