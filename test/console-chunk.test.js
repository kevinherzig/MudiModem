const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'views', 'mudimodem-console.js');

// Mirror the loader in the main chunk: eval with `module` in scope.
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
function makeVm(component, statusMap) {
  const vm = Object.assign({}, component.data());
  vm.$store = { getters: { moduleStatus(name) { return (statusMap && statusMap[name]) || {}; } } };
  for (const [k, fn] of Object.entries(component.methods || {})) vm[k] = fn.bind(vm);
  for (const [k, fn] of Object.entries(component.computed || {})) {
    Object.defineProperty(vm, k, { get: fn.bind(vm), configurable: true });
  }
  return vm;
}

const LIB = [
  { id: 'quectel.serving-cell', cat: 'Diagnostics', title: 'Serving cell details',
    cmd: 'AT+QENG="servingcell"', risk: 'read', vendor: 'quectel', verified: ['RG650V-NA'],
    summary: 'sum', source: 'src', by: 'kevin',
    decode: { prefix: '+QENG: "servingcell"',
      fields: ['state', 'rat', 'duplex', 'mcc', 'mnc', 'cell_id', 'pci', 'tac',
               'arfcn', 'band', 'dl_bandwidth', 'rsrp', 'rsrq', 'sinr', 'tx_power', 'srxlev'],
      hi: ['rsrp', 'rsrq', 'sinr'],
      enums: { dl_bandwidth: { 2: '15 MHz' } } } },
  { id: 'quectel.nr5g-band-set', cat: 'Bands', title: 'Set the 5G SA allowlist',
    cmd: 'AT+QNWPREFCFG="nr5g_band",{{bands}}', risk: 'nv', vendor: 'quectel',
    verified: ['RG650V-NA'], summary: 'sum', warn: 'warn', source: 'src', by: 'kevin',
    params: [{ name: 'bands', hint: 'colon-separated', example: '41:66:71' }] },
  { id: '3gpp.radio', cat: 'Power', title: 'Radio off / on', cmd: 'AT+CFUN={{fun}}',
    risk: 'set', vendor: 'any', verified: [], summary: 'sum', warn: 'warn',
    source: 'src', by: 'kevin',
    params: [{ name: 'fun', hint: '0 off, 1 on', values: ['0', '1'] }] },
  { id: 'demo.set-commit', cat: 'Bands', title: 'Set + commit', risk: 'nv',
    vendor: 'any', verified: [], summary: 'sum', warn: 'warn', source: 'src', by: 'kevin',
    steps: ['AT+QNWPREFCFG="nr5g_band",{{bands}}', 'AT+QNWPREFCFG="nr5g_band"'],
    params: [{ name: 'bands', hint: 'colon-separated', example: '41:71' }] }
];

// Genuinely captured on the box 2026-07-17 (NR5G-SA, includes <tac>).
const CAPTURED = '+QENG: "servingcell","NOCONN","NR5G-SA","FDD",310,260,187461035,721,870100,127490,71,2,-99,-13,4,0,-';

test('chunk evals to a render-only component named mudimodem-console', () => {
  const c = loadChunk();
  assert.ok(c && typeof c === 'object');
  assert.strictEqual(c.name, 'mudimodem-console');
  assert.strictEqual(c.template, undefined, 'template: is forbidden');
  assert.strictEqual(typeof c.render, 'function');
});

test('renders without store or library (honest empty states, no throw)', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Raw AT/, 'console card renders');
  assert.match(txt, /at_mdm0/, 'truth line names the channel even with no store');
});

test('truth line shows the ACTIVE SIM from the websocket store', () => {
  const c = loadChunk();
  const vm = makeVm(c, {
    'cellular.modems_status': { modems: [{ bus: 'cpu', current_sim_slot: '1' }] },
    'cellular.sims_status': { sims: [{ slot: '1', carrier: 'T-Mobile', status: 6 },
                                     { slot: '2', carrier: 'AT&T', status: 6 }] }
  });
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /T-Mobile/, 'active carrier');
  assert.match(txt, /slot 1/, 'active slot');
  assert.doesNotMatch(txt, /AT&T/, 'never the other SIM');
});

test('splitFields respects quoted commas', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  assert.deepStrictEqual(vm.splitFields('"a,b",c,"d",7'), ['a,b', 'c', 'd', '7']);
  assert.deepStrictEqual(vm.splitFields(''), ['']);
});

test('classifyLine: ok / err / urc / resp', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  assert.strictEqual(vm.classifyLine('OK'), 'ok');
  assert.strictEqual(vm.classifyLine('ERROR'), 'err');
  assert.strictEqual(vm.classifyLine('+CME ERROR: 100'), 'err');
  assert.strictEqual(vm.classifyLine('+QIND: SMS DONE'), 'urc');
  assert.strictEqual(vm.classifyLine('+QSPN: "T-Mobile"'), 'resp');
});

test('risk gate blocks set/nv LIBRARY sends and explains itself', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[1]);                       // nv entry with params
  vm.params.bands = '41:71';
  vm.riskOK = false;
  vm.send();
  const last = vm.lines[vm.lines.length - 1];
  assert.strictEqual(last.kind, 'note', 'blocked send explains via transcript note');
  assert.match(last.text, /Enable higher-risk/);
  assert.ok(!vm.lines.some((l) => l.kind === 'cmd'), 'command was NOT sent');
  vm.riskOK = true;
  vm.send();
  assert.ok(vm.lines.some((l) => l.kind === 'cmd' && /41:71/.test(l.text)),
    'gate on: assembled command line pushed');
});

test('free-typed commands always send, gate off or on', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.riskOK = false;
  vm.prompt = 'AT+QNWLOCK="common/4g",0';   // typed by hand — raw console
  vm.selId = null;
  vm.send();
  assert.ok(vm.lines.some((l) => l.kind === 'cmd'), 'free-typed cmd pushed');
  assert.ok(!vm.lines.some((l) => l.kind === 'note'), 'no gate note for free typing');
});

test('param strip: assembly, fill-gate, Send disabled until filled', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[1]);
  assert.strictEqual(vm.paramMode, true);
  assert.match(vm.assembled, /\{\{bands\}\}/, 'placeholder shown until filled');
  assert.strictEqual(vm.paramsFilled, false);
  vm.send();
  assert.match(vm.lines[vm.lines.length - 1].text, /parameter/, 'refuses to send unfilled');
  // Send button disabled while unfilled. NB: the Copy button shares the
  // mmc-send class and appears earlier in the tree — select by text too.
  const sendBtn = (tree) => walk(tree).find((n) =>
    n.data.staticClass && /mmc-send/.test(n.data.staticClass) && /^Send/.test(textOf(n)));
  let btn = sendBtn(c.render.call(vm, h));
  assert.ok(btn.data.attrs.disabled, 'Send disabled until params filled');
  vm.params.bands = '41:71';
  assert.strictEqual(vm.assembled, 'AT+QNWPREFCFG="nr5g_band",41:71');
  assert.strictEqual(vm.paramsFilled, true);
  btn = sendBtn(c.render.call(vm, h));
  assert.ok(!btn.data.attrs.disabled, 'Send arms once filled');
});

test('params with values render a dropdown', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[2]);                        // AT+CFUN={{fun}} with values 0|1
  const sel = walk(c.render.call(vm, h)).find((n) => n.tag === 'select');
  assert.ok(sel, 'values param renders a <select>');
});

test('decode labels the captured QENG line, tac included, enum mapped', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.applyDecode(LIB[0], 'AT+QENG="servingcell"', CAPTURED + '\r\nOK\r\n');
  assert.ok(vm.decodeRows && vm.decodeRows.length === 1, 'one matched line');
  const row = vm.decodeRows[0];
  const get = (f) => row.find((x) => x.f === f);
  assert.strictEqual(get('tac').v, '870100', 'tac present (the field the mockup once dropped)');
  assert.strictEqual(get('arfcn').v, '127490');
  assert.strictEqual(get('dl_bandwidth').v, '15 MHz', 'enum mapped — raw 2 never shown');
  assert.strictEqual(get('rsrp').v, '-99');
  assert.strictEqual(get('rsrp').hi, true, 'rsrp highlighted');
});

test('decode also matches a free-typed command against the library', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.applyDecode(null, 'AT+QENG="servingcell"', CAPTURED);
  assert.ok(vm.decodeRows, 'library matched by exact cmd string');
  assert.strictEqual(vm.decodeSrc, 'quectel.serving-cell');
});

test('library rail renders categories, titles, risk badges; search filters', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  let txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Diagnostics/); assert.match(txt, /Bands/); assert.match(txt, /Power/);
  assert.match(txt, /Serving cell details/);
  const badges = walk(c.render.call(vm, h)).filter((n) =>
    n.data.staticClass && /mmc-risk/.test(n.data.staticClass));
  assert.ok(badges.some((n) => /nv/.test(n.data.staticClass)), 'nv badge present');
  vm.q = 'allowlist';
  txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Set the 5G SA allowlist/);
  assert.doesNotMatch(txt, /Serving cell details/, 'search filters the rail');
});

test('detail card: unverified renders "nobody yet", never hides', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[2]);                        // verified: []
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /nobody yet/, 'honest unverified state');
  assert.match(txt, /Radio off \/ on/, 'entry still fully shown');
});

test('arrow-up recalls history', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.history = ['AT', 'ATI'];
  vm.promptKey({ key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(vm.prompt, 'ATI');
  vm.promptKey({ key: 'ArrowUp', preventDefault() {} });
  assert.strictEqual(vm.prompt, 'AT');
});

test('send(): resolved {error} is treated as failure, not success', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.resolve({ error: 'channel busy - another command in flight' }) };
    vm.prompt = 'ATI'; vm.selId = null;
    vm.send();
    await new Promise((r) => setTimeout(r, 0));   // let the .then microtask drain
    const last = vm.lines[vm.lines.length - 1];
    assert.strictEqual(last.kind, 'err');
    assert.match(last.text, /channel busy/);
    // must NOT have pushed a resp/ok line for a resolved {error}
    assert.ok(!vm.lines.some((l) => l.kind === 'ok' || l.kind === 'resp'));
  } finally { global.window = saved; }
});

test('send(): success response is classified into resp/ok lines', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  const saved = global.window;
  try {
    global.window = {
      $rpcRequest: () => Promise.resolve({
        ok: true, requested: 1, ran: 1, aborted: false, steps: [
          { cmd: 'AT+QSPN?', status: 'ok', response: '+QSPN: "T-Mobile"\r\nOK\r\n', elapsed_ms: 12 }
        ]
      })
    };
    vm.prompt = 'AT+QSPN?'; vm.selId = null;
    vm.send();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(vm.lines.some((l) => l.kind === 'resp' && /\+QSPN/.test(l.text)),
      'response line classified as resp');
    assert.ok(vm.lines.some((l) => l.kind === 'ok' && l.text === 'OK'),
      'OK line classified as ok');
    assert.ok(!vm.lines.some((l) => l.kind === 'err'), 'no error line on success');
  } finally { global.window = saved; }
});

test('send(): status "timeout" pushes a "no terminator" error line', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  const saved = global.window;
  try {
    global.window = {
      $rpcRequest: () => Promise.resolve({
        ok: true, requested: 1, ran: 1, aborted: false, steps: [
          { cmd: 'AT+SOMETHINGSLOW', status: 'timeout', response: '' }
        ]
      })
    };
    vm.prompt = 'AT+SOMETHINGSLOW'; vm.selId = null;
    vm.send();
    await new Promise((r) => setTimeout(r, 0));
    const err = vm.lines.find((l) => l.kind === 'err');
    assert.ok(err, 'timeout produced an error line');
    assert.match(err.text, /no terminator/);
  } finally { global.window = saved; }
});

test('send(): a rejected RPC promise surfaces an error line', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.reject({ type: 'accessDenied' }) };
    vm.prompt = 'ATI'; vm.selId = null;
    vm.send();
    await new Promise((r) => setTimeout(r, 0));
    const last = vm.lines[vm.lines.length - 1];
    assert.strictEqual(last.kind, 'err');
    assert.match(last.text, /accessDenied/);
  } finally { global.window = saved; }
});

test('onPromptInput: hand-editing away from the picked entry drops selId to free-typed', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB[0]);                        // no-param entry: prompt filled with its cmd
  assert.strictEqual(vm.selId, LIB[0].id);
  vm.onPromptInput(LIB[0].cmd);           // unchanged text — still the entry's own command
  assert.strictEqual(vm.selId, LIB[0].id, 'selection kept while text matches the entry cmd');
  vm.onPromptInput('AT+SOMETHINGELSE');   // hand-edited away
  assert.strictEqual(vm.selId, null, 'edited away from the entry cmd -> free-typed');
});

test('the chunk speaks only at_console — never GL AT paths', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /"at_console"/, 'sends via mudimodem.at_console');
  assert.doesNotMatch(src, /modem\.CPU\.AT|get_result_AT|send_at_command/,
    'never GL AT surfaces');
});

test('assembled substitutes params across all steps of a steps[] entry', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB.find((e) => e.id === 'demo.set-commit'));
  vm.params.bands = '41:71';
  assert.strictEqual(vm.assembled,
    'AT+QNWPREFCFG="nr5g_band",41:71\nAT+QNWPREFCFG="nr5g_band"');
  assert.deepStrictEqual(vm.stepLines,
    ['AT+QNWPREFCFG="nr5g_band",41:71', 'AT+QNWPREFCFG="nr5g_band"']);
});

test('stepLines drops blank lines from free-typed multi-line input', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.prompt = 'AT+ONE\n\n   \nAT+TWO';
  vm.selId = null;
  assert.deepStrictEqual(vm.stepLines, ['AT+ONE', 'AT+TWO']);
});

test('send(): a multi-step sequence renders every returned step in order', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.resolve({
      ok: true, requested: 2, ran: 2, aborted: false, steps: [
        { cmd: 'AT+ONE', status: 'ok', response: 'OK\r\n', elapsed_ms: 3 },
        { cmd: 'AT+TWO', status: 'ok', response: '+X: 1\r\nOK\r\n', elapsed_ms: 4 }
      ] }) };
    vm.prompt = 'AT+ONE\nAT+TWO'; vm.selId = null;
    await vm.send();
  } finally { global.window = saved; }
  const cmds = vm.lines.filter((l) => l.kind === 'cmd').map((l) => l.text);
  assert.deepStrictEqual(cmds, ['AT+ONE', 'AT+TWO'], 'both step commands shown');
  assert.ok(vm.lines.some((l) => l.text === '+X: 1'), 'second step response shown');
});

test('send(): aborted sequence marks the remaining steps skipped', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.resolve({
      ok: true, requested: 2, ran: 1, aborted: true, steps: [
        { cmd: 'AT+BAD', status: 'error', response: 'ERROR\r\n', elapsed_ms: 3 }
      ] }) };
    vm.prompt = 'AT+BAD\nAT+NEVER'; vm.selId = null;
    await vm.send();
  } finally { global.window = saved; }
  assert.ok(vm.lines.some((l) => l.kind === 'note' && /skipped/.test(l.text)),
    'skipped note for the step that never ran');
});

test('typing a newline morphs the prompt to multi-line', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.onPromptInput('AT+ONE\nAT+TWO');
  assert.strictEqual(vm.multiline, true);
  assert.strictEqual(vm.promptMultiline, true);
});

test('Shift+Enter inserts a newline and does not send', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  let sent = false;
  try {
    global.window = { $rpcRequest: () => { sent = true; return Promise.resolve({ ok: true, steps: [] }); } };
    vm.prompt = 'AT+ONE'; vm.selId = null;
    vm.promptKey({ key: 'Enter', shiftKey: true, preventDefault() {} });
    assert.strictEqual(sent, false, 'Shift+Enter must not send');
    assert.strictEqual(vm.multiline, true, 'morphed to multi-line');
    assert.match(vm.prompt, /\n$/, 'a newline was appended');
  } finally { global.window = saved; }
});

test('Enter (no shift) sends', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  let sent = false;
  try {
    global.window = { $rpcRequest: () => { sent = true;
      return Promise.resolve({ ok: true, requested: 1, ran: 1, aborted: false,
        steps: [{ cmd: 'ATI', status: 'ok', response: 'OK\r\n' }] }); } };
    vm.prompt = 'ATI'; vm.selId = null;
    vm.promptKey({ key: 'Enter', shiftKey: false, preventDefault() {} });
    assert.strictEqual(sent, true);
  } finally { global.window = saved; }
});

test('picking a steps[] entry lists its commands in the detail card', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.lib = LIB;
  vm.pick(LIB.find((e) => e.id === 'demo.set-commit'));
  assert.strictEqual(vm.multiline, true, 'steps entry is multi-line');
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /AT\+QNWPREFCFG="nr5g_band"/, 'a step command is listed');
});

test('multi-line prompt renders a textarea, single-line an input', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.prompt = 'ATI'; vm.selId = null;
  assert.ok(walk(c.render.call(vm, h)).some((n) => n.tag === 'input'
    && n.data.attrs && n.data.attrs['aria-label'] === 'AT command'),
    'single-line uses <input>');
  vm.onPromptInput('AT+ONE\nAT+TWO');
  assert.ok(walk(c.render.call(vm, h)).some((n) => n.tag === 'textarea'),
    'multi-line uses <textarea>');
});

test('send(): RPC timeout scales with the number of steps', async () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  let seenOpts = null;
  try {
    global.window = { $rpcRequest: (_m, _p, opts) => { seenOpts = opts;
      return Promise.resolve({ ok: true, requested: 3, ran: 3, aborted: false, steps: [
        { cmd: 'A', status: 'ok', response: 'OK\r\n' },
        { cmd: 'B', status: 'ok', response: 'OK\r\n' },
        { cmd: 'C', status: 'ok', response: 'OK\r\n' } ] }); } };
    vm.prompt = 'A\nB\nC'; vm.selId = null;
    await vm.send();
  } finally { global.window = saved; }
  assert.strictEqual(seenOpts.timeout, (8 * 3 + 10) * 1000, '3 steps -> 8*3+10 s');
});
