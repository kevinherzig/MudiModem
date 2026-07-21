const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem.js');

// Mirror GL's loader: `const component = eval(res.data)` with `module` in scope.
function loadChunk() {
  const module = { exports: {} };
  const source = fs.readFileSync(SRC, 'utf8');
  return eval(source);
}

// Stub createElement: records (tag, data, children) as a plain tree.
function h(tag, data, children) {
  if (Array.isArray(data) || typeof data === 'string') { children = data; data = {}; }
  return { tag, data: data || {}, children };
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

// Walk the vnode tree collecting every node for structural assertions.
function walk(node, out) {
  out = out || [];
  if (node == null || typeof node === 'string') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  walk(node.children, out);
  return out;
}

// Build a working component instance: data + bound methods + computed getters,
// exactly as Vue would wire them, plus a stub $store feeding the websocket data.
function makeVm(component, statusMap) {
  const vm = Object.assign({}, component.data());
  vm.$store = {
    getters: {
      moduleStatus(name) { return (statusMap && statusMap[name]) || {}; }
    }
  };
  for (const [k, fn] of Object.entries(component.methods || {})) vm[k] = fn.bind(vm);
  for (const [k, fn] of Object.entries(component.computed || {})) {
    Object.defineProperty(vm, k, { get: fn.bind(vm), configurable: true });
  }
  return vm;
}

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

// A realistic websocket snapshot, shaped exactly like the device pushes it
// (captured 2026-07-17; slot 1 = active T-Mobile n71).
const LIVE = {
  'cellular.modems_info': { modems: [{
    bus: 'cpu', name: 'RG650V-NA', type: 0,
    band: { LTE: [2, 4, 66, 71], 'NR-NSA': [41, 71], 'NR-SA': [25, 41, 71, 77, 78] }
  }] },
  'cellular.modems_status': { modems: [{ bus: 'cpu', current_sim_slot: '1' }] },
  'cellular.networks_info': { networks: [
    { slot: '1', bus: 'cpu', cell_info: {
      id: '187461035', band: 71, mode: 'NR5G-SA FDD',
      rsrp: '-101', rsrp_level: 3, rsrq: '-14', rsrq_level: 3,
      sinr: '4', sinr_level: 2, dl_bandwidth: '15MHz', tx_channel: '127490' } },
    { slot: '2', bus: 'cpu', cell_info: { band: 66, mode: 'LTE FDD', rsrp: '-120', rsrp_level: 1 } }
  ] },
  'cellular.sims_info': { sims: [{ slot: '1', mcc: '310', mnc: '260' }] },
  'cellular.sims_status': { sims: [
    { slot: '1', carrier: 'T-Mobile', status: 6 },
    { slot: '2', carrier: 'AT&T', status: 6 }
  ] }
};

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

test('chunk eval returns the component (not undefined)', () => {
  const c = loadChunk();
  assert.ok(c && typeof c === 'object', 'eval must yield the component object');
});

test('component has no template (runtime-only Vue would fail)', () => {
  const c = loadChunk();
  assert.strictEqual(c.template, undefined, 'template: is forbidden - bundle is runtime-only');
  assert.strictEqual(typeof c.render, 'function', 'must use render(h)');
});

test('component is named for the route', () => {
  assert.strictEqual(loadChunk().name, 'mudimodem');
});

test('renders gracefully with an empty store (no push yet)', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const tree = c.render.call(vm, h);
  assert.strictEqual(tree.tag, 'div');
  assert.match(textOf(tree), /Waiting for the modem/, 'must show an honest empty state');
  assert.match(textOf(tree), /Diagnostics/, 'tabs still render without data');
});

test('reads live data via $store.getters.moduleStatus and renders the serving cell', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /-101/, 'shows live RSRP from the active slot');
  assert.match(txt, /n71/, 'labels the NR band as n71');
  assert.match(txt, /NR5G-SA/, 'shows the serving mode');
  assert.match(txt, /15MHz/, 'uses GL pre-decoded bandwidth (no enum lie)');
});

test('picks the ACTIVE slot, never slot 0/2 by accident', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /-101/, 'slot-1 (T-Mobile n71) RSRP');
  assert.match(txt, /NR5G-SA FDD/, 'shows slot-1 mode');
  // slot-2 is LTE band 66 — its mode must not leak in ("-120" is now an axis label).
  assert.doesNotMatch(txt, /LTE FDD/, 'must NOT show slot-2 (AT&T) cell');
});

test('anchors on the ACTIVE (selected) SIM, never borrows the other slot', () => {
  const c = loadChunk();
  // GL declares SIM1 active (current_sim_slot=1). SIM1 is NOT registered; SIM2
  // (AT&T) is carrying failover data. The strip must show SIM1's not-registered
  // state and NEVER show SIM2's cell (which is GL's SIM1-active/modem-connected split).
  const S = {
    'cellular.modems_info': { modems: [{ bus: 'cpu', name: 'RG650V-NA', type: 0, band: { 'NR-SA': [71] } }] },
    'cellular.modems_status': { modems: [{ bus: 'cpu', current_sim_slot: '1' }] },
    'cellular.networks_info': { networks: [
      { slot: '1', bus: 'cpu' },  // active SIM: no cell (not registered)
      { slot: '2', bus: 'cpu', cell_info: { band: 66, mode: 'LTE FDD', rsrp: '-116', rsrp_level: 1 } }
    ] },
    'cellular.sims_info': { sims: [{ slot: '1', mcc: '310', mnc: '260' }] },
    'cellular.sims_status': { sims: [
      { slot: '1', carrier: '', status: 5 }, { slot: '2', carrier: 'AT&T', status: 6 }
    ] }
  };
  const vm = makeVm(c, S);
  assert.strictEqual(String(vm.activeSlot), '1', 'active SIM stays the selected slot');
  assert.strictEqual(vm.activeRegistered, false, 'active SIM is not registered');
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /SIM 1 \(active\) is not registered/, 'honest not-registered message');
  assert.doesNotMatch(txt, /-116/, 'must NOT show slot-2 RSRP');
  assert.doesNotMatch(txt, /LTE FDD/, 'must NOT show slot-2 cell');
});

test('shows the active SIM when it IS registered, with carrier label', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);   // slot 1 = T-Mobile n71, registered
  assert.strictEqual(String(vm.activeSlot), '1', 'active = selected slot');
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /-101/, 'shows slot-1 n71');
  assert.match(txt, /T-Mobile/, 'labels T-Mobile');
  assert.doesNotMatch(txt, /LTE FDD/, 'does not show slot-2');
});

test('quality colour comes from GL levels, mapped to GL ramp tokens', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  // rsrp_level 3 -> good -> --info-hover ; sinr_level 2 -> fair -> --warning
  const nodes = walk(c.render.call(vm, h));
  const styled = nodes.filter((n) => n.data && n.data.style && n.data.style.color)
    .map((n) => n.data.style.color);
  assert.ok(styled.includes('var(--info-hover)'), 'rsrp level 3 -> good ramp token');
  assert.ok(styled.includes('var(--warning)'), 'sinr level 2 -> fair ramp token');
});

// Bands with a seeded SA selection (as fetchBands would set after get_bands).
function bandsVm(c, override) {
  const vm = makeVm(c, LIVE);
  vm.tab = 'bands';
  vm.bands = Object.assign({
    supported: { sa: [71, 41, 78], nsa: [71, 41], LTE: [66, 12] },
    config: { enable: true, mode: 0, sa: [71], nsa: [], LTE: [] },
    policy: { sa: [41, 71], nsa: [41, 71], LTE: [12, 66] },
    capability: { sa: [71], nsa: [], LTE: [12, 66] },
    meta: { bus: 'cpu', slot: '1', plmn: '310260', sub_id: 1, plmn_matched: true, mode: 'AUTO' }
  }, override || {});
  // seed selections + mode exactly as fetchBands does
  vm.sel = { sa: vm.seedFor('sa'), nsa: vm.seedFor('nsa'), LTE: vm.seedFor('LTE') };
  vm.selMode = (vm.bands.meta && vm.bands.meta.mode) || 'AUTO';
  return vm;
}
function chips(c, vm) {
  return walk(c.render.call(vm, h)).filter((n) => n.data.staticClass && /mm-band/.test(n.data.staticClass));
}
function chip(cs, b) { return cs.find((n) => textOf(n.children[0]) === b); }

test('SA band chips are interactive: selected / permitted / blocked', () => {
  const c = loadChunk();
  const vm = bandsVm(c);              // selSA seeded to [71]
  const cs = chips(c, vm);
  assert.ok(cs.length >= 6, 'renders a chip per supported band');
  // n71 in policy AND selected -> sel; n41 in policy not selected -> unsel;
  // n78 not in policy -> blocked (and not clickable).
  assert.match(chip(cs, 'n71').data.staticClass, /\bsel\b/, 'n71 selected');
  assert.match(chip(cs, 'n41').data.staticClass, /\bunsel\b/, 'n41 permitted, not selected');
  assert.match(chip(cs, 'n78').data.staticClass, /\bblocked\b/, 'n78 blocked by policy');
  assert.ok(chip(cs, 'n41').data.on && chip(cs, 'n41').data.on.click, 'permitted chip is clickable');
  assert.ok(!(chip(cs, 'n78').data.on && chip(cs, 'n78').data.on.click), 'blocked chip is NOT clickable');
});

test('toggleBand edits the selection and Apply reflects change/empty', () => {
  const c = loadChunk();
  const vm = bandsVm(c);
  assert.strictEqual(vm.changed('sa'), false, 'no change initially (matches config)');
  vm.toggleBand('sa', 41);            // add n41 -> widening (safe)
  assert.deepStrictEqual(vm.sel.sa.slice().sort(), [41, 71], 'n41 added');
  assert.strictEqual(vm.changed('sa'), true, 'now changed');
  vm.toggleBand('sa', 71); vm.toggleBand('sa', 41);
  assert.deepStrictEqual(vm.sel.sa, [], 'emptied');
  // Apply must be disabled when an edited group has zero bands (would drop it).
  assert.ok(vm.emptyChange(), 'empty edit flagged');
  const applyBtn = walk(c.render.call(vm, h)).find(
    (n) => n.data.staticClass && /mm-btn primary/.test(n.data.staticClass));
  assert.ok(applyBtn.data.attrs.disabled, 'Apply disabled when a group is emptied');
});

test('per-group All / None / Invert act on the selectable (permitted) bands', () => {
  const c = loadChunk();
  const vm = bandsVm(c);              // policy.sa = [41,71]; sel.sa = [71]
  vm.selectAll('sa');
  assert.deepStrictEqual(vm.sel.sa.slice().sort(), [41, 71], 'All = every permitted band');
  vm.selectNone('sa');
  assert.deepStrictEqual(vm.sel.sa, [], 'None clears');
  vm.sel.sa = [71];
  vm.invertSel('sa');
  assert.deepStrictEqual(vm.sel.sa, [41], 'Invert toggles permitted membership (71 out, 41 in)');
});

test('LTE and NSA are interactive too, seeded and selectable', () => {
  const c = loadChunk();
  const vm = bandsVm(c);              // config.LTE=[]/nsa=[], policy fills the seed
  assert.deepStrictEqual(vm.sel.LTE.slice().sort(), [12, 66], 'LTE seeded from policy when config empty');
  assert.deepStrictEqual(vm.sel.nsa.slice().sort(), [41, 71], 'NSA seeded from policy when config empty');
  assert.strictEqual(vm.selectable('LTE', 12), true, 'permitted LTE band selectable');
  assert.strictEqual(vm.selectable('nsa', 41), true, 'permitted NSA band selectable');
});

test('network mode selector: seeded, changeable, feeds Apply payload', () => {
  const c = loadChunk();
  const vm = bandsVm(c, { meta: { mode: 'NR5G', plmn_matched: true } });
  assert.strictEqual(vm.selMode, 'NR5G', 'seeded from meta.mode');
  assert.strictEqual(vm.modeChanged(), false, 'no change initially');
  vm.setMode('AUTO');
  assert.strictEqual(vm.modeChanged(), true, 'mode change detected');
  assert.strictEqual(vm.changedAny(), true, 'Apply enabled by a mode change alone');
  // the mode segmented control renders with the current option marked
  const nodes = walk(c.render.call(vm, h));
  const on = nodes.filter((n) => n.data.staticClass && /mm-seg-b on/.test(n.data.staticClass));
  assert.strictEqual(on.length, 1, 'exactly one mode option marked active');
});

test('mode gate: NSA is off unless Auto; SA off under 4G-only', () => {
  const c = loadChunk();
  // NR5G mode: SA active, NSA + LTE gated off.
  let vm = bandsVm(c, { meta: { mode: 'NR5G', plmn_matched: true } });
  assert.strictEqual(vm.ratActive('sa'), true, 'SA active under 5G-only');
  assert.strictEqual(vm.ratActive('nsa'), false, 'NSA needs Auto');
  assert.strictEqual(vm.ratActive('LTE'), false, 'LTE off under 5G-only');
  let txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Off under NR5G mode/, 'shows the mode-gate note');
  // Auto: everything active, no gate.
  vm = bandsVm(c, { meta: { mode: 'AUTO', plmn_matched: true } });
  assert.ok(vm.ratActive('sa') && vm.ratActive('nsa') && vm.ratActive('LTE'), 'all active under Auto');
  assert.doesNotMatch(textOf(c.render.call(vm, h)), /Off under/, 'no gate under Auto');
});

test('blocked band cannot be toggled into the selection', () => {
  const c = loadChunk();
  const vm = bandsVm(c);
  // n78 is not in policy; the UI never wires a click, but guard the model too:
  assert.strictEqual(vm.selectable('sa', 78), false, 'n78 not selectable');
});

test('Bands grid orders NR chips by frequency, low to high', () => {
  const c = loadChunk();
  const vm = bandsVm(c, {
    supported: { sa: [41, 71, 78], nsa: [], LTE: [] },
    config: { enable: true, mode: 0, sa: [71], nsa: [], LTE: [] },
    policy: { sa: [41, 71, 78], nsa: [], LTE: [] },
    capability: { sa: [41, 71, 78], nsa: [], LTE: [] },
    meta: { plmn_matched: true }
  });
  const order = chips(c, vm).map((n) => textOf(n.children[0]));
  // n71=600, n41=2500, n78=3500 -> spectrum order is n71, n41, n78.
  assert.deepStrictEqual(order, ['n71', 'n41', 'n78']);
});

test('revert countdown banner renders with Keep/Revert and locks chips', () => {
  const c = loadChunk();
  const vm = bandsVm(c);
  vm.pending = { remaining: 47, window: 60, applied: { sa: '71:41', lte: '2:66' }, done: false };
  const nodes = walk(c.render.call(vm, h));
  const txt = textOf(nodes);
  assert.match(txt, /Reverting in/, 'shows revert message');
  assert.match(txt, /47s/, 'shows countdown');
  assert.match(txt, /5G-SA n71 n41/, 'summarises applied SA bands');
  assert.match(txt, /LTE B2 B66/, 'summarises applied LTE bands');
  const btns = nodes.filter((n) => n.data.staticClass && /mm-btn/.test(n.data.staticClass))
    .map((n) => textOf(n));
  assert.ok(btns.includes('Keep') && btns.includes('Revert now'), 'Keep + Revert now present');
  // chips must be non-clickable while a revert is pending
  const cs = chips(c, vm);
  assert.ok(cs.every((n) => !(n.data.on && n.data.on.click)), 'chips locked during pending');
  // no Apply button while pending
  assert.ok(!nodes.some((n) => n.data.staticClass && /mm-btn primary/.test(n.data.staticClass)),
    'Apply hidden during pending');
});

test('Tracking is an in-page tab (lazy-loaded graph), not a route change', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /gl-sdk4-ui-mudimodem-tracking\.common\.js/, 'lazy-loads the tracking chunk');
  assert.doesNotMatch(src, /\$router\.push\(\s*["']\/mudimodem-tracking/,
    'no longer routes away to the tracking page');
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Tracking/, 'Tracking tab rendered');
  assert.doesNotMatch(txt, /History/, 'the old "History →" link is removed');
  // Selecting it makes it the active in-page tab, exactly like the others.
  vm.tab = 'tracking';
  const on = walk(c.render.call(vm, h))
    .filter((n) => n.data.staticClass && /\bmm-tab\b/.test(n.data.staticClass)
      && /\bon\b/.test(n.data.staticClass))
    .map(textOf);
  assert.deepStrictEqual(on, ['Tracking'], 'Tracking shows as the active tab (stays in-page)');
  // Before the chunk loads, the panel shows a loading placeholder (no navigation).
  assert.match(textOf(c.render.call(vm, h)), /Loading the signal graph/, 'loading state pre-load');
});

test('loaded tracking chunk renders as an embedded child component', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'tracking';
  const fake = { name: 'mudimodem-tracking', render() {} };
  vm.trackingComp = fake;                 // as loadTracking would set it
  const node = walk(c.render.call(vm, h)).find((n) => n.tag === fake);
  assert.ok(node, 'renders the loaded component object as a child vnode');
  assert.strictEqual(node.data.props.embedded, true, 'passes embedded:true to drop its breadcrumb');
});

test('the write calls target the watchdog-protected methods only', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Writes are allowed now, but ONLY through set_bands/confirm/revert_now.
  assert.match(src, /"set_bands"/, 'Apply calls set_bands');
  assert.match(src, /"confirm"/, 'Keep calls confirm');
  assert.match(src, /"revert_now"/, 'Revert now calls revert_now');
  // The page must never speak raw AT or hit the modem object directly.
  assert.doesNotMatch(src, /get_result_AT|modem\.CPU\.AT|QNWPREFCFG/,
    'the chunk must never issue raw AT — writes go through the backend');
});

// ---- Cell-lock tab ----

const LOCKDATA_UNLOCKED = {
  lock: { l4g: { locked: false }, l5g: { locked: false }, save_ctrl: { raw: '0,0', s4g: 0, s5g: 0 } },
  gl: { locked: false, tower: null },
  serving: { rat: 'NR5G-SA', pci: 516, arfcn: 127490, band: 71, cell_id: '18B1AE035' },
  stale: false, pending_kind: null,
  meta: { sub_id: 1, slot: '1', plmn: '310260', plmn_matched: true }
};

test('lock tab: unlocked state renders serving cell + Lock button', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const tree = component.render.call(vm, h);
  const text = textOf(tree);
  assert.match(text, /PCI/);
  assert.match(text, /516/);
  assert.match(text, /127490/);
  assert.match(text, /Lock to this cell/);
});

test('lock tab: locked state shows Locked badge + Unlock, no Lock button', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.lockData.lock.l5g = { locked: true, pci: 516, freq: 127490, scs: 15, band: 71 };
  vm.lockData.gl = { locked: true, tower: { cellid: 'X', pci: 516 } };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /Locked/);
  assert.match(text, /Unlock/);
  assert.doesNotMatch(text, /Lock to this cell/);
});

test('lock tab: GL-only-locked state falls back to gl.tower, never shows literal "undefined"', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  // Both AT-side locks read unlocked, but GL's store says locked (the
  // documented GL/AT disagreement) — only gl.tower carries the details.
  vm.lockData.lock.l4g = { locked: false };
  vm.lockData.lock.l5g = { locked: false };
  vm.lockData.gl = {
    locked: true,
    tower: { cellid: 'X', network_type: 'NR5G', pci: 516, freq: 127490, scs: 15, band: 71 }
  };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /516/, 'PCI comes from gl.tower');
  assert.match(text, /127490/, 'ARFCN comes from gl.tower');
  assert.doesNotMatch(text, /undefined/, 'never renders the literal word "undefined"');
  assert.match(text, /Unlock/, 'Unlock is still offered');
});

test('lock tab: pin target derives from serving cell with SCS default', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const t = vm.pinTarget();
  assert.equal(t.rat, '5g');
  assert.equal(t.pci, 516);
  assert.equal(t.freq, 127490);
  assert.equal(t.band, 71);
  assert.equal(t.scs, 15);          // n71 default, 3GPP TS 38.104
  assert.equal(t.scsAssumed, true); // no scan result to confirm it
});

test('lock tab: pin target prefers a scan-confirmed SCS over the band default', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));   // serving pci 516, arfcn 127490, band 71
  // A scan row for this exact pci+arfcn with a DIFFERENT scs than the n71
  // default (15) — the scan reading must win, and be marked unassumed.
  vm.scan = { towers: [{ pci: 516, freq: 127490, scs: 30 }], running: false, error: '', ts: 0 };
  const t = vm.pinTarget();
  assert.equal(t.scs, 30, 'scan-confirmed scs overrides the band default');
  assert.equal(t.scsAssumed, false, 'not flagged as assumed when scan confirms it');
});

test('lock tab: pin target refuses an unknown NR band rather than guess SCS', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.lockData.serving.band = 999;   // not in SCS_DEFAULT, and no scan match below
  vm.scan = { towers: [], running: false, error: '', ts: 0 };
  const t = vm.pinTarget();
  assert.strictEqual(t, null, 'refuses to build a lock target rather than guess an unknown band\'s SCS');
});

test('lock tab: cell pending banner renders on lock tab, not bands tab', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.pending = { kind: 'cell', remaining: 42, window: 60,
                 applied: { rat: '5g', pci: 516, freq: 127490 } };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /42s/);
  assert.match(text, /Revert now/);
});

test('bands tab: cell pending does NOT paint the bands banner', () => {
  const component = loadChunk();
  // Use a fully-populated bands model (bandsLoading:false, valid bands shape)
  // so renderBands actually reaches the `pending.kind !== "cell"` gate instead
  // of short-circuiting on the loading guard — otherwise this test would pass
  // even if the gate itself were deleted.
  const vm = bandsVm(component);
  vm.pending = { kind: 'cell', remaining: 42, window: 60, applied: {} };
  const text = textOf(component.render.call(vm, h));
  assert.doesNotMatch(text, /42s/);
});

// ---- Nearby-cells scan card ----

test('lock tab: scan card empty state is honest about SA + disruption', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /no neighbour list/i);
  assert.match(text, /offline/i);
  assert.match(text, /Scan for cells/);
});

test('lock tab: scan results render rows sorted by strength with Lock buttons', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.scan = { running: false, error: '', ts: 1, towers: [
    { network_type: 'NR5G', pci: 99, freq: 520000, band: 41, scs: 30, cellid: 'A', strength: 2, rsrp: -101 },
    { network_type: 'NR5G', pci: 516, freq: 127490, band: 71, scs: 15, cellid: 'B', strength: 4, rsrp: -98 }
  ] };
  const tree = component.render.call(vm, h);
  const text = textOf(tree);
  // strongest first
  assert.ok(text.indexOf('516') < text.indexOf('99'), 'rows must sort by strength desc');
  const lockBtns = walk(tree).filter((n) => n.tag === 'button' && textOf(n) === 'Lock');
  assert.equal(lockBtns.length, 2);
});

test('lock tab: pending interlock disables Scan and every scan-row Lock button', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.scan = { running: false, error: '', ts: 1, towers: [
    { network_type: 'NR5G', pci: 99, freq: 520000, band: 41, scs: 30, cellid: 'A', strength: 2, rsrp: -101 },
    { network_type: 'NR5G', pci: 516, freq: 127490, band: 71, scs: 15, cellid: 'B', strength: 4, rsrp: -98 }
  ] };
  // An active revert countdown from an EARLIER experiment (band or cell) - the
  // interlock this covers is "one experiment at a time", regardless of kind.
  vm.pending = { kind: 'cell', remaining: 30, window: 60, applied: {} };
  const tree = component.render.call(vm, h);
  const nodes = walk(tree);
  const scanBtn = nodes.find((n) => n.tag === 'button' && textOf(n) === 'Scan for cells');
  assert.ok(scanBtn, 'Scan for cells button still renders');
  assert.ok(scanBtn.data.attrs && scanBtn.data.attrs.disabled,
    'Scan for cells must be disabled while a revert is pending (this is the bug the Critical caught)');
  const lockBtns = nodes.filter((n) => n.tag === 'button' && textOf(n) === 'Lock');
  assert.equal(lockBtns.length, 2, 'both scan rows still render a Lock button');
  assert.ok(lockBtns.every((n) => n.data.attrs && n.data.attrs.disabled),
    'every scan-row Lock button must be disabled while a revert is pending');
});

test('lock tab: pending interlock also disables "Scan now" in the confirm footer', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.scan = { running: false, error: '', ts: 0, towers: [] };
  vm.scanConfirm = true;
  vm.pending = { kind: 'cell', remaining: 30, window: 60, applied: {} };
  const tree = component.render.call(vm, h);
  const scanNowBtn = walk(tree).find((n) => n.tag === 'button' && textOf(n) === 'Scan now');
  assert.ok(scanNowBtn, 'Scan now button renders once scanConfirm is set');
  assert.ok(scanNowBtn.data.attrs && scanNowBtn.data.attrs.disabled,
    'Scan now must be disabled while a revert is pending');
});

test('lock tab: 5G scan row without a confirmed scs cannot be locked; a row with scs can', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.scan = { running: false, error: '', ts: 1, towers: [
    { network_type: 'NR5G', pci: 77, freq: 500000, band: 78, cellid: 'NOSCS', strength: 3, rsrp: -100 },
    { network_type: 'NR5G', pci: 516, freq: 127490, band: 71, scs: 15, cellid: 'HASSCS', strength: 4, rsrp: -98 }
  ] };
  // no pending - isolates the scs rule from the interlock rule.
  const tree = component.render.call(vm, h);
  const lockBtns = walk(tree).filter((n) => n.tag === 'button' && textOf(n) === 'Lock');
  assert.equal(lockBtns.length, 2);
  // Rows render sorted by strength desc, so HASSCS (516, strength 4) is first.
  assert.ok(!(lockBtns[0].data.attrs && lockBtns[0].data.attrs.disabled),
    'row with a confirmed scs must be lockable (falsy disabled)');
  assert.ok(lockBtns[1].data.attrs && lockBtns[1].data.attrs.disabled,
    'a 5G row with no scs must refuse to lock rather than guess');
});

test('lock tab: scan target uses the row scs verbatim', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const row = { network_type: 'NR5G', pci: 99, freq: 520000, band: 41, scs: 30, cellid: 'A' };
  const t = vm.scanTarget(row);
  assert.equal(t.rat, '5g');
  assert.equal(t.scs, 30);
  assert.equal(t.scsAssumed, false);
  assert.deepEqual(t.extra, row);
});

test('scanCells() no-ops while an experiment is pending (method-level guard)', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));

  // A minimal thenable chain compatible with scanCells' `.then(...).catch(...).then(...)`
  // usage: every link returns the same chain object, and none of the callbacks fire
  // (we only care whether $rpcRequest itself was invoked).
  function fakeChain() {
    const chain = {};
    chain.then = function () { return chain; };
    chain.catch = function () { return chain; };
    return chain;
  }

  let called = false;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const originalWindow = global.window;
  global.window = { $rpcRequest: function () { called = true; return fakeChain(); } };
  try {
    // Guarded: an experiment (band OR cell) is already pending -> scanCells must
    // return before ever touching $rpcRequest. This exercises the scanCells()
    // guard directly, independent of any button `disabled` attribute.
    vm.pending = { kind: 'cell', remaining: 30, window: 60, applied: {} };
    vm.scan.running = false;
    vm.lockBusy = false;
    vm.scanCells();
    assert.strictEqual(called, false, 'scanCells must no-op while this.pending is set');

    // Same guard, different trigger: a lock/unlock RPC in flight.
    called = false;
    vm.pending = null;
    vm.lockBusy = true;
    vm.scanCells();
    assert.strictEqual(called, false, 'scanCells must no-op while this.lockBusy is set');

    // Positive control: with nothing blocking it, scanCells DOES call $rpcRequest -
    // proves the guard is what's suppressing the call above, not a wiring mistake.
    called = false;
    vm.pending = null;
    vm.scan.running = false;
    vm.lockBusy = false;
    vm.scanCells();
    assert.strictEqual(called, true, 'scanCells calls $rpcRequest when nothing is blocking it');
  } finally {
    if (hadWindow) global.window = originalWindow; else delete global.window;
  }
});

test('lock tab: scan-row Confirm button disabled while pending (confirming branch)', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.scan = { running: false, error: '', ts: 1, towers: [
    { network_type: 'NR5G', pci: 516, freq: 127490, band: 71, scs: 15, cellid: 'B', strength: 4, rsrp: -98 }
  ] };
  // Puts renderScanCard's row 0 into the confirming branch (Cancel + Confirm),
  // which only paints when lockConfirm.scanIdx matches the sorted row index.
  vm.lockConfirm = { scanIdx: 0 };

  function findConfirmBtn() {
    const tree = component.render.call(vm, h);
    return walk(tree).find((n) => n.tag === 'button' && textOf(n) === 'Confirm');
  }

  vm.pending = null;
  let btn = findConfirmBtn();
  assert.ok(btn, 'Confirm button renders once lockConfirm targets this scan row');
  assert.ok(!(btn.data.attrs && btn.data.attrs.disabled), 'Confirm enabled when nothing is pending');

  vm.pending = { kind: 'cell', remaining: 30, window: 60, applied: {} };
  btn = findConfirmBtn();
  assert.ok(btn, 'Confirm button still renders while pending');
  assert.ok(btn.data.attrs && btn.data.attrs.disabled,
    'scan-row Confirm must be disabled while a revert is pending (previously uncovered)');
});

test('lock tab: stale GL store shows reconcile banner', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  vm.lockData.stale = true;
  vm.lockData.gl = { locked: true, tower: { cellid: 'X' } };
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /GL('s)? stored lock/i);
  assert.match(text, /Clear it/);
});

test('lock tab: recovery card names the ssh panic path', () => {
  const component = loadChunk();
  const vm = makeVm(component, LIVE);
  vm.tab = 'lock';
  vm.lockData = JSON.parse(JSON.stringify(LOCKDATA_UNLOCKED));
  const text = textOf(component.render.call(vm, h));
  assert.match(text, /mudimodem-revert panic/);
  assert.match(text, /survives reboot/i);
});

test('AT console is an in-page tab: lazy-loads its own chunk', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /gl-sdk4-ui-mudimodem-console\.common\.js/, 'lazy-loads the console chunk');
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'at';
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Loading the AT console/, 'loading state before the chunk arrives');
  assert.doesNotMatch(txt, /Phase 3/, 'placeholder copy is gone');
  const fake = { name: 'mudimodem-console', render() {} };
  vm.consoleComp = fake;
  const node = walk(c.render.call(vm, h)).find((n) => n.tag === fake);
  assert.ok(node, 'renders the loaded console component as a child vnode');
});

test('Speedtest is an in-page tab: lazy-loads its own chunk, embedded like Tracking', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /gl-sdk4-ui-mudimodem-speedtest\.common\.js/, 'lazy-loads the speedtest chunk');
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  vm.tab = 'speedtest';
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Loading the speed test/, 'loading state before the chunk arrives');
  const fake = { name: 'mudimodem-speedtest', render() {} };
  vm.speedtestComp = fake;
  const node = walk(c.render.call(vm, h)).find((n) => n.tag === fake);
  assert.ok(node, 'renders the loaded speedtest component as a child vnode');
  assert.strictEqual(node.data.props.embedded, true, 'passes embedded:true');
});

test('Speedtest tab appears in the tab bar', () => {
  const c = loadChunk();
  const vm = makeVm(c, LIVE);
  const on = walk(c.render.call(vm, h))
    .filter((n) => n.data.staticClass && /\bmm-tab\b/.test(n.data.staticClass))
    .map(textOf);
  assert.ok(on.includes('Speedtest'), 'Speedtest tab rendered alongside the others');
});

// ---------------------------------------------------------------------------
// Phase 4 — SIM / APN tab
// ---------------------------------------------------------------------------

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

test('SIM tab shows full identifiers by default, hides them on toggle', () => {
  const comp = loadChunk();
  const vm = makeVm(comp, SPLIT);
  vm.tab = 'sim';
  let text = textOf(comp.render.call(vm, h));
  assert.ok(text.includes('89012601000000000001'), 'full ICCID visible by default');
  assert.ok(text.includes('Hide identifiers'), 'offers a hide toggle');
  vm.simReveal[1] = false;                              // user hides
  text = textOf(comp.render.call(vm, h));
  assert.ok(!text.includes('89012601000000000001'), 'full ICCID hidden after toggle');
  assert.ok(text.includes('8901…'), 'masked stub shown when hidden');
  assert.ok(text.includes('Show identifiers'));
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

test('applySim: fresh read, merged write, band fields intact in the payload', async () => {
  const FRESH = { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0,
    roaming: true, band_enable: true, band_filter_mode: 0,
    band_list: { LTE: [], 'NR-NSA': [], 'NR-SA': [71] } };
  // reply 1: get_sim_config (RMW read); 2: set_sim_config; 3: post-apply re-seed read.
  const calls = stubRpc([FRESH, {}, FRESH]);
  try {
    const vm = makeVm(loadChunk(), SPLIT);
    vm.simEdit[1] = { apn: 'fast.t-mobile.com', auth: 'NONE', username: '', password: '',
      ip_type: 0, roaming: true };
    vm.applySim(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[0].params[2], 'get_sim_config');
    assert.equal(calls[1].params[2], 'set_sim_config');
    assert.equal(calls[2].params[2], 'get_sim_config');   // re-seeds edits after write
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
  const applies = nodes.filter((n) => /mm-apply/.test(n.data.staticClass || '') && textOf(n) === 'Apply');
  assert.equal(applies.length, 1);                    // only the loaded slot has a form Apply
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
  let vm;
  try {
    vm = makeVm(loadChunk(), SPLIT);
    vm.doSwitch(2);
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.switchErr, '');                     // no error shown
    assert.equal(vm.switchTarget, 2);                   // still waiting on the websocket
  } finally { vm.clearSwitchState(); unstubRpc(); }      // kill the 90s fallback timer
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
  let vm;
  try {
    vm = makeVm(loadChunk(), SPLIT);   // active slot is 1
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
  } finally { vm && vm.clearSwitchState && vm.clearSwitchState(); unstubRpc(); }
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

test('status-0 slot renders clean Empty/No SIM — no garbage iccid, no form, no switch', () => {
  // Modem glitch (seen live 2026-07-18 after rapid slot switches): iccid present
  // but status 0 (No SIM). The card must render as a clean empty slot — never the
  // "Empty title + No SIM badge + fake ICCID + editable form" contradiction.
  const g = JSON.parse(JSON.stringify(SPLIT));
  g['cellular.sims_status'].sims = [
    { slot: '1', iccid: '44000000003', carrier: '', status: 0 },
    { slot: '2', iccid: 'E0127E0127E', carrier: '', status: 0 }
  ];
  const comp = loadChunk();
  const vm = makeVm(comp, g);
  vm.tab = 'sim';
  // Even if edits somehow got seeded, a not-present slot must show no form.
  vm.simEdit[1] = { apn: 'x', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true };
  const nodes = walk(comp.render.call(vm, h));
  const text = textOf(nodes);
  assert.ok(!text.includes('44000000003'), 'garbage ICCID must not render');
  assert.ok(!text.includes('Show identifiers'), 'no identity block for an absent SIM');
  assert.ok(text.includes('No SIM'), 'still shows the No SIM badge');
  const forms = nodes.filter((n) => /mm-form/.test(n.data.staticClass || ''));
  assert.equal(forms.length, 0, 'no dial form for an absent SIM');
  const useBtns = nodes.filter((n) => textOf(n) === 'Use this SIM');
  assert.equal(useBtns.length, 0, 'no switch button for an absent SIM');
});

test('present-but-unregistered slot (status 5) still shows identity + form', () => {
  const g = JSON.parse(JSON.stringify(SPLIT));
  g['cellular.sims_status'].sims[0] = { slot: '1', iccid: '89012601000000000001',
    carrier: '', status: 5, apn: 'h2g2' };   // present, searching
  const comp = loadChunk();
  const vm = makeVm(comp, g);
  vm.tab = 'sim';
  vm.simEdit[1] = { apn: 'h2g2', auth: 'NONE', username: '', password: '', ip_type: 0, roaming: true };
  const text = textOf(comp.render.call(vm, h));
  assert.ok(text.includes('89012601000000000001'), 'present SIM shows identity even if unregistered');
  assert.ok(text.includes('Not registered'), 'honest not-registered badge');
});
