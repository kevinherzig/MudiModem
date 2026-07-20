#!/usr/bin/env python3
"""MudiModem's speed test runner — curl-based download/upload/latency test
over a chosen outbound interface, with a signal/carrier/tower snapshot taken
immediately before the test.

Stdlib + curl subprocess only (matches mudimodem-at.py's footing: no pip, no
compiled deps). Deployed standalone to /usr/lib/mudimodem/mudimodem-speedtest.py
and spawned DETACHED by the mudimodem RPC backend (a fixed-size test takes
~10-20s -- too long for one $rpcRequest) or by mudimodem-speedtestd on a
schedule. Persists one JSON line per result to /etc/mudimodem/speedtests.jsonl
(NOT /tmp -- unlike the RF-history telemetry, these must survive a reboot).

Design doc: docs/superpowers/specs/2026-07-20-speedtest-tab-design.md
"""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time

DOWN_URL = os.environ.get("MUDIMODEM_ST_DOWN_URL", "https://speed.cloudflare.com/__down")
UP_URL = os.environ.get("MUDIMODEM_ST_UP_URL", "https://speed.cloudflare.com/__up")
DOWN_BYTES = int(os.environ.get("MUDIMODEM_ST_DOWN_BYTES", 20 * 1024 * 1024))
UP_BYTES = int(os.environ.get("MUDIMODEM_ST_UP_BYTES", 8 * 1024 * 1024))
LATENCY_N = int(os.environ.get("MUDIMODEM_ST_LATENCY_N", 5))
HIST_PATH = os.environ.get("MUDIMODEM_ST_HIST", "/etc/mudimodem/speedtests.jsonl")
STATUS_PATH = os.environ.get("MUDIMODEM_ST_STATUS", "/tmp/mudimodem/speedtest-status.json")
LOCK_PATH = os.environ.get("MUDIMODEM_ST_LOCK", "/tmp/mudimodem/speedtest.lock")
HIST_MAX_LINES = 500


def mbps(bytes_per_sec):
    """curl's speed_download/speed_upload (bytes/sec) -> rounded Mbps."""
    if bytes_per_sec is None:
        return None
    return round(bytes_per_sec * 8 / 1e6, 1)


def resolve_iface_from_dump(dump, which):
    """Pick the live device for 'cellular' or 'wired' out of a `ubus call
    network.interface dump` payload. Never hardcoded -- this box's own eth0
    turned out to be bridged into LAN rather than acting as WAN, and the
    cellular device index has been observed to change (rmnet_data0 <->
    rmnet_data1) after a modem reconnect. Returns (device, up)."""
    ifaces = (dump or {}).get("interface") or []
    if which == "cellular":
        for i in ifaces:
            name = str(i.get("interface") or "")
            if i.get("proto") == "rmnet" and not name.endswith("_6"):
                dev = i.get("l3_device") or i.get("device")
                return dev, bool(i.get("up")) and dev is not None
    elif which == "wired":
        for i in ifaces:
            if i.get("interface") == "wan":
                dev = i.get("l3_device") or i.get("device")
                return dev, bool(i.get("up")) and dev is not None
    return None, False


def latency_stats(samples):
    """samples: seconds (floats, None entries dropped). -> (latency_ms,
    jitter_ms) using the median as the headline number (robust to one slow
    outlier) and max-min as jitter. (None, None) if nothing usable."""
    vals = sorted(s for s in samples if s is not None)
    if not vals:
        return None, None
    mid = len(vals) // 2
    median = vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2
    return round(median * 1000), round((vals[-1] - vals[0]) * 1000)


def build_snapshot(modem, net, sims):
    """Signal/carrier/tower snapshot for the active slot -- the same three
    ubus reads mudimodem-collectd uses (cellular.modem status / cellular.
    network info / cellular.sim status), independently implemented here since
    each deployed MudiModem script is self-contained (mirrors mudimodem-at.py
    / mudimodem-collectd, neither of which share code either). {} if the
    active slot can't be resolved."""
    m = ((modem or {}).get("modems") or [{}])
    m = m[0] if m else {}
    slot = m.get("current_sim_slot")
    if slot is None:
        return {}
    cell = {}
    for n in (net or {}).get("networks") or []:
        if str(n.get("slot")) == str(slot):
            cell = n.get("cell_info") or {}
            break
    carrier = ""
    for s in (sims or {}).get("sims") or []:
        if str(s.get("slot")) == str(slot):
            carrier = s.get("carrier") or ""
            break

    def num(v):
        if v is None or v == "":
            return None
        try:
            f = float(v)
        except (ValueError, TypeError):
            return None
        return int(f) if f == int(f) else f

    return {
        "slot": slot, "carrier": carrier, "band": cell.get("band"),
        "mode": cell.get("mode"), "cell_id": cell.get("id"),
        "rsrp": num(cell.get("rsrp")), "sinr": num(cell.get("sinr")), "rsrq": num(cell.get("rsrq")),
    }


def ubus_call(obj, method, args=None):
    """Return the parsed ubus result dict, or None on any failure."""
    try:
        cmd = ["ubus", "call", obj, method, json.dumps(args or {})]
        out = subprocess.run(cmd, capture_output=True, timeout=8, text=True)
        if out.returncode != 0 or not out.stdout:
            return None
        return json.loads(out.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def resolve_iface(which):
    return resolve_iface_from_dump(ubus_call("network.interface", "dump"), which)


def curl_probe(url, extra_args, timeout):
    """Run curl, discarding the response body (-o /dev/null), capturing ONLY
    the -w JSON trailer on stdout. Returns the parsed dict, or None on any
    failure (process error, timeout, or bad JSON)."""
    cmd = ["curl", "-s", "-m", str(timeout), "-o", "/dev/null", "-w", "%{json}"] + list(extra_args) + [url]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout.decode(errors="replace"))
    except ValueError:
        return None


def _ok(probe):
    return bool(probe) and 200 <= (probe.get("http_code") or 0) < 300


def run_download(device, cfg):
    r = curl_probe(cfg["down_url"], ["--interface", device, "-G", "--data-urlencode",
                                      "bytes=%d" % cfg["down_bytes"]], cfg["timeout"])
    return mbps(r.get("speed_download")) if _ok(r) else None


def run_upload(device, cfg, upload_path):
    r = curl_probe(cfg["up_url"], ["--interface", device, "--data-binary", "@" + upload_path], cfg["timeout"])
    return mbps(r.get("speed_upload")) if _ok(r) else None


def run_latency(device, cfg):
    samples = []
    for _ in range(LATENCY_N):
        r = curl_probe(cfg["down_url"], ["--interface", device, "-G", "--data-urlencode", "bytes=0"], cfg["timeout"])
        if _ok(r):
            samples.append(r.get("time_starttransfer"))
    return latency_stats(samples)


def acquire_lock(path):
    """Non-blocking flock. Returns the open file handle (caller must close()
    to release), or None if another instance already holds it."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    f = open(path, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def write_status(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(obj))
    os.replace(tmp, path)


def trim_history(path, max_lines=HIST_MAX_LINES):
    try:
        with open(path) as f:
            lines = [l for l in f.readlines() if l.strip()]
    except FileNotFoundError:
        return
    if len(lines) <= max_lines:
        return
    kept = lines[-max_lines:]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.writelines(kept)
    os.replace(tmp, path)


def append_result(path, result):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(result) + "\n")
    trim_history(path)


def parse_args(argv):
    """Manual argv parsing (matches mudimodem-at.py's style -- no argparse
    elsewhere in this codebase). --device is a debug/testing override that
    skips ubus resolution entirely; the Lua backend and the scheduler daemon
    never pass it -- only --iface, which is always resolved live."""
    cfg = {
        "trigger": "manual", "iface": "cellular", "timeout": 20.0, "device": None,
        "down_url": DOWN_URL, "up_url": UP_URL,
        "down_bytes": DOWN_BYTES, "up_bytes": UP_BYTES,
        "hist": HIST_PATH, "status": STATUS_PATH, "lock": LOCK_PATH,
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--trigger":
            i += 1; cfg["trigger"] = argv[i]
        elif a == "--iface":
            i += 1; cfg["iface"] = argv[i]
        elif a == "--device":
            i += 1; cfg["device"] = argv[i]
        elif a == "--timeout":
            i += 1; cfg["timeout"] = float(argv[i])
        elif a == "--down-url":
            i += 1; cfg["down_url"] = argv[i]
        elif a == "--up-url":
            i += 1; cfg["up_url"] = argv[i]
        elif a == "--down-bytes":
            i += 1; cfg["down_bytes"] = int(argv[i])
        elif a == "--up-bytes":
            i += 1; cfg["up_bytes"] = int(argv[i])
        elif a == "--hist":
            i += 1; cfg["hist"] = argv[i]
        elif a == "--status":
            i += 1; cfg["status"] = argv[i]
        elif a == "--lock":
            i += 1; cfg["lock"] = argv[i]
        else:
            raise SystemExit("unknown arg: %s" % a)
        i += 1
    if cfg["iface"] not in ("cellular", "wired"):
        raise SystemExit("--iface must be 'cellular' or 'wired'")
    return cfg


def main(argv):
    cfg = parse_args(argv)
    lock = acquire_lock(cfg["lock"])
    if lock is None:
        write_status(cfg["status"], {"running": False, "phase": "error",
                                      "message": "another test is already running"})
        return 2
    try:
        if cfg["device"]:
            device, up = cfg["device"], True
        else:
            device, up = resolve_iface(cfg["iface"])
        if not up or not device:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": cfg["iface"] + " is not connected", "iface": cfg["iface"]})
            return 3

        snapshot = build_snapshot(ubus_call("cellular.modem", "status"),
                                   ubus_call("cellular.network", "info"),
                                   ubus_call("cellular.sim", "status"))

        write_status(cfg["status"], {"running": True, "phase": "download", "iface": cfg["iface"]})
        down = run_download(device, cfg)
        if down is None:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": "download failed", "iface": cfg["iface"]})
            return 4

        write_status(cfg["status"], {"running": True, "phase": "upload", "iface": cfg["iface"]})
        upload_path = tempfile.mktemp(prefix="mudimodem-st-")
        with open(upload_path, "wb") as f:
            f.write(os.urandom(cfg["up_bytes"]))
        try:
            up_mbps = run_upload(device, cfg, upload_path)
        finally:
            try:
                os.remove(upload_path)
            except OSError:
                pass
        if up_mbps is None:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": "upload failed", "iface": cfg["iface"]})
            return 4

        write_status(cfg["status"], {"running": True, "phase": "latency", "iface": cfg["iface"]})
        latency_ms, jitter_ms = run_latency(device, cfg)
        if latency_ms is None:
            write_status(cfg["status"], {"running": False, "phase": "error",
                                          "message": "latency probe failed", "iface": cfg["iface"]})
            return 4

        result = {"t": int(time.time() * 1000), "trigger": cfg["trigger"], "iface": cfg["iface"],
                  "down_mbps": down, "up_mbps": up_mbps,
                  "latency_ms": latency_ms, "jitter_ms": jitter_ms}
        result.update(snapshot)
        append_result(cfg["hist"], result)
        write_status(cfg["status"], {"running": False, "phase": "done", "result": result})
        return 0
    finally:
        lock.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
