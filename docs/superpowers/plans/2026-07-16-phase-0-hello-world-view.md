# MudiModem Phase 0 — Hello-World View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a reachable "Modem" page in the GL-E5800 stock web admin — a hand-written Vue chunk plus a menu entry — proving the dynamic-view mechanism end-to-end before any modem control is built on it.

**Architecture:** Two files ship: a plain-JS chunk gzipped to `/www/views/gl-sdk4-ui-mudimodem.common.js.gz`, and a menu JSON at `/usr/share/oui/menu.d/mudimodem.json`. GL's SPA reads `menu.d` server-side via `ui.get_menu_list`, auto-registers a route `/mudimodem` under the `home` route, then `axios.get`s our chunk and **`eval`s** it. No backend RPC object in this phase — Phase 0 is pure frontend plumbing at zero risk to the modem.

**Tech Stack:** Vue 2.6.12 (**runtime-only**), vue-router 3.6.5, Element UI, plain hand-written JS, gzip, BusyBox ash on the device, Node 20 locally for tests only (never shipped).

## Global Constraints

These were verified against the live device on 2026-07-16 and override any conflicting statement in `CLAUDE.md`. Every task's requirements implicitly include this section.

- **No template compiler.** The bundle is Vue **runtime-only** (zero `{{` in 1.9 MB; Vue's own `defaultTagRE` would be present in a full build). `template:` is FORBIDDEN — use `render(h)` only.
- **The chunk is `eval`'d, not `require`d.** `loadViewBeforeEnter` does `const component = eval(res.data)`. The file must be an **expression statement whose value is the component**. Use `module.exports = { ... };` — `module` is in scope because the eval is direct, inside webpack module `a35c` declared `function(module, __webpack_exports__, __webpack_require__)`.
- **Chunk URL:** `/views/gl-sdk4-ui-<view>.common.js?_t=<timestamp>`. No `.gz` in the URL — `gzip_static on` (`/etc/nginx/nginx.conf:25`, with `root /www` at line 27) serves the `.gz` transparently. Ship **only** the `.gz`, matching GL.
- **`_t=` is a cache-buster** — no browser hard-reload needed when iterating on a chunk.
- **RPC helper (Phase 1+, not this phase):** `window.$rpcRequest("call", ["sid", <object>, <method>, <args>], opts?)`. The literal string `"sid"` is a **truthy placeholder** the helper overwrites with the `Admin-Token` cookie (`params[0] = params[0] && getCookie("Admin-Token") || ""`). It resolves to the **`result` payload directly** (the interceptor unwraps `result` and rejects on `error`). Not `$oui`/`$rpc` — those do not exist.
- **`level` is menu depth, not a permission tier:** `0` = route registered but no menu entry; `1` = top-level item (requires its own `icon`); `2` = child of a `parent` group.
- **Menu label:** `"title"` accepts a literal string (proven by `dnsview.json` → `"DNS"`), which sidesteps i18n entirely.
- **Deploy transfer:** the box has no sftp-server, so `scp` fails. Use `ssh root@mudi 'cat > /path' < file`.
- **Device host:** `mudi` (ssh alias). **Never** put the router IP in this repo. Note `192.168.8.1` is a *different* GL router (an AXT1800) — always guard on model.
- **Do not reboot the Mudi.**
- **No nginx reload needed in this phase** — we add no Lua backend. `ui.get_menu_list` re-scans `menu.d` on every call.
- **Zero modem risk:** Phase 0 touches no AT command, no band lock, no `cellular.*`. The box stays locked to n71 (deliberate).

## File Structure

| File | Responsibility |
|---|---|
| `src/views/mudimodem.js` | Chunk source — the Vue component options object, hand-written, `render(h)` only. The only file that becomes device-facing UI. |
| `src/menu/mudimodem.json` | Menu registration — placement, label, ordering. |
| `tools/build.sh` | "Build" = gzip source to the exact device filename into `build/`. No toolchain. |
| `tools/deploy.sh` | Push the two artifacts to the device over ssh `cat`, model-guarded. |
| `tools/verify.sh` | Post-deploy assertions run against the live device. |
| `test/chunk.test.js` | Local Node test: eval the chunk with a stub `module`/`h`, assert component shape and rendered tree. |

---

### Task 1: Chunk source, proven by a local eval test

**Files:**
- Create: `test/chunk.test.js`
- Create: `src/views/mudimodem.js`
- Create: `tools/build.sh`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `src/views/mudimodem.js` — an eval-able expression whose value is a Vue options object with `name: "mudimodem"`, `data()` returning `{ title: "MudiModem", subtitle: ... }`, and `render(h)`. `tools/build.sh` produces `build/gl-sdk4-ui-mudimodem.common.js.gz`.

- [ ] **Step 1: Write the failing test**

This test reproduces the device's loader exactly: it `eval`s the source with a `module` object in scope and asserts the completion value is the component. `h` is stubbed to record the vnode tree, so we assert structure without a browser.

```js
// test/chunk.test.js
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

test('render produces a rooted tree containing the title', () => {
  const c = loadChunk();
  const vm = Object.assign({}, c.data());
  const tree = c.render.call(vm, h);
  assert.ok(tree, 'render must return a root vnode');
  assert.strictEqual(tree.tag, 'div');
  assert.match(textOf(tree), /MudiModem/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /home/kevin/MudiModem && node --test test/`
Expected: FAIL — `ENOENT: no such file or directory, open '.../src/views/mudimodem.js'`

- [ ] **Step 3: Write the minimal chunk source**

Plain `div`s only — no Element UI — so a Phase 0 failure can only mean eval/route/menu, not a component-resolution problem.

```js
// src/views/mudimodem.js
// MudiModem - Phase 0 hello-world view.
//
// Loaded by GL's SPA via `eval()`, so this file must be a single expression
// statement whose value is the component. `module` is in scope at eval time.
//
// Vue here is runtime-only: render(h) only, never `template:`.
module.exports = {
  name: "mudimodem",
  data() {
    return {
      title: "MudiModem",
      subtitle: "Phase 0 - the view loads, the route resolves, the menu links here."
    };
  },
  render(h) {
    return h("div", { staticClass: "mudimodem-view" }, [
      h("h2", this.title),
      h("p", this.subtitle)
    ]);
  }
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd /home/kevin/MudiModem && node --test test/`
Expected: PASS — 4/4.

- [ ] **Step 5: Write the build script**

```sh
#!/bin/sh
# tools/build.sh - "build" = gzip to the exact filename the SPA requests.
# nginx `gzip_static on` serves this .gz for /views/gl-sdk4-ui-mudimodem.common.js
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
gzip -9 -n -c src/views/mudimodem.js > build/gl-sdk4-ui-mudimodem.common.js.gz
cp src/menu/mudimodem.json build/mudimodem.json 2>/dev/null || true
ls -l build/
```

- [ ] **Step 6: Verify the built artifact round-trips**

Run:
```sh
cd /home/kevin/MudiModem && chmod +x tools/build.sh && ./tools/build.sh
gunzip -c build/gl-sdk4-ui-mudimodem.common.js.gz | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c || c.name!=="mudimodem") { console.error("FAIL"); process.exit(1); }
    console.log("OK: gz round-trips to component", c.name);
  })'
```
Expected: `OK: gz round-trips to component mudimodem`

---

### Task 2: Menu entry + deploy + live verification

**Files:**
- Create: `src/menu/mudimodem.json`
- Create: `tools/deploy.sh`
- Create: `tools/verify.sh`

**Interfaces:**
- Consumes: `build/gl-sdk4-ui-mudimodem.common.js.gz` from Task 1.
- Produces: `/www/views/gl-sdk4-ui-mudimodem.common.js.gz` and `/usr/share/oui/menu.d/mudimodem.json` on the device.

- [ ] **Step 1: Write the menu JSON**

`level:2` attaches us to GL's existing **network** group. `parent`, `parent_icon`, and `parent_index` must match GL's other network entries **exactly** (`bridge.json`, `lanip.json`, …) — if our file is scanned first, *we* create the group, and mismatched values would produce a duplicate one. `index:60` sorts us after GL's network children (max is `netnat` at 50). `title` is a literal string, avoiding i18n.

```json
{ "index": 60, "view": "mudimodem", "title": "Modem", "level": 2, "parent": "network", "parent_icon": "network", "parent_index": 48 }
```

- [ ] **Step 2: Write the deploy script**

Model-guarded: `192.168.8.1` on this LAN is a different GL router (AXT1800), so deploying to the wrong box is a real hazard.

```sh
#!/bin/sh
# tools/deploy.sh - push Phase 0 artifacts to the Mudi.
# No scp: the box has no sftp-server, so we stream over ssh `cat`.
set -eu
cd "$(dirname "$0")/.."
HOST="${MUDI_HOST:-mudi}"

MODEL=$(ssh -o BatchMode=yes "root@$HOST" 'cat /proc/device-tree/model' 2>/dev/null | tr -d '\0')
case "$MODEL" in
  *E5800*) : ;;
  *) echo "REFUSING: '$HOST' is not a GL-E5800 (got: '$MODEL')" >&2; exit 1 ;;
esac
echo "target OK: $MODEL"

./tools/build.sh

ssh -o BatchMode=yes "root@$HOST" 'cat > /www/views/gl-sdk4-ui-mudimodem.common.js.gz' \
  < build/gl-sdk4-ui-mudimodem.common.js.gz
ssh -o BatchMode=yes "root@$HOST" 'cat > /usr/share/oui/menu.d/mudimodem.json' \
  < src/menu/mudimodem.json
echo "deployed to $HOST"
```

- [ ] **Step 3: Write the verification script**

```sh
#!/bin/sh
# tools/verify.sh - assert Phase 0 landed correctly on the device.
set -eu
HOST="${MUDI_HOST:-mudi}"
fail() { echo "FAIL: $1" >&2; exit 1; }

echo "1. files present"
ssh -o BatchMode=yes "root@$HOST" 'test -s /www/views/gl-sdk4-ui-mudimodem.common.js.gz' \
  || fail "chunk .gz missing"
ssh -o BatchMode=yes "root@$HOST" 'test -s /usr/share/oui/menu.d/mudimodem.json' \
  || fail "menu json missing"

echo "2. menu json is valid JSON on-device"
ssh -o BatchMode=yes "root@$HOST" \
  'lua -e "local c=require(\"cjson\"); local f=io.open(\"/usr/share/oui/menu.d/mudimodem.json\"); c.decode(f:read(\"*a\"))"' \
  || fail "menu json does not parse (would break ui.get_menu_list for EVERY page)"

echo "3. nginx serves the chunk decompressed via gzip_static"
BODY=$(ssh -o BatchMode=yes "root@$HOST" \
  'curl -sk -H "Accept-Encoding: gzip" --compressed https://127.0.0.1/views/gl-sdk4-ui-mudimodem.common.js?_t=1')
echo "$BODY" | grep -q 'name: *"mudimodem"' || fail "chunk not served / wrong content"

echo "4. chunk still evals to the component after the round trip"
printf '%s' "$BODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const module={exports:{}}; const c=eval(s);
    if(!c||c.name!=="mudimodem"){console.error("FAIL: eval");process.exit(1);}
    console.log("   eval OK ->", c.name);
  })'

echo "ALL PHASE 0 CHECKS PASSED"
```

- [ ] **Step 4: Deploy and verify**

Run:
```sh
cd /home/kevin/MudiModem && chmod +x tools/deploy.sh tools/verify.sh
./tools/deploy.sh && ./tools/verify.sh
```
Expected: `target OK: GL.iNet E5800 ...`, then `ALL PHASE 0 CHECKS PASSED`.

If check 2 fails, **remove the file immediately** (`ssh root@mudi 'rm -f /usr/share/oui/menu.d/mudimodem.json'`) — a malformed menu JSON can break `ui.get_menu_list`, which every page in the admin depends on.

- [ ] **Step 5: Confirm in the browser (human step — the actual Phase 0 exit criteria)**

Ask Kevin to open the GL admin, log in, and confirm:
1. **Network → Modem** appears in the left menu.
2. Clicking it navigates to `/mudimodem` and renders the "MudiModem" heading — proving eval + render + route.
3. No console errors (especially not `runtime-only build of Vue`, which would mean a stray `template:`).

Steps 1–4 verify everything reachable without a browser; only the render itself needs a human eye.

---

### Task 3: Fold the settled facts back into CLAUDE.md

The doc's own rule is "Trust the box over this doc if they ever disagree — then fix the doc." Recon disagreed with it in six places, and the open questions in §12 are now answered.

**Files:**
- Modify: `/home/kevin/MudiModem/CLAUDE.md`

**Interfaces:**
- Consumes: the verified findings in this plan's Global Constraints.
- Produces: no code.

- [ ] **Step 1: Apply these corrections**

| § | Correction |
|---|---|
| §2 | `gzip_static on` is in `/etc/nginx/nginx.conf:25` (with `root /www`, line 27) — **not** `gl.conf`. |
| §2 | Menu JSON is served to the browser by **`ui.get_menu_list`** (Lua bytecode, scans `/usr/share/oui/menu.d`), not fetched from disk by the SPA. Adding a menu file needs **no nginx reload**. |
| §2 | **`level` semantics — RESOLVED:** menu depth, not permission tier. `0` = route-only/hidden; `1` = top-level (needs `icon`); `2` = child of `parent` group. Remove the ⏳. |
| §5 | **Template compiler — RESOLVED: absent.** Vue 2.6.12 runtime-only ⇒ render functions. Remove the ⏳. |
| §5 | Chunk is **`eval`'d**: it must be an expression → `module.exports = {...}`; `module` is in scope (webpack module `a35c`). URL `/views/gl-sdk4-ui-<view>.common.js?_t=<ts>`. |
| §8 | The `_t=` cache-buster means chunks are **not** browser-cached — "hard-reload when iterating" is wrong for chunks. |
| §12 | **RPC helper — RESOLVED:** `window.$rpcRequest("call", ["sid", obj, method, args], opts?)`; `"sid"` is a truthy placeholder replaced with the `Admin-Token` cookie; resolves to the `result` payload directly. `$oui`/`$rpc` do not exist. |
| §1 | Add: `192.168.8.1` on this LAN is a **different GL router (AXT1800)** — the Mudi is ssh alias `mudi`. Always model-guard. |

- [ ] **Step 2: Verify no contradictions remain**

Run: `grep -nE 'template compiler|\$oui|level.*permission|gzip_static' /home/kevin/MudiModem/CLAUDE.md`
Expected: no stale claims — every hit reflects the resolved facts above.

---

## Notes for the executor

- **This repo is not a git repository** (MudiUI is). No commit steps are included; ask Kevin before `git init`.
- **Rollback is two `rm`s** — nothing of GL's is patched:
  `ssh root@mudi 'rm -f /www/views/gl-sdk4-ui-mudimodem.common.js.gz /usr/share/oui/menu.d/mudimodem.json'`
- **Phase 0 deliberately ships no RPC backend.** Phase 1 adds `/usr/lib/oui-httpd/rpc/mudimodem` and *then* the nginx-reload-per-edit rule starts to matter.
