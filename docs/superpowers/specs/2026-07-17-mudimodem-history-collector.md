# MudiModem — background history collector

**Date:** 2026-07-17
**Status:** design agreed (decisions locked by Kevin); ready to build.
**Relates to:** UI design §10 (the Tracking page). This replaces §10.6's in-memory
`window.__mmHist` recorder with a device-side service — the deferred §10.6.5 option, now chosen.

## 1. Why

The Tracking page currently builds history in a `window`-scoped ring buffer, so history only
accrues while a browser tab is open and dies on reload. A background service on the box gathers
continuously — history survives reload, tab close, and nginx reload, and accumulates **even with no
browser open** ("what did the radio do overnight?").

## 2. Locked decisions (Kevin, 2026-07-17)

1. **Storage: `/tmp` only** — tmpfs (RAM, 800 MB free), so zero flash wear; volatile (lost on reboot).
   Reboot survival is explicitly out of scope for v1.
2. **Retention: 24 h.**
3. **The service is the source of truth** — the in-memory `window.__mmHist` recorder is **retired**;
   the Tracking page reads history over RPC.
4. **Scope: match Tracking's needs** — RF metrics (RSRP/SINR/RSRQ + levels), band, Cell ID, ARFCN,
   SIM/carrier. Nothing speculative (no temps, no data-usage).

## 3. The crucial safety property

The collector polls **ubus** (`cellular.modem status`, `cellular.network info`, `cellular.sim
status`) — GL's `cellular_manager` cache, the same data the websocket pushes — **never raw AT.** So
it adds **no load on the modem's AT channel** and cannot cause the crossed-response contention that
has bitten this box (UI §5a/§10). ubus reads of the cache are effectively free.

## 4. Architecture

```
cellular_manager (GL) ──cache──> ubus objects
                                     │  poll every 10s (ubus only)
                          mudimodem-collectd (python3, procd)
                                     │  append one JSON line
                          /tmp/mudimodem/samples.jsonl   (sole writer: collectd; trims to 24h)
                          /tmp/mudimodem/events.jsonl    (user/dog events only; appenders below)
                                     ▲
                   set_bands/confirm/revert_now (Lua backend) ──append user event
                   mudimodem-revert (watchdog) ─────────────── append dog event
                                     │
                          mudimodem.get_history (Lua RPC)  reads both files
                                     │  $rpcRequest
                          Tracking page  ── derives net (handover/failover) events
                                            from the sample stream, renders lanes
```

### 4.1 Split of responsibility — who writes what

- **Samples** (`samples.jsonl`): the collector is the **sole writer**, so it trims freely with no race.
- **User/watchdog events** (`events.jsonl`): appended by the **Lua backend** (`set_bands`→"Bands
  applied", `confirm`→"Kept", `revert_now`→"Reverted") and by the **watchdog** (auto-revert→"Auto-revert
  fired"). These are *not derivable from samples*, so they must be persisted. Appends are single
  `O_APPEND` JSON lines (< PIPE_BUF ⇒ atomic). Low volume (dozens/day).
- **Network events** (handover/failover): **NOT persisted.** Derived at read time by the Tracking page
  from consecutive-sample deltas (`slot` change → Failover, `id` change → Handover), with an 8 s guard
  so a change *we* applied isn't double-counted as a network event. This is the one place the old
  `makeMMHist` diff logic survives — as a pure `deriveNetEvents(samples, knownEvents)` function.

This split means only the low-volume events file has multiple writers, and the collector touches it
only to trim (hourly, atomic rewrite) — the race window is milliseconds once an hour, acceptable for
best-effort telemetry and noted in the code.

## 5. The collector (`/usr/sbin/mudimodem-collectd`)

- Python 3.11 stdlib only (`subprocess` + `json`); no pip, matching `mudimodem-at.py`'s footing.
- Loop, every `POLL_INTERVAL = 10` s:
  1. `ubus call cellular.modem status {}` → active `bus` + `current_sim_slot`.
  2. `ubus call cellular.network info {}` → the network with matching `bus` and `slot ==
     current_sim_slot` → its `cell_info`.
  3. `ubus call cellular.sim status {}` → `carrier` for that slot.
  4. Build a sample (numbers parsed from the string fields; `t` = epoch **ms**). If the active slot has
     no `cell_info` (not registered), append a sample with `rsrp:null` etc. so the trace shows an
     honest gap. If ubus itself fails, skip this tick (append nothing).
  5. Append the sample line to `samples.jsonl`.
- **Trim:** every 30 polls (~5 min), rewrite `samples.jsonl` keeping `t >= now − 24 h` (atomic via
  temp + `os.rename`). Also a hard line cap (`MAX_SAMPLES = 10000`) as a backstop. Trim `events.jsonl`
  hourly the same way.
- Robust to malformed lines on read (skip). Never raises out of the loop; logs to stderr (procd
  captures).

## 6. Lifecycle (`/etc/init.d/mudimodem-collectd`)

procd service: `command /usr/sbin/mudimodem-collectd`, `respawn`. `enable`d so it starts on boot.
Started at install via `/etc/init.d/mudimodem-collectd start` (no reboot — the box is a travel router,
UI §working-agreements). Model-guarded by `deploy.sh`.

## 7. RPC — `mudimodem.get_history`

New method in the existing Lua backend:
- Args: `{ since?: <ms> }`. Returns `{ samples: [...], events: [...], now: <ms> }`.
- Reads `samples.jsonl` + `events.jsonl`, `cjson.decode`s each line, filters `t > since` when given.
- Files absent (service just started) ⇒ empty arrays, never an error.
- ~8640 samples × ~130 B ≈ 1.1 MB worst case (full 24 h); the frontend fetches the full window once on
  mount then polls incrementally with `since`, so steady-state payloads are tiny.

Also in the backend: `set_bands`/`confirm`/`revert_now` append their user event to `events.jsonl`
(a small shared `append_event(kind,label,detail)` helper). The watchdog appends the `dog` event.

## 8. Frontend rework (Tracking page)

- **Remove:** `makeMMHist`, `recordSample`, the `window.__mmHist` reads, the 1 Hz record poll.
- **Add:** `data.samples`, `data.events`; `fetchHistory(since)` → `$rpcRequest("call", ["sid",
  "mudimodem", "get_history", {since}])`; on mount fetch the full 24 h once, then poll every 10 s with
  `since = last sample t`, appending. `pause` stops the poll.
- **Derive:** `deriveNetEvents(samples, knownEvents)` (pure, tested) produces handover/failover ticks;
  `allEvents` merges derived + fetched user/dog events, sorted by `t`.
- `winSamples`/`winEvents` read `this.samples`/`allEvents` instead of the window singleton. All lane /
  slice / range / log rendering is unchanged.
- **Main page (`mudimodem.js`):** remove the recorder taps (`makeMMHist`, `hist`, `recordSample`, the
  four `pushEvent` calls). Keep the "History →" link. User/dog events are now persisted by the backend.

## 9. Files

| File | Role |
|---|---|
| `src/sbin/mudimodem-collectd` | **new** — Python poller daemon |
| `src/etc/init.d/mudimodem-collectd` | **new** — procd service wrapper |
| `src/rpc/mudimodem` | **modify** — `get_history` + `append_event` in set_bands/confirm/revert_now |
| `src/sbin/mudimodem-revert` | **modify** — append `dog` event on auto-revert |
| `src/views/mudimodem-tracking.js` | **modify** — fetch/derive instead of `window.__mmHist` |
| `src/views/mudimodem.js` | **modify** — drop recorder taps, keep History link |
| `test/collectd.test.py` | **new** — sample extraction + active-slot selection |
| `test/backend-history.test.lua` | **new** — on-box `get_history` round trip |
| `test/tracking.test.js` / `test/chunk.test.js` | **modify** — injected samples; drop recorder tests |
| `tools/deploy.sh` / `tools/verify.sh` | **modify** — push+enable+start service; assert it runs |

## 10. Out of scope (v1)

Reboot survival (persist to flash); broader telemetry (temps, data usage); server-side net-event
derivation; a socket/stream API (files are enough). `/etc/sysupgrade.conf` registration of all
MudiModem files is folded into install as a small idempotent step (the existing open thread).
