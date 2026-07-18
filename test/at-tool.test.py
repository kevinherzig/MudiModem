#!/usr/bin/env python3
"""Local tests for tools/mudimodem-at.py. No modem needed: a pty plays the
modem (raw mode, so no line-discipline mangling; the tool never does termios,
matching the real /dev/at_mdm0 which is not a tty)."""
import importlib.util, os, subprocess, sys, tempfile, threading, time, tty, unittest

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


if __name__ == "__main__":
    unittest.main()
