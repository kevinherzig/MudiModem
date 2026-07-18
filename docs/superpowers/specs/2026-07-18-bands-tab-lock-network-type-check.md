# Bands tab — network-type lock check (+ mode-display fix)

**Date:** 2026-07-18
**Status:** approved (design)
**Touches:** `src/rpc/mudimodem` (`get_bands`), `src/views/mudimodem.js` (Bands tab)

## Problem

Discovered while debugging a live report: *"modem locked to PCI 115 / ARFCN 5035, but not on
that band."* Two independent defects surfaced.

### Defect 1 — the lock is stranded by the network mode, silently
The box has a **GL tower lock to an LTE cell** (`get_feature_config.tower`:
`lock:true, network_type:"LTE", pci:115, freq:5035` — EARFCN 5035 = LTE Band 12, T-Mobile 700 MHz).
But the modem's mode preference is **`AT+QNWPREFCFG="mode_pref" → NR5G` (5G-only)**. In NR5G-SA
standalone mode the modem never selects LTE, so the LTE cell lock has nothing to bind to — it is
stored, GL reports it, yet it is inert. The modem falls through to the RAT it *is* permitted on and
camps on NR5G-SA band 41 (verified: `AT+QENG="servingcell" → NR5G-SA, band 41, PCI 478`).

This is exactly MudiModem's reason to exist (CLAUDE.md header: *scattered, and it lies*): a lock and
a mode that contradict each other, with no surface anywhere that says so.

### Defect 2 — the Bands tab shows the wrong network mode
`get_feature_config` returns **`network_mode` twice** — `"NR5G"` at the top (the real value, matching
AT `mode_pref`) and a trailing `"AUTO"`. When ubus flattens that blob into a Lua table, the duplicate
key keeps the **last** value, so `get_bands` returns `meta.mode = "AUTO"` (`src/rpc/mudimodem:291`).
The chunk sets `selMode = meta.mode` (`mudimodem.js:353`), so **"5G only" renders unselected** even
though the modem is genuinely 5G-only. The tab is reading GL's stored default, not the modem's truth.

Defect 2 also *hides* Defect 1: if the tab thought the mode were `AUTO`, no LTE/5G-only conflict would
appear to exist. Fixing the mode read is a prerequisite for the check to be correct.

## Design

### A. Backend — `get_bands` `meta` (two changes)

`get_bands` already calls `cellular.modem get_feature_config` (for `band`) and already issues AT at
the resolved `sub_id` (for `policy_band` / `ue_capability_band`). Both changes ride those existing
calls; no new round-trip pattern.

1. **Fix `meta.mode`.** Stop trusting `feat.network_mode` (the duplicate-key trap). Read the modem's
   authoritative mode from `AT+QNWPREFCFG="mode_pref"` at the resolved `sub_id`, alongside the
   existing policy/capability AT reads. Parse the value after `"mode_pref",` and normalize:
   - single token → `"AUTO" | "NR5G" | "LTE"` verbatim;
   - a colon combo that contains **both** LTE and NR5G (e.g. `"LTE:NR5G"`) → treat as `"AUTO"` for
     selector purposes (both RATs enabled);
   - unreadable → fall back to the old `feat.network_mode` so `meta.mode` is never nil.

2. **Add `meta.lock`.** From the `feat.tower` block already present in the same
   `get_feature_config` response (no extra call):
   ```
   meta.lock = { active = (tower.lock == true),
                 rat    = (tower.network_type == "LTE") and "4g" or "5g",
                 pci    = tower.pci, freq = tower.freq, band = tower.band }
   ```
   Absent `tower` or `tower.lock` falsey → `meta.lock = { active = false }`.

   Rationale for sourcing from `get_bands` rather than `get_lock`: the Bands tab always calls
   `get_bands`, but does not necessarily call `get_lock` (that belongs to the not-yet-built Cell Lock
   tab). `feat.tower` is already in hand, so the check has zero added cost and no dependency on the
   lock tab.

### B. Conflict model (frontend)

Reuse the existing `modeEnables(group, mode)` helper (`mudimodem.js:862`) — a lock's RAT must be
enabled by the applied mode:

- a `4g` lock needs `mode ∈ {AUTO, LTE}` (maps to `modeEnables("LTE", mode)`);
- a `5g` lock needs `mode ∈ {AUTO, NR5G}` (maps to `modeEnables("sa", mode)`).

```
lockRat        = meta.lock.active ? meta.lock.rat : null           // "4g" | "5g" | null
lockGroup(rat) = rat === "4g" ? "LTE" : "sa"
appliedMode    = meta.mode                                          // the modem's real mode
lockConflict   = lockRat && !modeEnables(lockGroup(lockRat), appliedMode)
```

The warning keys off **`appliedMode`** (the modem's real state), not the pending `selMode` — the
banner describes what is wrong *now*, independent of unsaved edits.

### C. Warn — inline banner on the Bands tab

When `lockConflict` is true, render a warning banner above the mode selector (same visual family as
the existing `--warning` hints). Copy names the concrete lock and the resolution, e.g.:

> ⚠ Modem is cell-locked to **LTE B12 / PCI 115**, but network mode is **5G only** — the lock
> can't take effect. Set mode to **Auto** or **4G only**, or clear the lock on the Cell Lock tab.

- Lock RAT label: `4g → "LTE"`, `5g → "5G"`; append `B<band>`/`n<band>` and `PCI <pci>` when present.
- Mode label reuses the selector's map (`NR5G → "5G only"`, `LTE → "4G only"`).
- The recommended modes are the ones that *enable* the lock's RAT (`Auto` always; plus `4G only` for
  a `4g` lock / `5G only` for a `5g` lock).
- No buttons, no writes. Resolution is the user's, on the appropriate tab.

### D. Block — mode selector disables the stranding option

In `renderMode` (`mudimodem.js:1181`), when a lock is active, the mode option that would strand it is
the *stranding option*:

- `4g` lock → stranding option is **"5G only"** (`NR5G`);
- `5g` lock → stranding option is **"4G only"** (`LTE`);
- **"Auto"** is never stranding (enables both RATs).

**Precise block rule** — the stranding option is disabled **unless it equals `appliedMode`**:

- If the modem is **not** currently in the stranding mode → the stranding option is `disabled` with a
  `title` tooltip ("Would strand your LTE/5G cell lock — clear the lock first"). The user cannot move
  *toward* the conflict.
- If the modem **is** currently in the stranding mode (this box: `NR5G` under an LTE lock) → that
  option is **left enabled and rendered selected-but-flagged** (`on`, not greyed), so the current
  state stays legible. Disabling the very option that is selected would read as broken, and we never
  auto-write a mode change on the live cellular link — the banner (C) carries the "how to fix."

So the disabled predicate is: `isStrandingOption(o) && o !== appliedMode`.

Interaction with `setMode`: `setMode(m)` refuses any target for which that predicate is true (guard
mirrors the disabled attribute), so a stale render can't apply a stranding mode.

## Non-goals / YAGNI

- No auto-fix action (no one-click "switch mode" or "clear lock") — the user chose **warn + block**,
  not warn + fix.
- No change to `set_bands` write path, revert/confirm, or the cell-lock backend.
- No new ubus/AT round-trips beyond the single `mode_pref` read folded into the existing AT batch.
- Does not resolve the separate §5a durability gap or build the Cell Lock tab.

## Verification

- **Backend, live read-only:** `get_bands` at the active `sub_id` returns `meta.mode == "NR5G"`
  (not `"AUTO"`) and `meta.lock == {active:true, rat:"4g", pci:115, freq:5035, ...}` on the current
  box state. A `/rpc` round-trip (verify.sh §9 style), not just a `dofile` (the stub path bypasses
  the duplicate-key ubus flattening this fix depends on — assert against the real ubus response).
- **Frontend, Node chunk test (`test/chunk.test.js`):** with `meta.mode="NR5G"` +
  `meta.lock={active:true,rat:"4g",...}`, `lockConflict` is true, the banner renders, and the mode
  selector marks "5G only" disabled=false-but-flagged while a *hypothetical* AUTO-start would block
  it. Add a fixture for the no-lock case (`meta.lock.active=false` → no banner, all modes enabled).
- **Manual (browser):** Bands tab now shows "5G only" selected and the conflict banner; the "5G only"
  option carries the tooltip; no writes fire from viewing.
