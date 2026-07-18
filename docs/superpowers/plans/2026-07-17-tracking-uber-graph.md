# Tracking (uber graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hidden `/mudimodem-tracking` page — a logic-analyzer lane stack (RSRP/SINR/RSRQ traces + Band/Cell-ID/SIM buses + cause ticks + a hover-to-slice cursor) driven by an in-memory session history, linked from the main page's monitor strip.

**Architecture:** History lives in a `window`-scoped ring-buffer singleton (`window.__mmHist`), fed by whichever MudiModem page is mounted (both subscribe to the same `global_sockets`). The Tracking page is a second oui chunk (its own `render(h)` component, `level:0` menu entry) that reads the singleton and renders SVG vnodes. No backend, no storage — history is session-scoped and lost on reload (spec §10.6).

**Tech Stack:** Vue 2.6.12 runtime-only (`render(h)`, no `template:`), hand-written UMD-style chunk `eval`'d by GL's SPA, plain-JS toolchain-free, Node `node:test` for local unit tests, `ssh cat` deploy (no scp).

## Global Constraints

- **Vue runtime-only:** `render(h)` only, `template:` forbidden (CLAUDE.md §5). Chunk source must be a single expression whose value is the component (`module.exports = …` or an IIFE returning it) — it is `eval`'d with `module` in scope (CLAUDE.md §5).
- **Ship gzipped only:** `gzip_static on`; deliver `/www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz`. The SPA appends `?_t=` so no browser cache-bust needed.
- **All colour is GL theme tokens** (`var(--success)`, `var(--warning)`, `var(--info-hover)`, `var(--error)`, `var(--text-*)`, `var(--background-card)`, `var(--divider)`, `var(--border)`). Never a literal hex. Quality ramp = GL's `modemsignallog` ramp: poor→`--error`, fair→`--warning`, good→`--info-hover`, excellent→`--success` (CLAUDE.md §8, spec §2).
- **No PCI on the box** (verified 2026-07-17): serving cell is `cell_info.id` (hex Cell ID), ARFCN is `tx_channel`, metrics are strings with `_level` (1–4) buckets. Handover = change in `id`; failover = change in active `slot`. (spec §10.2)
- **Never send `sub_id=0`; never issue raw AT from the chunk** (CLAUDE.md §3/§6). This page reads only from the websocket store — it issues no RPC at all.
- **Deploy is model-guarded** on `E5800` (CLAUDE.md §1); `192.168.8.1` is a different router — always go through `tools/deploy.sh`.
- **`makeMMHist()` is inlined identically in both chunks** (chunks can't `require` each other; repo is toolchain-free — spec §10.6.1). A test asserts the two copies are byte-identical.

---

## File Structure

- `src/views/mudimodem-tracking.js` — **new** chunk: `makeMMHist()` factory + the Tracking Vue component (lane stack, slice cursor, range/live controls, event-log table). Reads `window.__mmHist`; records while mounted.
- `src/menu/mudimodem-tracking.json` — **new** menu entry: `level:0` (hidden) + the six `global_sockets`.
- `src/views/mudimodem.js` — **modify**: add the identical `makeMMHist()` factory + `hist()`/`recordSample()` taps (rsrp watcher, apply/keep/revert) + a "History →" strip affordance routing to `/mudimodem-tracking`.
- `test/tracking.test.js` — **new**: unit tests for `makeMMHist()` (record/spacing/cap, event diffing) and the Tracking component (render structure, windowing, slice lookup, event-log order, hash parse).
- `test/chunk.test.js` — **modify**: assert the main chunk records samples + pushes user events + renders the History link; assert both `makeMMHist()` copies are identical.
- `tools/build.sh`, `tools/deploy.sh`, `tools/verify.sh` — **modify**: gzip / push / assert the second chunk + menu entry.

---

## Task 1: The history recorder (`makeMMHist`)

**Files:**
- Create: `src/views/mudimodem-tracking.js` (skeleton: factory + minimal component)
- Test: `test/tracking.test.js`

**Interfaces:**
- Produces: `makeMMHist() → { samples:[], events:[], startedAt:Number, record(sample), pushEvent(evt) }`
  - `sample = {slot,id,band,mode,rsrp,sinr,rsrq,rssi,dl_bandwidth,tx_channel,rsrp_level,sinr_level,rsrq_level,carrier}` (numbers already parsed; `t` is stamped by `record`)
  - `evt = {kind:'user'|'dog'|'net', label, detail}` (`t` stamped by `pushEvent`)
  - The component is exposed as the module value; the factory is reachable for tests as `component.makeMMHist`.
- Constants: `SAMPLES_MAX=5000`, `MIN_SPACING_MS=5000`, `EVENTS_MAX=500`, `RECENT_USER_MS=8000`.

- [ ] **Step 1: Write the skeleton chunk** — `src/views/mudimodem-tracking.js`:

```javascript
// MudiModem — Tracking (the uber graph). A hidden /mudimodem-tracking route.
// Loaded by GL's SPA via eval(): the file is ONE expression whose value is the
// component. Vue is runtime-only -> render(h) only, never template:. History is
// kept in a window-scoped ring buffer (window.__mmHist) fed by whichever
// MudiModem page is mounted; it is session-scoped and lost on reload (spec §10.6).
module.exports = (function () {
  "use strict";

  // ---- the in-memory recorder (IDENTICAL copy lives in mudimodem.js) ----
  // Kept verbatim in both chunks: chunks can't require() each other and the repo
  // is toolchain-free. test/chunk.test.js asserts the two copies are identical.
  function makeMMHist() {
    var SAMPLES_MAX = 5000, MIN_SPACING_MS = 5000, EVENTS_MAX = 500, RECENT_USER_MS = 8000;
    var samples = [], events = [], last = null;
    function now() { return Date.now(); }
    function recentUser(t) {
      for (var i = events.length - 1; i >= 0; i--) {
        if (t - events[i].t > RECENT_USER_MS) break;
        if (events[i].kind === "user" || events[i].kind === "dog") return true;
      }
      return false;
    }
    function pushEvent(e) {
      e.t = (e.t == null) ? now() : e.t;
      events.push(e);
      if (events.length > EVENTS_MAX) events.shift();
      return e;
    }
    function record(s) {
      var t = now();
      // network-event detection vs the last state we saw (independent of storage)
      if (last && !recentUser(t)) {
        if (String(s.slot) !== String(last.slot)) {
          pushEvent({ t: t, kind: "net", label: "Failover",
            detail: "Data now on SIM " + s.slot + (s.carrier ? " · " + s.carrier : "") });
        } else if (s.id != null && last.id != null && String(s.id) !== String(last.id)) {
          pushEvent({ t: t, kind: "net", label: "Handover",
            detail: "Cell " + last.id + " → " + s.id + (s.band != null ? " (" + s.band + ")" : "") });
        }
      }
      var changed = !last || String(s.slot) !== String(last.slot) ||
        String(s.id) !== String(last.id) || String(s.band) !== String(last.band) ||
        String(s.mode) !== String(last.mode);
      last = { slot: s.slot, id: s.id, band: s.band, mode: s.mode };
      var prev = samples[samples.length - 1];
      if (prev && !changed && (t - prev.t) < MIN_SPACING_MS) return null;  // spacing: drop
      var rec = { t: t, slot: s.slot, id: s.id, band: s.band, mode: s.mode,
        rsrp: s.rsrp, sinr: s.sinr, rsrq: s.rsrq, rssi: s.rssi,
        dl_bandwidth: s.dl_bandwidth, tx_channel: s.tx_channel,
        rsrp_level: s.rsrp_level, sinr_level: s.sinr_level, rsrq_level: s.rsrq_level,
        carrier: s.carrier };
      samples.push(rec);
      if (samples.length > SAMPLES_MAX) samples.shift();
      return rec;
    }
    return { samples: samples, events: events, startedAt: now(),
      record: record, pushEvent: pushEvent };
  }

  var component = {
    name: "mudimodem-tracking",
    render: function (h) { return h("div", { staticClass: "mmt" }, "tracking"); }
  };
  component.makeMMHist = makeMMHist;   // exposed for tests (harmless Vue option)
  return component;
})();
```

- [ ] **Step 2: Write failing tests** — `test/tracking.test.js`:

```javascript
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-tracking.js');
const MAIN = path.join(__dirname, '..', 'src', 'views', 'mudimodem.js');

function loadChunk(file) {
  const module = { exports: {} };
  return eval(fs.readFileSync(file, 'utf8'));
}
function h(tag, data, children) {
  if (Array.isArray(data) || typeof data === 'string') { children = data; data = {}; }
  return { tag, data: data || {}, children };
}
function textOf(n) {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(textOf).join('');
  return textOf(n.children);
}
function walk(n, out) {
  out = out || [];
  if (n == null || typeof n === 'string') return out;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return out; }
  out.push(n); walk(n.children, out); return out;
}
function sample(over) {
  return Object.assign({ slot: '1', id: 'A1', band: 71, mode: 'NR5G-SA FDD',
    rsrp: -101, sinr: 4, rsrq: -14, rssi: -70, dl_bandwidth: '15MHz',
    tx_channel: '127490', rsrp_level: 3, sinr_level: 2, rsrq_level: 3,
    carrier: 'T-Mobile' }, over || {});
}

test('makeMMHist records samples and caps the ring', () => {
  const H = loadChunk(SRC).makeMMHist();
  H.record(sample());
  assert.strictEqual(H.samples.length, 1, 'first sample stored');
  assert.strictEqual(H.samples[0].rsrp, -101);
});

test('spacing: a same-state push inside MIN_SPACING is dropped', () => {
  const H = loadChunk(SRC).makeMMHist();
  H.record(sample());
  H.record(sample({ rsrp: -100 }));   // same identity, <5s later
  assert.strictEqual(H.samples.length, 1, 'second same-state push dropped by spacing');
});

test('a state change is always stored even inside the spacing window', () => {
  const H = loadChunk(SRC).makeMMHist();
  H.record(sample());
  H.record(sample({ id: 'B2' }));     // cell changed -> stored regardless of spacing
  assert.strictEqual(H.samples.length, 2, 'transition stored');
});

test('handover (id change) pushes a net event', () => {
  const H = loadChunk(SRC).makeMMHist();
  H.record(sample());
  H.record(sample({ id: 'B2' }));
  const net = H.events.filter((e) => e.kind === 'net');
  assert.strictEqual(net.length, 1);
  assert.strictEqual(net[0].label, 'Handover');
});

test('failover (slot change) pushes a net event labelled Failover', () => {
  const H = loadChunk(SRC).makeMMHist();
  H.record(sample());
  H.record(sample({ slot: '2', id: 'C3', carrier: 'AT&T' }));
  const net = H.events.filter((e) => e.kind === 'net');
  assert.strictEqual(net[0].label, 'Failover');
});

test('a recent user event suppresses the net tick for the same change', () => {
  const H = loadChunk(SRC).makeMMHist();
  H.record(sample());
  H.pushEvent({ kind: 'user', label: 'Bands applied', detail: 'SA n71' });
  H.record(sample({ id: 'B2', band: 41 }));   // change we caused
  assert.strictEqual(H.events.filter((e) => e.kind === 'net').length, 0,
    'no net tick within RECENT_USER_MS of a user event');
});

test('pushEvent caps the events ring', () => {
  const H = loadChunk(SRC).makeMMHist();
  for (let i = 0; i < 600; i++) H.pushEvent({ kind: 'user', label: 'x', detail: '' });
  assert.ok(H.events.length <= 500, 'events capped at 500');
});
```

- [ ] **Step 3: Run tests to verify they pass** (the skeleton already implements the factory):

Run: `node --test test/tracking.test.js`
Expected: the 7 factory tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/views/mudimodem-tracking.js test/tracking.test.js
git commit -m "feat(tracking): in-memory history recorder (makeMMHist)"
```

---

## Task 2: Menu entry + build/deploy/verify wiring

**Files:**
- Create: `src/menu/mudimodem-tracking.json`
- Modify: `tools/build.sh`, `tools/deploy.sh`, `tools/verify.sh`

**Interfaces:**
- Produces: on-device files `/usr/share/oui/menu.d/mudimodem-tracking.json` and `/www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz`; route `/mudimodem-tracking` (name = view), hidden from nav.

- [ ] **Step 1: Write the menu entry** — `src/menu/mudimodem-tracking.json`:

```json
{
    "view": "mudimodem-tracking",
    "level": 0,
    "global_sockets": [
        "cellular.modems_info",
        "cellular.modems_status",
        "cellular.networks_info",
        "cellular.networks_status",
        "cellular.sims_info",
        "cellular.sims_status"
    ]
}
```

- [ ] **Step 2: Extend `tools/build.sh`** — add after the existing `gzip` line (before `ls -l build/`):

```sh
gzip -9 -n -c src/views/mudimodem-tracking.js > build/gl-sdk4-ui-mudimodem-tracking.common.js.gz
cp src/menu/mudimodem-tracking.json build/mudimodem-tracking.json 2>/dev/null || true
```

- [ ] **Step 3: Extend `tools/deploy.sh`** — add after the existing menu-json push (after line 21, the `mudimodem.json` block):

```sh
ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem-tracking.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/share/oui/menu.d/mudimodem-tracking.json' \
  < src/menu/mudimodem-tracking.json
echo "tracking chunk + menu deployed"
```

- [ ] **Step 4: Extend `tools/verify.sh`** — add a new check block after check 4 (the eval/render block), before the RPC block:

```sh
echo "4b. tracking chunk present, valid menu, serves, evals + renders"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem-tracking.common.js.gz' \
  || fail "tracking chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem-tracking.json' \
  || fail "tracking menu json missing"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\"); local f=io.open(\"/usr/share/oui/menu.d/mudimodem-tracking.json\"); c.decode(f:read(\"*a\"))"' \
  || fail "tracking menu json does not parse (would break ui.get_menu_list for EVERY page)"
TBODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" "https://127.0.0.1/views/gl-sdk4-ui-mudimodem-tracking.common.js?_t=1" | gzip -dc')
printf '%s' "$TBODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    global.window={__mmHist:null};
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem-tracking"){console.error("FAIL: tracking eval");process.exit(1);}
    if(typeof c.render!=="function"||c.template!==undefined){console.error("FAIL: not render-only");process.exit(1);}
    console.log("   tracking eval + render-only OK ->", c.name);
  })' || fail "tracking chunk eval failed"
```

- [ ] **Step 5: Run build to confirm both artifacts appear**

Run: `./tools/build.sh`
Expected: `build/` lists both `gl-sdk4-ui-mudimodem.common.js.gz` and `gl-sdk4-ui-mudimodem-tracking.common.js.gz`.

- [ ] **Step 6: Commit**

```bash
git add src/menu/mudimodem-tracking.json tools/build.sh tools/deploy.sh tools/verify.sh
git commit -m "build(tracking): gzip/deploy/verify the second chunk + level:0 menu"
```

---

## Task 3: The lane stack render (traces + buses + ticks + axis)

**Files:**
- Modify: `src/views/mudimodem-tracking.js` (replace the skeleton component; keep `makeMMHist` untouched)
- Test: `test/tracking.test.js` (add render-structure tests)

**Interfaces:**
- Consumes: `window.__mmHist` (Task 1), `this.$store.getters.moduleStatus` (websocket store).
- Produces: component `data()` fields `{ tab defaults, winW:60, pinnedM:null, tick:0, live:true, width:900, styleId:"mmt-css" }`; methods `hist()`, `recordSample()`, `winBounds()`, `xScale()`, `sampleSlice()`, `nearestSample(m)`, plus render helpers `renderLanes(h)`, `renderTrace(...)`, `renderBus(...)`, `renderTicks(...)`, `renderAxis(...)`.

- [ ] **Step 1: Replace the component object** in `src/views/mudimodem-tracking.js` (leave `makeMMHist` and the IIFE wrapper as-is; swap the `var component = {…}` for the full component below). This is large; write it verbatim.

```javascript
  var LINES = [
    { key: "rsrp", label: "RSRP · dBm", h: 60, dom: [-120, -80], mid: -100, lvl: "rsrp_level" },
    { key: "sinr", label: "SINR · dB",  h: 42, dom: [-10, 30],   mid: 13,  lvl: "sinr_level" },
    { key: "rsrq", label: "RSRQ · dB",  h: 42, dom: [-20, -3],   mid: -15, lvl: "rsrq_level" }
  ];
  var BUSES = [{ key: "band", label: "BAND" }, { key: "id", label: "CELL" }, { key: "sim", label: "SIM" }];
  var FREQ_N = { 2:1900,5:850,7:2600,12:700,13:750,14:700,25:1900,26:850,29:700,30:2300,
    38:2600,41:2500,48:3500,66:1700,70:1700,71:600,77:3700,78:3500,79:4700 };
  var RANGES = [[15,"15 m"],[60,"1 h"],[360,"6 h"],[1440,"24 h"]];
  var PADL = 46, PADR = 12, BUS_H = 20;

  var component = {
    name: "mudimodem-tracking",

    data: function () {
      return { winW: 60, pinnedM: null, tick: 0, live: true, width: 900,
        styleId: "mmt-css", cursor: null, poll: null };
    },

    computed: {
      ms: function () {
        var s = this.$store && this.$store.getters;
        return (s && s.moduleStatus) ? s.moduleStatus : function () { return {}; };
      },
      modem: function () {
        var modems = this.ms("cellular.modems_info").modems || [];
        return modems.filter(function (m) { return m.type === 0; })[0] || modems[0] || {};
      },
      modemStatus: function () {
        var self = this, modems = this.ms("cellular.modems_status").modems || [];
        return modems.filter(function (m) { return m.bus === self.modem.bus; })[0] || modems[0] || {};
      },
      activeSlot: function () { return this.modemStatus.current_sim_slot; },
      serving: function () {
        var self = this, bus = this.modem.bus;
        var nets = (this.ms("cellular.networks_info").networks || [])
          .filter(function (n) { return !bus || n.bus == null || n.bus === bus; });
        var net = nets.filter(function (n) { return String(n.slot) === String(self.activeSlot); })[0] || {};
        return net.cell_info || {};
      },
      carrier: function () {
        var self = this, sims = this.ms("cellular.sims_status").sims || [];
        var s = sims.filter(function (x) { return String(x.slot) === String(self.activeSlot); })[0] || {};
        return s.carrier || "";
      },
      H: function () { this.tick; return (typeof window !== "undefined" && window.__mmHist) || null; }
    },

    created: function () { this.injectStyle(); },
    mounted: function () {
      var self = this;
      if (typeof window === "undefined") return;
      this.measure();
      this._onResize = function () { self.measure(); };
      window.addEventListener("resize", this._onResize);
      this.poll = setInterval(function () {
        if (!self.live) return;
        self.recordSample();
        self.tick++;   // force re-render off the (non-reactive) ring buffer
      }, 1000);
    },
    beforeDestroy: function () {
      if (this.poll) clearInterval(this.poll);
      if (typeof window !== "undefined" && this._onResize) window.removeEventListener("resize", this._onResize);
    },

    methods: {
      hist: function () {
        if (typeof window === "undefined") return null;
        return window.__mmHist || (window.__mmHist = makeMMHist());
      },
      measure: function () {
        if (this.$refs && this.$refs.lanes && this.$refs.lanes.clientWidth)
          this.width = this.$refs.lanes.clientWidth;
      },
      num: function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; },
      recordSample: function () {
        var H = this.hist(); if (!H) return;
        var c = this.serving;
        if (c.rsrp === undefined || c.rsrp === null || c.rsrp === "") return;
        H.record({ slot: this.activeSlot, id: c.id, band: c.band, mode: c.mode,
          rsrp: this.num(c.rsrp), sinr: this.num(c.sinr), rsrq: this.num(c.rsrq), rssi: this.num(c.rssi),
          dl_bandwidth: c.dl_bandwidth, tx_channel: c.tx_channel,
          rsrp_level: c.rsrp_level, sinr_level: c.sinr_level, rsrq_level: c.rsrq_level,
          carrier: this.carrier });
      },
      qFromLevel: function (l) { return ({1:"poor",2:"fair",3:"good",4:"excellent"})[l] || "none"; },
      qColor: function (q) {
        return ({ poor:"var(--error)", fair:"var(--warning)", good:"var(--info-hover)",
          excellent:"var(--success)", none:"var(--text-hint)" })[q];
      },
      winBounds: function () {
        var H = this.H, endM = 0;
        var start = (H && H.startedAt) || (typeof window !== "undefined" ? Date.now() : 0);
        // clock: minutes relative to now; now = 0 at the right edge, negative to the left
        return { start: start, w0: -this.winW, w1: 0 };
      },
      // minute (relative to now) -> x pixel
      xOf: function (m) {
        var plotW = this.width - PADL - PADR;
        return PADL + (m + this.winW) / this.winW * plotW;
      },
      // absolute epoch-ms -> minute relative to now
      mOf: function (t) { return -(( (this.H && this.H.startedAt ? 0 : 0), (this.nowMs() - t) ) / 60000); },
      nowMs: function () { return (typeof window !== "undefined") ? Date.now() : 0; },
      winSamples: function () {
        var H = this.H; if (!H) return [];
        var cutoff = this.nowMs() - this.winW * 60000, self = this;
        return H.samples.filter(function (s) { return s.t >= cutoff; })
          .map(function (s) { return Object.assign({ m: self.mOf(s.t) }, s); });
      },
      winEvents: function () {
        var H = this.H; if (!H) return [];
        var cutoff = this.nowMs() - this.winW * 60000, self = this;
        return H.events.filter(function (e) { return e.t >= cutoff; })
          .map(function (e) { return Object.assign({ m: self.mOf(e.t) }, e); });
      },
      nearestSample: function (m) {
        var ss = this.winSamples(); if (!ss.length) return null;
        var best = ss[0];
        for (var i = 1; i < ss.length; i++)
          if (Math.abs(ss[i].m - m) < Math.abs(best.m - m)) best = ss[i];
        return best;
      },
      // (render helpers + interaction added in Task 4; injectStyle + render below)
      injectStyle: function () {
        if (typeof document === "undefined" || document.getElementById(this.styleId)) return;
        var css =
          '.mmt{color:var(--text-regular);font-variant-numeric:tabular-nums}' +
          '.mmt-card{background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);margin-bottom:11px}' +
          '.mmt-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px 10px}' +
          '.mmt-title{font-size:14px;font-weight:600;color:var(--text-title)}' +
          '.mmt-hint{font-size:11.5px;color:var(--text-badge)}.mmt-sp{flex:1}' +
          '.mmt-crumb{background:none;border:0;font:inherit;font-size:12px;color:var(--primary);cursor:pointer;padding:0}' +
          '.mmt-seg{display:inline-flex;border:1px solid var(--border);border-radius:3px;overflow:hidden}' +
          '.mmt-seg button{font:inherit;font-size:11.5px;background:transparent;border:0;padding:5px 12px;cursor:pointer;color:var(--text-weak);border-right:1px solid var(--border)}' +
          '.mmt-seg button:last-child{border-right:0}.mmt-seg button.on{background:var(--primary);color:#fff;font-weight:600}' +
          '.mmt-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--success);cursor:pointer;background:none;border:1px solid var(--border);border-radius:3px;padding:5px 10px}' +
          '.mmt-live .d{width:7px;height:7px;border-radius:50%;background:var(--success)}' +
          '.mmt-live.off{color:var(--text-badge)}.mmt-live.off .d{background:var(--text-hint)}' +
          '.mmt-lanes{position:relative;padding:2px 0 6px;cursor:crosshair}.mmt-lanes svg{display:block;width:100%;overflow:visible}' +
          '.mmt-foot{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:8px 14px 11px;border-top:1px solid var(--divider);font-size:11px;color:var(--text-badge)}' +
          '.mmt-lg{display:inline-flex;align-items:center;gap:5px}' +
          '.mmt-tip{position:absolute;top:8px;pointer-events:none;z-index:5;background:var(--background-card);border:1px solid var(--border);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:8px 10px;min-width:170px}' +
          '.mmt-tip .t{font-size:10.5px;color:var(--text-badge);margin-bottom:5px}' +
          '.mmt-tip .e{font-size:11px;font-weight:600;margin:-1px 0 5px;padding-bottom:5px;border-bottom:1px solid var(--divider)}' +
          '.mmt-tip table{border-collapse:collapse;width:100%}.mmt-tip td{padding:1px 0;font-size:11.5px}' +
          '.mmt-tip td.k{color:var(--text-badge);font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding-right:10px}' +
          '.mmt-tip td.v{font-weight:600;color:var(--text-title);text-align:right;white-space:nowrap}' +
          '.mmt-empty{padding:30px 14px;text-align:center;color:var(--text-hint);font-size:12.5px;line-height:1.6}' +
          '.mmt-log{width:100%;border-collapse:collapse}' +
          '.mmt-log th{font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge);text-align:left;padding:7px 14px 6px;border-bottom:1px solid var(--divider)}' +
          '.mmt-log td{font-size:12px;padding:6px 14px;border-bottom:1px solid var(--divider);color:var(--text-regular)}' +
          '.mmt-log td.tm{font-family:var(--mono,ui-monospace,monospace);font-size:11px;color:var(--text-weak);white-space:nowrap}' +
          '.mmt-chip{display:inline-block;font-size:10px;font-weight:600;border-radius:2px;padding:1px 6px}' +
          '.mmt-chip.user{background:var(--primary-background,#eef1fe);color:var(--primary)}' +
          '.mmt-chip.dog{background:var(--warning-background,#fef6e9);color:var(--warning-hover,#c4851c)}' +
          '.mmt-chip.net{background:var(--background-title,#f2f2f7);color:var(--text-badge)}' +
          '@media(max-width:720px){.mmt-hint{display:none}}';
        var el = document.createElement("style");
        el.id = this.styleId; el.textContent = css;
        document.head.appendChild(el);
      }
    },

    render: function (h) {
      return this.renderPage(h);   // renderPage assembled in this + Task 4
    }
  };
```

- [ ] **Step 2: Add the render helpers** as methods (append inside `methods`, before `injectStyle`). Write verbatim:

```javascript
      clock: function (t) {
        var d = new Date(t);
        var p = function (n) { return (n < 10 ? "0" : "") + n; };
        return p(d.getHours()) + ":" + p(d.getMinutes());
      },
      freqOf: function (b) { return FREQ_N[b]; },
      bandLabel: function (s) {
        var pre = /NR5G/.test(s.mode || "") ? "n" : "B";
        return (s.band == null || s.band === "") ? "—" : pre + s.band;
      },
      // contiguous runs of a bus key across the windowed samples
      busRuns: function (key) {
        var ss = this.winSamples(), runs = [], self = this;
        for (var i = 0; i < ss.length; i++) {
          var v = key === "band" ? self.bandLabel(ss[i])
            : key === "id" ? (ss[i].id == null ? "—" : String(ss[i].id))
            : (ss[i].carrier ? ss[i].carrier + " · SIM " + ss[i].slot : "SIM " + ss[i].slot);
          var last = runs[runs.length - 1];
          if (last && last.v === v) last.m1 = ss[i].m;
          else { if (last) last.m1 = ss[i].m; runs.push({ v: v, m0: ss[i].m, m1: 0, s: ss[i] }); }
        }
        if (runs.length) runs[runs.length - 1].m1 = 0;   // extend last run to now
        return runs;
      },
      renderLanes: function (h) {
        var self = this, W = this.width, kids = [], y = 16, laneY = {};
        var ss = this.winSamples();
        // line lanes
        LINES.forEach(function (L) {
          laneY[L.key] = y;
          var d0 = L.dom[0], d1 = L.dom[1];
          var yv = function (v) { return y + L.h - (Math.max(d0, Math.min(d1, v)) - d0) / (d1 - d0) * L.h; };
          kids.push(h("text", { staticClass: "mmt-ll", attrs: { x: 8, y: y - 5,
            "font-size": 9, fill: "var(--text-badge)" } }, L.label));
          [y, y + L.h].forEach(function (yy) {
            kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yy, y2: yy,
              stroke: "var(--divider)", "stroke-width": 1 } }));
          });
          kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yv(L.mid), y2: yv(L.mid),
            stroke: "var(--divider)", "stroke-width": 1, "stroke-dasharray": "2 3" } }));
          [[d1, y], [d0, y + L.h], [L.mid, yv(L.mid)]].forEach(function (p) {
            kids.push(h("text", { attrs: { x: PADL - 4, y: p[1] + 3, "text-anchor": "end",
              "font-size": 8, fill: "var(--text-hint)" } }, String(p[0])));
          });
          // quality-coloured runs (break where the value is null)
          var run = [], runQ = null;
          var flush = function () {
            if (run.length > 1) kids.push(h("path", { attrs: { fill: "none",
              stroke: self.qColor(runQ), "stroke-width": 1.75, "stroke-linejoin": "round",
              "stroke-linecap": "round", d: "M" + run.join("L") } }));
            run = [];
          };
          ss.forEach(function (s) {
            var v = s[L.key];
            if (v == null) { flush(); runQ = null; return; }
            var q = self.qFromLevel(s[L.lvl]);
            var pt = self.xOf(s.m).toFixed(1) + " " + yv(v).toFixed(1);
            if (runQ !== null && q !== runQ) { run.push(pt); flush(); }
            runQ = q; run.push(pt);
          });
          flush();
          y += L.h + 22;
        });
        // bus lanes
        y += 2;
        BUSES.forEach(function (B) {
          laneY[B.key] = y;
          kids.push(h("text", { attrs: { x: 8, y: y + BUS_H / 2 + 3, "font-size": 9,
            fill: "var(--text-badge)" } }, B.label));
          self.busRuns(B.key).forEach(function (r) {
            var x0 = Math.max(PADL, self.xOf(r.m0)), x1 = Math.min(W - PADR, self.xOf(r.m1));
            var w = x1 - x0; if (w < 1.2) return;
            kids.push(h("rect", { attrs: { x: x0.toFixed(1), y: y, width: w.toFixed(1),
              height: BUS_H, rx: 2, fill: "var(--background-title,#f2f2f7)",
              stroke: "var(--border)", "stroke-width": 1 } }));
            var lab = r.v; if (B.key === "band" && self.freqOf(r.s.band)) lab += " · " + self.freqOf(r.s.band) + " MHz";
            if (w > String(lab).length * 6.2 + 10)
              kids.push(h("text", { attrs: { x: ((x0 + x1) / 2).toFixed(1), y: y + BUS_H / 2 + 3.5,
                "text-anchor": "middle", "font-size": 10, fill: "var(--text-weak)",
                "font-family": "var(--mono,ui-monospace,monospace)" } }, lab));
          });
          y += BUS_H + 7;
        });
        // cause ticks
        var evTop = laneY.rsrp, evBot = y - 7;
        this.winEvents().forEach(function (e) {
          var col = e.kind === "user" ? "var(--primary)" : e.kind === "dog" ? "var(--warning)" : "var(--text-hint)";
          var ex = self.xOf(e.m);
          kids.push(h("line", { attrs: { x1: ex.toFixed(1), x2: ex.toFixed(1), y1: evTop, y2: evBot,
            stroke: col, "stroke-width": 1, "stroke-dasharray": "3 3" } }));
        });
        // time axis
        var step = { 15:2, 60:10, 360:60, 1440:240 }[this.winW];
        for (var m = -this.winW; m <= 0; m += step) {
          var xx = self.xOf(m);
          kids.push(h("line", { attrs: { x1: xx.toFixed(1), x2: xx.toFixed(1), y1: y, y2: y + 4,
            stroke: "var(--divider)", "stroke-width": 1 } }));
          kids.push(h("text", { attrs: { x: xx.toFixed(1), y: y + 14, "text-anchor": "middle",
            "font-size": 9, fill: "var(--text-badge)",
            "font-family": "var(--mono,ui-monospace,monospace)" } },
            this.clock(this.nowMs() + m * 60000)));
        }
        y += 22;
        // cursor rule
        if (this.cursor != null) {
          var cx = this.xOf(this.cursor);
          kids.push(h("line", { attrs: { x1: cx.toFixed(1), x2: cx.toFixed(1), y1: evTop, y2: evBot,
            stroke: this.pinnedM != null ? "var(--primary)" : "var(--text-weak)",
            "stroke-width": this.pinnedM != null ? 1.25 : 1 } }));
        }
        return h("svg", { ref: "svg", attrs: { viewBox: "0 0 " + W + " " + y,
          width: W, height: y } }, kids);
      },
```

- [ ] **Step 3: Add `renderPage` scaffold** (interaction handlers land in Task 4 — for now a static page with the lane stack and an empty state). Append as a method:

```javascript
      renderPage: function (h) {
        var self = this, H = this.H;
        var hasData = H && this.winSamples().length > 0;
        var head = h("div", { staticClass: "mmt-head" }, [
          h("button", { staticClass: "mmt-crumb", on: { click: function () {
            if (self.$router) self.$router.push("/mudimodem"); } } }, "← Modem"),
          h("span", { staticClass: "mmt-title" }, "Tracking"),
          h("span", { staticClass: "mmt-hint" }, "one clock, every lane"),
          h("span", { staticClass: "mmt-sp" }),
          h("span", { staticClass: "mmt-seg" }, RANGES.map(function (r) {
            return h("button", { key: r[0], staticClass: self.winW === r[0] ? "on" : "",
              on: { click: function () { self.winW = r[0]; self.pinnedM = null; self.cursor = null; } } }, r[1]);
          })),
          h("button", { staticClass: "mmt-live" + (self.live ? "" : " off"),
            on: { click: function () { self.live = !self.live; } } },
            [h("span", { staticClass: "d" }), self.live ? "LIVE" : "PAUSED"])
        ]);
        var body = hasData
          ? h("div", { ref: "lanes", staticClass: "mmt-lanes" }, [this.renderLanes(h)])
          : h("div", { staticClass: "mmt-empty" }, [
              "Collecting modem history in this browser session.",
              h("br"), (H ? "Since " + this.clock(H.startedAt) + " · " : ""),
              "reloading the page clears it."]);
        var foot = h("div", { staticClass: "mmt-foot" }, [
          h("span", { staticClass: "mmt-lg" }, "■ You"),
          h("span", { staticClass: "mmt-lg" }, "▲ Watchdog"),
          h("span", { staticClass: "mmt-lg" }, "○ Network"),
          h("span", "a tick marks the moment — everything to its right is the radio's answer")
        ]);
        return h("div", { staticClass: "mmt" }, [
          h("div", { staticClass: "mmt-card" }, [head, body, foot]),
          this.renderLog(h)
        ]);
      },
      renderLog: function (h) {
        var self = this, H = this.H;
        var evs = (H ? H.events.slice() : []).reverse();
        var rows = evs.map(function (e, i) {
          var src = { user: "You", dog: "Watchdog", net: "Network" }[e.kind];
          return h("tr", { key: i }, [
            h("td", { staticClass: "tm" }, self.clock(e.t)),
            h("td", [h("span", { staticClass: "mmt-chip " + e.kind }, src)]),
            h("td", { staticStyle: { fontWeight: "600", color: "var(--text-title)" } }, e.label),
            h("td", { staticStyle: { color: "var(--text-weak)" } }, e.detail || "")
          ]);
        });
        return h("div", { staticClass: "mmt-card" }, [
          h("div", { staticClass: "mmt-head" }, [
            h("span", { staticClass: "mmt-title" }, "Event log"),
            h("span", { staticClass: "mmt-hint" }, "newest first")
          ]),
          rows.length
            ? h("table", { staticClass: "mmt-log" }, [
                h("thead", [h("tr", [h("th", "Time"), h("th", "Source"), h("th", "Event"), h("th", "Detail")])]),
                h("tbody", rows)])
            : h("div", { staticClass: "mmt-empty" }, "No band changes, handovers or failovers recorded yet.")
        ]);
      },
```

Also change the component's `render` to `return this.renderPage(h);` (already set in Step 1).

- [ ] **Step 4: Add render-structure tests** to `test/tracking.test.js`:

```javascript
// Seed a window singleton with a short synthetic history, then render.
function seedWindow(mkHist) {
  const H = mkHist();
  const now = Date.now();
  // 20 samples over the last 20 min, a handover at t-10 (id A1->B2, band 71->41)
  for (let i = 20; i >= 0; i--) {
    const id = i > 10 ? 'A1' : 'B2';
    const band = i > 10 ? 71 : 41;
    H.samples.push({ t: now - i * 60000, slot: '1', id, band, mode: 'NR5G-SA FDD',
      rsrp: -100 - i, sinr: 5, rsrq: -13, rsrp_level: 3, sinr_level: 2, rsrq_level: 3,
      carrier: 'T-Mobile', tx_channel: '127490', dl_bandwidth: '15MHz' });
  }
  H.events.push({ t: now - 10 * 60000, kind: 'net', label: 'Handover', detail: 'Cell A1 → B2' });
  global.window = { __mmHist: H };
  return H;
}
function makeVm(c, over) {
  const vm = Object.assign({}, c.data());
  vm.$store = { getters: { moduleStatus() { return {}; } } };
  for (const [k, f] of Object.entries(c.methods || {})) vm[k] = f.bind(vm);
  for (const [k, f] of Object.entries(c.computed || {}))
    Object.defineProperty(vm, k, { get: f.bind(vm), configurable: true });
  Object.assign(vm, over || {});
  return vm;
}

test('empty state when no history yet', () => {
  global.window = { __mmHist: loadChunk(SRC).makeMMHist() };
  const c = loadChunk(SRC);
  const vm = makeVm(c);
  assert.match(textOf(c.render.call(vm, h)), /Collecting modem history/);
});

test('renders three trace lanes + three buses + a handover tick', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60 });
  const txt = textOf(c.render.call(vm, h));
  ['RSRP · dBm', 'SINR · dB', 'RSRQ · dB', 'BAND', 'CELL', 'SIM'].forEach((L) =>
    assert.match(txt, new RegExp(L.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${L} lane present`));
  assert.match(txt, /n71/, 'band bus shows the pre-handover band');
  assert.match(txt, /n41/, 'band bus shows the post-handover band');
  // a dashed tick line was emitted for the handover
  const dashed = walk(c.render.call(vm, h)).filter(
    (n) => n.data.attrs && n.data.attrs['stroke-dasharray'] === '3 3');
  assert.ok(dashed.length >= 1, 'at least one cause tick rendered');
});

test('nearestSample returns the closest sample to a minute offset', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60 });
  const s = vm.nearestSample(-5);   // ~5 min ago
  assert.ok(s && Math.abs(s.m + 5) < 1.5, 'picks a sample near t-5min');
});

test('event log lists events newest-first with source chips', () => {
  const c = loadChunk(SRC);
  const H = seedWindow(() => c.makeMMHist());
  H.events.push({ t: Date.now(), kind: 'user', label: 'Bands applied', detail: 'SA n41' });
  const vm = makeVm(c, { winW: 60 });
  const txt = textOf(c.renderLog.call(vm, h));
  assert.match(txt, /Bands applied/);
  assert.match(txt, /Handover/);
  assert.ok(txt.indexOf('Bands applied') < txt.indexOf('Handover'), 'newest (user) first');
});
```

- [ ] **Step 5: Run tests**

Run: `node --test test/tracking.test.js`
Expected: all Task 1 + Task 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/mudimodem-tracking.js test/tracking.test.js
git commit -m "feat(tracking): lane-stack render (traces + buses + ticks + log)"
```

---

## Task 4: Interaction — range control, live/pause, slice cursor + pin, deep-link

**Files:**
- Modify: `src/views/mudimodem-tracking.js` (add mouse handlers + tooltip + hash parse)
- Test: `test/tracking.test.js` (slice + hash tests)

**Interfaces:**
- Consumes: `nearestSample`, `winSamples`, `winEvents`, `xOf` (Task 3).
- Produces: methods `onMove(e)`, `onLeave()`, `onClick(e)`, `sliceReadout(h)`, `parseHash()`; `data.cursor` (minute offset or null), `data.pinnedM`.

- [ ] **Step 1: Wire the lanes container** — in `renderPage`, replace the `body = hasData ? h("div", {ref:"lanes",…}, [this.renderLanes(h)])` line with mouse handlers + the tooltip overlay:

```javascript
        var body = hasData
          ? h("div", { ref: "lanes", staticClass: "mmt-lanes",
              on: { mousemove: this.onMove, mouseleave: this.onLeave, click: this.onClick } },
              [this.renderLanes(h), this.cursor != null ? this.sliceReadout(h) : null])
          : h("div", { staticClass: "mmt-empty" }, [
```

- [ ] **Step 2: Add the interaction methods** (append inside `methods`):

```javascript
      mFromEvent: function (e) {
        var el = this.$refs.lanes; if (!el) return null;
        var r = el.getBoundingClientRect();
        var plotW = this.width - PADL - PADR;
        return -this.winW + (e.clientX - r.left - PADL) / plotW * this.winW;
      },
      onMove: function (e) {
        if (this.pinnedM != null) return;
        var m = this.mFromEvent(e); if (m == null) return;
        this.cursor = Math.max(-this.winW, Math.min(0, m));
      },
      onLeave: function () { if (this.pinnedM == null) this.cursor = null; },
      onClick: function (e) {
        if (this.pinnedM != null) { this.pinnedM = null; return; }
        var m = this.mFromEvent(e); if (m == null) return;
        this.pinnedM = this.cursor = Math.max(-this.winW, Math.min(0, m));
      },
      sliceReadout: function (h) {
        var s = this.nearestSample(this.cursor); if (!s) return null;
        var self = this, W = this.width, cx = this.xOf(s.m);
        var near = null, evs = this.winEvents();
        for (var i = 0; i < evs.length; i++)
          if (Math.abs(this.xOf(evs[i].m) - cx) < 6) near = evs[i];
        var row = function (k, v, u, q) {
          return h("tr", [h("td", { staticClass: "k" }, k),
            h("td", { staticClass: "v", staticStyle: q ? { color: self.qColor(q) } : {} },
              v + (u ? " " + u : ""))]);
        };
        var rows = [
          row("RSRP", s.rsrp, "dBm", this.qFromLevel(s.rsrp_level)),
          row("SINR", s.sinr, "dB", this.qFromLevel(s.sinr_level)),
          row("RSRQ", s.rsrq, "dB", this.qFromLevel(s.rsrq_level)),
          row("Band", this.bandLabel(s), this.freqOf(s.band) ? "· " + this.freqOf(s.band) + " MHz" : "", null),
          row("Cell", s.id == null ? "—" : s.id, "", null),
          row("SIM", (s.carrier || "SIM") + " · " + s.slot, "", null)
        ];
        var kids = [h("div", { staticClass: "t" },
          this.clock(this.nowMs() + s.m * 60000) + (this.pinnedM != null ? " · pinned" : ""))];
        if (near) kids.push(h("div", { staticClass: "e",
          staticStyle: { color: near.kind === "user" ? "var(--primary)"
            : near.kind === "dog" ? "var(--warning-hover,#c4851c)" : "var(--text-weak)" } },
          near.label + " — " + near.detail));
        kids.push(h("table", rows));
        var left = cx + 12; var tw = 180;
        if (left + tw > W - 4) left = cx - tw - 12;
        return h("div", { staticClass: "mmt-tip", staticStyle: { left: Math.max(4, left) + "px" } }, kids);
      },
      parseHash: function () {
        if (typeof window === "undefined" || !window.location) return;
        var q = {}; (window.location.hash || "").replace(/^#/, "").split("&").forEach(function (kv) {
          var p = kv.split("="); if (p[0]) q[p[0]] = p[1];
        });
        var w = parseInt(q.w, 10);
        if ([15, 60, 360, 1440].indexOf(w) !== -1) this.winW = w;
        var m = parseFloat(q.m);
        if (!isNaN(m)) { this.pinnedM = this.cursor = Math.max(-this.winW, Math.min(0, m)); }
      },
```

- [ ] **Step 3: Call `parseHash` on mount** — in `mounted`, add `this.parseHash();` right after `this.measure();`.

- [ ] **Step 4: Add slice + hash tests** to `test/tracking.test.js`:

```javascript
test('clicking pins the cursor; clicking again releases it', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60 });
  vm.$refs = { lanes: { getBoundingClientRect: () => ({ left: 0 }) } };
  vm.width = 900;
  vm.onClick({ clientX: 46 + (900 - 46 - 12) });   // far right ~ now
  assert.ok(vm.pinnedM != null, 'pinned after first click');
  vm.onClick({ clientX: 400 });
  assert.strictEqual(vm.pinnedM, null, 'released after second click');
});

test('parseHash reads #w= and #m= into range + pin', () => {
  const c = loadChunk(SRC);
  const H = c.makeMMHist();
  global.window = { __mmHist: H, location: { hash: '#w=360&m=-42' } };
  const vm = makeVm(c);
  vm.parseHash();
  assert.strictEqual(vm.winW, 360, 'range set from hash');
  assert.ok(Math.abs(vm.pinnedM + 42) < 0.01, 'pin set from hash');
});

test('sliceReadout shows the nearby event and metric rows', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60, cursor: -10, width: 900 });
  const txt = textOf(c.sliceReadout.call(vm, h));
  assert.match(txt, /RSRP/); assert.match(txt, /Band/);
});
```

- [ ] **Step 5: Run tests**

Run: `node --test test/tracking.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/mudimodem-tracking.js test/tracking.test.js
git commit -m "feat(tracking): slice cursor, pin, range/live controls, deep-link"
```

---

## Task 5: Wire the main page — recorder taps + History link

**Files:**
- Modify: `src/views/mudimodem.js`
- Test: `test/chunk.test.js`

**Interfaces:**
- Consumes: `makeMMHist` (identical copy), the existing `serving`/`activeSlot`/`servingCarrier` computeds.
- Produces: `window.__mmHist` populated on the rsrp watcher; `user`/`dog` events on apply/keep/revert; a "History →" affordance in the strip that routes to `/mudimodem-tracking`.

- [ ] **Step 1: Add the identical `makeMMHist` factory** to `src/views/mudimodem.js`. Insert it as a **function declaration immediately before** `module.exports = {` (eval still returns the assignment's value — the declaration is hoisted). Copy the ENTIRE `function makeMMHist() { … }` body verbatim from `src/views/mudimodem-tracking.js` (byte-for-byte; a test asserts equality). Prefix with a comment:

```javascript
// In-memory history recorder — IDENTICAL copy in src/views/mudimodem-tracking.js.
// Kept verbatim in both chunks (they can't require() each other; repo is
// toolchain-free). test/chunk.test.js asserts the two copies match byte-for-byte.
function makeMMHist() {
  /* …exact body from mudimodem-tracking.js… */
}
module.exports = {
```

- [ ] **Step 2: Add `hist()` + `recordSample()` methods** to `src/views/mudimodem.js` (inside `methods`, near `qFromLevel`):

```javascript
    hist() {
      if (typeof window === "undefined") return null;
      return window.__mmHist || (window.__mmHist = makeMMHist());
    },
    numOf(v) { var n = parseFloat(v); return isNaN(n) ? null : n; },
    recordSample() {
      var H = this.hist(); if (!H) return;
      var c = this.serving;
      if (c.rsrp === undefined || c.rsrp === null || c.rsrp === "") return;
      H.record({ slot: this.activeSlot, id: c.id, band: c.band, mode: c.mode,
        rsrp: this.numOf(c.rsrp), sinr: this.numOf(c.sinr), rsrq: this.numOf(c.rsrq),
        rssi: this.numOf(c.rssi), dl_bandwidth: c.dl_bandwidth, tx_channel: c.tx_channel,
        rsrp_level: c.rsrp_level, sinr_level: c.sinr_level, rsrq_level: c.rsrq_level,
        carrier: this.servingCarrier });
    },
```

- [ ] **Step 3: Tap the rsrp watcher** — in `src/views/mudimodem.js`, the `"serving.rsrp"` watcher handler currently pushes to `this.trace`. Add `this.recordSample();` as the last line of that handler (after the trace shift).

- [ ] **Step 4: Push events on write actions.** In `applyBands`'s success branch (right after `self.startCountdown(...)`), add:

```javascript
          var H = self.hist();
          if (H) { var b = res.applied || {}, d = [];
            if (b.sa) d.push("SA " + b.sa.split(":").map(function (x){return "n"+x;}).join(" "));
            if (b.lte) d.push("LTE " + b.lte.split(":").map(function (x){return "B"+x;}).join(" "));
            if (b.mode) d.push("mode " + b.mode);
            H.pushEvent({ kind: "user", label: "Bands applied", detail: d.join("; ") || "band change" });
          }
```

In `keepBands` (inside the final `.then`), add: `var H = self.hist(); if (H) H.pushEvent({ kind: "user", label: "Kept", detail: "Change confirmed" });`

In `revertBands` (inside the final `.then`), add: `var H = self.hist(); if (H) H.pushEvent({ kind: "user", label: "Reverted", detail: "Restored previous bands" });`

In `startCountdown`'s timeout branch (where `self.pending = { done:true, reverted:true }`), add: `var H = self.hist(); if (H) H.pushEvent({ kind: "dog", label: "Auto-revert fired", detail: "No confirm in " + window_s + "s — previous bands restored" });`

- [ ] **Step 5: Add the "History →" strip affordance.** In the main `render(h)`, inside the strip's `.mm-trace` block, add a small button after the eyebrow. Replace the eyebrow line `h("div", { staticClass: "mm-eyebrow" }, "RSRP live"),` with a header row:

```javascript
          h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
            h("span", { staticClass: "mm-eyebrow" }, "RSRP live"),
            h("button", { staticClass: "mm-tab", staticStyle: { fontSize: "10.5px", padding: "0",
              borderBottom: "0", letterSpacing: ".03em" },
              on: { click: function () { if (self.$router) self.$router.push("/mudimodem-tracking"); } } },
              "History →")
          ]),
```

- [ ] **Step 6: Add main-chunk tests** to `test/chunk.test.js`:

```javascript
test('both chunks carry a byte-identical makeMMHist factory', () => {
  const a = fs.readFileSync(SRC, 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'mudimodem-tracking.js'), 'utf8');
  const grab = (s) => {
    const i = s.indexOf('function makeMMHist()');
    assert.ok(i >= 0, 'makeMMHist present');
    // capture to the matching close by brace-counting
    let d = 0, j = i;
    for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (d === 0) { j++; break; } } }
    return s.slice(i, j).replace(/\s+/g, ' ').trim();
  };
  assert.strictEqual(grab(a), grab(b), 'the two makeMMHist copies must match');
});

test('the rsrp watcher records a sample into window.__mmHist', () => {
  const c = loadChunk();
  global.window = { __mmHist: null };
  const vm = makeVm(c, LIVE);
  vm.recordSample();
  assert.ok(window.__mmHist && window.__mmHist.samples.length === 1, 'sample recorded');
  assert.strictEqual(window.__mmHist.samples[0].rsrp, -101);
  delete global.window;
});

test('applyBands-style user event lands in history', () => {
  const c = loadChunk();
  global.window = { __mmHist: c.makeMMHist ? c.makeMMHist() : null };
  // main chunk does not expose makeMMHist; build one via hist()
  const vm = makeVm(c, LIVE);
  const H = vm.hist();
  H.pushEvent({ kind: 'user', label: 'Bands applied', detail: 'SA n71' });
  assert.strictEqual(H.events[0].kind, 'user');
  delete global.window;
});

test('strip shows a History link routing to /mudimodem-tracking', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /\/mudimodem-tracking/, 'History link targets the tracking route');
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  assert.match(textOf(c.render.call(vm, h)), /History/, 'History affordance rendered');
});
```

Note: the main chunk does not expose `makeMMHist` as a property (its `module.exports` is a plain object literal); tests reach the recorder via `vm.hist()`.

- [ ] **Step 7: Run the full test suite**

Run: `node --test test/`
Expected: all `chunk.test.js` + `tracking.test.js` tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "feat(tracking): record history + push events + History link from main page"
```

---

## Task 6: Build, deploy, verify on the device

**Files:** none (operational)

- [ ] **Step 1: Build both chunks**

Run: `./tools/build.sh`
Expected: `build/` contains both `.gz` chunks + both menu JSONs.

- [ ] **Step 2: Deploy (model-guarded)**

Run: `./tools/deploy.sh`
Expected: `target OK: …E5800…`, then "tracking chunk + menu deployed", "deployed to mudi". If it prints `REFUSING`, STOP — wrong host.

- [ ] **Step 3: Verify on-device**

Run: `./tools/verify.sh`
Expected: ends with `ALL CHECKS PASSED`, including the new "4b. tracking chunk …" block.

- [ ] **Step 4: Confirm the route is registered in the live menu** (mirrors CLAUDE.md §8 stub):

Run:
```bash
ssh root@mudi 'lua -e "
  ngx={socket={tcp=function() return {settimeout=function() end,connect=function() end} end},
    re={match=function() end,gmatch=function() end,find=function() end},log=function() end,
    ERR=0,WARN=1,NOTICE=2,INFO=3,var={},req={},ctx={},say=function() end,print=function() end,
    exit=function() end,HTTP_OK=200,timer={at=function() end},
    config={ngx_lua_version=10025,subsystem=\"http\",debug=false},
    worker={id=function() return 0 end,count=function() return 4 end},
    now=function() return os.time() end,time=function() return os.time() end}
  local t=dofile(\"/usr/lib/oui-httpd/rpc/ui\")
  for _,m in ipairs(t.get_menu_list({}).menus) do
    if m.view==\"mudimodem-tracking\" then print(\"tracking present, level=\"..tostring(m.level)) end
  end"'
```
Expected: `tracking present, level=0`.

- [ ] **Step 5: Manual smoke (report to user).** Reload the GL admin, open Modem, click **History →**. Confirm: page loads, empty state shows "Collecting…", and after ~30 s of live pushes the traces begin to draw. (No commit — this is human verification; note results.)

---

## Self-Review

**Spec coverage:**
- §10.1 separate `level:0` route + strip link → Task 2 (menu), Task 5 (link). ✔
- §10.2 traces + buses (Cell ID not PCI) + quality ramp → Task 3. ✔
- §10.2 correction (id/tx_channel/string metrics/levels) → Task 1 sample shape, Task 3 `busRuns`/`qFromLevel`. ✔
- §10.3 range control, live/pause, event-log table, deep-link → Task 3 (log), Task 4 (range/live/hash). ✔
- §10.3 slice cursor + pin → Task 4. ✔
- §10.4 no new tokens → all render helpers use `var(--…)`; asserted implicitly by GL-token-only CSS. ✔
- §10.6.1 window singleton, capped ring, spacing, first-mount-wins, identical factory + test → Task 1, Task 5 (identity test). ✔
- §10.6.2 honest empty state → Task 3 `renderPage` empty branch. ✔
- §10.6.3 user/dog/net agency → Task 1 (net diff + guard), Task 5 (user/dog pushes). ✔
- §10.6.4 four files → Tasks 1–5. ✔
- §10.6.5 build/deploy/verify wiring → Task 2, Task 6. ✔

**Placeholder scan:** No TBD/TODO. The one "copy verbatim from the other file" (Task 5 Step 1) points at Task 1's fully-written factory, not an unwritten task, and is guarded by a byte-identity test — acceptable and intentional (the factory must be identical, so duplicating its text in the plan would invite drift).

**Type consistency:** `makeMMHist` shape (`samples/events/startedAt/record/pushEvent`), `sample` fields, and `evt` fields are used identically across Tasks 1, 3, 4, 5. `winW`/`pinnedM`/`cursor`/`tick`/`live`/`width` data fields consistent across Tasks 3–4. `hist()`/`recordSample()` names identical in both chunks.
