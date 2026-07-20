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


if __name__ == "__main__":
    sys.exit(0)
