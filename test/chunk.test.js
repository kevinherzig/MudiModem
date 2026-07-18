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
    { slot: '1', bus: 'cpu', iccid: '8901260108736235562F', imsi: '310260103623556',
      mcc: '310', mnc: '260', phone_number: '15388500234',
      apn_list: ['h2g2', 'fast.t-mobile.com', 'gigsky', 'gigsky'] },
    { slot: '2', bus: 'cpu', iccid: '89320420000217304391', imsi: '206018224530439',
      mcc: '206', mnc: '01', phone_number: '',
      apn_list: ['bicsapn', 'internet.proximus.be'] }
  ] },
  'cellular.sims_status': { sims: [
    { slot: '1', iccid: '8901260108736235562F', carrier: 'T-Mobile', status: 6, apn: 'h2g2' },
    { slot: '2', iccid: '89320420000217304391', carrier: 'AT&T', status: 6, apn: 'internet.proximus.be' }
  ] },
  'cellular.networks_status': { networks: [
    { slot: '1', iccid: '8901260108736235562F', dial_status: 0 },
    { slot: '2', iccid: '89320420000217304391', dial_status: 1 }
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
  assert.equal(s2.iccid, '89320420000217304391');
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
