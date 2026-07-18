# SIM / APN Tab (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "SIM / APN - Phase 4" placeholder in the Modem page with the honest DSDS panel: two slot cards (selected vs data-carrying made visible, roaming honesty, editable dial profile with APN suggestions), a slot-switch behind a confirm dialog, and an editable failover card — all browser-direct to GL's own undotted RPC.

**Architecture:** Chunk-only change to `src/views/mudimodem.js` (plus its test). Reads come free over `global_sockets` (already subscribed in the menu JSON). Writes use exactly two GL methods, called with `window.$rpcRequest`: `modem.set_sim_config` (dial profile — **always read-modify-write**, because the same object carries the band config) and `modem.set_slot_failover_config` (failover config *and* manual slot switch — GL's own UI switches slots this way; `AT+QUIMSLOT` does not exist on this modem). **No backend, menu, or watchdog changes.**

**Tech Stack:** Plain JS Vue 2.6 options object (runtime-only — `render(h)`, never `template:`), Node 20 `node:test` for local tests, `tools/build.sh` + `tools/deploy.sh` + `tools/verify.sh` for the device.

**Spec:** `docs/superpowers/specs/2026-07-18-sim-apn-tab-design.md` — read it first. All RPC shapes below were captured from GL's own `gl-sdk4-ui-internet` chunk and the live box on 2026-07-18.

## Global Constraints

- The chunk file MUST remain a single expression (`module.exports = {...}`) — GL `eval`s it. Run `node --test test/chunk.test.js` after every edit; it evals the file exactly as the SPA does.
- `render(h)` only. Vue here is runtime-only; `template:` silently renders nothing.
- Match the file's idiom: `var self = this`, ES5 function bodies inside methods/render, GL theme tokens only (`var(--success)` etc.), never hex colours.
- **RMW is mandatory for `set_sim_config`:** the same object carries `band_enable`/`band_filter_mode`/`band_list`. A partial write clobbers the n71 band lock. Never build a `set_sim_config` payload except by merging dial-field edits into a fresh `get_sim_config` result.
- No AT commands anywhere in this tab. No `sub_id` anywhere (nothing here talks to the modem directly).
- Zero backend changes: do not touch `src/rpc/mudimodem`, `src/menu/mudimodem.json`, or `src/sbin/`.
- Working agreements: don't reboot the Mudi; deploy only via `./tools/deploy.sh` (model-guarded); keep the router IP out of the repo; commit only at the commit steps below.
- RPC helper facts (CLAUDE.md §6): `window.$rpcRequest("call", ["sid", "modem", "<method>", args], {timeout: 30000})` — the literal string `"sid"` is mandatory; it resolves to the result payload directly; rejection shapes are `{type: "accessDenied"|"invalidParams"|"timeout"|"rpcCancel"}`.

### Captured RPC shapes (ground truth — do not re-derive)

`modem.get_sim_config` args (from GL's call sites): `{slot: Number, bus: "cpu", iccid: "<iccid>"}`.
Returns the full per-SIM config, flat fields + nested `band_list`; GL's drawer model shows the field set:
`{protocol, apn, ip_type, network_mode, rrc_seg, device, service, auth, username, password, dial_number, ttl, hl, mtu, roaming, band_enable, band_filter_mode, band_list:{LTE,"NR-NSA","NR-SA"}}`.
`modem.set_sim_config` takes `{slot, bus, iccid, ...that same config}`; GL coerces `ttl`/`hl`/`mtu`/`ip_type` to `Number`.

`modem.get_slot_failover_config {bus}` → `{enable_switch, esim2_enable, current_sim, slot_priority: [1,2], enable_timing, hour: "00", min: "00", slot_type: [{slot,type},…]}`. `modem.set_slot_failover_config` takes the same object + `bus`. GL's rule: when `enable_switch` is true, `current_sim` must equal `slot_priority[0]`. `hour`/`min` are strings.

Websocket objects (all already in our `global_sockets`), live-captured shapes:
- `cellular.sims_info.sims[]`: `{slot: "1", bus, iccid, imsi, mcc: "310", mnc: "260", phone_number, apn_list: ["h2g2", …]}` — `slot` is a **string**; `apn_list` can contain duplicates.
- `cellular.sims_status.sims[]`: `{slot, iccid, carrier: "T-Mobile", status: 6, strength, type, technology, apn: "h2g2"}` — `status`: 0 no-SIM · 5 not registered · 6 registered.
- `cellular.networks_status.networks[]`: `{slot: "1", iccid, dial_status: 0|1, …}` — `dial_status: 1` marks the one slot carrying data.
- `cellular.modems_status.modems[]`: `{bus, current_sim_slot: "1", slot_switch_status, slot_switch_count}`.
- `cellular.modems_info.modems[0].supports_ip_type`: `[{label:"IPv4&IPv6",value:0},{label:"IPv4",value:1},{label:"IPv6",value:2}]` — use this, never hardcode labels.
- Auth values are strings: `"NONE" | "PAP" | "CHAP" | "PAP/CHAP"`.

Resolved decisions from the spec's probe list: the Auto/Manual APN flag is **not** in `modem.get/set_sim_config` → the toggle is **dropped** (spec §7.5 fallback). `ip_type` labels come from `supports_ip_type`. Two live checks remain and are in Task 7 only: redial-on-apply observation, and one coordinated slot-switch test.

---

### Task 1: Per-slot view model (`slotCards`) + PLMN table

The pure data layer: one computed producing a view-model per physical slot, merging `sims_info` + `sims_status` + `networks_status`, with home-operator resolution and roaming detection. No rendering yet.

**Files:**
- Modify: `src/views/mudimodem.js` (data block ~line 59, computed block after `servingCarrier` ~line 105, methods block after `qColor` ~line 168)
- Test: `test/chunk.test.js` (append)

**Interfaces:**
- Consumes: existing `ms()` and `activeSlot` computeds.
- Produces: computed `slotCards` → array of exactly two objects `{slot: 1|2, selected: bool, data: bool, reg: number|undefined, carrier: string, home: string, roaming: bool, iccid, imsi, phone, mcc, mnc, apn, apnList: string[]}`; methods `plmnName(mcc, mnc) → string`, `regLabel(reg) → string`. Tasks 3–5 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `test/chunk.test.js`. First add the failover-split fixture (top level, near the existing `LIVE` fixture) — this is the box's real state captured 2026-07-18: slot 1 selected but idle, slot 2 (Belgian Proximus-based SIM) roaming on AT&T and carrying data:

```js
// Failover split state, captured live 2026-07-18: slot 1 SELECTED (T-Mobile,
// registered, no data), slot 2 (Belgian 206-01 travel SIM, roaming on AT&T)
// CARRYING DATA. The state GL's UI cannot render.
const SPLIT = {
  'cellular.modems_info': LIVE['cellular.modems_info'],
  'cellular.modems_status': { modems: [{ bus: 'cpu', current_sim_slot: '1', slot_switch_status: 0 }] },
  'cellular.sims_info': { sims: [
    { slot: '1', bus: 'cpu', iccid: '89012601000000000001', imsi: '310260000000001',
      mcc: '310', mnc: '260', phone_number: '15550001234',
      apn_list: ['h2g2', 'fast.t-mobile.com', 'gigsky', 'gigsky'] },
    { slot: '2', bus: 'cpu', iccid: '89320420000000000002', imsi: '206018000000002',
      mcc: '206', mnc: '01', phone_number: '',
      apn_list: ['bicsapn', 'internet.proximus.be'] }
  ] },
  'cellular.sims_status': { sims: [
    { slot: '1', iccid: '89012601000000000001', carrier: 'T-Mobile', status: 6, apn: 'h2g2' },
    { slot: '2', iccid: '89320420000000000002', carrier: 'AT&T', status: 6, apn: 'internet.proximus.be' }
  ] },
  'cellular.networks_status': { networks: [
    { slot: '1', iccid: '89012601000000000001', dial_status: 0 },
    { slot: '2', iccid: '89320420000000000002', dial_status: 1 }
  ] }
};
```

Then the tests:

```js
test('slotCards: merges info/status/network per slot with the DSDS facts', () => {
  const vm = makeVm(loadChunk(), SPLIT);
  const [s1, s2] = vm.slotCards;
  assert.equal(vm.slotCards.length, 2);
  // Slot 1: selected, registered, NOT carrying data.
  assert.equal(s1.slot, 1);
  assert.equal(s1.selected, true);
  assert.equal(s1.data, false);
  assert.equal(s1.reg, 6);
  assert.equal(s1.carrier, 'T-Mobile');
  assert.equal(s1.apn, 'h2g2');
  // Slot 2: NOT selected, carrying data — the split state.
  assert.equal(s2.selected, false);
  assert.equal(s2.data, true);
  assert.equal(s2.iccid, '89320420000000000002');
});

test('slotCards: roaming honesty — home PLMN vs serving carrier', () => {
  const vm = makeVm(loadChunk(), SPLIT);
  const [s1, s2] = vm.slotCards;
  // T-Mobile SIM on T-Mobile: home operator known, not roaming.
  assert.equal(s1.home, 'T-Mobile US');
  assert.equal(s1.roaming, false);
  // Belgian 206-01 SIM serving on AT&T: roaming.
  assert.equal(s2.home, 'Proximus BE');
  assert.equal(s2.roaming, true);
});

test('slotCards: apn_list is deduplicated', () => {
  const vm = makeVm(loadChunk(), SPLIT);
  assert.deepEqual(vm.slotCards[0].apnList, ['h2g2', 'fast.t-mobile.com', 'gigsky']);
});

test('slotCards: empty slot degrades to blanks, unknown PLMN to mcc-mnc', () => {
  const empty = JSON.parse(JSON.stringify(SPLIT));
  empty['cellular.sims_info'].sims = [
    { slot: '1', mcc: '999', mnc: '99', iccid: 'X', imsi: 'Y', apn_list: [] }
  ];
  empty['cellular.sims_status'].sims = [{ slot: '1', status: 0 }];
  empty['cellular.networks_status'].networks = [];
  const vm = makeVm(loadChunk(), empty);
  const [s1, s2] = vm.slotCards;
  assert.equal(s1.home, '999-99');           // unknown PLMN: no fake name
  assert.equal(s1.roaming, false);           // status 0 → never claim roaming
  assert.equal(s2.iccid, '');                // absent slot → blank card, no crash
  assert.equal(s2.reg, undefined);
});

test('regLabel maps GL sim-status codes', () => {
  const vm = makeVm(loadChunk(), SPLIT);
  assert.equal(vm.regLabel(6), 'Registered');
  assert.equal(vm.regLabel(5), 'Not registered');
  assert.equal(vm.regLabel(0), 'No SIM');
  assert.equal(vm.regLabel(undefined), '—');
  assert.equal(vm.regLabel(3), 'Status 3');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunk.test.js`
Expected: the five new tests FAIL (`vm.slotCards is undefined` / `vm.regLabel is not a function`); every pre-existing test still PASSES.

- [ ] **Step 3: Implement the data layer**

In `data()`, after the `freq` table (before its closing brace ~line 59), add:

```js
      ,
      // Home-operator names for common PLMNs (MCC+MNC from sims_info). Labels
      // only — used for the "roaming on X" honesty line. Unknown → "MCC-MNC".
      PLMN: {
        "310260": "T-Mobile US", "312250": "T-Mobile US", "310410": "AT&T US",
        "310280": "AT&T US", "311480": "Verizon US", "313100": "FirstNet US",
        "20601": "Proximus BE", "20404": "Vodafone NL", "26201": "Telekom DE",
        "23430": "EE UK", "20801": "Orange FR", "22201": "TIM IT",
        "21407": "Movistar ES", "50501": "Telstra AU", "44010": "docomo JP",
        "302220": "Telus CA", "302610": "Bell CA", "302720": "Rogers CA"
      }
```

In `computed`, after `servingCarrier` (~line 105), add:

```js
    // ---- SIM tab (Phase 4) ----
    // One view-model per physical slot: identity + registration + the two DSDS
    // facts GL never shows together (selected slot vs data-carrying slot).
    slotCards() {
      var self = this;
      var infos = this.ms("cellular.sims_info").sims || [];
      var stats = this.ms("cellular.sims_status").sims || [];
      var nets = this.ms("cellular.networks_status").networks || [];
      return [1, 2].map(function (slot) {
        var bySlot = function (arr) {
          return arr.filter(function (x) { return String(x.slot) === String(slot); })[0] || {};
        };
        var info = bySlot(infos), st = bySlot(stats), net = bySlot(nets);
        var home = self.plmnName(info.mcc, info.mnc);
        var named = !!self.PLMN[String(info.mcc || "") + String(info.mnc || "")];
        return {
          slot: slot,
          selected: String(self.activeSlot) === String(slot),
          data: net.dial_status === 1,
          reg: st.status,
          carrier: st.carrier || "",
          home: home,
          // Roaming claim only when confident: registered, home PLMN known, and
          // the serving carrier's name doesn't contain the home name (or vice
          // versa — "T-Mobile" vs "T-Mobile US" is home, not roaming).
          roaming: st.status === 6 && named && !!st.carrier &&
            !self.nameOverlap(home, st.carrier),
          iccid: info.iccid || "", imsi: info.imsi || "",
          phone: info.phone_number || "",
          mcc: info.mcc || "", mnc: info.mnc || "",
          apn: st.apn || "",
          apnList: (info.apn_list || []).filter(function (a, i, arr) {
            return arr.indexOf(a) === i;
          })
        };
      });
    },
```

In `methods`, after `qColor` (~line 168), add:

```js
    plmnName(mcc, mnc) {
      if (!mcc) return "";
      return this.PLMN[String(mcc) + String(mnc)] || (mcc + "-" + mnc);
    },
    // Case/punctuation-insensitive containment: "T-Mobile US" vs "T-Mobile".
    nameOverlap(a, b) {
      var n = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); };
      var x = n(a), y = n(b);
      return !!x && !!y && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1);
    },
    regLabel(reg) {
      if (reg === undefined || reg === null) return "—";
      return ({ 0: "No SIM", 5: "Not registered", 6: "Registered" })[reg] || ("Status " + reg);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 4: per-slot view model with DSDS + roaming facts"
```

---

### Task 2: Config plumbing — fetch on tab entry + the RMW merge guard

The RPC layer: per-slot dial config, failover config, and the pure merge function that makes clobbering the band lock impossible. No rendering yet.

**Files:**
- Modify: `src/views/mudimodem.js` (data ~line 48, watch `tab` ~line 151, methods after `seedFor` ~line 224)
- Test: `test/chunk.test.js` (append)

**Interfaces:**
- Consumes: `slotCards` (Task 1), existing `modem` computed (`.bus`).
- Produces: data fields `simCfg {1,2}`, `simCfgErr {1,2}`, `simEdit {1,2}`, `failover`, `failoverEdit`, `failoverErr`; methods `loadSimTab()`, `fetchSimCfg(slot)`, `fetchFailover()`, `mergeSimConfig(fresh, edits) → object`. Tasks 4–6 rely on these exact names. `simEdit[slot]` shape: `{apn, auth, username, password, ip_type: Number, roaming: bool}`. `failoverEdit` shape: `{enable_switch: bool, slot_priority: number[], enable_timing: bool, hour: string, min: string}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/chunk.test.js`. The RPC tests need a `window.$rpcRequest` stub; add this helper near `makeVm`:

```js
// Install a window.$rpcRequest stub that records calls and replies from a
// queue of results (or rejects when an Error is queued). Returns the record.
function stubRpc(replies) {
  const calls = [];
  global.window = {
    $rpcRequest(method, params, opts) {
      calls.push({ method, params, opts });
      const r = replies.shift();
      return (r instanceof Error) ? Promise.reject(r) : Promise.resolve(r);
    }
  };
  return calls;
}
function unstubRpc() { delete global.window; }
```

Then the tests:

```js
test('mergeSimConfig: dial edits land, band fields pass through untouched', () => {
  const vm = makeVm(loadChunk(), SPLIT);
  const fresh = {
    protocol: 'rmnet', apn: 'old', auth: 'NONE', username: '', password: '',
    ip_type: 0, roaming: true, network_mode: 'AUTO', ttl: '0', hl: '0', mtu: '0',
    band_enable: true, band_filter_mode: 0,
    band_list: { LTE: [], 'NR-NSA': [], 'NR-SA': [71] }
  };
  const out = vm.mergeSimConfig(fresh, {
    apn: 'new-apn', auth: 'PAP', username: 'u', password: 'p', ip_type: 1, roaming: false
  });
  // Dial fields updated…
  assert.equal(out.apn, 'new-apn');
  assert.equal(out.auth, 'PAP');
  assert.equal(out.ip_type, 1);
  assert.equal(out.roaming, false);
  // …the band lock survives verbatim…
  assert.equal(out.band_enable, true);
  assert.equal(out.band_filter_mode, 0);
  assert.deepEqual(out.band_list, { LTE: [], 'NR-NSA': [], 'NR-SA': [71] });
  // …numeric passthroughs coerced the way GL coerces them…
  assert.strictEqual(out.ttl, 0);
  assert.strictEqual(out.mtu, 0);
  // …and the input object was not mutated.
  assert.equal(fresh.apn, 'old');
});

test('fetchSimCfg: calls modem.get_sim_config with slot+bus+iccid, seeds simEdit', async () => {
  const calls = stubRpc([{ apn: 'h2g2', auth: 'NONE', username: '', password: '',
    ip_type: 0, roaming: true, band_enable: true }]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.fetchSimCfg(1);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, ['sid', 'modem', 'get_sim_config',
      { slot: 1, bus: 'cpu', iccid: '89012601000000000001' }]);
    assert.equal(vm.simCfg[1].apn, 'h2g2');
    assert.deepEqual(vm.simEdit[1],
      { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true });
  } finally { unstubRpc(); }
});

test('fetchSimCfg: RPC rejection lands in simCfgErr, simEdit stays null', async () => {
  const calls = stubRpc([Object.assign(new Error('x'), { type: 'timeout' })]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.fetchSimCfg(2);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(vm.simCfgErr[2], 'timeout');
    assert.equal(vm.simEdit[2], null);
  } finally { unstubRpc(); }
});

test('fetchFailover: reads config and seeds failoverEdit with string hour/min', async () => {
  const calls = stubRpc([{ enable_switch: true, esim2_enable: false, current_sim: 1,
    slot_priority: [1, 2], enable_timing: false, hour: '03', min: '30',
    slot_type: [{ slot: 1, type: 0 }, { slot: 2, type: 0 }] }]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.fetchFailover();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls[0].params, ['sid', 'modem', 'get_slot_failover_config', { bus: 'cpu' }]);
    assert.deepEqual(vm.failoverEdit, {
      enable_switch: true, slot_priority: [1, 2], enable_timing: false, hour: '03', min: '30'
    });
  } finally { unstubRpc(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunk.test.js`
Expected: the four new tests FAIL (`mergeSimConfig is not a function` etc.); everything else PASSES.

- [ ] **Step 3: Implement the plumbing**

In `data()`, after `trackingErr` (~line 48), add:

```js
      // ---- SIM tab (Phase 4) — all writes browser-direct to GL's own undotted
      // RPC (modem.*); zero mudimodem-backend involvement. Keys 1/2 are the two
      // physical slots, predeclared so plain assignment stays reactive.
      simCfg: { 1: null, 2: null },      // fresh get_sim_config per slot (the RMW base)
      simCfgErr: { 1: "", 2: "" },
      simEdit: { 1: null, 2: null },     // editable dial-profile fields per slot
      simReveal: { 1: false, 2: false }, // identity fields unmasked per card
      simApplying: 0,                    // slot with an Apply in flight, else 0
      simApplyErr: { 1: "", 2: "" },
      switchConfirm: 0,                  // slot awaiting "Use this SIM" confirm, else 0
      switchTarget: 0,                   // slot a switch is moving to, else 0
      switchErr: "",
      switchTimer: null,                 // fallback timer clearing the switching state
      failover: null,                    // get_slot_failover_config result (passthrough base)
      failoverEdit: null,                // editable copy
      failoverErr: "",
      failoverApplying: false,
      failoverConfirm: false,            // failover Apply would switch slots — confirm first
```

In `watch`, extend the existing `tab` handler (~line 151):

```js
    tab(t) {
      if (t === "bands" && !this.bands && !this.bandsLoading) this.fetchBands();
      if (t === "sim") this.loadSimTab();
    }
```

In `methods`, after `seedFor` (~line 224), add:

```js
    // ---- SIM tab (Phase 4) ----
    // Refetch on every tab entry: cheap, and the RMW base must be fresh anyway.
    loadSimTab() {
      this.fetchFailover();
      this.fetchSimCfg(1);
      this.fetchSimCfg(2);
    },
    fetchSimCfg(slot) {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return;
      var card = this.slotCards[slot - 1];
      if (!card.iccid) { this.simCfgErr[slot] = ""; return; }   // empty slot: nothing to fetch
      window.$rpcRequest("call", ["sid", "modem", "get_sim_config",
        { slot: slot, bus: this.modem.bus, iccid: card.iccid }], { timeout: 30000 })
        .then(function (cfg) {
          self.simCfg[slot] = cfg;
          self.simEdit[slot] = {
            apn: cfg.apn || "", auth: cfg.auth || "NONE",
            username: cfg.username || "", password: cfg.password || "",
            ip_type: Number(cfg.ip_type || 0), roaming: !!cfg.roaming
          };
          self.simCfgErr[slot] = "";
        })
        .catch(function (e) {
          self.simCfgErr[slot] = (e && (e.type || e.message)) || "request failed";
        });
    },
    // RMW guard — the ONLY way a set_sim_config payload may be built. The same
    // object carries the band config (band_enable/band_filter_mode/band_list);
    // merging into a fresh read is what keeps the n71 lock unclobberable.
    mergeSimConfig(fresh, edits) {
      var out = {};
      for (var k in fresh) out[k] = fresh[k];
      out.apn = edits.apn;
      out.auth = edits.auth;
      out.username = edits.username;
      out.password = edits.password;
      out.ip_type = Number(edits.ip_type);
      out.roaming = !!edits.roaming;
      // GL coerces these to Number on its own writes; mirror it.
      if (out.ttl !== undefined) out.ttl = Number(out.ttl || 0);
      if (out.hl !== undefined) out.hl = Number(out.hl || 0);
      if (out.mtu !== undefined) out.mtu = Number(out.mtu || 0);
      return out;
    },
    fetchFailover() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return;
      window.$rpcRequest("call", ["sid", "modem", "get_slot_failover_config",
        { bus: this.modem.bus }], { timeout: 30000 })
        .then(function (cfg) {
          self.failover = cfg;
          self.failoverEdit = {
            enable_switch: !!cfg.enable_switch,
            slot_priority: (cfg.slot_priority || [1, 2]).slice(),
            enable_timing: !!cfg.enable_timing,
            hour: cfg.hour != null ? String(cfg.hour) : "00",
            min: cfg.min != null ? String(cfg.min) : "00"
          };
          self.failoverErr = "";
        })
        .catch(function (e) {
          self.failoverErr = (e && (e.type || e.message)) || "request failed";
        });
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 4: sim/failover config plumbing + RMW merge guard"
```

---

### Task 3: Read-only slot cards + CSS

Replace the placeholder with `renderSim(h)`: two slot cards showing header badges, identity (masked, click-to-reveal), and the current APN. Editing, switching, and failover come in Tasks 4–6; this task must leave the tab useful read-only.

**Files:**
- Modify: `src/views/mudimodem.js` (methods — add `renderSim`/`renderSlotCard` + `maskId`; render `panel` dispatch ~line 730; `injectStyle` CSS string ~line 375 area)
- Test: `test/chunk.test.js` (append)

**Interfaces:**
- Consumes: `slotCards`, `regLabel` (Task 1); `simCfgErr` (Task 2).
- Produces: methods `renderSim(h)`, `renderSlotCard(h, card)`, `maskId(v)`. Task 4 extends `renderSlotCard`'s form area; Task 5 adds its footer button; Task 6 appends a card inside `renderSim`. CSS classes: `.mm-simgrid`, `.mm-slot`, `.mm-slot.sel`, `.mm-badges`, `.mm-badge` (+ modifiers `.b-sel`, `.b-data`, `.b-reg`, `.b-warn`, `.b-off`), `.mm-idrow`, `.mm-reveal`.

- [ ] **Step 1: Write the failing tests**

```js
test('SIM tab renders two slot cards with honest DSDS badges', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  const nodes = walk(comp.render.call(vm, h));
  const cards = nodes.filter((n) => /mm-slot\b/.test(n.data.staticClass || ''));
  assert.equal(cards.length, 2);
  // Selected ring on slot 1 only.
  assert.ok(/\bsel\b/.test(cards[0].data.staticClass));
  assert.ok(!/\bsel\b/.test(cards[1].data.staticClass));
  // The split state: "Selected" on card 1, "Carrying data" on card 2.
  assert.ok(textOf(cards[0]).includes('Selected'));
  assert.ok(!textOf(cards[0]).includes('Carrying data'));
  assert.ok(textOf(cards[1]).includes('Carrying data'));
  // Roaming honesty on card 2.
  assert.ok(textOf(cards[1]).includes('Proximus BE'));
  assert.ok(textOf(cards[1]).includes('Roaming on AT&T'));
});

test('SIM tab masks identity until revealed', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  let text = textOf(comp.render.call(vm, h));
  assert.ok(!text.includes('89012601000000000001'));   // full ICCID hidden
  assert.ok(text.includes('8901…'));                   // masked stub shown
  vm.simReveal[1] = true;
  text = textOf(comp.render.call(vm, h));
  assert.ok(text.includes('89012601000000000001'));
});

test('SIM tab: empty slot renders as an empty card, no crash', () => {
  const empty = JSON.parse(JSON.stringify(SPLIT));
  empty['cellular.sims_info'].sims = empty['cellular.sims_info'].sims.slice(0, 1);
  empty['cellular.sims_status'].sims = [
    empty['cellular.sims_status'].sims[0], { slot: '2', status: 0 }
  ];
  const comp = loadChunk();
  const vm = makeVm(comp, empty);
  vm.tab = 'sim';
  const text = textOf(comp.render.call(vm, h));
  assert.ok(text.includes('No SIM'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunk.test.js`
Expected: new tests FAIL (cards not found — the placeholder card renders instead).

- [ ] **Step 3: Implement render + CSS**

In the `render(h)` panel dispatch, insert before the final `else` (~line 730):

```js
    } else if (this.tab === "sim") {
      panel = this.renderSim(h);
```

and delete the `sim: "SIM / APN - Phase 4."` line from the `soon` map.

Add to `methods` (after the Task 2 methods):

```js
    maskId(v) { return v ? String(v).slice(0, 4) + "…" : "—"; },
    renderSlotCard(h, card) {
      var self = this, slot = card.slot;
      var revealed = this.simReveal[slot];
      // Fact badges: Selected (mint) and Carrying data (indigo) are different
      // facts and never share a colour (spec §4). Registration is neutral/amber.
      var badges = [];
      if (card.selected) badges.push(h("span", { staticClass: "mm-badge b-sel" }, "Selected"));
      if (card.data) badges.push(h("span", { staticClass: "mm-badge b-data" }, "Carrying data"));
      badges.push(h("span", {
        staticClass: "mm-badge " + (card.reg === 6 ? "b-reg" : card.reg === 5 ? "b-warn" : "b-off")
      }, this.regLabel(card.reg)));

      var idRow = function (label, val) {
        return h("div", { staticClass: "mm-idrow" }, [
          h("span", { staticClass: "k" }, label),
          h("b", revealed ? (val || "—") : self.maskId(val))
        ]);
      };

      var kids = [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, card.carrier || (card.reg === 0 || card.reg === undefined ? "Empty" : "SIM")),
          h("span", { staticClass: "mm-hint" }, "Slot " + slot)
        ]),
        h("div", { staticClass: "mm-badges" }, badges)
      ];

      // Identity: home operator + roaming honesty, then masked identifiers.
      if (card.iccid) {
        if (card.home) {
          kids.push(h("div", { staticClass: "mm-idrow" }, [
            h("span", { staticClass: "k" }, "Home operator"),
            h("b", card.home + (card.roaming ? "" : ""))
          ]));
        }
        if (card.roaming) {
          kids.push(h("div", {
            staticClass: "mm-hint",
            staticStyle: { color: "var(--warning)", margin: "2px 0 6px" }
          }, "Roaming on " + card.carrier));
        }
        kids.push(idRow("ICCID", card.iccid));
        kids.push(idRow("IMSI", card.imsi));
        if (card.phone) kids.push(idRow("Phone", card.phone));
        kids.push(h("button", {
          staticClass: "mm-reveal",
          on: { click: function () { self.simReveal[slot] = !revealed; } }
        }, revealed ? "Hide identifiers" : "Show identifiers"));
        kids.push(h("div", { staticClass: "mm-idrow" }, [
          h("span", { staticClass: "k" }, "APN in use"),
          h("b", card.apn || "—")
        ]));
      }
      if (this.simCfgErr[slot]) {
        kids.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
          "Couldn't load dial config: " + this.simCfgErr[slot]));
      }
      return h("div", { key: slot, staticClass: "mm-card mm-slot" + (card.selected ? " sel" : "") }, kids);
    },
    renderSim(h) {
      var self = this;
      return h("div", [
        h("div", { staticClass: "mm-simgrid" },
          this.slotCards.map(function (c) { return self.renderSlotCard(h, c); })),
        // Failover card lands here in Task 6.
        h("div", { staticClass: "mm-hint", staticStyle: { marginTop: "9px" } },
          "DSDS: both SIMs stay registered; exactly one carries data at a time. " +
          "The selected slot and the data-carrying slot can differ during failover — " +
          "both facts are shown above. (AT users: sub_id must follow the active " +
          "subscription; sub_id=0 answers for the wrong SIM.)")
      ]);
    },
```

In `injectStyle`'s CSS string (append alongside the existing `.mm-*` rules — find the string containing `.mm-tabs{` ~line 375 and add):

```js
        '.mm-simgrid{display:grid;grid-template-columns:1fr 1fr;gap:11px}' +
        '@media (max-width:720px){.mm-simgrid{grid-template-columns:1fr}}' +
        '.mm-slot.sel{box-shadow:0 0 0 1.5px var(--success) inset}' +
        '.mm-badges{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0 9px}' +
        '.mm-badge{font-size:11px;padding:2px 8px;border-radius:9px;border:1px solid var(--divider);color:var(--text-secondary)}' +
        '.mm-badge.b-sel{border-color:var(--success);color:var(--success)}' +
        '.mm-badge.b-data{background:var(--primary);border-color:var(--primary);color:#fff}' +
        '.mm-badge.b-warn{border-color:var(--warning);color:var(--warning)}' +
        '.mm-badge.b-off{color:var(--text-hint)}' +
        '.mm-idrow{display:flex;justify-content:space-between;gap:9px;padding:3px 0;font-size:12.5px}' +
        '.mm-idrow .k{color:var(--text-hint)}' +
        '.mm-reveal{background:none;border:none;color:var(--primary);font-size:12px;padding:2px 0;cursor:pointer}' +
```

(Exact concatenation style must match the surrounding lines — it is one long string of `'…' +` pieces.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 4: read-only slot cards with DSDS badges + roaming honesty"
```

---

### Task 4: Dial-profile form + Apply (the RMW write)

Make the dial profile editable per card: APN with suggestion chips, auth, username/password, IP type, roaming — applied via fresh-read → `mergeSimConfig` → `set_sim_config`.

**Files:**
- Modify: `src/views/mudimodem.js` (methods — `applySim`, `simDirty`, extend `renderSlotCard`; CSS additions)
- Test: `test/chunk.test.js` (append)

**Interfaces:**
- Consumes: `simEdit`/`simCfg`/`mergeSimConfig`/`fetchSimCfg` (Task 2), `renderSlotCard` (Task 3), `modem.supports_ip_type` from the websocket.
- Produces: methods `applySim(slot)`, `simDirty(slot) → bool`, `ipTypeOptions` computed. CSS classes `.mm-form`, `.mm-frow`, `.mm-input`, `.mm-select`, `.mm-apnchip`, `.mm-apply`.

- [ ] **Step 1: Write the failing tests**

```js
test('applySim: fresh read, merged write, band fields intact in the payload', async () => {
  const FRESH = { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0,
    roaming: true, band_enable: true, band_filter_mode: 0,
    band_list: { LTE: [], 'NR-NSA': [], 'NR-SA': [71] } };
  const calls = stubRpc([FRESH, {}]);   // reply 1: get_sim_config; reply 2: set_sim_config
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.simEdit[1] = { apn: 'fast.t-mobile.com', auth: 'NONE', username: '', password: '',
      ip_type: 0, roaming: true };
    vm.applySim(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params[2], 'get_sim_config');
    assert.equal(calls[1].params[2], 'set_sim_config');
    const payload = calls[1].params[3];
    assert.equal(payload.slot, 1);
    assert.equal(payload.bus, 'cpu');
    assert.equal(payload.iccid, '89012601000000000001');
    assert.equal(payload.apn, 'fast.t-mobile.com');
    // The band lock rides through untouched — the whole point of RMW.
    assert.equal(payload.band_enable, true);
    assert.deepEqual(payload.band_list, { LTE: [], 'NR-NSA': [], 'NR-SA': [71] });
  } finally { unstubRpc(); }
});

test('applySim: failure surfaces in simApplyErr and clears the in-flight flag', async () => {
  const calls = stubRpc([Object.assign(new Error('x'), { type: 'accessDenied' })]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.simEdit[1] = { apn: 'a', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true };
    vm.applySim(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.simApplying, 0);
    assert.equal(vm.simApplyErr[1], 'accessDenied');
  } finally { unstubRpc(); }
});

test('simDirty: true only when an edit differs from the loaded config', () => {
  const vm = makeVm(loadChunk(), SPLIT);
  vm.simCfg[1] = { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true };
  vm.simEdit[1] = { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true };
  assert.equal(vm.simDirty(1), false);
  vm.simEdit[1].apn = 'other';
  assert.equal(vm.simDirty(1), true);
});

test('dial form renders APN chips from apn_list and an Apply button', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  vm.simEdit[1] = { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true };
  const nodes = walk(comp.render.call(vm, h));
  const chips = nodes.filter((n) => /mm-apnchip/.test(n.data.staticClass || ''));
  assert.ok(chips.length >= 3);                       // deduped apn_list for slot 1
  assert.ok(chips.some((c) => textOf(c) === 'fast.t-mobile.com'));
  const applies = nodes.filter((n) => /mm-apply/.test(n.data.staticClass || ''));
  assert.equal(applies.length, 1);                    // only the loaded slot has a form
});

test('auth != NONE reveals username/password inputs', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  vm.simEdit[1] = { apn: 'h2g2', auth: 'PAP', username: '', password: '', ip_type: 0, roaming: true };
  const nodes = walk(comp.render.call(vm, h));
  const inputs = nodes.filter((n) => n.tag === 'input' &&
    ((n.data.attrs || {}).placeholder === 'Username' || (n.data.attrs || {}).placeholder === 'Password'));
  assert.equal(inputs.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunk.test.js`
Expected: the five new tests FAIL; everything else PASSES.

- [ ] **Step 3: Implement form + apply**

Add computed (after `slotCards`):

```js
    // IP-type labels come from the modem itself over the websocket — never
    // hardcoded (supports_ip_type: 0 IPv4&IPv6 · 1 IPv4 · 2 IPv6 on this box).
    ipTypeOptions() { return this.modem.supports_ip_type || []; },
```

Add methods:

```js
    AUTHS() { return ["NONE", "PAP", "CHAP", "PAP/CHAP"]; },
    simDirty(slot) {
      var cfg = this.simCfg[slot], ed = this.simEdit[slot];
      if (!cfg || !ed) return false;
      return ed.apn !== (cfg.apn || "") || ed.auth !== (cfg.auth || "NONE") ||
        ed.username !== (cfg.username || "") || ed.password !== (cfg.password || "") ||
        Number(ed.ip_type) !== Number(cfg.ip_type || 0) || !!ed.roaming !== !!cfg.roaming;
    },
    applySim(slot) {
      var self = this;
      if (this.simApplying || typeof window === "undefined" || !window.$rpcRequest) return;
      var card = this.slotCards[slot - 1];
      if (!card.iccid || !this.simEdit[slot]) return;
      this.simApplying = slot;
      this.simApplyErr[slot] = "";
      // Fresh read immediately before the write, so every passthrough field
      // (band config included) is current — never write from a stale base.
      window.$rpcRequest("call", ["sid", "modem", "get_sim_config",
        { slot: slot, bus: this.modem.bus, iccid: card.iccid }], { timeout: 30000 })
        .then(function (fresh) {
          self.simCfg[slot] = fresh;
          var payload = self.mergeSimConfig(fresh, self.simEdit[slot]);
          payload.slot = slot;
          payload.bus = self.modem.bus;
          payload.iccid = card.iccid;
          return window.$rpcRequest("call", ["sid", "modem", "set_sim_config", payload],
            { timeout: 30000 });
        })
        .then(function () {
          self.simApplying = 0;
          self.fetchSimCfg(slot);   // re-seed edits from what actually stuck
        })
        .catch(function (e) {
          self.simApplying = 0;
          self.simApplyErr[slot] = (e && (e.type || e.message)) || "request failed";
        });
    },
```

Extend `renderSlotCard` — insert after the "APN in use" row, still inside the `if (card.iccid)` block:

```js
        var ed = self.simEdit[slot];
        if (ed) {
          var frow = function (label, ctl) {
            return h("div", { staticClass: "mm-frow" }, [h("span", { staticClass: "k" }, label), ctl]);
          };
          var form = [
            frow("APN", h("input", {
              staticClass: "mm-input",
              attrs: { value: ed.apn, maxlength: 128, placeholder: "APN" },
              on: { input: function (ev) { ed.apn = ev.target.value; } }
            })),
            h("div", { staticClass: "mm-apnchips" }, card.apnList.map(function (a) {
              return h("button", {
                key: a,
                staticClass: "mm-apnchip" + (ed.apn === a ? " on" : ""),
                on: { click: function () { ed.apn = a; } }
              }, a);
            })),
            frow("Auth", h("select", {
              staticClass: "mm-select",
              attrs: { value: ed.auth },
              on: { change: function (ev) { ed.auth = ev.target.value; } }
            }, self.AUTHS().map(function (a) {
              return h("option", { key: a, attrs: { value: a, selected: ed.auth === a } }, a);
            })))
          ];
          if (ed.auth !== "NONE") {
            form.push(frow("Username", h("input", {
              staticClass: "mm-input", attrs: { value: ed.username, placeholder: "Username" },
              on: { input: function (ev) { ed.username = ev.target.value; } }
            })));
            form.push(frow("Password", h("input", {
              staticClass: "mm-input", attrs: { value: ed.password, type: "password", placeholder: "Password" },
              on: { input: function (ev) { ed.password = ev.target.value; } }
            })));
          }
          form.push(frow("IP type", h("select", {
            staticClass: "mm-select",
            attrs: { value: String(ed.ip_type) },
            on: { change: function (ev) { ed.ip_type = Number(ev.target.value); } }
          }, self.ipTypeOptions.map(function (o) {
            return h("option", { key: o.value, attrs: { value: String(o.value), selected: Number(ed.ip_type) === o.value } }, o.label);
          }))));
          form.push(frow("Data roaming", h("button", {
            staticClass: "mm-apnchip" + (ed.roaming ? " on" : ""),
            attrs: { "aria-pressed": String(!!ed.roaming) },
            on: { click: function () { ed.roaming = !ed.roaming; } }
          }, ed.roaming ? "Allowed" : "Blocked")));
          form.push(h("button", {
            staticClass: "mm-apply",
            attrs: { disabled: self.simApplying === slot || !self.simDirty(slot) },
            on: { click: function () { self.applySim(slot); } }
          }, self.simApplying === slot ? "Applying…" : "Apply"));
          if (self.simApplyErr[slot]) {
            form.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
              "Apply failed: " + self.simApplyErr[slot]));
          }
          kids.push(h("div", { staticClass: "mm-form" }, form));
        }
```

Note the guard the spec demands: when `simCfg[slot]` failed to load, `simEdit[slot]` is `null` and no form (hence no Apply) renders — a blind write is impossible.

CSS additions (same string as Task 3):

```js
        '.mm-form{margin-top:9px;border-top:1px solid var(--divider);padding-top:7px}' +
        '.mm-frow{display:flex;justify-content:space-between;align-items:center;gap:9px;padding:3px 0;font-size:12.5px}' +
        '.mm-frow .k{color:var(--text-hint);flex:none}' +
        '.mm-input,.mm-select{background:var(--background-title);border:1px solid var(--divider);border-radius:6px;color:var(--text-primary);font-size:12.5px;padding:4px 8px;min-width:0;flex:1;max-width:200px}' +
        '.mm-apnchips{display:flex;gap:5px;flex-wrap:wrap;margin:3px 0 5px}' +
        '.mm-apnchip{font-size:11px;padding:2px 8px;border-radius:9px;border:1px solid var(--divider);background:none;color:var(--text-secondary);cursor:pointer}' +
        '.mm-apnchip.on{border-color:var(--primary);color:var(--primary)}' +
        '.mm-apply{margin-top:7px;padding:5px 14px;border-radius:6px;border:none;background:var(--primary);color:#fff;font-size:12.5px;cursor:pointer}' +
        '.mm-apply:disabled{opacity:.45;cursor:default}' +
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 4: editable dial profile with APN chips, RMW apply"
```

---

### Task 5: "Use this SIM" — slot switch behind a confirm

The one disruptive action. Button on the non-selected card → inline confirm stating the consequence → `set_slot_failover_config` with `current_sim` (GL's own switch path — there is no modem AT for this). A timeout during the switch is expected, not an error.

**Files:**
- Modify: `src/views/mudimodem.js` (methods — `askSwitch`/`doSwitch`/`clearSwitchState`, extend `renderSlotCard` footer; `watch` — clear switching state when `activeSlot` lands; `beforeDestroy` — clear timer)
- Test: `test/chunk.test.js` (append)

**Interfaces:**
- Consumes: `slotCards`, `activeSlot`, `failover` fields (Task 2 fetches), data fields `switchConfirm`/`switchTarget`/`switchErr`/`switchTimer` (declared in Task 2).
- Produces: methods `askSwitch(slot)`, `doSwitch(slot)`, `clearSwitchState()`. CSS `.mm-switchbox`.

- [ ] **Step 1: Write the failing tests**

```js
test('doSwitch: RMW on failover config, sets current_sim, reorders priority when auto-switch on', async () => {
  const FCFG = { enable_switch: true, esim2_enable: false, current_sim: 1,
    slot_priority: [1, 2], enable_timing: false, hour: '00', min: '00',
    slot_type: [{ slot: 1, type: 0 }, { slot: 2, type: 0 }] };
  const calls = stubRpc([FCFG, {}]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.doSwitch(2);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[0].params[2], 'get_slot_failover_config');
    assert.equal(calls[1].params[2], 'set_slot_failover_config');
    const p = calls[1].params[3];
    assert.equal(p.bus, 'cpu');
    assert.equal(p.current_sim, 2);
    assert.deepEqual(p.slot_priority, [2, 1]);          // manual pick becomes the preference
    assert.equal(p.esim2_enable, false);                // passthrough intact
    assert.deepEqual(p.slot_type, FCFG.slot_type);
    assert.equal(vm.switchTarget, 2);
  } finally { unstubRpc(); }
});

test('doSwitch: timeout is EXPECTED (link drops), not an error', async () => {
  const FCFG = { enable_switch: false, current_sim: 1, slot_priority: [1, 2] };
  const calls = stubRpc([FCFG, Object.assign(new Error('t'), { type: 'timeout' })]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.doSwitch(2);
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.switchErr, '');                     // no error shown
    assert.equal(vm.switchTarget, 2);                   // still waiting on the websocket
  } finally { unstubRpc(); }
});

test('switch confirm: button on non-selected card only, confirm box states the cost', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  let nodes = walk(comp.render.call(vm, h));
  const useBtns = nodes.filter((n) => textOf(n) === 'Use this SIM' && n.tag === 'button');
  assert.equal(useBtns.length, 1);                      // only on slot 2 (non-selected)
  vm.switchConfirm = 2;
  nodes = walk(comp.render.call(vm, h));
  const box = nodes.filter((n) => /mm-switchbox/.test(n.data.staticClass || ''));
  assert.equal(box.length, 1);
  assert.ok(textOf(box[0]).includes('drops connectivity'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunk.test.js`
Expected: new tests FAIL (`doSwitch is not a function`, no switch button found).

- [ ] **Step 3: Implement the switch**

Methods:

```js
    askSwitch(slot) { this.switchConfirm = slot; this.switchErr = ""; },
    clearSwitchState() {
      this.switchTarget = 0;
      if (this.switchTimer) { clearTimeout(this.switchTimer); this.switchTimer = null; }
    },
    // GL's own UI switches slots by applying the failover config with
    // current_sim set — QUIMSLOT does not exist on this modem (GL-layer only).
    doSwitch(slot) {
      var self = this;
      if (this.switchTarget || typeof window === "undefined" || !window.$rpcRequest) return;
      this.switchConfirm = 0;
      this.switchErr = "";
      this.switchTarget = slot;
      window.$rpcRequest("call", ["sid", "modem", "get_slot_failover_config",
        { bus: this.modem.bus }], { timeout: 30000 })
        .then(function (cfg) {
          var payload = {};
          for (var k in cfg) payload[k] = cfg[k];        // esim2_enable, slot_type… intact
          payload.bus = self.modem.bus;
          payload.current_sim = slot;
          // GL's invariant: with auto-switch on, current_sim == slot_priority[0].
          if (payload.enable_switch) payload.slot_priority = [slot, slot === 1 ? 2 : 1];
          return window.$rpcRequest("call", ["sid", "modem", "set_slot_failover_config",
            payload], { timeout: 30000 });
        })
        .then(function () { self.armSwitchFallback(); })
        .catch(function (e) {
          // The data link drops mid-switch; a timeout here means "in progress",
          // not "failed" — keep waiting for the websocket to confirm.
          if (e && e.type === "timeout") { self.armSwitchFallback(); return; }
          self.clearSwitchState();
          self.switchErr = (e && (e.type || e.message)) || "request failed";
        });
    },
    armSwitchFallback() {
      var self = this;
      if (this.switchTimer) clearTimeout(this.switchTimer);
      // If the websocket never confirms (switch failed silently), stop showing
      // "Switching…" after 90 s and let the cards tell the truth again.
      this.switchTimer = setTimeout(function () { self.clearSwitchState(); }, 90000);
    },
```

Watch — add after the `tab` watcher:

```js
    // A slot switch is done when GL's selected slot lands on the target.
    activeSlot(v) {
      if (this.switchTarget && String(v) === String(this.switchTarget)) {
        this.clearSwitchState();
        this.loadSimTab();   // fresh configs for the new arrangement
      }
    },
```

`beforeDestroy` (~line 157) — extend:

```js
  beforeDestroy() { this.clearCountdown(); this.clearSwitchState(); },
```

Extend `renderSlotCard` — append after the form block (inside `if (card.iccid)`):

```js
        if (!card.selected) {
          if (self.switchConfirm === slot) {
            kids.push(h("div", { staticClass: "mm-switchbox" }, [
              h("div", "Switching drops connectivity for ~30 seconds while slot " + slot +
                " connects. This admin session will stall until it does."),
              h("div", { staticStyle: { display: "flex", gap: "9px", marginTop: "7px" } }, [
                h("button", { staticClass: "mm-apply", on: { click: function () { self.doSwitch(slot); } } }, "Switch"),
                h("button", { staticClass: "mm-reveal", on: { click: function () { self.switchConfirm = 0; } } }, "Cancel")
              ])
            ]));
          } else {
            kids.push(h("button", {
              staticClass: "mm-apply",
              staticStyle: { marginTop: "9px" },
              attrs: { disabled: !!self.switchTarget },
              on: { click: function () { self.askSwitch(slot); } }
            }, self.switchTarget === slot ? "Switching…" : "Use this SIM"));
          }
        }
        if (self.switchErr && !card.selected) {
          kids.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
            "Switch failed: " + self.switchErr));
        }
```

CSS addition:

```js
        '.mm-switchbox{margin-top:9px;padding:9px;border:1px solid var(--warning);border-radius:8px;font-size:12.5px;color:var(--text-secondary)}' +
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 4: slot switch via GL failover config, confirm-gated"
```

---

### Task 6: Failover card

Auto-switch toggle, slot priority swap, scheduled switch-back — applied as the full config object. Applying a config whose `current_sim` would change the active slot gets the same confirm treatment as a manual switch.

**Files:**
- Modify: `src/views/mudimodem.js` (methods — `applyFailover`, `renderFailoverCard`; wire into `renderSim`)
- Test: `test/chunk.test.js` (append)

**Interfaces:**
- Consumes: `failover`/`failoverEdit`/`fetchFailover` (Task 2), `slotCards` (Task 1), `armSwitchFallback`/`switchTarget` (Task 5).
- Produces: methods `applyFailover(confirmed)`, `renderFailoverCard(h)`.

- [ ] **Step 1: Write the failing tests**

```js
test('applyFailover: full passthrough payload; enable_switch forces current_sim = priority[0]', async () => {
  const FCFG = { enable_switch: false, esim2_enable: false, current_sim: 1,
    slot_priority: [1, 2], enable_timing: false, hour: '00', min: '00',
    slot_type: [{ slot: 1, type: 0 }, { slot: 2, type: 0 }] };
  const calls = stubRpc([{}]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.failover = FCFG;
    vm.failoverEdit = { enable_switch: true, slot_priority: [1, 2],
      enable_timing: true, hour: '03', min: '30' };
    vm.applyFailover(true);
    await new Promise((r) => setImmediate(r));
    const p = calls[0].params[3];
    assert.equal(calls[0].params[2], 'set_slot_failover_config');
    assert.equal(p.enable_switch, true);
    assert.equal(p.current_sim, 1);                    // priority[0], GL's invariant
    assert.deepEqual(p.slot_priority, [1, 2]);
    assert.equal(p.enable_timing, true);
    assert.strictEqual(p.hour, '03');                  // strings, as GL sends them
    assert.equal(p.esim2_enable, false);               // passthrough intact
    assert.deepEqual(p.slot_type, FCFG.slot_type);
  } finally { unstubRpc(); }
});

test('applyFailover: a config that would change the active slot demands confirmation', async () => {
  const calls = stubRpc([{}]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);   // active slot is 1
    vm.failover = { enable_switch: false, current_sim: 1, slot_priority: [1, 2] };
    vm.failoverEdit = { enable_switch: true, slot_priority: [2, 1],
      enable_timing: false, hour: '00', min: '00' };
    vm.applyFailover();                       // not confirmed
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);            // nothing sent
    assert.equal(vm.failoverConfirm, true);   // confirm UI armed instead
    vm.applyFailover(true);                   // user confirmed
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[3].current_sim, 2);
  } finally { unstubRpc(); }
});

test('failover card renders toggle, priority order and time picker when timing on', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  vm.failover = { enable_switch: true, current_sim: 1, slot_priority: [1, 2] };
  vm.failoverEdit = { enable_switch: true, slot_priority: [1, 2],
    enable_timing: true, hour: '03', min: '30' };
  const text = textOf(comp.render.call(vm, h));
  assert.ok(text.includes('Auto failover'));
  assert.ok(text.includes('Preferred order'));
  assert.ok(text.includes('Scheduled switch'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunk.test.js`
Expected: new tests FAIL; everything else PASSES.

- [ ] **Step 3: Implement the failover card**

Methods:

```js
    applyFailover(confirmed) {
      var self = this;
      if (this.failoverApplying || !this.failoverEdit ||
          typeof window === "undefined" || !window.$rpcRequest) return;
      var ed = this.failoverEdit;
      var base = this.failover || {};
      var payload = {};
      for (var k in base) payload[k] = base[k];          // esim2_enable, slot_type… intact
      payload.bus = this.modem.bus;
      payload.enable_switch = !!ed.enable_switch;
      payload.slot_priority = ed.slot_priority.slice();
      payload.enable_timing = !!ed.enable_timing;
      payload.hour = String(ed.hour);
      payload.min = String(ed.min);
      // GL's invariant: with auto-switch on, the preferred slot IS the current one.
      if (payload.enable_switch) payload.current_sim = payload.slot_priority[0];
      // If this apply would change the selected slot, it's a switch — same
      // consequence, same confirmation, no back door.
      var wouldSwitch = payload.current_sim &&
        String(payload.current_sim) !== String(this.activeSlot);
      if (wouldSwitch && !confirmed) { this.failoverConfirm = true; return; }
      this.failoverConfirm = false;
      this.failoverApplying = true;
      this.failoverErr = "";
      if (wouldSwitch) this.switchTarget = Number(payload.current_sim);
      window.$rpcRequest("call", ["sid", "modem", "set_slot_failover_config", payload],
        { timeout: 30000 })
        .then(function () {
          self.failoverApplying = false;
          if (wouldSwitch) self.armSwitchFallback(); else self.fetchFailover();
        })
        .catch(function (e) {
          self.failoverApplying = false;
          if (wouldSwitch && e && e.type === "timeout") { self.armSwitchFallback(); return; }
          if (wouldSwitch) self.clearSwitchState();
          self.failoverErr = (e && (e.type || e.message)) || "request failed";
        });
    },
    renderFailoverCard(h) {
      var self = this, ed = this.failoverEdit;
      var kids = [h("span", { staticClass: "mm-sect" }, "Failover")];
      if (!ed) {
        kids.push(h("div", { staticClass: "mm-hint" },
          this.failoverErr ? "Couldn't load failover config: " + this.failoverErr
            : "Loading failover config…"));
        return h("div", { staticClass: "mm-card", staticStyle: { marginTop: "11px" } }, kids);
      }
      var frow = function (label, ctl) {
        return h("div", { staticClass: "mm-frow" }, [h("span", { staticClass: "k" }, label), ctl]);
      };
      kids.push(frow("Auto failover", h("button", {
        staticClass: "mm-apnchip" + (ed.enable_switch ? " on" : ""),
        attrs: { "aria-pressed": String(!!ed.enable_switch) },
        on: { click: function () { ed.enable_switch = !ed.enable_switch; } }
      }, ed.enable_switch ? "On" : "Off")));
      var names = this.slotCards.map(function (c) {
        return "Slot " + c.slot + (c.carrier ? " · " + c.carrier : "");
      });
      kids.push(frow("Preferred order", h("button", {
        staticClass: "mm-apnchip",
        attrs: { title: "Swap priority" },
        on: { click: function () { ed.slot_priority = ed.slot_priority.slice().reverse(); } }
      }, ed.slot_priority.map(function (s) { return names[s - 1]; }).join("  →  "))));
      kids.push(frow("Scheduled switch to preferred", h("button", {
        staticClass: "mm-apnchip" + (ed.enable_timing ? " on" : ""),
        attrs: { "aria-pressed": String(!!ed.enable_timing) },
        on: { click: function () { ed.enable_timing = !ed.enable_timing; } }
      }, ed.enable_timing ? "On" : "Off")));
      if (ed.enable_timing) {
        kids.push(frow("At", h("input", {
          staticClass: "mm-input",
          attrs: { type: "time", value: ed.hour + ":" + ed.min },
          on: { input: function (ev) {
            var p = String(ev.target.value || "00:00").split(":");
            ed.hour = p[0] || "00"; ed.min = p[1] || "00";
          } }
        })));
      }
      if (this.failoverConfirm) {
        kids.push(h("div", { staticClass: "mm-switchbox" }, [
          h("div", "This change makes slot " + (ed.slot_priority[0]) + " the active SIM — " +
            "it drops connectivity for ~30 seconds."),
          h("div", { staticStyle: { display: "flex", gap: "9px", marginTop: "7px" } }, [
            h("button", { staticClass: "mm-apply", on: { click: function () { self.applyFailover(true); } } }, "Apply anyway"),
            h("button", { staticClass: "mm-reveal", on: { click: function () { self.failoverConfirm = false; } } }, "Cancel")
          ])
        ]));
      } else {
        kids.push(h("button", {
          staticClass: "mm-apply",
          attrs: { disabled: this.failoverApplying },
          on: { click: function () { self.applyFailover(); } }
        }, this.failoverApplying ? "Applying…" : "Apply"));
      }
      if (this.failoverErr && ed) {
        kids.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
          "Failover apply failed: " + this.failoverErr));
      }
      return h("div", { staticClass: "mm-card", staticStyle: { marginTop: "11px" } }, kids);
    },
```

Wire into `renderSim` — replace the `// Failover card lands here in Task 6.` comment line with:

```js
        this.renderFailoverCard(h),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 5: Update the file header comment and commit**

The chunk's header comment (lines 12–14) says "The one WRITE (set_bands)…". Update that paragraph to:

```js
// Writes: set_bands is confirm-or-revert via the mudimodem backend + watchdog.
// The SIM tab (Phase 4) instead writes browser-direct to GL's own undotted RPC
// (modem.set_sim_config — ALWAYS read-modify-write, the same object carries the
// band config; modem.set_slot_failover_config — also GL's slot-switch path,
// since QUIMSLOT does not exist on this modem). No backend, no AT, no sub_id.
```

```bash
git add src/views/mudimodem.js test/chunk.test.js
git commit -m "Phase 4: failover card with switch-aware confirm"
```

---

### Task 7: Build, deploy, live verification

The two remaining live checks from the spec (§7.2, §7.3) happen here, deliberately last and deliberately coordinated: a no-op Apply first (safest possible write), then redial observation, then — **only with Kevin's explicit go** — one real slot switch.

**Files:**
- No source changes expected; fixes discovered here loop back into the relevant task's files.

**Interfaces:**
- Consumes: everything above, `tools/build.sh`, `tools/deploy.sh`, `tools/verify.sh`.
- Produces: deployed `.gz` chunk; verified live behavior; doc updates to `CLAUDE.md` §12 and the spec if reality disagrees.

- [ ] **Step 1: Full local test run**

Run: `node --test test/chunk.test.js`
Expected: ALL tests PASS.

- [ ] **Step 2: Build and deploy**

```bash
./tools/build.sh && ./tools/deploy.sh && ./tools/verify.sh
```
Expected: deploy's model guard confirms `E5800`; `verify.sh` green. No nginx reload needed — only the chunk changed, and the SPA's `?_t=` cache-buster refetches it on page reload.

- [ ] **Step 3: Read-only smoke test in the browser**

Open the admin → Modem → SIM tab. Verify against the live box (currently in the failover split state):
- Two cards; slot 1 ringed + `Selected`; slot 2 shows `Carrying data` + "Roaming on AT&T" under "Proximus BE".
- Identity masked; "Show identifiers" reveals; APN chips render (deduped).
- Failover card loads with the real config.
- Browser console: zero errors; Network tab: only `get_sim_config` ×2 + `get_slot_failover_config` on tab entry.

- [ ] **Step 4: The no-op Apply (safest first write) + band-lock integrity check**

In the UI, change slot 1's APN to something and back (making it dirty is not needed — if `simDirty` correctly disables Apply on no change, temporarily change APN to its own value via a chip after clearing a character). Simplest honest no-op: change APN to `fast.t-mobile.com`, Apply, then back to `h2g2`, Apply. After each Apply:

```bash
ssh root@mudi 'ubus call cellular.modem get_feature_config "{\"bus\":\"cpu\"}"' | grep -A6 band
```
Expected: `band_list` still `{"LTE":[],"NR-SA":[71],"NR-NSA":[]}`, `band_enable: true`, `band_filter_mode: 0` — **the n71 lock survived the RMW write**. Also note (spec §7.2): does the data connection redial on Apply? Record the observed behavior in the spec's §7 as resolved.

⚠️ If `band_list` changed: STOP. Revert the band config via the Bands tab (or `ssh root@mudi '/usr/sbin/mudimodem-revert --panic'` if cellular is down), and fix `mergeSimConfig` before any further writes.

- [ ] **Step 5: Live slot-switch test — ONLY with Kevin's explicit go**

This drops WAN data (LAN ssh to `mudi` survives; a cellular-side session does not). Ask Kevin before running. With his go: click "Use this SIM" on slot 2 → confirm → watch the switching state clear when `current_sim_slot` lands on 2 over the websocket. Then switch back to slot 1 the same way. Confirms spec §7.3 (`set_slot_failover_config {current_sim}` is the switch path on this firmware). If it does NOT switch, fall back to `mvas.switch_sim_slot {slot}` in `doSwitch` (GL's simo flow uses it) — that's a one-line change in Task 5's `doSwitch` + test update.

- [ ] **Step 6: Update docs and commit**

- CLAUDE.md §12: mark Phase 4 done, note the SIM tab is browser-direct (no backend), and record the §7.2/§7.3 findings.
- Spec §7: mark all probes resolved with what was observed.

```bash
git add -A
git commit -m "Phase 4: SIM/APN tab deployed + live-verified; docs updated"
```

---

## Plan Self-Review (done at write time)

- **Spec coverage:** §1 honesty facts → Tasks 1+3; §2 decisions → Tasks 4 (full profile), 5 (confirm-only switch), 6 (full failover), all browser-direct; §4 layout → Tasks 3–6; §5 clobber guard + timeout-not-error → Tasks 2, 4, 5; §6 exclusions respected (no PIN/eSIM/traffic/advanced fields — advanced fields pass through untouched); §7 probes → resolved in the plan header except §7.2/§7.3 → Task 7; §8 testing → per-task tests + Task 7.
- **Known simplification:** `esim2_enable` is passed through, never rendered (spec §6 says "displayed if present" — dropped entirely as YAGNI; it's meaningless on a box with two physical slots).
- **Type consistency check:** `slotCards` consumed by Tasks 3/4/5/6 with the Task 1 field names; `simEdit` shape identical in Tasks 2 and 4; `hour`/`min` strings end-to-end; slot keys are the numbers 1/2 everywhere, with `String()` comparison against websocket strings.
