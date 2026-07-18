# Banner mode-lock + tower-lock badges

**Date:** 2026-07-18
**Status:** approved

## Goal

Surface two control-state indicators in the always-on RSRP status strip: the **network
mode lock** (Auto / 4G-only / 5G-only) and the **tower (cell) lock** (locked to a
PCI/ARFCN, or unlocked). Today neither is visible at a glance — the case that motivated
this was Auto mode + an active LTE tower lock leaving the modem stuck on LTE, with nothing
in the banner explaining why.

## Behavior (decided)

- **Always visible, muted when idle.** Auto / Unlocked render in a quiet grey; a real
  restriction turns the badge bold/colored. Silence is never ambiguous.
- **Placement:** right-aligned on the "RSRP live" eyebrow row of the strip — a status
  header, visually separate from the live-measurement KPIs below.

| State | Mode badge | Tower badge |
|---|---|---|
| Idle | `Auto` — grey (`--text-hint`) | `🔓 Unlocked` — grey |
| Active | `4G only` / `5G only` — amber (`--warning`) | `🔒 <RAT> <band|PCI>` — rose (`--error`) |

- Mode text maps `AUTO→"Auto"`, `LTE→"4G only"`, `NR5G→"5G only"`.
- Tower badge when locked: compact `🔒 <RAT> <band-or-PCI>`; the full `lockLabel()` string
  (e.g. `LTE B12 / PCI 115`) goes in the badge `title` tooltip.
- Clicking a badge jumps to its tab: mode → Bands, tower → Cell lock.

## Data source

`get_bands` already returns `meta.mode` and `meta.lock` in one call, and the existing
computeds `appliedMode()`, `lockInfo()`, `lockLabel()` read them. The only new plumbing:
call `fetchBands()` once in `mounted()` (guarded), alongside the existing tracking load, so
the badges have data on every page load regardless of which tab is active. No new backend
method; no extra AT reads beyond that one `get_bands` call.

## Freshness

After a cell-lock change confirms, the code currently refetches only lock state
(`fetchLock`). Add a `fetchBands()` refresh on the cell-lock confirm/clear paths so the
tower badge updates without a page reload. Band/mode writes already refetch bands.

## Edge cases

- Render the badges only once `this.bands` is loaded (sub-second gap). If `get_bands`
  fails, badges stay hidden rather than falsely asserting "Unlocked".
- When the websocket has not pushed status yet, the whole strip is in its "waiting" state
  and shows no badges (unchanged).

## Testing

Extend `test/chunk.test.js`: eval the chunk with stubbed `bands.meta` for the four
state combinations (Auto/Unlocked, 4G-only, 5G-only, locked) and assert the badge text and
class; assert `mounted()` triggers a `get_bands` call.

## Scope

Reuses `appliedMode()` / `lockInfo()` / `lockLabel()` verbatim. Render change ~15 lines,
one CSS class (`.mm-lockbadge`), one line in `mounted()`, and a `fetchBands()` call on the
lock confirm/clear paths. Chunk-only — no backend, menu, or validator change.
