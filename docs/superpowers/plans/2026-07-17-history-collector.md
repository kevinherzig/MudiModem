# History Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** A device-side Python service gathers modem history continuously to `/tmp`; the Tracking page reads it over RPC instead of the in-memory buffer.

**Architecture:** See spec `docs/superpowers/specs/2026-07-17-mudimodem-history-collector.md`. Collector polls **ubus only** (no AT), appends samples to `/tmp/mudimodem/samples.jsonl`; backend + watchdog append user/dog events to `events.jsonl`; `get_history` RPC serves both; frontend derives net events client-side.

## Global Constraints
- Python 3.11 stdlib only (box has `/usr/bin/python3` 3.11.7); no pip.
- Collector reads ubus (`cellular.modem status`, `cellular.network info`, `cellular.sim status`) — never raw AT.
- Storage `/tmp` (tmpfs); 24 h retention; `MUDIMODEM_HIST` overridable for tests (default `/tmp/mudimodem`).
- Timestamps epoch **ms** (`os.time()*1000` in Lua/shell, `int(time.time()*1000)` in Python), single box clock.
- Deploy model-guarded on E5800; start service via init.d (no reboot).
- Vue chunks stay render-only (no `template:`); GL theme tokens only.

## Tasks
1. **Collector** `src/sbin/mudimodem-collectd` + `test/collectd.test.py` — `build_sample(modem,net,sims)` pure fn + `trim()` + poll loop; test extraction/active-slot/trim locally.
2. **procd service** `src/etc/init.d/mudimodem-collectd`.
3. **Backend** `src/rpc/mudimodem` — `append_event` helper; `get_history`; event appends in set_bands/confirm/revert_now. `test/backend-history.test.lua` (on-box).
4. **Watchdog** `src/sbin/mudimodem-revert` — append `dog` event on auto-revert.
5. **Tracking frontend** `src/views/mudimodem-tracking.js` — drop `window.__mmHist`; `fetchHistory`/poll; `deriveNetEvents` pure fn; box-clock skew handling.
6. **Main page** `src/views/mudimodem.js` — remove recorder taps; keep History link.
7. **Tests** `test/tracking.test.js` + `test/chunk.test.js` — reworked (inject samples; drop recorder/byte-identity).
8. **Tooling** `tools/deploy.sh` (push collector+init.d, enable+start) + `tools/verify.sh` (service running, get_history works) + `/etc/sysupgrade.conf` idempotent registration.
9. **Build, deploy, install, verify** on the box.

Verification per task: `python3 -m unittest`, `node --test test/`, on-box `verify.sh`, and a live `get_history` returning growing samples.
