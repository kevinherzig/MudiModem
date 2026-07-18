const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-tracking.js');

function loadChunk() {
  const module = { exports: {} };
  return eval(fs.readFileSync(SRC, 'utf8'));
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
function makeVm(c, over) {
  const vm = Object.assign({}, c.data());
  vm.$store = { getters: { moduleStatus() { return {}; } } };
  for (const [k, f] of Object.entries(c.methods || {})) vm[k] = f.bind(vm);
  for (const [k, f] of Object.entries(c.computed || {}))
    Object.defineProperty(vm, k, { get: f.bind(vm), configurable: true });
  Object.assign(vm, over || {});
  return vm;
}
// A 21-sample history over the last 20 min, handover at t-10 (id A1->B2, band 71->41).
function seedSamples() {
  const now = Date.now(), out = [];
  for (let i = 20; i >= 0; i--) {
    out.push({ t: now - i * 60000, slot: '1', id: i > 10 ? 'A1' : 'B2', band: i > 10 ? 71 : 41,
      mode: 'NR5G-SA FDD', rsrp: -100 - i, sinr: 5, rsrq: -13,
      rsrp_level: 3, sinr_level: 2, rsrq_level: 3, carrier: 'T-Mobile',
      tx_channel: '127490', dl_bandwidth: '15MHz' });
  }
  return out;
}
function s(over) {
  return Object.assign({ t: 1000, slot: '1', id: 'A1', band: 71, mode: 'NR5G-SA FDD',
    rsrp: -101, sinr: 4, rsrq: -14, carrier: 'T-Mobile' }, over || {});
}

// ---- deriveNetEvents (pure) ----

test('deriveNetEvents flags a handover on an id change', () => {
  const vm = makeVm(loadChunk());
  const ev = vm.deriveNetEvents([s({ t: 1000 }), s({ t: 2000, id: 'B2' })], []);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].label, 'Handover');
  assert.strictEqual(ev[0].kind, 'net');
});

test('deriveNetEvents flags a failover on a slot change', () => {
  const vm = makeVm(loadChunk());
  const ev = vm.deriveNetEvents([s({ t: 1000 }), s({ t: 2000, slot: '2', id: 'C3', carrier: 'AT&T' })], []);
  assert.strictEqual(ev[0].label, 'Failover');
});

test('deriveNetEvents suppresses a change near a user event', () => {
  const vm = makeVm(loadChunk());
  const known = [{ t: 2000, kind: 'user', label: 'Bands applied', detail: '' }];
  const ev = vm.deriveNetEvents([s({ t: 1000 }), s({ t: 2500, id: 'B2', band: 41 })], known);
  assert.strictEqual(ev.length, 0, 'change within 8s of a user event is not a net tick');
});

test('deriveNetEvents ignores steady state', () => {
  const vm = makeVm(loadChunk());
  const ev = vm.deriveNetEvents([s({ t: 1000 }), s({ t: 2000, rsrp: -99 })], []);
  assert.strictEqual(ev.length, 0);
});

// ---- component render ----

test('loading state before any data', () => {
  const c = loadChunk();
  const vm = makeVm(c, { loading: true, samples: [] });
  assert.match(textOf(c.render.call(vm, h)), /Loading history/);
});

test('empty (loaded, no samples) explains the collector', () => {
  const c = loadChunk();
  const vm = makeVm(c, { loading: false, samples: [] });
  assert.match(textOf(c.render.call(vm, h)), /collector runs on the router/);
});

test('renders one overlaid plot (RSRP/SINR/RSRQ) + three buses + a derived handover tick', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60 });
  const txt = textOf(c.render.call(vm, h));
  // legend carries each metric name; buses carry BAND/CELL/SIM.
  ['RSRP · dBm', 'SINR · dB', 'RSRQ · dB', 'BAND', 'CELL', 'SIM'].forEach((L) =>
    assert.match(txt, new RegExp(L.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${L} present`));
  assert.match(txt, /n71/, 'band bus shows the pre-handover band');
  assert.match(txt, /n41/, 'band bus shows the post-handover band');
  const dashed = walk(c.render.call(vm, h)).filter(
    (n) => n.data.attrs && n.data.attrs['stroke-dasharray'] === '3 3');
  assert.ok(dashed.length >= 1, 'derived handover tick rendered');
});

test('legend shows each metric name with its domain range', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60 });
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /RSRP · dBm {2}-120…-80/, 'RSRP range in legend');
  assert.match(txt, /SINR · dB {2}-10…30/, 'SINR range in legend');
  assert.match(txt, /RSRQ · dB {2}-20…-3/, 'RSRQ range in legend');
});

test('three overlaid metric lines, one fixed distinct GL colour each', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60 });
  const paths = walk(c.render.call(vm, h)).filter((n) => n.tag === 'path');
  // Exactly one path per metric — overlaid, NOT lane-stacked and NOT
  // quality-segmented (segmenting would yield many same-coloured paths).
  assert.strictEqual(paths.length, 3, 'one path per metric');
  const strokes = paths.map((p) => p.data.attrs.stroke);
  assert.ok(strokes.every((s) => /^var\(--/.test(s)), 'stroke is a GL token');
  assert.strictEqual(new Set(strokes).size, 3, 'three distinct fixed colours');
});

test('nearestSample returns the closest sample to a minute offset', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60 });
  const near = vm.nearestSample(-5);
  assert.ok(near && Math.abs(near.m + 5) < 1.5, 'picks a sample near t-5min');
});

test('event log merges server + derived events, newest first', () => {
  const c = loadChunk();
  const now = Date.now();
  const vm = makeVm(c, {
    samples: seedSamples(),
    events: [{ t: now, kind: 'user', label: 'Bands applied', detail: 'SA n41' }],
    winW: 60
  });
  const txt = textOf(vm.renderLog(h));
  assert.match(txt, /Bands applied/, 'server user event shown');
  assert.match(txt, /Handover/, 'derived net event shown');
  assert.ok(txt.indexOf('Bands applied') < txt.indexOf('Handover'), 'newest (now) first');
});

test('clicking pins the cursor; clicking again releases it', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60, width: 900 });
  vm.$refs = { lanes: { getBoundingClientRect: () => ({ left: 0, width: 900 }) } };
  vm.onClick({ clientX: 800 });
  assert.ok(vm.pinnedM != null, 'pinned after first click');
  vm.onClick({ clientX: 400 });
  assert.strictEqual(vm.pinnedM, null, 'released after second click');
});

// Faithfully model how a browser paints a viewBox-space x for the <svg>'s actual
// preserveAspectRatio. This is what makes the test catch the real bug: the default
// "meet" uniformly scales + CENTERS (so points drift toward centre), whereas "none"
// stretches to fill the width. `elemH == viewBox H` here, so meet's scale = 1.
function renderedX(svg, vbX, rectW) {
  const a = svg.data.attrs;
  const [, , W, H] = a.viewBox.split(' ').map(Number);
  const par = a.preserveAspectRatio || 'xMidYMid meet';
  if (/\bnone\b/.test(par)) return vbX * rectW / W;              // stretch X to fill
  const scale = Math.min(rectW / W, Number(a.height) / H);       // meet: uniform min-scale
  return (rectW - W * scale) / 2 + vbX * scale;                  // + horizontal centring
}

test('cursor line sits under the mouse when the panel is wider than the viewBox', () => {
  // Embedded, the container renders WIDER than the 900-unit viewBox (measure lags
  // the panel). The drawn line xOf(m) must render under the pointer regardless —
  // which requires the SVG to stretch (preserveAspectRatio:none), not "meet"
  // (uniform-scale + centre), or the line lags the cursor toward both edges.
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60, width: 900 });
  const rectW = 1280;
  vm.$refs = { lanes: { getBoundingClientRect: () => ({ left: 0, width: rectW }) } };
  const svg = walk(c.render.call(vm, h)).find((n) => n.tag === 'svg');
  assert.ok(svg, 'plot svg rendered');
  [120, 450, 800, 1150].forEach((clientX) => {
    const m = vm.clampM(vm.mFromEvent({ clientX }));
    const lineCss = renderedX(svg, vm.xOf(m), rectW);
    assert.ok(Math.abs(lineCss - clientX) < 0.6,
      `line at ${lineCss.toFixed(1)}px must sit under the mouse at ${clientX}px`);
  });
});

test('parseHash reads #w= and #m= into range + pin', () => {
  const c = loadChunk();
  global.window = { location: { hash: '#w=360&m=-42' } };
  const vm = makeVm(c);
  vm.parseHash();
  assert.strictEqual(vm.winW, 360, 'range set from hash');
  assert.ok(Math.abs(vm.pinnedM + 42) < 0.01, 'pin set from hash');
  delete global.window;
});

test('sliceReadout shows the nearby event and metric rows', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60, cursor: -10, width: 900 });
  const txt = textOf(vm.sliceReadout(h));
  assert.match(txt, /RSRP/); assert.match(txt, /Band/);
});

test('fetches over RPC (get_history), never touches raw AT or window.__mmHist', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /"get_history"/, 'reads history via the backend RPC');
  assert.doesNotMatch(src, /__mmHist/, 'no in-memory window recorder anymore');
  assert.doesNotMatch(src, /get_result_AT|QNWPREFCFG/, 'never issues raw AT');
});

test('updated() re-syncs this.width to the rendered width (no stretched viewBox)', () => {
  const c = loadChunk();
  assert.strictEqual(typeof c.updated, 'function', 'has an updated hook');
  // width starts at its default; after a render the lanes element reports its real
  // width, and updated() must adopt it so the SVG scale stays ≈ 1.
  const vm = makeVm(c, { samples: seedSamples(), events: [], winW: 60, width: 900 });
  vm.$refs = { lanes: { clientWidth: 1280,
    getBoundingClientRect: () => ({ left: 0, width: 1280 }) } };
  c.updated.call(vm);
  assert.strictEqual(vm.width, 1280, 'viewBox width now matches the rendered width');
});

test('embedded mode drops the "← Modem" breadcrumb (kept standalone)', () => {
  const c = loadChunk();
  const standalone = makeVm(c, { samples: seedSamples(), events: [], winW: 60 });
  assert.match(textOf(c.render.call(standalone, h)), /← Modem/, 'standalone route keeps the breadcrumb');
  const embedded = makeVm(c, { samples: seedSamples(), events: [], winW: 60, embedded: true });
  assert.doesNotMatch(textOf(c.render.call(embedded, h)), /← Modem/, 'embedded tab drops the breadcrumb');
});

test('render-only: no template, render is a function', () => {
  const c = loadChunk();
  assert.strictEqual(c.template, undefined);
  assert.strictEqual(typeof c.render, 'function');
  assert.strictEqual(c.name, 'mudimodem-tracking');
});

// ---- in-memory sample ordering (the "line across the whole graph" bug) ----
// The draw + bus code walk winSamples() in array order, drawing one polyline per
// metric. Incremental polling builds this.samples with .concat(), which does NOT
// guarantee ascending t: a full/incremental poll race, or a re-fetch with a stale
// `since`, re-appends already-held samples. A point ordered before its neighbours
// makes the single polyline draw a long L segment jumping back across the plot —
// the straight line spanning the whole graph.

// Longest single drawn segment (in window-minutes) across every metric path. A
// backward jump across the plot shows up here as a segment approaching winW.
function longestSegMin(c, vm) {
  const paths = [];
  const cap = (tag, data) => {
    if (tag === 'path' && data && data.attrs && data.attrs.d) paths.push(data.attrs.d);
    return {};
  };
  c.methods.renderLanes.call(vm, cap);
  const minPerPx = 60 / (vm.width - 30 - 12);   // PADL 30, PADR 12
  let worst = 0;
  for (const d of paths) {
    const pts = d.split(/(?=[ML])/).map((x) => x.trim()).filter(Boolean)
      .map((t) => ({ cmd: t[0], x: Number(t.slice(1).trim().split(/\s+/)[0]) }));
    for (let i = 1; i < pts.length; i++)
      if (pts[i].cmd === 'L') worst = Math.max(worst, Math.abs(pts[i].x - pts[i - 1].x));
  }
  return worst * minPerPx;
}

test('winSamples returns ascending, de-duplicated time order', () => {
  const c = loadChunk();
  const base = seedSamples();                       // 21 ordered samples
  // Model an incremental-poll overlap: the whole history re-appended (a full/
  // incremental race or a stale `since`). Raw array is now out of order + dup'd.
  const vm = makeVm(c, { samples: base.concat(base.slice()), winW: 60, width: 1900 });
  const ts = vm.winSamples().map((x) => x.t);
  assert.deepStrictEqual(ts, ts.slice().sort((a, b) => a - b), 'winSamples must be ascending by t');
  assert.strictEqual(new Set(ts).size, ts.length, 'winSamples must not contain duplicate timestamps');
  assert.strictEqual(ts.length, base.length, 'duplicates collapse back to the unique set');
});

test('an overlapping in-memory merge does NOT draw a line across the plot', () => {
  const c = loadChunk();
  const base = seedSamples();
  assert.ok(longestSegMin(c, makeVm(c, { samples: base, winW: 60, width: 1900 })) < 2,
    'clean data has only short segments');
  // Full re-append — without a sort in winSamples this drew a ~winW-minute L
  // segment straight back across the graph.
  assert.ok(
    longestSegMin(c, makeVm(c, { samples: base.concat(base.slice()), winW: 60, width: 1900 })) < 2,
    'a re-appended/duplicated merge must not produce a cross-plot segment');
});

test('a single out-of-order sample cannot streak across the plot', () => {
  const c = loadChunk();
  const base = seedSamples();
  // Newest sample ordered before the oldest (two batches concatenated newest-first).
  const scrambled = base.slice(1).concat([base[0]]);
  assert.ok(longestSegMin(c, makeVm(c, { samples: scrambled, winW: 60, width: 1900 })) < 2,
    'a lone misordered sample must be sorted back into place before drawing');
});

// Capture the get_history `since` argument of each /rpc post.
function stubAxios() {
  const calls = [], resolvers = [];
  global.window = {
    $getCookie: () => 'sid',
    $axios: { post: (url, body) => {
      calls.push({ since: body.params[3].since, method: body.params[2] });
      return new Promise((res) => resolvers.push(res));
    } }
  };
  return { calls, resolvers,
    settle: (i, result) => resolvers[i]({ data: { result } }) };
}

test('initial fetch requests only the visible window, not the whole history', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: [], winW: 60, width: 1900, serverNow: 0 });
  const ax = stubAxios();
  try {
    const t0 = Date.now();
    vm.fetchHistory();                      // the mount-time load
    assert.strictEqual(ax.calls.length, 1);
    const want = t0 - 60 * 60000;           // now - winW
    assert.ok(Math.abs(ax.calls[0].since - want) < 5000,
      `since must be ~now-winW (${want}), not 0 — got ${ax.calls[0].since}`);
  } finally { delete global.window; }
});

test('selecting a LARGER range backfills the wider window; SMALLER/equal does not', async () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: [], winW: 60, width: 1900, serverNow: 0 });
  const ax = stubAxios();
  const flush = () => new Promise((r) => setImmediate(r));
  try {
    vm.fetchHistory();                                  // loads 60m, loadedFrom = now-60m
    ax.settle(0, { samples: [], events: [], now: Date.now() });
    await flush();
    // Go to 24h → must backfill the wider window.
    const before = ax.calls.length;
    const t0 = Date.now();
    vm.setRange(1440);
    assert.strictEqual(ax.calls.length, before + 1, 'a wider range fetches more history');
    assert.ok(Math.abs(ax.calls[before].since - (t0 - 1440 * 60000)) < 5000,
      'backfill requests since = now - 24h');
    ax.settle(before, { samples: [], events: [], now: Date.now() });
    await flush();
    // Back down to 1h → already loaded, no fetch.
    const n = ax.calls.length;
    vm.setRange(60);
    assert.strictEqual(ax.calls.length, n, 'a narrower range re-filters in memory, no fetch');
  } finally { delete global.window; }
});

test('the 10s poll fetches incrementally from lastT and merges', () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: [], winW: 60, width: 1900, serverNow: 0, lastT: 111111, loading: false });
  const ax = stubAxios();
  try {
    vm.fetchHistory({ since: vm.lastT, merge: true });
    assert.strictEqual(ax.calls[0].since, 111111, 'poll uses lastT, not the window');
  } finally { delete global.window; }
});

test('an overlapping fetch is skipped, and a range request made during one runs after it settles', async () => {
  const c = loadChunk();
  const vm = makeVm(c, { samples: [], winW: 60, width: 1900, serverNow: 0 });
  const ax = stubAxios();
  try {
    vm.fetchHistory();                       // initial load, stays pending
    assert.strictEqual(ax.calls.length, 1);
    vm.fetchHistory({ since: vm.lastT, merge: true });   // a poll fires mid-flight
    assert.strictEqual(ax.calls.length, 1, 'the overlapping poll is dropped');
    vm.setRange(1440);                       // user widens the range while still fetching
    assert.strictEqual(ax.calls.length, 1, 'the backfill is deferred, not lost');
    ax.settle(0, { samples: [], events: [], now: Date.now() });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ax.calls.length, 2, 'the deferred backfill runs once the first settles');
    assert.ok(ax.calls[1].since < Date.now() - 1400 * 60000, 'and it is the 24h window');
  } finally { delete global.window; }
});
