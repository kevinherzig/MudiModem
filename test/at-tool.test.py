#!/usr/bin/env python3
"""Local tests for tools/mudimodem-at.py. No modem needed: a pty plays the
modem (raw mode, so no line-discipline mangling; the tool never does termios,
matching the real /dev/at_mdm0 which is not a tty)."""
import contextlib, importlib.util, io, os, subprocess, sys, tempfile, threading, time, tty, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
TOOL = os.path.join(ROOT, "tools", "mudimodem-at.py")

spec = importlib.util.spec_from_file_location("mudimodem_at", TOOL)
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)


class FakeModem:
    """Answers the first AT command written to the pty with a canned reply."""
    def __init__(self, reply=b"\r\nOK\r\n", delay=0.0):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)          # raw byte stream, like the real port
        self.path = os.ttyname(self.slave)
        self.reply, self.delay = reply, delay
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        buf = b""
        while b"\r" not in buf:
            try:
                b = os.read(self.master, 64)
            except OSError:
                return
            if not b:
                return
            buf += b
        if self.delay:
            time.sleep(self.delay)
        if self.reply:
            os.write(self.master, self.reply)


class ATToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.lock = os.path.join(self.tmp, "at.lock")

    def test_send_ok_sees_terminator(self):
        fm = FakeModem(b"\r\n+QSPN: \"T-Mobile\"\r\n\r\nOK\r\n")
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, ok = ch.send("AT+QSPN", timeout=3)
        finally:
            ch.close()
        self.assertTrue(ok, "terminator must be recognised")
        self.assertIn("OK", text)
        self.assertIn("T-Mobile", text)

    def test_send_timeout_reports_no_terminator(self):
        fm = FakeModem(reply=b"")           # never answers
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            text, ok = ch.send("AT", timeout=0.4)
        finally:
            ch.close()
        self.assertFalse(ok)
        self.assertEqual(text, "")

    def test_lines_filters_urcs(self):
        fm = FakeModem(b"\r\n+QIND: SMS DONE\r\n+QSPN: \"T\"\r\nOK\r\n")
        ch = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            out = ch.lines("AT+QSPN", timeout=3)
        finally:
            ch.close()
        self.assertNotIn("+QIND: SMS DONE", out)
        self.assertTrue(any("QSPN" in l for l in out))
        self.assertIn("OK", out)

    def test_flock_busy(self):
        fm = FakeModem()
        holder = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            with self.assertRaises(mm.ChannelBusy):
                mm.ATChannel(port=fm.path, lock=self.lock, lock_wait=0.3)
        finally:
            holder.close()

    def test_recover_stopped_is_safe_without_gl_modem(self):
        mm.recover_stopped()                # dev box has no gl_modem: no-op, no raise
        self.assertEqual(mm.gl_modem_pids(), [])

    def test_glmodem_sleep_noop_without_daemon(self):
        with mm.GlModemSleep(True) as s:
            self.assertEqual(s.stopped, [])

    def test_cli_envelope_ok(self):
        fm = FakeModem(b"\r\nRG650VNA\r\n\r\nOK\r\n")
        r = subprocess.run(
            [sys.executable, TOOL, "--envelope", "--timeout", "3",
             "--port", fm.path, "--lock", self.lock, "--no-glsleep", "ATI"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        first, _, rest = r.stdout.partition("\n")
        self.assertRegex(first, r"^MM-AT:ok:\d+$")
        self.assertIn("RG650VNA", rest)
        self.assertIn("OK", rest)

    def test_cli_envelope_busy(self):
        fm = FakeModem()
        holder = mm.ATChannel(port=fm.path, lock=self.lock)
        try:
            r = subprocess.run(
                [sys.executable, TOOL, "--envelope", "--timeout", "2",
                 "--port", fm.path, "--lock", self.lock, "--lock-wait", "0.3",
                 "--no-glsleep", "AT"],
                capture_output=True, text=True, timeout=15)
        finally:
            holder.close()
        self.assertEqual(r.returncode, 2)
        self.assertRegex(r.stdout.splitlines()[0], r"^MM-AT:busy:\d+$")

    def test_recover_stopped_runs_only_after_lock_acquired(self):
        """Fix 1: recovering a stale-stopped gl_modem must happen only once
        THIS process exclusively holds the flock — not before contending for
        it. Recovering earlier would race a legitimately-stopped gl_modem
        that another worker has SIGSTOPped for its own in-flight send."""
        fm = FakeModem()
        calls = []
        orig_pids, orig_state, orig_kill = mm.gl_modem_pids, mm.proc_state, mm.os.kill
        mm.gl_modem_pids = lambda: [4242]
        mm.proc_state = lambda pid: "T"
        mm.os.kill = lambda pid, sig: calls.append((pid, sig))
        try:
            # (a) Opening the FIRST channel acquires the lock -> recovery
            # of the (faked) stale-stopped gl_modem must run.
            ch = mm.ATChannel(port=fm.path, lock=self.lock)
            try:
                self.assertIn((4242, mm.signal.SIGCONT), calls,
                              "lock holder must recover a stale-stopped gl_modem")
            finally:
                ch.close()

            # (b) While a holder legitimately has the lock, a contending
            # open must fail with ChannelBusy and must NEVER have issued
            # SIGCONT during its own failed attempt — only the process that
            # actually acquires the lock may recover.
            holder = mm.ATChannel(port=fm.path, lock=self.lock)
            try:
                calls.clear()
                with self.assertRaises(mm.ChannelBusy):
                    mm.ATChannel(port=fm.path, lock=self.lock, lock_wait=0.3)
                self.assertEqual(calls, [],
                                  "a busy/failed open must not SIGCONT gl_modem")
            finally:
                holder.close()
        finally:
            mm.gl_modem_pids, mm.proc_state, mm.os.kill = orig_pids, orig_state, orig_kill

    def test_write_failure_yields_defined_envelope(self):
        """Fix 2: an OSError from the initial os.write() inside send() must
        not escape main() as a bare traceback — it must still print a
        parseable MM-AT: line and return an exit code in {0,2,3}, and
        specifically openfail/3 since the command was never actually sent."""
        fm = FakeModem()
        orig_write = mm.os.write

        def boom(fd, data):
            raise OSError("simulated write failure")

        mm.os.write = boom
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc = mm.main(["--envelope", "--timeout", "2",
                              "--port", fm.path, "--lock", self.lock,
                              "--no-glsleep", "AT"])
        finally:
            mm.os.write = orig_write
        out = buf.getvalue()
        lines = out.splitlines()
        self.assertTrue(lines, "must still print an MM-AT: envelope line")
        self.assertRegex(lines[0], r"^MM-AT:(ok|timeout|busy|openfail):\d+$")
        self.assertIn(rc, (0, 2, 3))
        self.assertEqual(rc, 3, "unsendable command must be openfail, not a silent 0")
        self.assertTrue(lines[0].startswith("MM-AT:openfail:"))


if __name__ == "__main__":
    unittest.main()
