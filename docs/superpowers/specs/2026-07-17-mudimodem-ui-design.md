# MudiModem — UI design

**Date:** 2026-07-17
**Status:** design agreed; band data unverified (see Open questions)
**Mockup:** `.superpowers/brainstorm/782253-1784289176/content/design.html` (self-contained, opens in any browser)
**Addendum (2026-07-17, Tracking page):** `.superpowers/brainstorm/782253-1784289176/content/tracking.html` — see §10
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

## 10. Addendum — Tracking page (the uber graph)

**Date:** 2026-07-17
**Status:** ✅ design agreed **and data source resolved** (2026-07-17) — in-memory recorder,
history kept in a session-scoped `window` singleton (§10.6.1). Ready for an implementation plan.
**Mockup:** `.superpowers/brainstorm/782253-1784289176/content/tracking.html` (⚠️ its "Cell · PCI"
bus is corrected to **Cell ID** below — the box carries no PCI over the websocket, §10.2).

### 10.1 Why a separate page, and why it's allowed to look different

The monitor strip (§3) answers **now** — it's evidence for the revert decision, and it's deliberately
thin: one trace, one readout, visible from every tab. It cannot also be the place you go to answer
*"what happened at 6am, and why did the link move to AT&T?"* — that needs history across every
metric, not the readout of one.

So Tracking is a **second route**, not a sixth tab. Reasoning:

- **Registered `level:0`**, exactly like GL's own `modemsignallog` (CLAUDE.md §2) — reachable, not in
  the nav. It's a drill-down, not a peer of Diagnostics/Bands/Cell lock/AT console/SIM.
- **Linked from the strip** (the readout or trace becomes a link/button to `/mudimodem-tracking`), so
  the "why" is always one click from the "what's true now."
- It's allowed a **denser idiom than the rest of the admin** — a logic-analyzer lane stack, not GL's
  card-and-form language — because its job is different: forensic reconstruction, not control. The
  five tabs stay in GL's idiom because they're closer to what a GL page already looks like; this page
  doesn't try to.

### 10.2 The signature: one clock, every lane, a slice cursor

Same discipline as §3's "the trace is the object, not a KPI row" — extended across every metric at
once instead of one.

- **Three fixed-domain traces** stacked on a shared time axis: RSRP (−120…−80 dBm), SINR (−10…30 dB),
  RSRQ (−20…−3 dB). Same rule as Diagnostics (§4): **never a shared or dual axis** — dBm and dB don't
  compose on one scale. Each trace is coloured by GL's own quality ramp (§2) *per sample*, so a
  degrading run visibly walks mint → amber → rose without a legend lookup.
- **Three state buses** below the traces — Band, **Cell ID**, SIM — rendered as labelled segments, not
  lines. A band or cell is identity, not a magnitude; a bus makes the boundary (the moment it changed)
  the thing you see, the way a logic analyzer shows a signal's state, not its voltage.
  - ⚠️ **Correction from the box (verified 2026-07-17):** `cellular.network info` → `cell_info` carries
    **no PCI**. The serving cell is identified by `id` (a hex Cell ID, e.g. `"D43B70D"`), with
    `tx_channel` the ARFCN (`"8701"`). PCI is AT-only (`AT+QENG`) and not on `/ws`. So the middle bus
    is **Cell ID + band + ARFCN**, and handover detection keys off a **change in `id`**, not PCI.
    Metrics arrive as strings (`"-118"`) with `_level` (1–4) buckets already attached — the tracking
    page reuses those levels for quality colour exactly as the main page's strip does (`qFromLevel`).
- **Full-height cause ticks** cross every lane at once, coloured by **who/what caused the change**, not
  by what changed: indigo square = you (an apply/confirm), amber triangle = the watchdog (an
  auto-revert), open circle = the network (a handover/failover with no local cause). This is the same
  "user vs system" distinction the revert banner already makes (§5) — the tick vocabulary is that
  decision's icon set reused, not invented fresh, because it's the same question ("who did this?")
  asked with history now available.
- **The slice cursor is the signature.** Hover anywhere in the lane stack and a crosshair reads every
  lane at that instant into one composite tooltip (RSRP/SINR/RSRQ with quality dots, band+freq+RAT,
  PCI, SIM) — click to pin it, click again to release. This is what makes the page a graph you
  *interrogate* rather than a chart you *read*: the six-lane alignment problem (which SINR corresponds
  to which band segment, at which second) is solved by pointing, not by visually tracing a vertical
  line across six rows by eye.
- A **re-registration gap** (SIM/network searching after a band change or failover) renders as an
  absent trace segment and a `searching…` bus state, never an interpolated line — a straight line
  across a gap would assert a measurement that was never taken.

### 10.3 Interaction

- **Time range** is a segmented control (15 m / 1 h / 6 h / 24 h), not a date picker — matches the
  field-test-instrument framing (§1): these are the ranges that answer "did the thing I just did work"
  vs. "what's the pattern of failovers this box has." Any other range is not a use case this page
  serves.
- **Live/paused toggle**, top right, mirrors what "watching a live radio" means: paused freezes the
  right edge so a hover/pin target doesn't scroll out from under the cursor mid-inspection.
- **The event log below the lanes is the accessibility table** (dataviz skill §6: a table view must
  exist alongside any chart) — newest-first, one row per cause tick, with the same source/agency
  vocabulary (You / Watchdog / Network) as chip colour. Hovering a row places the slice cursor at that
  moment without leaving the table; clicking pins it and, if the event is outside the current window,
  widens the range to bring it into view. This makes the log a second way to reach every cause tick,
  for anyone who'd rather scan text than hover a chart.
- **Deep-linkable** (`#w=<minutes>&m=<minute>&d=<0|1>`) so a specific moment — "look, THIS is where the
  n71 lock happened" — is a URL, not a set of hover instructions. Not a requirement from the brief;
  added because the page's whole job is pointing at a moment in history, and a moment that can't be
  named and shared undermines that job.

### 10.4 Visual system — no new tokens

Tracking introduces **zero new colour**. Trace quality colouring reuses GL's `modemsignallog` ramp
(§2); cause-tick colours reuse the revert banner's user/watchdog vocabulary (§5); bus segments and
gridlines use the same card/border/divider tokens as every other tab. The only new *marks* are the
bus segment (a rounded rect on `--bg-title`) and the cause-tick glyphs (square/triangle/circle) — both
validated against the dataviz skill's six-check palette validator (§10.7) before use, not eyeballed.

Base type stays at GL's 13px system stack; ARFCN/PCI/band figures use `ui-monospace` (§2's existing
rule for RF figures), applied here to the bus-segment labels and the slice-cursor readout.

### 10.5 What this page is not

- **Not a replacement for the strip.** The strip is the loop's evidence (§1); Tracking is the loop's
  memory. Removing the strip in favour of "just link to Tracking" would break the revert decision,
  which needs to be answerable without navigating away from Bands.
- **Not a general-purpose time-series explorer.** No arbitrary metric picker, no export, no annotation
  authoring. Scope is fixed to the three RF traces + three state buses this box actually has, because
  a configurable dashboard is a different (and much larger) product than "why did the radio do that."
- **Not real-time-guaranteed.** Data delivery depends on §10.6 below; the page is designed to degrade
  to "shows what's been captured so far" rather than promise a complete history it can't back.

### 10.6 Data source — RESOLVED (2026-07-17): in-memory, session-scoped

**Decision (Kevin, 2026-07-17): keep history in memory for now.** No backend recorder, no `/tmp`
storage, no mining of GL logs — those stay as *later* options (§10.6.5) if the in-memory limits bite.

#### 10.6.1 The recorder — a `window`-scoped singleton (`window.__mmHist`)

`global_sockets` (§2) pushes *current* state over `/ws`; it is not a history API. We build history
client-side by recording each push into a bounded ring buffer. **The buffer lives on `window`, not in a
component's `data()`**, for one load-bearing reason: **Tracking is a separate route/chunk (§10.1).** A
buffer inside the Tracking component would start empty every time you open the page — the opposite of
its job. A component inside the *main* page would vanish when you navigate to Tracking. `window`
outlives both, for the whole SPA session.

Shape:
```
window.__mmHist = {
  samples: [ { t, slot, id, band, mode, rsrp, sinr, rsrq, rssi, dl_bandwidth, tx_channel,
               rsrp_level, sinr_level, rsrq_level, carrier } , … ],   // ring, capped
  events:  [ { t, kind:'user'|'dog'|'net', label, detail } , … ],
  record(sample), pushEvent(evt)
}
```
- **Capped ring buffer:** ~5000 samples with a **min ~5 s spacing** between recorded samples ⇒ several
  hours of coverage at trivial memory cost. Pushes arriving faster than the spacing are dropped (the
  latest value wins); this is the retention-resolution decision the old open-question flagged. The four
  range buttons window into *whatever exists* — a 24 h button with 3 h buffered shows 3 h and says so.
- **Recording happens while any MudiModem page is mounted.** The main page already watches
  `serving.rsrp` for its strip; that same watcher calls `record()`. The Tracking page records too while
  it's the mounted page. Both reach the singleton through an **identical small `makeMMHist()` factory
  inlined in both chunks** (`window.__mmHist || (window.__mmHist = makeMMHist())`, first-mount-wins) —
  chunks can't `require` each other and the repo is deliberately toolchain-free (§7), so a tiny verbatim
  copy in each file is the honest cost, covered by a test asserting both produce a compatible recorder.

#### 10.6.2 Honest limitation (say it in the empty state)

History accumulates **only while a MudiModem page has been open this session, and is lost on reload.**
Open Tracking cold ⇒ it fills going forward; sit on Diagnostics first ⇒ you carry that history in. The
empty/short-buffer state says exactly this ("collecting since HH:MM · reload clears it"), so the page
never implies a completeness it can't back. Whether the `global_sockets` subscription is session-wide
(store updates even off-page) or per-page is **not yet verified on the box** — if session-wide, a future
tweak could record from an earlier point, but the design does not depend on it.

#### 10.6.3 Cause-tick detection — where each agency comes from

- **`user`** — pushed explicitly by the main page's own handlers: `applyBands()` success →
  `pushEvent({kind:'user', label:'Bands applied', …})`; `keepBands()` → `Kept`; `revertBands()` (manual
  *Revert now*) → `Reverted`. We already know the instant we cause these.
- **`dog`** — the auto-revert: the main page's countdown reaching 0 (the watchdog fired server-side) →
  `pushEvent({kind:'dog', label:'Auto-revert fired', …})`.
- **`net`** — handover/failover, **inferred inside `record()`** by diffing the new sample against the
  previous: a change in `id` (handover), active `slot` (failover), or `band`/`mode` (RAT change) with
  **no `user` event within a small window (~5 s)** ⇒ a `net` event. The near-in-time guard prevents
  misattributing a band change *we* just applied as a network event. A missed sample at a fast handover
  can still merge two edges into one tick — acceptable for an in-memory best-effort log, and noted.

#### 10.6.4 The four files

| File | Change |
|---|---|
| `src/views/mudimodem-tracking.js` | **New chunk** (`render(h)`, expression `module.exports=…`, §7). Lane stack (3 traces + 3 buses), cause ticks, slice cursor + pin, range control, live/pause, event-log table. Reads `window.__mmHist`; records while mounted. |
| `src/menu/mudimodem-tracking.json` | **New.** `level:0` (hidden, mirrors `modemsignallog.json`) + the same six `global_sockets` so the subscription is live on this route. |
| `src/views/mudimodem.js` | Add recorder taps: `record()` on the existing `serving.rsrp` watcher; `pushEvent` in apply/keep/revert; a **"History →"** affordance in the strip → `this.$router.push('/mudimodem-tracking')`. The existing strip `trace` stays as-is (low-risk; recorder is additive). |
| `test/chunk.test.js` | Extend to eval the new chunk as the SPA does, and exercise `makeMMHist()` (record/cap/spacing, event diffing) + the slice-lookup math under the stub. |

#### 10.6.5 Deferred (revisit only if in-memory bites)

- **Backend recorder to `/tmp`** (bounded, rotated — NOT `/etc`; this is telemetry, not durable config)
  → survives reload/tab-close. Costs a process + rotation design.
- **Mining GL's own logs** if `cellular_manager` already records handovers (unconfirmed — not grepped).
- **Drag-to-zoom** on the lane stack if the four fixed ranges prove too coarse to separate close events.
- **build/deploy/verify wiring** (`tools/build.sh` must gzip the second chunk; `deploy.sh` push it;
  `verify.sh` assert the `level:0` entry) — mechanical, folded into the implementation plan, not a design
  question.

### 10.7 Quality floor (delta from §6)

Same floor as §6, plus:

- **Palette validated, not eyeballed** — dataviz skill's `validate_palette.js` run against GL's quality
  ramp (mint/indigo/amber/rose) on both light and dark surfaces: CVD separation and normal-vision
  floor pass; the light-mode mint/amber-vs-white contrast WARN is relieved by direct labels (bus text,
  slice-cursor readout) and the event-log table, per the skill's "WARN obligates visible labels or a
  table view" rule — both already exist here for other reasons, so no extra element was added to
  satisfy it.
- **Deep-link hash state** (`#w=&m=&d=`) must round-trip through the SPA's router without colliding
  with `?_t=` cache-busting (§7) — untested against the real route since no backend exists yet.
- `prefers-reduced-motion` kills the LIVE-dot pulse, matching §6's existing rule for the strip/bar.
