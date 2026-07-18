# Cell-lock tab — design

**Date:** 2026-07-18 · **Branch:** `cell-lock` · **Status:** approved (Kevin, 2026-07-18)

Locks the modem to a specific cell (PCI + ARFCN) so it stops wandering to a worse one. Built on
`AT+QNWLOCK` **through GL's own cell-tower stack**, wrapped in MudiModem's confirm-or-revert safety
net. Supersedes the Cell-lock section of `2026-07-17-mudimodem-ui-design.md` where they disagree
(the "pin from a live neighbour list" premise is dead — see §1).

## 0. Recon results (2026-07-18, all read-only — no set forms fired)

These close most of CLAUDE.md §6a's open questions. Evidence: strings in `/usr/lib/libcm_modem.so`
(GL's cellular_manager modem lib), `/lib/functions/modem.sh`, GL's `internet` chunk, and live query
forms.

| Question | Answer | Source |
|---|---|---|
| Lock NR | `AT+QNWLOCK="common/5g",<pci>,<arfcn>,<scs>,<band>` | libcm format string, order matches box `=?` |
| Lock LTE | `AT+QNWLOCK="common/4g",1,<earfcn>,<pci>` — GL hardcodes **mode 1**; other 0–10 values unused by GL | libcm |
| Clear | `AT+QNWLOCK="common/4g",0` / `"common/5g",0` — community lore confirmed | libcm unlock flow |
| `save_ctrl` | `save_ctrl,1,1` on lock, `0,0` on unlock ⇒ the two flags are per-RAT (4g,5g) persistence; with `1` the **modem itself** re-locks after reboot | libcm |
| Side effects | Locking 5G forces `mode_pref=NR5G`; locking LTE forces `mode_pref=LTE:NR5G` + `nr5g_disable_mode=1` | modem.sh (same ATs as libcm ships) |
| SA neighbours | **None.** `AT+QENG="neighbourcell"` returns bare `OK` on NR5G-SA | live query |
| GL's scan | `modem.scan_cell_tower {bus,slot}` → `AT+QSCAN=3,1`; up to 10 min (GL's UI uses a 600 s timeout); modem offline meanwhile | libcm + internet chunk |
| GL's store | `modem.get_cell_tower {bus}` → `{slot1:{cellid,…},slot2:{…}}`; `modem.set_cell_tower {bus,slot,lock:bool,…towerInfo}`; error codes 20002044 (lock), 20002050 (unlock), 20002052 (save) | internet chunk |
| UCI path | `glmodem.tower_sim<slot>` + `modem_AT_lock_cell_tower()` in `/lib/functions/modem.sh` is **dead code on 4.8.5** — nothing calls it; `uci show glmodem` has only `global` | grep of hotplug/init callers |
| Mutual exclusion | GL refuses tower lock while an operator lock exists (and vice versa) | modem.sh |
| Direct `glc` exec | **Segfaults** from shell — not a watchdog path. Server-side `ngx.location.capture("/cgi-bin/glc")` is oui's own mechanism and is available to our Lua backend, sid-free | live test + `oui-lib-rpc.lua` |
| Softer alternative | `AT+QNWCFG="nr5g_earfcn_lock"/"lte_earfcn_lock"` — frequency-only lock lists exist (future option, out of scope) | `AT+QNWCFG=?` |
| Crossed AT replies | Reproduced again on `modem.CPU.AT` (a query answered with the next query's payload) — backend must validate reply prefixes | live |

**Still unknown:** `<scs>` encoding (GL copies it verbatim from `QSCAN` output — resolved by the
supervised live-fire test, §5). `QSCAN` is absent from the 5-series manual too.

## 1. Decisions (made with Kevin, 2026-07-18)

1. **Write path: GL's stack** (`set_cell_tower` et al.), not raw-AT-only. Durable, GL's UI agrees
   with reality (no "UI lies" sin of our own), no durability-gap fight with cellular_manager.
2. **Safety: confirm-or-revert on top**, same as bands. The earlier "GL stack = no revert window"
   tradeoff is obsolete: the watchdog can restore the *link* from plain shell via raw AT unlock
   (`common/X,0` + `save_ctrl,0,0` + mode-pref restore), and GL-store reconciliation happens through
   the backend once connectivity is back.
3. **Cell list: pin-current primary, scan secondary.** SA exposes no neighbour list, so the UI
   spec's "pin from a live table" reduces to the serving cell; GL's disruptive scan (behind an
   honest warning) provides the full pick-list.

## 2. UI — three cards, revert banner inline (C1, as Bands)

- **Current cell** — serving cell from `global_sockets` (PCI, ARFCN, band chip, cell ID,
  RSRP/RSRQ/SINR in GL's quality ramp) + lock state. Primary button **Lock to this cell** — the
  main use case and the safest possible target. When locked: mint "Locked" badge + **Unlock**.
  Disabled (with reason shown) while any pending change exists or an operator lock is set.
- **Nearby cells** — empty state says the truth: *"5G SA exposes no neighbour list; scanning takes
  the modem offline for up to ~10 minutes."* **Scan for cells** → confirm dialog → GL scan →
  table sorted by strength (RAT, carrier, band, ARFCN, PCI, RSRP/RSRQ, per-row **Lock**). Last
  results kept with a "scanned N min ago" stamp. The status strip shows the scan outage honestly.
- **Recovery** — the danger card from the UI spec: what persists where (`save_ctrl` ⇒ modem NV;
  GL store ⇒ survives everything short of its own unlock), the ssh panic line, and a reconcile
  banner whenever GL's store and the modem disagree.
- Confirm dialog states the side effect plainly: *"Locking to a 5G cell also switches network mode
  to 5G-only until unlocked."* (LTE variant accordingly.)

## 3. Backend (`mudimodem` methods)

| Method | Does |
|---|---|
| `get_lock {}` | `AT+QNWLOCK="common/4g"/"common/5g"/"save_ctrl"` (explicit active sub_id, never 0) **+** glc `modem.get_cell_tower` → returns modem truth, GL store, and an `agree` flag |
| `scan_cells {}` | glc `modem.scan_cell_tower {bus:"cpu", slot:<active>}`, long timeout; returns GL's towers list verbatim |
| `set_cell_lock {rat, pci, freq, scs?, band?}` | validate ints → refuse if operator lock or pending exists → snapshot previous lock + `mode_pref` + `nr5g_disable_mode` to `pending.json` → arm watchdog → glc `modem.set_cell_tower {…, lock:true}` |
| `confirm {}` (existing) | clears pending — GL store and modem already agree |
| `revert_now {}` (existing) | for a cell pending: glc `set_cell_tower {lock:false}` + restore mode prefs + clear pending |

Watchdog (`mudimodem-revert`) gains a cell mode: raw AT unlock for the pending RAT +
`save_ctrl,0,0` + mode-pref restore from `pending.json`, then drops a `gl-store-stale` marker;
`get_lock` sees marker/mismatch and the page offers one-click reconcile (backend GL-level unlock).
`--panic` additionally unlocks **both** RATs + `save_ctrl,0,0` + `mode_pref,AUTO`.

Single-pending interlock is shared with Bands: one experiment at a time (existing `pending.json`
semantics).

## 4. The SCS gap (pin-current on NR)

No live source reports the serving cell's SCS (`QENG`/`QCAINFO`/`QNWCFG` checked). Resolution
order for **Lock to this cell** on NR:
1. a cell in the last scan results matching serving PCI+ARFCN — scan carries `scs` verbatim;
2. else a 3GPP band-default table (n71 → 15 kHz) shipped in the chunk with explicit provenance;
   the confirm dialog displays the assumed value.

Scan-row locks pass GL's `scs` through untouched, exactly as GL does. LTE pin-current has no gap:
`common/4g` mode 1 needs only EARFCN + PCI, both live in `QENG`/websocket data.

## 5. Supervised live-fire test (its own plan milestone — the only set-form firing)

Preconditions: Kevin present, ssh session open, watchdog armed, target = **current serving cell**
(locking to the cell you're already on is the minimum-risk lock).
Run once: lock via our full stack → query `AT+QNWLOCK="common/5g"` (response reveals the SCS
encoding for the very cell we're on) → verify GL's `get_cell_tower` agrees → unlock → verify
clean state. This confirms SCS encoding, `towerInfo` field names, and the whole write path in one
pass. **No set forms are fired before this milestone.**

## 6. Error handling

- GL error codes surfaced with GL's own i18n strings (20002044/20002050/20002052).
- Crossed-AT-reply guard: every AT read validates the reply prefix matches the query; retry once.
- Operator-lock conflict → disabled control + explanation, never a failed write.
- Scan failure/timeout → honest error, previous results kept.

## 7. Testing

- Node chunk test extended (eval-as-the-SPA-does + render smoke for the new cards).
- Backend validation logic under the stubbed-`ngx` harness (never `pcall` a cosocket — CLAUDE.md §8).
- `verify.sh`: new files present, watchdog modes parse (`sh -n`), pending-schema assert.
- Live-fire milestone per §5.

## 8. Plan-time verifications (not design blockers)

1. Exact `towerInfo` field names `set_cell_tower` needs — read off a real scan result.
2. The 600 s glc subrequest through `/rpc` — GL's own UI uses this exact path, expected fine.
3. `<scs>` encoding — §5.
4. Whether `set_cell_tower` requires a prior scan on this firmware or accepts hand-built
   `towerInfo` (pin-current path depends on the latter; §5 verifies).
