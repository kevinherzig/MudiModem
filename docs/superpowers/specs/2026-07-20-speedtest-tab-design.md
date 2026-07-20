# Spec: Speedtest tab

**Date:** 2026-07-20
**Status:** approved (design), pending implementation plan
**Touches:** `src/views/mudimodem.js`, `src/views/mudimodem-speedtest.js` (new),
`src/menu/mudimodem-speedtest.json` (new), `src/rpc/mudimodem`,
`src/sbin/mudimodem-speedtestd` (new), `tools/mudimodem-speedtest.py` (new, deployed to
`/usr/lib/mudimodem/`), `tools/deploy.sh`, `tools/verify.sh`

## Motivation

The Mudi has no built-in speed test. MudiModem adds one: a manual (and optionally scheduled)
download/upload/latency test, run against a fixed public HTTPS endpoint over the normal cellular
data path, with results **persisted across reboots** (unlike the existing 24h RF-history collector,
which is deliberately `/tmp`-only/volatile — speedtest results are a different durability tier) and
graphed over time. Each stored result also carries a snapshot of carrier/SIM/tower/signal state at
the moment of the test, so a dip in throughput can be correlated with what the radio was doing.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Trigger | Manual button, **plus** an optional background schedule (off by default) |
| Test method | `curl` against Cloudflare's public speed-test endpoints (`speed.cloudflare.com/__down`, `/__up`) — no server to run/maintain, HTTPS, matches the project's stdlib+subprocess convention |
| Data usage per test | Fixed modest size: ~20 MiB download, ~8 MiB upload |
| Latency/jitter | `curl` connect+TTFB timing (5× tiny requests), not ICMP — carrier NAT sometimes throttles/blocks ICMP in ways that would misrepresent real latency |
| Schedule interval | User-selectable: 30m / 1h / 2h / 6h / 12h / 24h; **off by default** |
| Retention | Cap by count — last 500 results, trimmed the same way the RF-history collector trims |
| Placement | A tab in the main page's tab bar, **embedded exactly like the existing Tracking tab** — lazy-loaded+eval'd chunk, cached, rendered in-page via an `embedded` prop (not a router navigation), plus a hidden `level:0` route for direct linking |
| Graph layout | Download & upload as two lines/points sharing one Mbps axis; latency as a thin lane underneath |
| Point detail | Hover/click pops the full snapshot: down/up/latency + carrier/slot/band/cell id/RSRP/SINR/RSRQ — same style as Tracking's `sliceReadout` |
| Live progress | Simple phase text + spinner ("Testing download…" → "…upload…" → "…latency…"), no live-updating gauge |
| Outbound interface | Selectable **Cellular** (default) or **Wired WAN** — the box's two physical uplinks. VPN tunnels (NordVPN, Tailscale — both present and up on this box) are excluded: testing through a tunnel measures the tunnel, not the underlying link, which is a different question |
| Mixed-interface graph | One graph, **filterable by interface** (default: Cellular, matching the test default) — avoids a 10-50x wired/cellular scale mismatch squashing the cellular trend |

## Architecture

```
Browser (mudimodem-speedtest.js, embedded like Tracking)
   │  $rpcRequest: run_speedtest / get_speedtest_status /
   │               get_speedtest_history / get_speedtest_schedule / set_speedtest_schedule
   ▼
mudimodem RPC backend (src/rpc/mudimodem)
   │  spawns detached, flock-serialized (same pattern mudimodem-at.py uses for the AT channel)
   ▼
/usr/lib/mudimodem/mudimodem-speedtest.py  ──curl subprocess──> speed.cloudflare.com
   │  writes progress, then appends the finished result
   ▼
/tmp/mudimodem/speedtest-status.json    (ephemeral — "what phase is running right now")
/etc/mudimodem/speedtests.jsonl         (persistent — survives reboot, capped at 500 lines)
/etc/mudimodem/speedtest-schedule.json  (persistent — {enabled, interval_seconds, last_run})

mudimodem-speedtestd (new procd daemon, shaped like mudimodem-collectd)
   │  wakes every 60s, re-reads the schedule config, runs the test script when due
```

**Why a background job, not a blocking RPC call:** a fixed-size down+up+latency test takes on the
order of 10-20s at typical cellular speeds — too long for a single `$rpcRequest` (default 10s
timeout). `run_speedtest` spawns the script detached (the same shape as `mudimodem-revert`) and
returns immediately; the frontend polls `get_speedtest_status` roughly once a second while running.

**Never touches the AT channel.** The test is pure IP traffic over the normal WWAN interface — none
of CLAUDE.md §8's AT-contention concerns apply. The only shared state with the rest of MudiModem is
the *signal snapshot*, which reuses `mudimodem-collectd`'s existing ubus reads (`cellular.modem
status`, `cellular.network info`, `cellular.sim status`) — no new read path, and it resolves
whichever slot is actively carrying data, exactly as the collector does.

## The test script (`mudimodem-speedtest.py`)

Python 3 stdlib + `curl` subprocess (matching `mudimodem-at.py`'s footing — no pip, no compiled
deps). A `flock` on `/tmp/mudimodem/speedtest.lock` serializes manual and scheduled runs so they
never overlap.

| Phase | Command shape | Fixed size |
|---|---|---|
| Download | `curl -w '%{json}' 'https://speed.cloudflare.com/__down?bytes=N' -o /dev/null` | ~20 MiB |
| Upload | `curl -w '%{json}' --data-binary @tmpfile 'https://speed.cloudflare.com/__up'` | ~8 MiB |
| Latency/jitter | 5× `bytes=0` requests, timing connect+TTFB via curl's `-w`; report median and jitter (max−min) | negligible |

Steps:
1. Write `{"phase": "download", "started": <ms>}` to the status file.
2. Capture the pre-test signal/carrier/tower snapshot (same ubus calls as `build_sample()` in
   `mudimodem-collectd`).
3. Run download, update status to `"upload"`, run upload, update status to `"latency"`, run the 5
   latency probes.
4. On success: append one JSON line to `speedtests.jsonl`, write `{"phase": "done", "result": {...}}`
   to the status file.
5. On any failure (no connectivity, DNS failure, curl non-zero exit): write
   `{"phase": "error", "message": "..."}` to the status file and **append nothing** to history — a
   partial/failed attempt is not a data point.
6. Trim `speedtests.jsonl` to the last 500 lines after every append (atomic temp+rename, same
   technique as the RF-history collector's `trim()`).

A stored result:
```json
{"t": 1753034000000, "trigger": "manual", "iface": "cellular", "down_mbps": 42.1, "up_mbps": 11.3,
 "latency_ms": 61, "jitter_ms": 8, "slot": 1, "carrier": "T-Mobile",
 "band": "n71", "cell_id": "...", "rsrp": -98, "sinr": 8, "rsrq": -11}
```
`trigger` is `"manual"` or `"schedule"` depending on who invoked the script. `iface` is `"cellular"`
or `"wired"`. A scheduled run always uses `"cellular"` (there's no UI present to pick otherwise; a
future revision could add a scheduling-side interface setting, but that's not asked for here).

## Outbound interface

`curl`'s `--interface <name>` binds outgoing connections to a specific local interface/device, which
is enough to force each test phase over cellular or wired WAN regardless of which one the box's
routing table would otherwise prefer.

**Device names are resolved live, never hardcoded** — this box's own `ubus call network.interface
dump` shows the mapping is not as simple as "wan = eth0" (its `eth0` is currently bridged into
`br-lan` as a LAN port, and the standalone `wan` logical interface is down/unconfigured), so a fixed
device name would be wrong on this box today and could go stale on any box. Instead, immediately
before each run the script (or the backend, before spawning — see below) calls `ubus call
network.interface dump` and resolves:
- **Cellular** → the interface whose `proto` is `rmnet` (GL's cellular data interface, currently
  named `modem_cpu` on this box) → its `l3_device` (`rmnet_data1` today).
- **Wired WAN** → the standard OpenWrt logical interface named `wan` → its `l3_device`.

If the selected interface has no live device (down — e.g. Wired WAN with nothing plugged in),
`run_speedtest` returns an error **before spawning** anything (`{error: "iface_down", iface:
"wired"}`) rather than starting a test doomed to fail partway through.

**RPC additions for this:**

| Method | Behavior |
|---|---|
| `get_speedtest_interfaces` | Resolves both candidates right now, returns `{cellular: {device, up}, wired: {device, up}}` — backs the dropdown so an unplugged Wired WAN renders disabled/greyed rather than merely failing after the fact |

`run_speedtest` gains an `iface` arg (`"cellular"` \| `"wired"`, default `"cellular"`); the resolved
device name is passed through to the spawned script, which adds `--interface <device>` to every curl
invocation (download, upload, all 5 latency probes) — so a mid-test cable pull is the only way an
interface can go down after the check, and that already surfaces as the existing curl-failure error
path (§ "The test script").

**Frontend:** an interface dropdown (Cellular / Wired WAN, default Cellular) next to the "Run speed
test" button, populated from `get_speedtest_interfaces` (disabling Wired WAN when its `up` is false);
and a separate interface filter on the history graph (default Cellular) controlling which subset of
`speedtests.jsonl` is plotted.

## Scheduling (`mudimodem-speedtestd`)

A small procd-managed loop, shaped like `mudimodem-collectd`: every 60s, read
`speedtest-schedule.json` (`{enabled, interval_seconds, last_run}`); if `enabled` and
`now - last_run >= interval_seconds`, invoke the same test script (as `trigger=schedule`) and update
`last_run`. Re-reading the config every wake means changing the interval from the UI takes effect
without restarting the service — no daemon restart plumbing needed.

## Persistence

`/etc/mudimodem/` (not `/tmp`) — the same directory `pending.json` already lives in, so results
survive a normal reboot. This joins the existing, already-tracked open thread of registering
MudiModem's files in `/etc/sysupgrade.conf` for firmware-upgrade survival (CLAUDE.md §9/§12) — no
new scope here, just another file added to that eventual list.

- `speedtests.jsonl` — capped at 500 results.
- `speedtest-schedule.json` — tiny, single object, no trimming needed.
- `/tmp/mudimodem/speedtest-status.json` and `speedtest.lock` — ephemeral, fine to lose on reboot.

## RPC surface (additions to `src/rpc/mudimodem`)

| Method | Behavior |
|---|---|
| `run_speedtest` | Takes `{iface: "cellular"\|"wired"}` (default `"cellular"`). Resolves the interface (see below); if it's down, returns `{error:"iface_down", iface}` without spawning. If the status file already shows a run in progress, returns `{running:true}` immediately with no error. Otherwise spawns the script detached with `trigger=manual` and the resolved device, returns `{started:true}`. The script's own non-blocking `flock` (`flock -n`) is the authoritative guard against the rarer race of a scheduled run starting in the same instant — if it loses that race it exits immediately without touching the status file or history |
| `get_speedtest_status` | Reads the status file; `{running, phase, message?, result?}` |
| `get_speedtest_history` | Reads `speedtests.jsonl` (optional `since`/`limit`/`iface`), returns `{results:[...]}` |
| `get_speedtest_interfaces` | Resolves both candidates now via `ubus call network.interface dump`; returns `{cellular: {device, up}, wired: {device, up}}` |
| `get_speedtest_schedule` | Returns `{enabled, interval_seconds, last_run}` |
| `set_speedtest_schedule` | Validates `interval_seconds` against the fixed option set (30m/1h/2h/6h/12h/24h in seconds), writes the config file |
| `clear_speedtest_history` | Truncates `speedtests.jsonl` — backs the UI's "Clear history" action |

## Frontend

- **New tab** `["speedtest", "Speedtest"]` added to `mudimodem.js`'s `TABS`. Clicking it follows the
  exact mechanism the `tracking` tab already uses: `openSpeedtest()` lazy-fetches+`eval`s
  `/views/gl-sdk4-ui-mudimodem-speedtest.common.js?_t=<ts>` once, caches it as `speedtestComp`, and
  the panel renders `h(this.speedtestComp, { props: { embedded: true } })` — no router navigation,
  same full-width panel space as every other tab.
- **New hidden menu entry** `src/menu/mudimodem-speedtest.json` (`level:0`, mirroring
  `mudimodem-tracking.json`) registers `/mudimodem-speedtest` as a real (unlisted) route for direct
  linking, independent of the embedded path.
- **New chunk source** `src/views/mudimodem-speedtest.js`, same `embedded` prop convention as
  `mudimodem-tracking.js` (suppresses its own back-button when the tab bar is already visible).
- **Layout:**
  - "Run speed test" button at top; while running, phase text + spinner
    ("Testing download…"/"…upload…"/"…latency…"), polling `get_speedtest_status` ~1/s.
  - History graph below: time on X; download/upload as two colored lines/points on one shared Mbps
    axis; a thin latency lane underneath. Colors pulled from GL's theme tokens (not hand-picked) —
    confirm against `/www/theme/base.css` during implementation, following the same
    `var(--primary)`/`var(--success)`/`var(--error)` convention `mudimodem-tracking.js` already uses.
    The `dataviz` skill should be consulted when the chart code is actually written.
  - Hovering/clicking a point shows a popover with down/up/latency plus carrier/slot/band/cell
    id/RSRP/SINR/RSRQ, styled like Tracking's `sliceReadout`.
  - An interface dropdown (Cellular / Wired WAN, default Cellular) next to the run button, from
    `get_speedtest_interfaces`; Wired WAN renders disabled when its device is down.
  - A separate interface filter on the history graph itself (default Cellular).
  - A schedule control (enabled toggle + interval dropdown) bound to `get/set_speedtest_schedule`.
  - A "Clear history" action.

## Testing

- `test/speedtest.test.py` — pure functions: curl JSON-output → Mbps, latency/jitter aggregation
  from 5 probes, schedule due-check logic, and the `network.interface dump` → device resolver
  (cellular/wired, including the down/no-device case). Mirrors the split already used in
  `test/collectd.test.py`.
- `test/speedtest-chunk.test.js` — evals the new chunk exactly as the SPA does (stub `module`+`h`),
  asserts the graph/tab/popover/schedule pieces render, and that it remains Vue-2.6 runtime-only
  (`render(h)`, no `template:`).
- `test/chunk.test.js` — extend for `mudimodem.js`: `TABS` includes `"Speedtest"`, clicking it
  lazy-loads+caches like `tracking` does.
- `test/backend-speedtest.test.lua` — on-box `dofile`+stubbed-`ngx` round trip for
  `run_speedtest`/`get_speedtest_status`/`get_speedtest_history`/`get/set_speedtest_schedule`/
  `clear_speedtest_history` (the stub-vs-real-path trap from CLAUDE.md §8 — a real `/rpc` round trip
  is also needed once validator entries exist, per the existing `mudimodem.lua` validator note).
- `tools/verify.sh` — extend: new files present & gzipped, daemon registered+enabled+running,
  `speedtests.jsonl`/`speedtest-schedule.json` under `/etc/mudimodem`, RPC methods reachable.

## Out of scope (v1)

Live-updating gauge mid-test (numbers ticking in real time); iperf3 as a test method; per-test size
selector (small/medium/large); time-based (vs count-based) retention; multi-SIM speed comparison
views; VPN tunnels (NordVPN/Tailscale) as selectable test interfaces; a per-schedule interface
setting (scheduled runs are always Cellular); `/etc/sysupgrade.conf` registration (folds into the
existing not-yet-done installer thread, not new work here).
