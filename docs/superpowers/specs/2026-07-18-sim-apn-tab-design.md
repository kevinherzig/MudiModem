# SIM / APN tab — design (Phase 4)

**Date:** 2026-07-18 · **Branch:** `sim-apn` · **Status:** approved by Kevin (brainstorm session)

## 1. Why this tab exists (the "what do we add" question, answered)

This tab overlaps GL's own pages more than any other, so its value is presentation and honesty,
not access:

1. **The DSDS truth.** GL renders one "active SIM". The box's reality (session findings
   2026-07-17): both SIMs register simultaneously, exactly one carries data (`dial_status:1`),
   and the *selected* slot (`current_sim_slot`) is not always the *data-carrying* slot — seen
   live during failover. We render both slots side by side with that split made visible.
2. **Roaming honesty.** Home operator (derived from IMSI MCC/MNC) vs. serving carrier
   (`sims_status.carrier`) are different facts. Live example on the box: slot 2 is a
   Proximus-based travel SIM (IMSI 206-01) whose status reports "AT&T" — we render
   *"Roaming on AT&T"*, not a silent lie.
3. **Consolidation.** Full dial profile editable in place, with the per-SIM `apn_list`
   (GL's carrier DB, already on the websocket) as one-click suggestions instead of a blank
   text field.

## 2. Decisions locked in brainstorming

| Question | Decision |
|---|---|
| Slot switching | **Include, confirm-dialog only.** No watchdog auto-revert — a switch-back is itself disruptive; GL's own failover is the recovery path. Dialog states plainly: drops connectivity ~30 s. |
| APN editing scope | **Full dial profile**: apn, auth (NONE/PAP/CHAP), username, password, ip_type, roaming, manual/auto — plus `apn_list` suggestion chips. |
| Failover config | **Full failover config editable**: enable_switch, slot priority order, scheduled switch-back (enable_timing + time). |
| Write path | **Browser-direct GL RPC** (`modem.*` objects are undotted → callable from the page, same code path GL's own UI uses). **Zero backend changes; Phase 4 is chunk-only.** |

## 3. Verified RPC / data surface (probed 2026-07-18)

### Reads — free over `global_sockets` (already in our menu JSON)
- `cellular.sims_info` → per slot: `iccid`, `imsi`, `mcc`, `mnc`, `phone_number`,
  **`apn_list`** (carrier-DB APN suggestions).
- `cellular.sims_status` → per slot: `carrier`, `status` (0 no-SIM · 5 not-registered ·
  6 registered), `strength`, `type`, `technology`, current `apn`.
- `cellular.networks_status` → per slot `dial_status` (1 = carrying data).
- `cellular.modems_status` → `current_sim_slot` (selected slot), `slot_switch_status`,
  `slot_switch_count`.

### Reads — fetched once on tab entry (`$rpcRequest`, browser-direct)
- `modem.get_sim_config` → full per-SIM config. Confirmed shape from GL's own drawer model
  (internet chunk @618354): `{protocol, apn, ip_type, network_mode, rrc_seg, device, service,
  auth, username, password, dial_number, ttl, hl, mtu, roaming, band_enable, band_filter_mode,
  lte, nsa, sa}`. ⚠️ Exact *args* (iccid vs bus) to be captured at build time from the call site.
- `modem.get_slot_failover_config {bus}` → `{enable_switch, esim2_enable, current_sim,
  slot_priority: [1,2], enable_timing, hour, min, slot_type: [{slot,type},…]}` (confirmed from
  GL chunk @574273/@575091).

### Writes — browser-direct, two methods total
- `modem.set_sim_config` — dial profile. **⚠️ The same object carries the band config**
  (`band_enable, band_filter_mode, lte, nsa, sa`). A partial write could clobber the n71 band
  lock. **Read-modify-write is mandatory:** `get_sim_config` → merge only our dial fields →
  `set_sim_config` with everything else passed through untouched.
- `modem.set_slot_failover_config` — **both** failover config *and* manual slot switch.
  Confirmed: GL's own switch dialog applies this method with `current_sim` set
  (`handleSimSwitchApply` / `handleChangeSim` in the internet chunk). `mvas.switch_sim_slot`
  exists but is GL's simo/eSIM flow; we follow the main-UI path. (Re-verify at build time.)

### Ruled out at the modem layer
`AT+QUIMSLOT` / `QDSIM` / `QUSIM` all ERROR on the RG650V-NA — slot selection is GL-layer only
(reference §7). No AT is sent by this tab at all.

## 4. Layout

Two slot cards + one failover card. Cards go single-column under 720 px (UI spec §6).

### Slot card (one per physical slot; selected card ringed mint)
- **Header:** carrier name + "Slot N". Fact badges, each a distinct colour + non-colour cue
  (UI spec §6):
  - `Selected` — `current_sim_slot` matches.
  - `Carrying data` — `dial_status === 1` for this slot.
  - Registration: `Registered` / `Not registered` / `No SIM` from `sims_status.status`.
  - During failover the user sees `Selected` on one card and `Carrying data` on the other —
    the state GL cannot render.
- **Identity (read-only):** home operator resolved from MCC/MNC (small static PLMN table in the
  chunk — common carriers only, fall back to raw `MCC-MNC`); if it differs from
  `sims_status.carrier`, show *"Roaming on ⟨carrier⟩"*. ICCID, IMSI, phone number — masked by
  default, click-to-reveal (GL's `isPrivate` treatment).
- **Dial profile (editable form):**
  - APN text field + `apn_list` rendered as suggestion chips (click fills the field).
  - Auth select (NONE/PAP/CHAP); username/password shown only when auth ≠ NONE.
  - IP type select (v4 / v6 / v4v6, from `ip_type` int).
  - Roaming toggle; Auto/Manual APN toggle (the `manual` flag — seen in ubus
    `cellular.sim get_config`, absent from the `modem.get_sim_config` drawer model; probe §7.5).
  - **Apply** per card → read-modify-write via `set_sim_config`. Show GL-style warning if a
    redial results (probe at build time whether it always does).
- **"Use this SIM"** button on the non-selected card only → confirm dialog: *"Switching SIMs
  drops connectivity for ~30 seconds. The admin session will stall until the new SIM connects."*
  → `set_slot_failover_config` with `current_sim` → watch `slot_switch_status` on the websocket
  and show a switching state on both cards until it settles.

### Failover card
- `enable_switch` toggle (auto failover on/off).
- Slot priority: two-row ordered list with a swap control (maps to `slot_priority`).
- Scheduled switch-back: `enable_timing` toggle + time picker (`hour`/`min`) — GL's "scheduled
  switch to preferred SIM".
- Apply sends the **full** config object (mirroring GL's `handleApply`: when `enable_switch` is
  on, `current_sim` follows `slot_priority[0]`).
- Footnote (UI spec §4): why `sub_id` must follow the active slot — both SIMs stay registered;
  `sub_id=0` answers for the wrong SIM (CLAUDE.md §6).

## 5. Error handling & safety

- **Clobber guard:** never send `set_sim_config` without a fresh `get_sim_config` merge
  (band fields ride along). If `get_sim_config` fails, the Apply button stays disabled —
  no blind writes.
- Handle all `$rpcRequest` rejection shapes (§6): `accessDenied`, `invalidParams`, `timeout`
  (expected during a slot switch — the link drops), `rpcCancel`. Timeout after a switch is
  *not* an error state; keep the switching indicator until the websocket confirms.
- Editing is per-card and non-destructive until Apply; no auto-run anywhere.
- No interaction with the Bands revert watchdog — different config surface; band pending-revert
  state does not lock this tab.

## 6. Out of scope (deliberate)

PIN management, eSIM management (`esim2_enable` displayed if present but not editable), traffic
caps, TTL/MTU/dial-number/protocol/network-mode advanced fields (pass through untouched in RMW;
GL's dialogs remain the place to edit them).

## 7. Build-time probe tasks (before code — plan must front-load these)

1. Exact `modem.get_sim_config` request args (iccid? bus? slot?) — read the call site in the
   internet chunk; confirm with one live authenticated call.
2. Does `set_sim_config` always trigger a redial, or only when dial fields change? (GL shows a
   warning only while `dialing`.)
3. Confirm `set_slot_failover_config {current_sim}` performs the switch on this firmware
   (vs `mvas.switch_sim_slot`) — one live test at a moment a dropped link is acceptable.
4. `ip_type` int → v4/v6/v4v6 mapping (from GL's select options in the chunk).
5. Where the Auto/Manual APN flag lives in `modem.get/set_sim_config` (ubus
   `cellular.sim get_config` returns `manual: true`; the GL drawer model shows no such field —
   it may be implied by `protocol` or handled elsewhere). If it isn't representable via
   `modem.set_sim_config`, drop the toggle rather than adding a backend method.

## 8. Testing

- Extend `test/chunk.test.js`: eval the chunk with stubbed `moduleStatus` fixtures for the
  probed shapes above, including the failover split state (selected=1, data on 2) and the
  roaming-SIM case (MCC/MNC ≠ carrier).
- RMW merge is a pure function → unit-test it directly (band fields survive a dial-profile edit).
- On-device: `tools/verify.sh` unchanged (no new files); manual pass per §7 probes.
