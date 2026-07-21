# Speedtest Latest-Result Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a speed test finishes, show its result in a dedicated panel on the Speedtest tab instead of requiring a hover on the History graph.

**Architecture:** Single-file change to `src/views/mudimodem-speedtest.js` (a hand-written Vue 2.6 runtime-only chunk, `render(h)` only, no `template:`, `eval`'d by GL's SPA exactly as-is). No backend/RPC changes — the finished-test payload (`{running:false, phase:"done", result:{...}}`) is already written by `tools/mudimodem-speedtest.py` and already polled by the frontend; today the frontend discards `result`. Two pieces: (1) capture it into new `lastResult` component state at the existing "test just finished" transition in `fetchStatus`; (2) render it as a new card between the controls card and the History card.

**Tech Stack:** Plain-JS Vue 2.6 runtime-only chunk (`render(h)`, no template), Node `node:test` for the chunk (`node --test test/speedtest-chunk.test.js`).

## Global Constraints

- No `template:` anywhere — Vue runtime is compiler-less; use `render(h)` / helper `render*` methods only (per `src/views/mudimodem-speedtest.js`'s existing pattern).
- No backend or RPC changes — `result` already exists in the `get_speedtest_status` payload once `phase === "done"`.
- `lastResult` must only ever be populated by a test that completed while this component instance was actively polling (`this.statusPoll` set) — never from a stale `done` status already on disk at mount. This is the mechanism, not just a UI nicety: it's what makes the panel "only right after a run."
- Starting a new run must NOT clear the previous `lastResult` — it stays visible until the new run's result replaces it.
- Field set and formatting (units, `—` for null, band label `n`/`B` prefix, carrier/slot line) must match the existing graph-tooltip conventions in `renderGraph` (`.mms-tip-row`) for consistency — reuse that CSS class for the detail rows rather than inventing new ones.
- Test with the existing chunk-test harness pattern in `test/speedtest-chunk.test.js` (`loadChunk()`, `h()`, `textOf()`, `walk()`, `makeVm()`, `stubRpc()`/`unstubRpc()`) — do not introduce a new test harness.

---

### Task 1: Capture the finished result into `lastResult`

**Files:**
- Modify: `src/views/mudimodem-speedtest.js` (data function ~line 27-38, `fetchStatus` method ~line 99-108)
- Test: `test/speedtest-chunk.test.js`

**Interfaces:**
- Consumes: existing `this.rpc("get_speedtest_status", {})` response shape `{running, phase, result?}` (already used by `fetchStatus`); existing `this.statusPoll` (interval id or `null`, already used to gate the "test just finished" branch).
- Produces: `this.lastResult` — `null` until a test finishes while polling; thereafter the `result` object `{t, trigger, iface, down_mbps, up_mbps, latency_ms, jitter_ms, carrier, slot, band, mode, cell_id, rsrp, sinr, rsrq}`. Task 2 reads this field to render the panel.

- [ ] **Step 1: Write the failing tests**

Add to `test/speedtest-chunk.test.js`, after the existing `fetchStatus(): a finished test stops polling and refreshes history` test (currently ends at line 117):

```js
test('fetchStatus(): captures the finished result into lastResult', async () => {
  const result = { t: 5000, iface: 'cellular', down_mbps: 42, up_mbps: 9, latency_ms: 55, jitter_ms: 3 };
  const calls = stubRpc([{ running: false, phase: 'done', result: result }, { results: [] }]);
  try {
    const vm = makeVm(loadChunk());
    vm.statusPoll = setInterval(() => {}, 100000);
    vm.fetchStatus(false);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(vm.lastResult, result);
  } finally { unstubRpc(); }
});

test('fetchStatus(): a stale "done" status already on disk at mount does not populate lastResult', async () => {
  const calls = stubRpc([{ running: false, phase: 'done', result: { t: 1, iface: 'cellular', down_mbps: 1 } }]);
  try {
    const vm = makeVm(loadChunk());
    vm.fetchStatus(true);   // mount-time call; statusPoll is null, nothing was being watched
    await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(vm.lastResult, null);
  } finally { unstubRpc(); calls; }
});

test('runTest(): a new run does not clear the previous lastResult until it completes', () => {
  const vm = makeVm(loadChunk());
  vm.lastResult = { t: 1, iface: 'cellular', down_mbps: 10 };
  const calls = stubRpc([{ started: true }]);
  try {
    vm.runIface = 'cellular';
    vm.runTest();
    assert.deepStrictEqual(vm.lastResult, { t: 1, iface: 'cellular', down_mbps: 10 }, 'old result stays until replaced');
  } finally {
    if (vm.statusPoll) clearInterval(vm.statusPoll);
    unstubRpc(); calls;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/speedtest-chunk.test.js`
Expected: the first two new tests FAIL (`lastResult` is `undefined`, not in `data()` yet, or doesn't get set); the third test passes trivially (nothing sets `lastResult` yet, so it doesn't get cleared either — this is a regression guard, not new behavior, and is fine to already pass).

- [ ] **Step 3: Add `lastResult` to `data()` and capture it in `fetchStatus`**

In `src/views/mudimodem-speedtest.js`, in the `data: function ()` return object (around line 28-38), add `lastResult: null,` next to `status: { running: false },`:

```js
    data: function () {
      return {
        styleId: "mms-css",
        results: [], resultsLoading: true, resultsErr: "",
        ifaces: null, ifacesErr: "",
        runIface: "cellular",
        filterIface: "cellular",
        status: { running: false },
        lastResult: null,
        statusPoll: null,
        schedule: null, scheduleErr: "", scheduleSaving: false,
        cursor: null, pinned: null, width: 900
      };
    },
```

Then modify `fetchStatus` (around line 99-108) to capture the result at the existing completion transition:

```js
      fetchStatus: function (startPollIfRunning) {
        var self = this;
        this.rpc("get_speedtest_status", {})
          .then(function (r) {
            self.status = r || { running: false };
            if (self.status.running && startPollIfRunning) self.startPoll();
            if (!self.status.running && self.statusPoll) {
              if (self.status.phase === "done" && self.status.result) self.lastResult = self.status.result;
              self.stopPollAndRefresh();
            }
          })
          .catch(function () { /* transient -- next poll tick tries again */ });
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/speedtest-chunk.test.js`
Expected: PASS — all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem-speedtest.js test/speedtest-chunk.test.js
git commit -m "speedtest: capture the finished test result into lastResult"
```

---

### Task 2: Render the "Latest result" panel

**Files:**
- Modify: `src/views/mudimodem-speedtest.js` (top-level constants ~line 17-21, `injectStyle` ~line 324-348, `renderPage` ~line 349-370; add new `renderLatestResult` method)
- Test: `test/speedtest-chunk.test.js`

**Interfaces:**
- Consumes: `this.lastResult` (produced by Task 1); `this.clock(t)` (existing method, formats a ms timestamp as `MM/DD HH:MM`).
- Produces: `renderLatestResult(h)` method, called from `renderPage`; a new `ifaceLabel(id)` top-level helper function (mirrors the existing `IFACES` constant's `["cellular","Cellular"]`/`["wired","Wired WAN"]` pairs, needed because the panel must print the interface as prose, not populate a `<select>`).

- [ ] **Step 1: Write the failing tests**

Add to `test/speedtest-chunk.test.js`, after the existing `ifacesErr renders as a visible error instead of failing silently` test (currently ends at line 165, before the `RESULTS` constant):

```js
test('renderLatestResult: absent until a result exists', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.resultsLoading = false;
  const txt = textOf(c.render.call(vm, h));
  assert.doesNotMatch(txt, /Latest result/);
});

test('renderLatestResult: shows headline numbers + detail rows for the just-finished test', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.resultsLoading = false;
  vm.lastResult = { t: 2000, iface: 'cellular', down_mbps: 55, up_mbps: 12, latency_ms: 58, jitter_ms: 4,
    carrier: 'T-Mobile', slot: 1, band: 71, mode: 'NR5G-SA FDD', cell_id: 'ABC', rsrp: -95, sinr: 9, rsrq: -10 };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Latest result/);
  assert.match(txt, /Cellular/);
  assert.match(txt, /55/);
  assert.match(txt, /12/);
  assert.match(txt, /58/);
  assert.match(txt, /T-Mobile/);
  assert.match(txt, /n71/);
  assert.match(txt, /-95 dBm/);
});

test('renderLatestResult: null fields render as an honest em-dash placeholder', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.resultsLoading = false;
  vm.lastResult = { t: 1000, iface: 'wired', down_mbps: 500, up_mbps: 100, latency_ms: 8, jitter_ms: 1 };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Wired WAN/);
  assert.match(txt, /—/, 'missing carrier/band/cell/rsrp/sinr/rsrq render as em dash');
});

test('renderLatestResult: card sits between the controls card and the History card', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.resultsLoading = false;
  vm.lastResult = { t: 1000, iface: 'cellular', down_mbps: 10, up_mbps: 2, latency_ms: 20, jitter_ms: 1 };
  const txt = textOf(c.render.call(vm, h));
  const speedtestIdx = txt.indexOf('Speedtest');
  const latestIdx = txt.indexOf('Latest result');
  const historyIdx = txt.indexOf('History');
  assert.ok(speedtestIdx >= 0 && latestIdx > speedtestIdx, 'Latest result comes after the page header');
  assert.ok(historyIdx > latestIdx, 'History still comes after Latest result');
});
```

Note: the existing "History" card header is a bare `h("span", "History")` with no `mms-title` class — don't rely on `.mms-title` to find it; use text position in the flattened output instead, as above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/speedtest-chunk.test.js`
Expected: FAIL — `renderLatestResult` doesn't exist / panel never renders / the ordering test fails (`indexOf('Latest result')` is `-1` today).

- [ ] **Step 3: Implement `ifaceLabel`, `renderLatestResult`, wire it into `renderPage`, add CSS**

In `src/views/mudimodem-speedtest.js`, add `ifaceLabel` next to the other top-level constants (around line 17-21):

```js
  var IFACES = [["cellular", "Cellular"], ["wired", "Wired WAN"]];
  var INTERVALS = [[1800, "30 min"], [3600, "1 hour"], [7200, "2 hours"],
    [21600, "6 hours"], [43200, "12 hours"], [86400, "24 hours"]];
  var PHASE_TEXT = { download: "Testing download…", upload: "Testing upload…",
    latency: "Testing latency…" };
  function ifaceLabel(id) {
    for (var i = 0; i < IFACES.length; i++) if (IFACES[i][0] === id) return IFACES[i][1];
    return id;
  }
```

Add a new `renderLatestResult` method to the `methods` object, placed just before `renderGraph` (around line 196), reusing the same field formatting `renderGraph`'s tooltip already uses:

```js
      renderLatestResult: function (h) {
        if (!this.lastResult) return null;
        var r = this.lastResult;
        var big = h("div", { staticClass: "mms-latest-big" }, [
          h("div", { staticClass: "mms-latest-metric" }, [
            h("span", { staticClass: "v" }, r.down_mbps == null ? "—" : String(r.down_mbps)),
            h("span", { staticClass: "u" }, "Mbps down")
          ]),
          h("div", { staticClass: "mms-latest-metric" }, [
            h("span", { staticClass: "v" }, r.up_mbps == null ? "—" : String(r.up_mbps)),
            h("span", { staticClass: "u" }, "Mbps up")
          ]),
          h("div", { staticClass: "mms-latest-metric" }, [
            h("span", { staticClass: "v" }, r.latency_ms == null ? "—" : String(r.latency_ms)),
            h("span", { staticClass: "u" }, "ms latency")
          ])
        ]);
        var rows = [
          ["Latency", r.latency_ms == null ? "—" : r.latency_ms + " ms (±" + (r.jitter_ms == null ? "—" : r.jitter_ms) + ")"],
          ["Carrier", (r.carrier || "—") + " · SIM " + (r.slot == null ? "—" : r.slot)],
          ["Band", r.band == null ? "—" : (r.mode && /NR5G/.test(r.mode) ? "n" : "B") + r.band],
          ["Cell", r.cell_id == null ? "—" : r.cell_id],
          ["RSRP", r.rsrp == null ? "—" : r.rsrp + " dBm"],
          ["SINR", r.sinr == null ? "—" : r.sinr + " dB"],
          ["RSRQ", r.rsrq == null ? "—" : r.rsrq + " dB"]
        ];
        return h("div", { staticClass: "mms-card" }, [
          h("div", { staticClass: "mms-latest-head" }, [
            h("span", { staticClass: "mms-title" }, "Latest result"),
            h("span", { staticClass: "mms-latest-when" }, ifaceLabel(r.iface) + " · " + this.clock(r.t))
          ]),
          big,
          h("div", { staticClass: "mms-latest-rows" }, rows.map(function (row) {
            return h("div", { staticClass: "mms-tip-row" }, [h("span", row[0]), h("b", row[1])]);
          }))
        ]);
      },
```

Wire it into `renderPage` (around line 349-370), inserting between the controls card and the History card:

```js
      renderPage: function (h) {
        var self = this;
        var head = h("div", { staticClass: "mms-head" }, [
          this.embedded ? null : h("button", { staticClass: "mms-crumb", on: { click: function () {
            if (self.$router) self.$router.push("/mudimodem"); } } }, "← Modem"),
          h("span", { staticClass: "mms-title" }, "Speedtest")
        ].filter(Boolean));
        var ifaceFilterSel = h("select", {
          domProps: { value: this.filterIface },
          on: { change: function (ev) { self.filterIface = ev.target.value; } }
        }, IFACES.map(function (i) { return h("option", { attrs: { value: i[0] }, key: i[0] }, i[1]); }));
        return h("div", { staticClass: "mms" }, [
          h("div", { staticClass: "mms-card" }, [head, this.renderControls(h), this.renderSchedule(h)]),
          this.renderLatestResult(h),
          h("div", { staticClass: "mms-card" }, [
            h("div", { staticClass: "mms-controls" }, [
              h("span", "History"), ifaceFilterSel,
              h("button", { staticClass: "mms-btn", on: { click: function () { self.clearHistory(); } } }, "Clear history")
            ]),
            this.renderGraph(h)
          ])
        ]);
      }
```

Add CSS rules in `injectStyle()` (around line 324-348), appended to the existing `css` string just before the closing `.mms-tip-row b{...}` line's trailing `;`:

```js
          '.mms-tip-row b{font-weight:600;color:var(--text-title)}' +
          '.mms-latest-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}' +
          '.mms-latest-when{font-size:11px;color:var(--text-badge)}' +
          '.mms-latest-big{display:flex;gap:22px;margin-bottom:10px;flex-wrap:wrap}' +
          '.mms-latest-metric{display:flex;flex-direction:column}' +
          '.mms-latest-metric .v{font-size:22px;font-weight:700;color:var(--text-title);line-height:1.15}' +
          '.mms-latest-metric .u{font-size:10.5px;color:var(--text-badge)}';
```

(Only the last line's terminator changes from `;` to `+` on the now-not-final `.mms-tip-row b{...}` line, and the new rules become the new final line ending in `;`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/speedtest-chunk.test.js`
Expected: PASS — all tests including the 4 new ones.

- [ ] **Step 5: Run the full chunk test suite**

Run: `node --test test/`
Expected: all tests across the whole suite still pass (confirms nothing else references card ordering or the `mms-` class names this task touched).

- [ ] **Step 6: Commit**

```bash
git add src/views/mudimodem-speedtest.js test/speedtest-chunk.test.js
git commit -m "speedtest: show a latest-result panel after a test completes"
```

---

### Task 3: Deploy and manually verify on-device

**Files:** none (deploy + manual check only; no new files)

**Interfaces:**
- Consumes: `tools/deploy.sh` (existing deploy script — model-guarded push over `ssh cat`, no scp), `tools/build.sh` (existing build — gzips chunk sources).

- [ ] **Step 1: Build**

Run: `./tools/build.sh`
Expected: succeeds, regenerates `build/gl-sdk4-ui-mudimodem-speedtest.common.js.gz` from the modified source.

- [ ] **Step 2: Deploy**

Run: `./tools/deploy.sh`
Expected: succeeds, pushes the updated chunk to the router over `ssh cat` (per CLAUDE.md §1/§8 — no scp, no sftp-server on the box).

- [ ] **Step 3: Manual verification in the browser**

Open the Mudi admin, go to Modem → Speedtest. Confirm:
- No "Latest result" card on first load (no test has run yet this session).
- Click "Run speed test" (cellular). While it's running, the card is still absent (or shows the prior result if one exists from an earlier run this session — do a second run to check this specifically).
- When it finishes, a "Latest result" card appears between the controls and History cards, showing Down/Up/Latency headline numbers plus Carrier/Band/Cell/RSRP/SINR/RSRQ detail rows matching what hovering the newest graph point shows.
- Run a second test (e.g. switch to Wired WAN if available, or run cellular again) — confirm the old card stays visible with its own numbers while the new test runs, then flips to the new result on completion.
- Reload the page — confirm the card is gone again (no run happened this fresh session) even though History still shows the prior results.

No expected command output here — this is a manual UI check, since CLAUDE.md notes there's no automated way to drive the actual GL admin browser session.

- [ ] **Step 4: Update CLAUDE.md status if needed**

If this closes an open thread in `CLAUDE.md` §12, add a short status line noting the latest-result panel was added to the Speedtest tab (2026-07-21), per the existing convention of dated status entries in that section. (No other CLAUDE.md section needs changes — this doesn't alter architecture, RPC surface, or any documented invariant.)
