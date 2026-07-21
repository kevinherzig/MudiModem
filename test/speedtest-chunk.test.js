const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-speedtest.js');

function loadChunk() {
  const module = { exports: {} };
  const source = fs.readFileSync(SRC, 'utf8');
  return eval(source);
}

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
function walk(node, out) {
  out = out || [];
  if (node == null || typeof node === 'string') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  out.push(node);
  walk(node.children, out);
  return out;
}
function makeVm(component) {
  const vm = Object.assign({}, component.data());
  for (const [k, fn] of Object.entries(component.methods || {})) vm[k] = fn.bind(vm);
  for (const [k, fn] of Object.entries(component.computed || {})) {
    Object.defineProperty(vm, k, { get: fn.bind(vm), configurable: true });
  }
  return vm;
}
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

test('chunk evals to a render-only component named mudimodem-speedtest', () => {
  const c = loadChunk();
  assert.strictEqual(c.name, 'mudimodem-speedtest');
  assert.strictEqual(c.template, undefined, 'template: is forbidden');
  assert.strictEqual(typeof c.render, 'function');
});

test('renders an honest empty state before data arrives', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.resultsLoading = true;
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Run speed test/);
  assert.match(txt, /Loading history/);
});

test('runTest(): calls run_speedtest with the picked interface, sets running state', async () => {
  const calls = stubRpc([{ started: true }]);
  let vm;
  try {
    vm = makeVm(loadChunk());
    vm.runIface = 'wired';
    vm.runTest();
    assert.strictEqual(vm.status.running, true, 'optimistic running state set immediately');
    await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(calls[0].params, ['sid', 'mudimodem', 'run_speedtest', { iface: 'wired' }]);
  } finally {
    if (vm && vm.statusPoll) clearInterval(vm.statusPoll);
    unstubRpc();
  }
});

test('runTest(): iface_down surfaces as a friendly error, not a crash', async () => {
  const calls = stubRpc([{ error: 'iface_down', iface: 'wired' }]);
  try {
    const vm = makeVm(loadChunk());
    vm.runIface = 'wired';
    vm.runTest();
    await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(vm.status.running, false);
    assert.match(vm.status.message, /Wired WAN is not connected/);
  } finally { unstubRpc(); calls; }
});

test('runTest(): no-ops while a test is already running', () => {
  const vm = makeVm(loadChunk());
  vm.status = { running: true, phase: 'download' };
  const calls = stubRpc([]);
  try {
    vm.runTest();
    assert.strictEqual(calls.length, 0, 'must not start a second test');
  } finally { unstubRpc(); }
});

test('fetchStatus(): a finished test stops polling and refreshes history', async () => {
  const calls = stubRpc([{ running: false, phase: 'done' }, { results: [{ t: 1, down_mbps: 1 }] }]);
  try {
    const vm = makeVm(loadChunk());
    vm.statusPoll = setInterval(() => {}, 100000);
    vm.fetchStatus(false);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(vm.statusPoll, null, 'poll cleared once the test is done');
    assert.strictEqual(calls[1].params[2], 'get_speedtest_history', 'history refetched after completion');
  } finally { unstubRpc(); }
});

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

test('setSchedule(): posts enabled+interval, then re-fetches', async () => {
  const calls = stubRpc([{ ok: true }, { enabled: true, interval_seconds: 3600, last_run: 0 }]);
  try {
    const vm = makeVm(loadChunk());
    vm.setSchedule(true, 3600);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(calls[0].params, ['sid', 'mudimodem', 'set_speedtest_schedule',
      { enabled: true, interval_seconds: 3600 }]);
    assert.strictEqual(calls[1].params[2], 'get_speedtest_schedule');
  } finally { unstubRpc(); }
});

test('clearHistory(): empties the local results list', async () => {
  const calls = stubRpc([{ ok: true }]);
  try {
    const vm = makeVm(loadChunk());
    vm.results = [{ t: 1 }];
    vm.clearHistory();
    await Promise.resolve(); await Promise.resolve();
    assert.deepStrictEqual(vm.results, []);
    assert.strictEqual(calls[0].params[2], 'clear_speedtest_history');
  } finally { unstubRpc(); }
});

test('filtered: only shows results matching filterIface', () => {
  const vm = makeVm(loadChunk());
  vm.results = [{ t: 1, iface: 'cellular' }, { t: 2, iface: 'wired' }];
  vm.filterIface = 'cellular';
  assert.strictEqual(vm.filtered.length, 1);
  assert.strictEqual(vm.filtered[0].t, 1);
});

test('interface dropdown marks a down interface as not connected', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.ifaces = { cellular: { device: 'rmnet_data0', up: true }, wired: { device: null, up: false } };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Wired WAN \(not connected\)/);
});

test('ifacesErr renders as a visible error instead of failing silently', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.ifacesErr = 'timeout';
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Couldn't check interfaces: timeout/);
});

const RESULTS = [
  { t: 1000, iface: 'cellular', down_mbps: 40, up_mbps: 10, latency_ms: 60, jitter_ms: 5,
    carrier: 'T-Mobile', slot: 1, band: 71, mode: 'NR5G-SA FDD', cell_id: 'ABC', rsrp: -98, sinr: 8, rsrq: -11 },
  { t: 2000, iface: 'cellular', down_mbps: 55, up_mbps: 12, latency_ms: 58, jitter_ms: 4,
    carrier: 'T-Mobile', slot: 1, band: 71, mode: 'NR5G-SA FDD', cell_id: 'ABC', rsrp: -95, sinr: 9, rsrq: -10 },
  { t: 3000, iface: 'wired', down_mbps: 500, up_mbps: 100, latency_ms: 8, jitter_ms: 1 }
];

test('renderGraph: draws a line for cellular results only when filtered', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = RESULTS;
  vm.filterIface = 'cellular';
  vm.resultsLoading = false;
  const svg = walk(c.render.call(vm, h)).find((n) => n.tag === 'svg');
  assert.ok(svg, 'graph renders an svg once results exist');
  const paths = walk(svg).filter((n) => n.tag === 'path');
  assert.ok(paths.length >= 2, 'at least a download and upload line');
});

test('renderGraph: hovering picks the nearest result and shows a full snapshot popover', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = RESULTS;
  vm.filterIface = 'cellular';
  vm.resultsLoading = false;
  vm.width = 400;
  vm.cursor = 1;   // simulate onMove having picked index 1
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /55 Mbps/);
  assert.match(txt, /12 Mbps/);
  assert.match(txt, /58 ms/);
  assert.match(txt, /T-Mobile/);
  assert.match(txt, /n71/);
  assert.match(txt, /-95 dBm/);
});

test('renderGraph: clicking pins the cursor; clicking again unpins', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = RESULTS;
  vm.filterIface = 'cellular';
  vm.resultsLoading = false;
  vm.width = 400;
  const graphDiv = walk(c.render.call(vm, h)).find((n) => n.data.staticClass === 'mms-graph');
  assert.ok(graphDiv.data.on && graphDiv.data.on.click, 'graph wires a click handler');
  graphDiv.data.on.click({ clientX: 0, currentTarget: null });
  assert.notStrictEqual(vm.pinned, null, 'click pins a cursor position');
  const pinnedAt = vm.pinned;
  graphDiv.data.on.click({ clientX: 0, currentTarget: null });
  assert.strictEqual(vm.pinned, null, 'second click unpins');
  pinnedAt;
});

test('renderGraph: empty-for-this-interface state is honest, no crash', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  vm.results = [RESULTS[2]];        // only a wired result
  vm.filterIface = 'cellular';
  vm.resultsLoading = false;
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /No results yet for this interface/);
});

test('renderGraph: skips circles when down_mbps or up_mbps is null (honest gaps)', () => {
  const c = loadChunk();
  const vm = makeVm(c);
  // Create results where index 1 has down_mbps: null (simulating a partial result).
  // We should get 2*(results.length) circles total if all were present, but only 2*3-1=5 because one is missing.
  vm.results = [
    { t: 1000, iface: 'cellular', down_mbps: 40, up_mbps: 10, latency_ms: 60 },
    { t: 2000, iface: 'cellular', down_mbps: null, up_mbps: 12, latency_ms: 58 },  // down is null
    { t: 3000, iface: 'cellular', down_mbps: 55, up_mbps: null, latency_ms: 62 }   // up is null
  ];
  vm.filterIface = 'cellular';
  vm.resultsLoading = false;
  const svg = walk(c.render.call(vm, h)).find((n) => n.tag === 'svg');
  const circles = walk(svg).filter((n) => n.tag === 'circle');
  // With 3 results, we'd have 6 circles if all were present.
  // Result 1: down_mbps null -> skip down circle, keep up -> 1 circle
  // Result 2: up_mbps null -> keep down, skip up -> 1 circle
  // Result 3: both present -> 2 circles
  // Total: 4 circles (not 6)
  assert.strictEqual(circles.length, 4, 'must skip circles for null values; found ' + circles.length);
});

test('the chunk never issues raw AT and never calls tracking/console RPC objects', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /get_result_AT|modem\.CPU\.AT|at_console/);
});
