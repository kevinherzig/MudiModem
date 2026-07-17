# MudiModem — UI design

**Date:** 2026-07-17
**Status:** design agreed; band data unverified (see Open questions)
**Mockup:** `.superpowers/brainstorm/782253-1784289176/content/design.html` (self-contained, opens in any browser)
**Supersedes the UI portions of:** `2026-07-16-mudimodem-design.md`

---

## 1. The design driver

Every other page in GL's admin is safe to operate. This one isn't: **you change the radio over the link
the radio provides.** Band and cell locks persist in modem NV — they survive reboot, reflash, and factory
reset (CLAUDE.md §9). A bad lock can drop the cellular link you're administering over.

So the page is built as an **RF field-test instrument**, not a dashboard. Its single job:

> change the radio → watch the radio answer → keep it or let it revert.

Every layout decision below follows from that loop. Where the loop didn't drive a decision, GL's own
idiom wins — the page must read as part of the admin, not as a bolt-on.

## 2. Visual system — GL's, not ours

**All colour is extracted from the device**, `/www/theme/base.css` + `default|dark/index.css`. Nothing is
invented. Using Element UI's stock palette (an earlier mistake) would have been visibly wrong: GL's
`--success` is mint `#00c8b5`, not leaf-green; `--error` is rose `#e04c7e`, not red; and the text ramp is
purple-tinted (`#141427` / `#1f1f3d` / `#333366`), not neutral gray. That violet undertone is the house
identity.

| Role | default (light) | dark |
|---|---|---|
| `--primary` | `#5272f7` | `#4665de` |
| `--success` | `#00c8b5` | `#00c8b5` |
| `--warning` | `#f5a623` | `#db951f` |
| `--error` | `#e04c7e` | `#c94471` |
| `--text-regular` | `#141427` | `#b9b9bd` |
| `--background-card` | `#fff` | `#141427` |
| `--background-content` | `#ebebf0` | `#222223` |
| `--border` | `#d2d2d6` | `#87878a` |

**Signal-quality ramp — use GL's, don't invent one.** `gl-sdk4-ui-modemsignallog` already maps:
`poor → --error`, `fair → --warning`, `good → --info-hover`, `excellent → --success`. The box already
shows this ramp on its own signal page; matching it is what "native" means here.

Read the active theme from the SPA (`theme_list: ["default","classic","dark"]`, `$getThemeRealVal`).
Because every colour is a token rather than a literal, dark costs one class.

**Type:** GL's system stack (`SF Pro Text, -apple-system, Helvetica Neue, …`). No web fonts — the chunk
is served from the router and must not depend on a CDN. Personality comes from *treatment*, not family:
`font-variant-numeric: tabular-nums` on every RF figure, `ui-monospace` for ARFCN/PCI/AT.

Base size stays at GL's 13px. **One deliberate departure:** the RSRP readout is 29px/600/`-0.025em`.
Justified by the instrument framing — this is the only page in the admin whose job is watching a number
change. Accepted risk: it will look unlike neighbouring GL pages in emphasis.

**Radius:** 4px cards, 3px controls, 2px tags — GL's own conventions.

## 3. The signature — the monitor strip

The status strip (locked decision: **above the tabs, visible from every tab**) is **not a row of stat
tiles**. It is a **live RSRP trace spanning the strip, with the current value pinned at the right edge
and a dashed tick dropped at the instant of every change.**

Why this and not a KPI row:

- A KPI row is the template answer, and it's the wrong object. The trace is the thing; the number is
  merely its current value. Inverting that hierarchy is what makes this an instrument rather than a
  dashboard.
- **It's what makes the revert decision answerable.** The countdown asks "keep this?" — a judgement about
  whether RSRP/SINR actually improved after the modem re-registered. The strip must be holding the
  evidence at the moment the question is asked.
- The change-tick is the loop made visible: apply → tick drops → watch the trace after the tick.

**Fixed domain, −120 to −80 dBm.** Never auto-scale to the series' own range — that makes noise look like
signal. A fixed field-test domain means height is absolute, flat means stable, and a step means the change
did something.

Line colour tracks the quality ramp (§2), so the trace and readout go mint → amber → rose as it degrades.

## 4. Tabs

Five equal citizens: **Diagnostics · Bands · Cell lock · AT console · SIM**.

### Diagnostics
Serving-cell facts as a definition list (operator, mode, band+freq, PCI, ARFCN, bandwidth, TAC, slot),
then **small multiples** for RSRP / SINR / RSRQ — stacked, time-aligned, each with its own fixed domain.

**Never a shared or dual axis.** RSRP is dBm; SINR and RSRQ are dB. Overlaid, their crossings would carry
no meaning. Three plots, three scales, one x-axis.

### Bands
The reason the project exists. GL ships band masking, but the gap Kevin identified is *"here's every band
the modem supports — check the ones I'll allow"* rather than lock-to-current.

- **Chips ordered by frequency, low → high**, with the axis labelled ("600 MHz — reaches far, goes through
  things" … "3.7 GHz — fast, short range"). Numeric order is an accident of standards committees: n2 and
  n25 are both 1900 MHz; n71 and n78 sit at opposite ends of usable spectrum. Frequency order makes
  left-to-right mean something physically true, so "only the bands that reach" is a spatial gesture rather
  than a lookup. Cost, accepted: hunting for a band *by number* now requires reading.
  Neither GL nor Peplink does this.
- Chip carries **band number (primary) + MHz (secondary)**.
- **Checked (indigo) and serving (mint ring + dot) are different facts and never share a colour.**
- Three groups — SA / NSA / LTE — because they're three separate AT commands anyway
  (`nr5g_band` / `nsa_nr5g_band` / `lte_band`). Peplink flattens what is really three lists.
- Per-group **All · None · Known-good**; footer **Lock to current** + **Apply**.
- Mode toggle is **"Auto" / "Choose bands"** — not GL's `band_filter_mode` 0/1 "Open/Block", which nobody
  can parse.
- The count (`18 of 18 supported · 1 allowed`) is deliberate: the premise is the full supported set. If it
  ever reads fewer than the RG650V supports, that's the bug, stated out loud.

**No gradient on the axis rule.** An earlier draft ran it mint→amber→rose — GL's *quality* colours — which
read as "high frequency is bad". Wrong meaning; cut.

### Cell lock
**A selection task, not data entry.** Nobody types a PCI from memory. Show the cells actually in range
(serving + neighbours) as a table with a **Pin** button per row — PCI, band, ARFCN, RSRP, SINR, quality-
coloured.

Second card states the danger plainly: locks live in modem NV and survive reflash + factory reset, so
here is the ssh way back (`/usr/sbin/mudimodem-revert --panic`) and a **Restore known-good** button.
This is the only honest place for it — it's the recovery surface.

### AT console
The sharp edge, and labelled as such: no validation, no auto-revert, locks written here persist in NV.
Transcript + prompt + **six canned commands** (fill the prompt, don't send). Restrained terminal treatment
inside a GL card — monospace and `--background-title`, not a black box.

### SIM
Two slot cards, active one ringed mint. APN editable, ICCID read-only, per-slot registration state,
switch button, failover toggle. Footnote states why `sub_id` must follow the active slot (both SIMs stay
registered; default `sub_id=0` answers for the wrong SIM — CLAUDE.md §6).

## 5. Auto-revert UI

Locked decision **C1: inline, plain** — the banner sits on the tab that caused it, next to the Apply
button. No countdown chip on other tabs.

This works *only because* the strip carries the trace: leave the Bands tab and you lose the countdown, but
you keep the evidence and the readout, and the watchdog protects you regardless. The cost of wandering off
is a lost experiment, not a lost router.

Amber (`--warning`), countdown + draining bar, **Revert now** / **Keep**. Copy: *"Reverting to your
previous bands in 60s. Watch the trace — if it didn't help, do nothing."* — the default is safe, and the
sentence says so.

The UI is **not** the safety mechanism. The detached watchdog (`/usr/sbin/mudimodem-revert`) fires whether
or not a browser is open (CLAUDE.md §5).

## 6. Quality floor

- Responsive: strip stacks under 720px; tabs scroll; SIM slots go single-column.
- Keyboard: real `<button>`s, `role="tab"`/`aria-selected`, `aria-pressed` on band chips, visible
  `:focus-visible` rings.
- `prefers-reduced-motion: reduce` kills the trace animation and bar transition.
- Every state colour also carries a non-colour cue (ring, dot, tag, position).

## 7. Implementation constraints (unchanged, restated)

- **Vue 2.6.12 runtime-only** → `render(h)` only, `template:` forbidden (CLAUDE.md §5).
- Chunk must be an **expression statement**: `module.exports = {...};` — it's `eval`'d.
- Ship gzipped only (`gzip_static on`); `?_t=` cache-buster means no hard-reload when iterating.
- Backend calls via `window.$rpcRequest("call", ["sid", "mudimodem", "<method>", {}])` — `"sid"` is a
  verbatim placeholder.
- Charts are **hand-rolled inline SVG**, not `gl-line-chart`. The trace needs a fixed domain and
  change-markers; GL's component gives neither. Cost is ours, and it's small — two `<path>`s and a `<g>`.

## 8. Open questions

1. **⚠️ The band lists in the mockup are invented.** They're the §5 known-good SA/NSA lists, not the
   modem's supported set; the LTE list is a plausible US set with no evidence behind it. **Phase 1 must
   query the modem and render what it actually reports.** If the real SA set is 40+ bands the grid roughly
   doubles in height and needs another look — spectrum ordering gets *more* valuable at that size, not
   less. The exact AT query for *supported* (vs *configured*) bands is not yet known; do not guess it —
   check MudiUI's CLAUDE.md §6/§7 first.
2. **Frequency table.** `FREQ` in the mockup is downlink centres, rounded, hand-entered. Needs a real
   source before it ships — a wrong label undermines the whole ordering argument.
3. **The premise conflict is still unresolved.** GL's `internet` chunk contains `ModemSelectBands` with
   LTE/NSA/SA checkbox groups and an allowlist ("Open") mode, gated behind `isBuiltInModem` +
   `showAdvance`. Kevin reports the stock UI does *not* offer "check every band you'll allow". Most likely
   explanation: GL's offered list is populated from currently-visible bands, not the full supported set —
   which would make **the count in §4 the entire product**. Worth confirming before building Phase 2.
4. **"Known-good" placement** — currently on Bands; arguably belongs only on Cell lock next to the other
   recovery affordances.
5. **Neighbour-cell data** — does `AT+QENG="neighbourcell"` return SINR per neighbour on the RG650V, or
   only RSRP? The Cell lock table assumes SINR.

## 9. Decision log

| Decision | Choice | Rationale |
|---|---|---|
| Status position | Above tabs, all-tab visible | Every tab is change-and-observe |
| Status form | **Live RSRP trace, readout derived** | Revert asks a question about numbers; strip must hold the evidence. Avoids the KPI-row template. |
| Trace domain | Fixed −120…−80 dBm | Auto-scale makes noise look like signal |
| Revert UI | C1 — inline, plain | Trace carries the evidence, so the countdown needn't follow you |
| Band order | **Frequency, low → high** | Left-to-right encodes reach vs speed. Numeric order teaches nothing. |
| Band groups | SA / NSA / LTE | Three separate AT commands; Peplink wrongly flattens |
| Checked vs serving | Indigo vs mint ring | Different facts, different channels |
| Diagnostics charts | Small multiples | dBm ≠ dB; shared axis would be meaningless |
| Cell lock | Pin from a live list | Selection, not data entry |
| Palette | GL's extracted tokens | Native is the brief; Element defaults read as a bolt-on |
| Quality ramp | GL's `modemsignallog` ramp | The box already shows this ramp |
| Charts | Hand-rolled SVG | `gl-line-chart` gives no fixed domain, no markers |
| Readout size | 29px (breaks GL's scale) | Only page whose job is watching a number; accepted risk |
| Axis gradient | **Cut** | Used quality colours for frequency — wrong meaning |
