# Speedtest tab: latest-result panel (2026-07-21)

## Problem

Today, the only way to see the numbers from a speed test you just ran is to hover (or click) the
newest point on the History graph. That's an extra step and easy to miss — the graph's hover
tooltip (`renderGraph`'s `.mms-tip`) is the only place the full result (down/up/latency/jitter +
serving-cell detail) is shown.

## Goal

After a speed test completes, show its result in a dedicated panel on the page — no need to go
hover the graph.

## Design

### Data flow — no backend change

`tools/mudimodem-speedtest.py` already writes the finished result to the status file:
```py
write_status(cfg["status"], {"running": False, "phase": "done", "result": result})
```
`result` = `{t, trigger, iface, down_mbps, up_mbps, latency_ms, jitter_ms, carrier, slot, band,
mode, cell_id, rsrp, sinr, rsrq}` (same shape as a history entry; see `build_snapshot` in
`tools/mudimodem-speedtest.py`).

The frontend already polls `get_speedtest_status` every second while a test is in flight
(`fetchStatus`/`startPoll` in `src/views/mudimodem-speedtest.js`) but currently discards
`result` — it only inspects `running` to decide whether to stop polling and refresh history.

**Change:** in `fetchStatus`, at the existing "test just finished" transition —
```js
if (!self.status.running && self.statusPoll) self.stopPollAndRefresh();
```
— before calling `stopPollAndRefresh()`, if `r.phase === "done" && r.result`, set
`self.lastResult = r.result`.

This only fires while `this.statusPoll` is set, i.e. while this component instance is actively
watching a run that started during this mount. It does **not** fire on the initial
`fetchStatus(true)` call in `mounted()` even if the status file already holds a stale `done`
result from a previous session — so the panel only ever shows a result that finished while the
tab was open (a manual run, or a scheduled background run if the tab happened to be open and
polling). `lastResult` starts `null` and the panel is absent until then.

On a `phase: "error"` completion, `lastResult` is left untouched (not cleared) — the existing
inline error message under the Run button already covers the failure case.

### UI layout

New `mms-card` inserted between the controls card and the History card, rendered only when
`this.lastResult` is truthy:

```
[ Controls card: iface picker, Run button, schedule ]
[ Latest result card ]   <- NEW, only after a completion this session
[ History card: iface filter, graph w/ hover tooltip ]
```

Header: interface tested + timestamp, e.g. `Cellular · 2:41 PM` (reuse the existing `clock()`
helper). Body: headline row for Down / Up / Latency (large, like the graph legend colors —
`var(--primary)` down, `var(--success)` up), then the same detail rows the graph tooltip already
shows: Latency (±jitter), Carrier · SIM, Band, Cell, RSRP, SINR, RSRQ. Same "—" placeholder
convention for null fields as the existing tooltip code.

Starting a new run does **not** clear `lastResult` — the old panel stays visible (still labeled
with its own timestamp) until the new run finishes and replaces it. This avoids a ~10-20s blank
gap during the test.

No dismiss/close control — the panel is inherently transient (tied to component lifetime; a tab
switch away and back remounts the component fresh, per the existing `speedtestComp` caching in
`mudimodem.js`, which already discards state across tab switches today).

### Styling

New CSS rules alongside the existing `.mms-*` block in `injectStyle()`: `.mms-latest` (card
content layout), `.mms-latest-head` (iface + timestamp), `.mms-latest-big` (headline down/up/
latency row), `.mms-latest-rows` (reuse `.mms-tip-row` styling for the detail rows).

### Testing

Extend `test/chunk.test.js`'s speedtest coverage:
- Simulate a status poll transition to `{running:false, phase:"done", result:{...}}` after a run
  was started; assert the new panel renders with the expected fields.
- Assert the panel is **absent** when the component mounts with a status file that's already
  `{running:false, phase:"done", result:{...}}` at mount time (no run happened this session).
- Assert starting a second run leaves the first result visible until the second's `result`
  replaces it.

## Out of scope

- No backend/RPC changes (data already exists in the status payload).
- No change to the History graph or its hover tooltip.
- No persistence of "latest result" across page reloads/tab switches — by design (§ triggers).
