# Fold Diagnostics into the "RSRP live" top bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Diagnostics tab, move its serving-cell facts into the top "RSRP live" status strip, remove the strip's Tracking shortcut, and make Tracking the first + default tab.

**Architecture:** Single chunk file `src/views/mudimodem.js` (a hand-written Vue 2.6 runtime-only component, `render(h)` only — no `template:`). Two focused edits: (1) the status strip's fact row + interactivity; (2) the tab list, default tab, and lifecycle. Unit-tested by `eval`-ing the chunk exactly as GL's SPA loader does, via `test/chunk.test.js` (Node's built-in `node --test`).

**Tech Stack:** Plain JS, Vue 2.6.12 runtime-only render functions, Node `node:test` + `node:assert`. No toolchain, no package.json.

## Global Constraints

- **Runtime-only Vue:** `template:` is forbidden — use `render(h)` (hyperscript). Every UI edit is an `h(...)` change.
- **Chunk must eval to the component:** the file ends `module.exports = { ... };` — do not break that shape.
- **No backend / menu / global_sockets changes.** This is a chunk-only edit.
- **Run tests with:** `node --test test/chunk.test.js` (full suite is slow, ~90s). For a single test use `node --test --test-name-pattern '<name>' test/chunk.test.js`.
- **Do not commit** unless the user asks (repo working agreement). Steps below stage nothing to git.
- The `facts` computed property (`src/views/mudimodem.js:220`) stays as-is — it is not the source the strip reads; the strip reads `this.serving` fields inline.

---

### Task 1: Move diagnostics facts into the strip + make the strip inert

Extend the strip's `.mm-facts` row (today: SINR · RSRQ · Band) with the serving-cell
fields the strip lacks — **BW · Cell · Ch · RSSI** — each rendered only when present.
Remove the `Tracking ↗` label and the trace block's click/pointer/title so the strip
is pure display. The Diagnostics tab is still present after this task (removed in Task 2);
that is intentional and harmless.

**Files:**
- Modify: `src/views/mudimodem.js` (render's status-strip section, ~lines 1579–1637)
- Test: `test/chunk.test.js`

**Interfaces:**
- Consumes: `this.serving` (alias `c` in `render`) — device cell_info with fields
  `dl_bandwidth` (e.g. `"15MHz"`), `id` (cell id string), `tx_channel` (ARFCN string),
  `rssi` (dBm number/string, may be absent). `this.hasData`, `this.bandLabel`,
  `this.qColor`, `this.sinrQ`, `this.rsrqQ` already used in the strip.
- Produces: no new methods. Strip `.mm-trace` node has **no** `on.click`/`title`/`cursor`.
  Strip `.mm-facts` renders extra `div > span.k + b` pairs for present fields.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `test/chunk.test.js` (anywhere after the existing strip tests,
e.g. after the test ending at line 204):

```javascript
test('strip facts row carries the moved diagnostics fields (Cell/Channel/BW/RSSI)', () => {
  const c = loadChunk();
  // Clone LIVE and add an RSSI reading to the active slot's cell_info.
  const withRssi = JSON.parse(JSON.stringify(LIVE));
  withRssi['cellular.networks_info'].networks[0].cell_info.rssi = '-70';
  const vm = makeVm(c, withRssi);
  vm.tab = 'bands';                 // NOT diag/tracking — isolate the strip as the source
  const nodes = walk(c.render.call(vm, h));
  const facts = nodes.find((n) => n.data.staticClass === 'mm-facts');
  assert.ok(facts, 'strip facts row renders');
  const txt = textOf(facts);
  assert.match(txt, /Cell/, 'Cell label present in strip');
  assert.match(txt, /187461035/, 'Cell id from serving cell');
  assert.match(txt, /Ch/, 'Channel label present');
  assert.match(txt, /127490/, 'ARFCN from serving cell');
  assert.match(txt, /15MHz/, 'bandwidth from serving cell');
  assert.match(txt, /RSSI/, 'RSSI label present');
  assert.match(txt, /-70/, 'RSSI value from serving cell');
});

test('strip is inert: no Tracking link, no click handler on the trace', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  const nodes = walk(c.render.call(vm, h));
  const trace = nodes.find((n) => n.data.staticClass === 'mm-trace');
  assert.ok(trace, 'trace block still renders');
  assert.ok(!(trace.data.on && trace.data.on.click), 'trace has no click handler');
  assert.ok(!(trace.data.attrs && trace.data.attrs.title), 'trace has no Open Tracking title');
  assert.doesNotMatch(textOf(trace), /↗/, 'no "Tracking ↗" affordance in the strip');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern 'strip facts row carries|strip is inert' test/chunk.test.js`
Expected: FAIL — the first on missing `Cell`/`RSSI`/`Ch` labels, the second on the
present `on.click`/`title`/`↗`.

- [ ] **Step 3: Make the trace block inert**

In `src/views/mudimodem.js`, first delete the now-unused local helper and its comment
(the trace no longer opens Tracking; the tab button calls `self.openTracking()` directly).

Replace:
```javascript
    var self = this, c = this.serving;
    // Open the in-page Tracking tab (lazy-loads the graph chunk). Shared by the
    // Tracking tab button and the strip's live sparkline.
    var openTracking = function () { self.openTracking(); };

    // ---- status strip ----
```
with:
```javascript
    var self = this, c = this.serving;

    // ---- status strip ----
```

Then replace the trace block's opening (interactive) with a plain one. Replace:
```javascript
        h("div", {
          staticClass: "mm-trace",
          staticStyle: { cursor: "pointer" },
          attrs: { title: "Open Tracking" },
          on: { click: openTracking }
        }, [
          h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
            h("span", { staticClass: "mm-eyebrow" }, "RSRP live"),
            h("span", {
              staticClass: "mm-eyebrow",
              staticStyle: { color: "var(--primary)", letterSpacing: ".03em" }
            }, "Tracking ↗")
          ]),
```
with:
```javascript
        h("div", { staticClass: "mm-trace" }, [
          h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
            h("span", { staticClass: "mm-eyebrow" }, "RSRP live")
          ]),
```

- [ ] **Step 4: Extend the facts row with BW/Cell/Ch/RSSI**

Replace the facts-row node:
```javascript
          h("div", { staticClass: "mm-facts" }, [
            h("div", [h("span", { staticClass: "k" }, "SINR"),
              h("b", { style: { color: this.qColor(this.sinrQ) } }, c.sinr !== undefined ? String(c.sinr) : "-")]),
            h("div", [h("span", { staticClass: "k" }, "RSRQ"),
              h("b", { style: { color: this.qColor(this.rsrqQ) } }, c.rsrq !== undefined ? String(c.rsrq) : "-")]),
            h("div", [h("span", { staticClass: "k" }, "Band"), h("b", this.bandLabel)])
          ])
```
with (the three always-on facts, then the moved fields appended only when present):
```javascript
          h("div", { staticClass: "mm-facts" }, [
            h("div", [h("span", { staticClass: "k" }, "SINR"),
              h("b", { style: { color: this.qColor(this.sinrQ) } }, c.sinr !== undefined ? String(c.sinr) : "-")]),
            h("div", [h("span", { staticClass: "k" }, "RSRQ"),
              h("b", { style: { color: this.qColor(this.rsrqQ) } }, c.rsrq !== undefined ? String(c.rsrq) : "-")]),
            h("div", [h("span", { staticClass: "k" }, "Band"), h("b", this.bandLabel)])
          ].concat(
            [["BW", c.dl_bandwidth], ["Cell", c.id], ["Ch", c.tx_channel], ["RSSI", c.rssi]]
              .filter(function (f) { return f[1] !== undefined && f[1] !== null && f[1] !== ""; })
              .map(function (f) {
                return h("div", [h("span", { staticClass: "k" }, f[0]), h("b", String(f[1]))]);
              })
          ))
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `node --test --test-name-pattern 'strip facts row carries|strip is inert' test/chunk.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full suite to confirm no regression**

Run: `node --test test/chunk.test.js`
Expected: all PASS (74 now: the prior 72 + 2 new). The existing "reads live data …"
test (`/15MHz/`) still passes — bandwidth now comes from the strip as well as the
(still-present) Diagnostics tab.

---

### Task 2: Remove the Diagnostics tab; make Tracking first + default

Delete the `diag` tab and its panel branch, reorder `TABS` so Tracking is first,
default `data.tab` to `"tracking"`, and add a `mounted()` hook so the lazy Tracking
chunk fetches on landing (nothing clicks the tab on first paint).

**Files:**
- Modify: `src/views/mudimodem.js` — `data.tab` (line ~32), lifecycle (line ~263),
  `TABS` array + diag panel branch in `render` (lines ~1642–1665)
- Test: `test/chunk.test.js`

**Interfaces:**
- Consumes: `this.loadTracking()` (existing method, `src/views/mudimodem.js:301`;
  idempotent — guards on `this.trackingComp || this.trackingLoading`).
- Produces: `data().tab === "tracking"`; `TABS` first entry `["tracking","Tracking"]`,
  no `["diag", ...]`; a `mounted()` hook on the component that calls `loadTracking()`
  when `this.tab === "tracking"`.

- [ ] **Step 1: Write the failing tests**

Add to `test/chunk.test.js` (after Task 1's tests):

```javascript
test('Diagnostics tab is gone; Tracking is first and the default', () => {
  const c = loadChunk();
  assert.strictEqual(c.data().tab, 'tracking', 'default landing tab is Tracking');
  const vm = makeVm(c, LIVE);
  const tabLabels = walk(c.render.call(vm, h))
    .filter((n) => n.data.staticClass && /\bmm-tab\b/.test(n.data.staticClass))
    .map(textOf);
  assert.strictEqual(tabLabels[0], 'Tracking', 'Tracking is the first tab');
  assert.ok(!tabLabels.includes('Diagnostics'), 'no Diagnostics tab');
});

test('mounted() fetches the tracking chunk on landing', () => {
  const c = loadChunk();
  assert.strictEqual(typeof c.mounted, 'function', 'component has a mounted hook');
  const vm = makeVm(c, LIVE);       // tab defaults to 'tracking'
  let called = 0;
  vm.loadTracking = function () { called++; };
  c.mounted.call(vm);
  assert.strictEqual(called, 1, 'mounted calls loadTracking when landing on Tracking');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern 'Diagnostics tab is gone|mounted\(\) fetches' test/chunk.test.js`
Expected: FAIL — default tab is still `"diag"`, `Diagnostics` still in `tabLabels`,
and `c.mounted` is `undefined`.

- [ ] **Step 3: Default the tab to Tracking**

In `src/views/mudimodem.js`, replace:
```javascript
      tab: "diag",
```
with:
```javascript
      tab: "tracking",
```

- [ ] **Step 4: Add the mounted hook**

Replace:
```javascript
  created() { this.injectStyle(); },
```
with:
```javascript
  created() { this.injectStyle(); },
  mounted() { if (this.tab === "tracking") this.loadTracking(); },
```

- [ ] **Step 5: Reorder TABS and drop the Diagnostics entry**

Replace:
```javascript
    var TABS = [["diag", "Diagnostics"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"], ["tracking", "Tracking"]];
```
with:
```javascript
    var TABS = [["tracking", "Tracking"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"]];
```

- [ ] **Step 6: Remove the Diagnostics panel branch**

Replace the diag branch head (which also declares the now-unused `var m`):
```javascript
    if (this.tab === "diag") {
      var m = this.modem;
      panel = h("div", { staticClass: "mm-card" }, [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Serving cell"),
          h("span", { staticClass: "mm-hint" }, m.name ? m.name + " live" : "live")
        ]),
        this.hasData
          ? h("div", { staticClass: "mm-dl" }, this.facts.map(function (f, i) {
              return h("div", { key: i }, [h("span", { staticClass: "k" }, f[0]), h("b", String(f[1]))]);
            }))
          : h("div", { staticClass: "mm-empty" }, "No serving-cell data yet.")
      ]);
    } else if (this.tab === "bands") {
```
with:
```javascript
    if (this.tab === "bands") {
```

- [ ] **Step 7: Update the two existing tests that assumed the Diagnostics tab**

In `test/chunk.test.js`, in the test `renders gracefully with an empty store (no push yet)`,
replace:
```javascript
  assert.match(textOf(tree), /Diagnostics/, 'tabs still render without data');
```
with:
```javascript
  assert.match(textOf(tree), /Bands/, 'tabs still render without data');
```

(The other affected assertions still hold: `reads live data …` gets `/15MHz/` from the
strip after Task 1; the `Tracking is an in-page tab …` test sets `vm.tab='tracking'`
explicitly, so it is unaffected by the default change.)

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `node --test --test-name-pattern 'Diagnostics tab is gone|mounted\(\) fetches' test/chunk.test.js`
Expected: PASS (2 tests).

- [ ] **Step 9: Run the full suite**

Run: `node --test test/chunk.test.js`
Expected: all PASS (76: 72 original + 4 new; the edited empty-store assertion still
passes). If any test mentions `Diagnostics`, it was missed in Step 7 — fix it.

---

### Task 3: Build and verify the chunk still evals

Confirm the gzip build succeeds (the shipped artifact is the gzipped chunk) and that
the built file is loadable. No device deploy in this plan (the user runs `tools/deploy.sh`
when ready).

**Files:**
- No source changes. Uses `tools/build.sh`.

- [ ] **Step 1: Build**

Run: `sh tools/build.sh`
Expected: exits 0; `ls -l build/` lists `gl-sdk4-ui-mudimodem.common.js.gz` freshly written.

- [ ] **Step 2: Verify the gzipped chunk still evals to the component**

Run:
```bash
node -e 'const z=require("zlib"),fs=require("fs");const s=z.gunzipSync(fs.readFileSync("build/gl-sdk4-ui-mudimodem.common.js.gz")).toString();const module={exports:{}};const c=eval(s);if(!c||typeof c.render!=="function"||c.data().tab!=="tracking"){console.error("BAD",c&&c.data&&c.data().tab);process.exit(1)}console.log("OK tab="+c.data().tab)'
```
Expected: prints `OK tab=tracking`.

---

## Self-Review

**Spec coverage:**
- "Remove Diagnostics tab" → Task 2 Steps 5–6. ✓
- "Tracking first + default" → Task 2 Steps 3, 5; tests Step 1. ✓
- "mounted loads tracking chunk on landing" → Task 2 Step 4; test Step 1. ✓
- "Extend facts row with BW/Cell/Ch/RSSI, present-only" → Task 1 Step 4; test Step 1. ✓
- "Strip inert: drop `Tracking ↗`, cursor, title, click" → Task 1 Step 3; test Step 1. ✓
- "Keep Tracking tab/openTracking/loadTracking/chunk" → untouched; only the strip's
  local `openTracking` helper is removed (the method stays). ✓
- "Keep empty states" → strip empty states untouched; existing empty-store test updated. ✓
- "Tests updated" → Task 2 Step 7. ✓

**Placeholder scan:** none — every code step shows the exact old/new text and commands.

**Type/name consistency:** `loadTracking` (method, kept), `openTracking` (method kept;
render-local helper removed), `this.serving`/`c` fields (`dl_bandwidth`,`id`,`tx_channel`,
`rssi`), `data().tab === "tracking"`, `TABS` first `["tracking","Tracking"]` — all
consistent across tasks. Test helpers `walk`/`textOf`/`makeVm`/`LIVE` used as defined in
the existing harness.
