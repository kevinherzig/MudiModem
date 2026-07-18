const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-tracking.js');

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

// ---- Task 1: the recorder ----

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

// ---- Task 3/4: the component ----

function seedWindow(mkHist) {
  const H = mkHist();
  const now = Date.now();
  // 21 samples over the last 20 min, a handover at t-10 (id A1->B2, band 71->41)
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
  const c = loadChunk(SRC);
  global.window = { __mmHist: c.makeMMHist() };
  const vm = makeVm(c);
  assert.match(textOf(c.render.call(vm, h)), /Collecting modem history/);
  delete global.window;
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
  const dashed = walk(c.render.call(vm, h)).filter(
    (n) => n.data.attrs && n.data.attrs['stroke-dasharray'] === '3 3');
  assert.ok(dashed.length >= 1, 'at least one cause tick rendered');
  delete global.window;
});

test('trace paths are quality-coloured with GL ramp tokens', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60 });
  const paths = walk(c.render.call(vm, h)).filter((n) => n.tag === 'path');
  assert.ok(paths.length >= 3, 'at least one path per trace lane');
  assert.ok(paths.every((p) => /^var\(--/.test(p.data.attrs.stroke)), 'stroke is a GL token');
  delete global.window;
});

test('nearestSample returns the closest sample to a minute offset', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60 });
  const s = vm.nearestSample(-5);   // ~5 min ago
  assert.ok(s && Math.abs(s.m + 5) < 1.5, 'picks a sample near t-5min');
  delete global.window;
});

test('event log lists events newest-first with source chips', () => {
  const c = loadChunk(SRC);
  const H = seedWindow(() => c.makeMMHist());
  H.events.push({ t: Date.now(), kind: 'user', label: 'Bands applied', detail: 'SA n41' });
  const vm = makeVm(c, { winW: 60 });
  const txt = textOf(vm.renderLog(h));
  assert.match(txt, /Bands applied/);
  assert.match(txt, /Handover/);
  assert.ok(txt.indexOf('Bands applied') < txt.indexOf('Handover'), 'newest (user) first');
  delete global.window;
});

test('clicking pins the cursor; clicking again releases it', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60, width: 900 });
  vm.$refs = { lanes: { getBoundingClientRect: () => ({ left: 0 }) } };
  vm.onClick({ clientX: 46 + (900 - 46 - 12) });   // far right ~ now
  assert.ok(vm.pinnedM != null, 'pinned after first click');
  vm.onClick({ clientX: 400 });
  assert.strictEqual(vm.pinnedM, null, 'released after second click');
  delete global.window;
});

test('parseHash reads #w= and #m= into range + pin', () => {
  const c = loadChunk(SRC);
  const H = c.makeMMHist();
  global.window = { __mmHist: H, location: { hash: '#w=360&m=-42' } };
  const vm = makeVm(c);
  vm.parseHash();
  assert.strictEqual(vm.winW, 360, 'range set from hash');
  assert.ok(Math.abs(vm.pinnedM + 42) < 0.01, 'pin set from hash');
  delete global.window;
});

test('sliceReadout shows the nearby event and metric rows', () => {
  const c = loadChunk(SRC);
  seedWindow(() => c.makeMMHist());
  const vm = makeVm(c, { winW: 60, cursor: -10, width: 900 });
  const txt = textOf(vm.sliceReadout(h));
  assert.match(txt, /RSRP/); assert.match(txt, /Band/);
  delete global.window;
});

test('render-only: no template, render is a function', () => {
  const c = loadChunk(SRC);
  assert.strictEqual(c.template, undefined);
  assert.strictEqual(typeof c.render, 'function');
  assert.strictEqual(c.name, 'mudimodem-tracking');
});
