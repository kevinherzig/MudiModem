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
    { slot: '1', cell_info: {
      id: '187461035', band: 71, mode: 'NR5G-SA FDD',
      rsrp: '-101', rsrp_level: 3, rsrq: '-14', rsrq_level: 3,
      sinr: '4', sinr_level: 2, dl_bandwidth: '15MHz', tx_channel: '127490' } },
    { slot: '2', cell_info: { band: 66, mode: 'LTE FDD', rsrp: '-120', rsrp_level: 1 } }
  ] },
  'cellular.sims_info': { sims: [{ slot: '1', mcc: '310', mnc: '260' }] }
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
  assert.doesNotMatch(txt, /-120/, 'must NOT show slot-2 (AT&T) RSRP');
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

test('render is a pure read — never mutates modem state', () => {
  const c = loadChunk();
  // The whole component exposes no set_/write path in Phase 1.
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /\$rpcRequest|set_bands|set_lock|get_result_AT/,
    'Phase 1 must contain no write/AT calls');
});
