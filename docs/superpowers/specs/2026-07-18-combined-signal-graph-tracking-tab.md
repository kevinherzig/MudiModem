# Spec: Combined signal graph + Tracking tab

**Date:** 2026-07-18
**Status:** approved (design), pending implementation plan
**Touches:** `src/views/mudimodem-tracking.js`, `src/views/mudimodem.js`,
`test/tracking.test.js`, `test/chunk.test.js`

## Motivation

Two small UX changes to the signal history surface:

1. The Tracking page (`/mudimodem-tracking`, the "uber graph") currently stacks
   **three separate lane graphs** — RSRP, SINR, RSRQ — each in its own vertical
   band with its own Y-axis. Collapsing them into **one overlaid graph** frees
   vertical space and gives a larger single viewing area.
2. The Tracking page is reachable only through a small **"History →" link** in
   the status strip. Promote it to a proper **tab** in the main tab bar.

Neither change touches the backend, the collector, or the RPC surface — this is
purely presentation in the two Vue view chunks.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| How do 3 incompatible-scale metrics share one graph? | **Normalized overlay** — all three lines in one plot area, each mapped to its own domain. |
| Line coloring | **Fixed color per metric** (quality moves to the hover readout + left labels). Not the per-quality segment coloring the lanes use today. |
| Tab behavior | **Tab navigates to the full-screen route** `/mudimodem-tracking` (the page stays its own component; it is not embedded in-page). |
| Strip mini-sparkline | **Keep it**, and make it clickable → opens the Tracking route. Only the redundant "History →" link is removed. |
| Tab label | **"Tracking"** (matches the component/route name). |

## Goal 1 — Combine the three lanes into one overlay graph

**File:** `src/views/mudimodem-tracking.js`, primarily `renderLanes(h)` and the
`LINES` constant.

### Current behavior (to replace)

`renderLanes` iterates `LINES` (the three metrics), and for each:

- reserves a vertical band of height `L.h` (120 / 84 / 84) at a running `y`,
  advancing `y += L.h + 22` between lanes;
- computes a **per-lane** scaler `yv(v)` mapping `L.dom` into that band;
- draws top/bottom border lines, a dashed **mid** line at `L.mid`, and three
  numeric axis labels (`d1` top, `d0` bottom, `mid`);
- draws the metric as **quality-segmented** paths: a `run`/`flush` loop splits
  the line wherever `qFromLevel(s[L.lvl])` changes, stroking each segment with
  `qColor(runQ)`.

Total plotted height for the three lanes is ~330px before the buses.

### New behavior

- **One shared plot rectangle.** Define a single plot band of height
  `PLOT_H` (target ~220–240px; final value chosen so the whole SVG, buses
  included, is not taller than the old layout). All three metrics render into
  this same rectangle at the same `y` origin.
- **Per-metric normalized scaler.** Each metric keeps its own `dom`
  (`[d0,d1]`) but maps into the shared rectangle:
  `yv_L(v) = plotY0 + PLOT_H - (clamp(v, d0, d1) - d0) / (d1 - d0) * PLOT_H`.
  So each line still uses its full dynamic range; they simply overlap.
- **One continuous path per metric, fixed color.** Remove the quality
  `run`/`flush` segmenting. For each metric, build a single path over the
  window's samples in that metric's fixed color; a `null` sample breaks the
  path into a new subpath (gap), preserving the existing "gaps on missing data"
  behavior.
- **Colors — GL theme tokens, one per metric, distinct hues.** Proposed:
  - RSRP → `--primary` (blue, the headline metric)
  - SINR → `--success` (mint)
  - RSRQ → a violet/rose token
  Per CLAUDE.md §8, colors are **extracted from GL's theme, never hand-picked**.
  During implementation, confirm the exact three tokens against
  `/www/theme/base.css` (+ `theme/{default,classic,dark}/index.css.gz`) so all
  three read as distinct hues in **both** light and dark themes. The RSRQ token
  is the one to verify most carefully (the mockup intent is purple; fall back to
  a rose/`--error`-family token only if no violet reads well in both themes).
- **Legend (new).** A single shared Y-axis cannot label three different scales,
  so add a small legend: three colored swatches, each with the metric name and
  its domain range, e.g. `RSRP −120…−80 dBm · SINR −10…30 dB · RSRQ −20…−3 dB`.
  Render it just above or inside the plot header. Exact per-sample values remain
  available in the hover readout.
- **Gridlines / axis labels.** Drop the per-lane numeric axis labels and the
  three per-metric dashed mid-lines. Frame the shared plot with top and bottom
  border lines plus **one** faint horizontal gridline at 50% of `PLOT_H`.
  Shrink the left gutter `PADL` (currently 46, sized for stacked numeric labels)
  now that no per-lane numbers are drawn — pick a value that still clears the
  legend/frame.

### Unchanged

- **BAND / CELL / SIM buses** below the plot (the `BUSES` loop, `busRuns`).
- **Event markers** — vertical dashed lines spanning plot-top → buses-bottom.
- **Time ticks** along the bottom and the range selector (15 m / 1 h / 6 h / 24 h).
- **Cursor / pin interaction** (`onMove`, `onClick`, `mFromEvent`, `parseHash`
  `#m=` / `#w=`).
- **Hover readout** (`sliceReadout`) — it already lists RSRP / SINR / RSRQ with
  quality coloring. This is now the primary place quality is shown, so no change
  is needed there beyond it continuing to work.

## Goal 2 — Promote Tracking to a tab

**File:** `src/views/mudimodem.js`.

- **Add the tab.** Append `["tracking", "Tracking"]` to the `TABS` array
  (rendered around line 655–662). Special-case its click handler so it calls
  `this.$router.push("/mudimodem-tracking")` instead of `self.tab = "tracking"`.
  It must **never** render with the `on` class (it is a nav shortcut, not an
  in-page panel), and it adds **no** panel branch in the render's `if
  (this.tab === …)` chain.
- **Remove the "History →" link.** Delete the strip button at lines 610–614
  (the `mm-tab`-styled button inside `mm-trace`).
- **Keep the sparkline, make it clickable.** The `mm-trace` / `mm-plot`
  sparkline stays. Attach a click handler (on `mm-trace` or `mm-plot`) that
  does the same `this.$router.push("/mudimodem-tracking")`, so clicking the
  live trace opens the Tracking route. Add a `cursor: pointer` affordance.

No router registration changes — `/mudimodem-tracking` already exists as a
hidden route (menu `level:0`).

## Testing

- **`test/tracking.test.js`** — the current assertions that depend on the
  three-lane layout change:
  - lane/band count and per-lane Y offsets → one shared plot;
  - quality-segmented path assertions → **one path per metric** in a fixed
    color;
  - add an assertion for the **legend** presence (three metric labels + ranges);
  - buses / events / ticks / cursor assertions should continue to pass
    unchanged (regression guard).
- **`test/chunk.test.js`** — the strip no longer contains `"History →"`; the
  `TABS` list includes `"Tracking"`; the sparkline is present and its container
  carries a click handler. Keep evaluating the chunk exactly as the SPA does
  (stub `module` + `h`).
- Both chunks must still `eval` cleanly as expressions (`module.exports = {…}`)
  and remain Vue-2.6 runtime-only (`render(h)`, no `template:`).

## Out of scope

- No changes to `mudimodem-collectd`, the history backend, or the RPC surface.
- No new metrics, ranges, or persisted state.
- No embedding of the Tracking component inside the main page (explicitly
  rejected in favor of route navigation).
