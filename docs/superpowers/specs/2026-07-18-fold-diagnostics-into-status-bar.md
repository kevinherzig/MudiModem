# Fold the Diagnostics tab into the "RSRP live" top bar

**Date:** 2026-07-18
**Status:** approved
**Surface:** `src/views/mudimodem.js` (main chunk) + `test/`

## Goal

Retire the standalone **Diagnostics** tab. Its serving-cell readout moves into the
top status strip (the region with the **"RSRP live"** eyebrow). Also promote the
**Tracking** tab to first position and make it the default landing tab. The strip's
old `Tracking ↗` shortcut is removed and the strip becomes pure display.

## Region names (for reference)

The top **status strip** (`.mm-strip`, rendered as `strip`) has:
- `[A]` "RSRP live" eyebrow · `[B]` "Tracking ↗" link
- `[C]` RSRP sparkline · `[E]` hero RSRP number
- `[D]` axis line: `-120 · Mode  Carrier  SIM n · -80 dBm`
- `[F]` facts row (`.mm-facts`): today `SINR · RSRQ · Band`

The **Diagnostics tab** rendered a "Serving cell" card listing `facts`:
Mode · Band · Bandwidth · Cell ID · Channel · RSRP · RSRQ · SINR · RSSI · Carrier · SIM slot.

## Changes

### 1. Remove the Diagnostics tab
- Delete `["diag", "Diagnostics"]` from the `TABS` array.
- Delete the `if (this.tab === "diag") { … }` branch in the panel render.

### 2. Tracking becomes first + default
- Reorder `TABS` to: `Tracking · Bands · Cell lock · AT console · SIM`.
- Change `data.tab` default from `"diag"` → `"tracking"`.
- Add a `mounted()` hook: `if (this.tab === "tracking") this.loadTracking();`
  so the lazy Tracking chunk fetches on landing (today the fetch is triggered only
  by the click handler `openTracking`, which won't fire on the default paint).
  `created()` keeps doing `injectStyle()`.

### 3. Extend the facts row `[F]` with the diagnostics fields the strip lacks
Append, after the existing SINR / RSRQ / Band, the fields not already shown elsewhere
in the strip: **Bandwidth · Cell ID · Channel · RSSI**. Source each inline from
`this.serving` (`dl_bandwidth`, `id`, `tx_channel`, `rssi`) using the same
`.mm-facts` `k`/`b` markup, rendering each only when its value is present (mirroring
the guard in the `facts` computed).

No duplication: Mode/Carrier/SIM remain on the axis line `[D]`, RSRP remains the hero
`[E]`. Band/SINR/RSRQ stay in `[F]`.

### 4. Make the strip inert
On the trace block `[C]`, remove `staticStyle:{cursor:"pointer"}`,
`attrs:{title:"Open Tracking"}`, and `on:{click:openTracking}`. Remove the
`Tracking ↗` label span `[B]`. The strip no longer navigates anywhere.

### 5. Keep
- The **Tracking tab** button, `openTracking`, `loadTracking`, and the tracking chunk
  — untouched (the tab is still the route into the graph).
- The strip's no-data / not-registered empty states — they already cover what the
  Diagnostics empty state did.
- The `facts` computed may stay (unused by the strip now, still low-cost); leave it.

## Tests (`test/chunk.test.js`)
- Assert the rendered tab bar contains **no** "Diagnostics" tab.
- Assert the first tab is "Tracking" and `tab` defaults to `"tracking"`.
- Assert the strip trace block carries no click handler / pointer affordance and no
  "Tracking ↗" label.
- With serving data present, assert the strip facts row renders the moved fields
  (Cell / Channel / BW / RSSI) alongside SINR/RSRQ/Band.

## Out of scope
No backend, menu, or global_sockets changes. No change to the Tracking chunk or any
other tab. Chunk-only edit; deploy via `tools/deploy.sh`, `tools/build.sh` to gzip.
