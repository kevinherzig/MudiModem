#!/usr/bin/env python3
"""MudiModem's own AT channel — an independent, compile-free AT client.

Talks to the modem over /dev/at_mdm0, a free, world-accessible AT port SEPARATE
from GL's /dev/smd9 (which GL's modem_AT holds). Because it's our own channel,
responses never cross with GL's background polling — the failure that garbles
`ubus call modem.CPU.AT` when the modem is churning (reference §8).

CPython stdlib only (os, select, fcntl, signal). No pyserial, no compiler — the
box ships Python 3.11. This is the transport for the Phase 3 AT console.

Backend usage (one command per invocation):
    python3 mudimodem-at.py --envelope --timeout 8 'AT+QSPN'
  stdout line 1:  MM-AT:<status>:<elapsed_ms>     status: ok|timeout|busy|openfail
  then:           the raw response, verbatim (URCs included; may be empty)
  exit code:      0 ok/timeout, 2 busy, 3 openfail

Serialization + GL coexistence:
  - fcntl.flock on /tmp/mudimodem/at.lock serializes concurrent invocations
    (nginx has 4 workers). Lock not acquired within --lock-wait (5 s) => busy.
  - While sending, every `gl_modem` process (GL's AT traffic source) is
    SIGSTOPped, and SIGCONTed in a finally. On startup, any gl_modem already
    in state T is CONTed first — recovery from a killed predecessor. modem_AT
    and cellular_manager are deliberately left alone (spec 2026-07-18 §2).
  - /dev/at_mdm0 is also held by GL's port-bridge (USB-AT passthrough). Probed
    coexistence is clean; drain-before-send + strict terminator matching are
    the defense against stray bytes.

⚠️ Caveats (reference §8):
  - Open BLOCKING: the SMD channel returns EBUSY on a non-blocking write.
  - /dev/at_mdm0 is NOT a tty, so no termios setup (it's a raw byte stream).
  - No sub_id: the direct port operates in the ACTIVE subscription's context
    only (probed 2026-07-18: no subscription selector exists on this port).
    For per-SIM data (the other SIM's policy_band) use GL's modem.CPU.AT.
  - Writes hit modem NV the same as any AT path — and GL re-applies its own
    stored config on cellular_manager restart, so raw-AT band writes are not
    durable on their own (reference §9).
"""
import fcntl, os, select, signal, sys, time

DEFAULT_PORT = "/dev/at_mdm0"
DEFAULT_LOCK = "/tmp/mudimodem/at.lock"
# Unsolicited result codes that arrive unprompted, unrelated to our command.
URC_PREFIXES = ("RDY", "+CPIN:", "+QUSIM:", "+QUSIM", "+CPINDS:", "+QIND:",
                "+CFUN:", "+CGEV:", "+QNETDEVSTATUS:", "POWERED DOWN")


def gl_modem_pids():
    """PIDs of GL's gl_modem daemon(s) — the AT traffic source we quiet."""
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/comm" % name) as f:
                if f.read().strip() == "gl_modem":
                    pids.append(int(name))
        except OSError:
            pass
    return pids


def proc_state(pid):
    """Single-letter process state from /proc/<pid>/stat (comm-safe split)."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().rsplit(") ", 1)[1].split()[0]
    except (OSError, IndexError):
        return None


def recover_stopped():
    """CONT any gl_modem left stopped by a killed predecessor. Run at startup —
    a stopped gl_modem that never wakes is worse than a crossed response."""
    for pid in gl_modem_pids():
        if proc_state(pid) == "T":
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass


class GlModemSleep:
    """SIGSTOP gl_modem for the duration of the send; ALWAYS SIGCONT on exit."""
    def __init__(self, enabled=True):
        self.enabled, self.stopped = enabled, []

    def __enter__(self):
        if self.enabled:
            for pid in gl_modem_pids():
                try:
                    os.kill(pid, signal.SIGSTOP)
                    self.stopped.append(pid)
                except OSError:
                    pass
        return self

    def __exit__(self, *exc):
        for pid in self.stopped:
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass
        self.stopped = []
        return False


class ChannelBusy(Exception):
    """Another invocation holds the AT channel lock."""


class ATChannel:
    def __init__(self, port=DEFAULT_PORT, lock=DEFAULT_LOCK, lock_wait=5.0):
        self.lockf = None
        if lock:
            d = os.path.dirname(lock)
            if d:
                os.makedirs(d, exist_ok=True)
            self.lockf = open(lock, "w")
            deadline = time.time() + lock_wait
            while True:
                try:
                    fcntl.flock(self.lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.time() >= deadline:
                        self.lockf.close()
                        self.lockf = None
                        raise ChannelBusy()
                    time.sleep(0.2)
            # Only NOW do we exclusively hold the lock, so any gl_modem still
            # in state T is provably stale (a live holder would be inside its
            # own GlModemSleep, and a dead one's flock auto-releases on close)
            # — this is the only safe moment to recover it. Recovering before
            # acquiring the lock would race a legitimately-stopped gl_modem
            # under another worker's in-flight send.
            recover_stopped()
        # BLOCKING open (non-blocking writes return EBUSY on this SMD channel);
        # reads are gated by select() for the timeout.
        try:
            self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY)
        except OSError:
            if self.lockf:
                self.lockf.close()
                self.lockf = None
            raise

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass
        if self.lockf:
            try:
                self.lockf.close()
            except OSError:
                pass
            self.lockf = None

    def _drain(self):
        while select.select([self.fd], [], [], 0)[0]:
            try:
                if not os.read(self.fd, 4096):
                    break
            except OSError:
                break

    def send(self, cmd, timeout=8):
        """Send one AT command. Returns (raw_text, terminator_seen)."""
        self._drain()
        os.write(self.fd, (cmd + "\r").encode())
        buf, ok, deadline = b"", False, time.time() + timeout
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
                ok = True
                break
        return buf.decode(errors="replace"), ok

    def lines(self, cmd, timeout=8):
        """send(), returned as clean lines with URCs filtered out."""
        resp, _ok = self.send(cmd, timeout)
        out = [l.strip() for l in resp.replace("\r", "\n").split("\n") if l.strip()]
        return [l for l in out if not l.startswith(URC_PREFIXES)]


def main(argv):
    envelope, timeout, port = False, 8, DEFAULT_PORT
    lock, lock_wait, glsleep = DEFAULT_LOCK, 5.0, True
    cmds, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--envelope":
            envelope = True
        elif a == "--timeout":
            i += 1
            timeout = max(1, min(60, int(float(argv[i]))))
        elif a == "--port":
            i += 1
            port = argv[i]
        elif a == "--lock":
            i += 1
            lock = argv[i] or None
        elif a == "--lock-wait":
            i += 1
            lock_wait = float(argv[i])
        elif a == "--no-glsleep":
            glsleep = False
        else:
            cmds.append(a)
        i += 1
    if not cmds:
        print("usage: mudimodem-at.py [--envelope] [--timeout N] [--port P]"
              " [--lock PATH] [--lock-wait S] [--no-glsleep] CMD...", file=sys.stderr)
        return 1

    t0 = time.time()

    def ms():
        return int((time.time() - t0) * 1000)

    try:
        ch = ATChannel(port, lock, lock_wait)
    except ChannelBusy:
        if envelope:
            print("MM-AT:busy:%d" % ms())
        else:
            print("busy: another command holds the AT channel", file=sys.stderr)
        return 2
    except OSError as e:
        if envelope:
            print("MM-AT:openfail:%d" % ms())
        else:
            print("cannot open %s: %s" % (port, e), file=sys.stderr)
        return 3

    try:
        try:
            with GlModemSleep(glsleep):
                if envelope:
                    resp, ok = ch.send(cmds[0], timeout)
                    print("MM-AT:%s:%d" % ("ok" if ok else "timeout", ms()))
                    sys.stdout.write(resp)
                    return 0
                for cmd in cmds:
                    t1 = time.time()
                    for l in ch.lines(cmd, timeout):
                        print("    " + l)
                    print(">>> %s   (%.2fs)" % (cmd, time.time() - t1))
                return 0
        except OSError as e:
            # e.g. os.write() failing mid-send (port yanked, EIO, ...). The
            # GlModemSleep context above has already unwound (its __exit__
            # ran and resumed gl_modem) by the time we get here, since it
            # does not suppress the exception. Still must yield a defined
            # envelope line + an exit code in {0,2,3} — never let a bare
            # traceback replace stdout line 1 that Task 2's Lua parses.
            if envelope:
                print("MM-AT:openfail:%d" % ms())
            else:
                print("send failed: %s" % e, file=sys.stderr)
            return 3
    finally:
        ch.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
