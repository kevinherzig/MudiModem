# MudiModem — modem control panel inside the GL-E5800 "Mudi" web admin

**Goal:** a community add-on that installs a **Modem** page into the Mudi's stock GL web admin —
band lock, cell lock, live diagnostics, raw AT console, SIM/APN, and a community **AT command
library**. It adds a page *alongside* GL's own; it patches nothing.

⚠️ **The pitch is NOT "GL can't do this" — that was wrong (§7).** GL ships nearly every control.
The real gaps, all verified 2026-07-17:
1. **Undiscoverable** — band selection lives at Internet → SIM → dial config → *Advanced* → enable
   band filter. Kevin (who wrote this box's band lock by hand) didn't know it existed.
2. **Scattered** — modem controls are spread across the Internet page, modem details, SIM dialogs,
   and a *hidden* view (`modemsignallog` is `level:0` — GL built a signal log and left it out of
   the menu entirely).
3. **It lies.** GL's UI offers all 18 module-supported SA bands, but carrier policy permits 6 (§5a).
   The other 12 write cleanly, report success, and never take. GL also can't see AT-set locks (§5a).

Sibling project: **`../MudiUI`** (front-LCD renderer). Different surface, same box. MudiUI's
`CLAUDE.md` is the reference for **modem/AT/ubus knowledge** (its §6 data sources, §7 band+cell
lock) — don't re-derive it here.

Everything below was reverse-engineered from the live device (2026-07-16 / **-07-17**). **Trust the
box over this doc if they ever disagree** — then fix the doc.

## Working agreements (inherited from MudiUI — they still apply)
- **Deploy transfer:** the box has **no sftp-server**, so `scp` fails — use `ssh host 'cat > /path' < file`.
- **Commit only when Kevin asks.** Single `main`.
- **Don't reboot the Mudi remotely** — travel router; a reboot can drop the cellular ssh link.
- **Keep the real router IP out of this repo** (it's public). Use `<router-ip>` in docs.
- MudiModem never touches `/dev/fb0` — no interaction with gl_screen or MudiUI. The two add-ons
  are independent and can be installed separately.

## 1. Device access
- **SSH:** `ssh root@mudi` (hostname alias; key auth). BusyBox `ash`.
- ⚠️ **`192.168.8.1` is NOT the Mudi** — on this LAN that address is a *different* GL router
  (an **AXT1800**/Slate AX) that also answers ssh as root. The GL default is a trap here. Every
  deploy/install script **must model-guard** on `E5800` (`cat /proc/device-tree/model`) before
  writing anything. `tools/deploy.sh` does this.
- **Hardware:** GL.iNet **GL-E5800** ("Mudi"), Qualcomm **SDXPINN**, `aarch64_cortex-a53`,
  GL firmware **4.8.5** / OpenWrt 23.05.4, kernel 5.15.170, musl.
- **Modem: Quectel `RG650V-NA`** (`ATI`) — the **NA** variant, not EU (GL's code branches on
  `isEuModem(){ return "RG650V-EU"===this.info.name }`). Revision `RG650VNA01ACR02A04G8G`;
  firmware `QRM650VNA01ACR02A04G8G_OCPU_RGH_01.005.01.005` (`AT+QGMR`). AT port `/dev/smd9`,
  `bus: "cpu"`, `vendor: "quectel"`, `type: 0` (= built-in; GL gates band UI on `type===0`).
- ⚠️ **No AT manual exists for the RG650V (6-series).** The one in `docs/` is the **5-series**
  (RG50xQ/RM5xxQ) — a generation older; close, but wrong in confirmed ways. **The box is the only
  authority.** Probe read-only and trust it over any doc. Details: `reference/quectel-at-reference.md`.
- **Web admin:** `http(s)://<router-ip>` → nginx. LuCI also installed (`/cgi-bin/luci`).

## 2. The web admin architecture (what we extend)

GL's admin is an **oui**-framework Vue SPA (lineage: `github.com/zhaojh329/oui`), served by
**nginx + lua** — *not* uhttpd. (uhttpd also runs, on :8080/:8443, serving `/www` + LuCI. Ignore it.)

| Piece | Location |
|---|---|
| nginx site config | `/etc/nginx/conf.d/gl.conf` (copy in `reference/`) |
| **`gzip_static on` + `root /www`** | **`/etc/nginx/nginx.conf` lines 25 / 27** — *not* `gl.conf` |
| SPA entry / app bundle | `/www/gl_home.html`, `/www/js/app.<hash>.js.gz` |
| **Page chunks** | **`/www/views/gl-sdk4-ui-<view>.common.js.gz`** |
| **Menu entries** | **`/usr/share/oui/menu.d/<view>.json`** |
| **RPC backends (Lua)** | **`/usr/lib/oui-httpd/rpc/<object>`** |
| RPC backends (C) | `/usr/lib/oui-httpd/rpc/<object>.so` (e.g. `modem.so`, closed) |
| Arg validators | `/usr/share/gl-validator.d/<object>.lua` |
| RPC/WS endpoints | `/rpc`, `/ws`, `/upload`, `/download` → `/usr/share/gl-ngx/oui-*.lua` |

**Pages are dynamically loaded, not compiled in.** Adding one = drop a chunk + a menu JSON. No
rebuild of GL's app, no closed binary in the way. This is the opposite of the `gl_screen` dead end
that shaped MudiUI.

Menu JSON is tiny — the entire `modemsignallog.json` is:
```json
{ "view": "modemsignallog", "level": 0 }
```
Nesting under an existing section (`overview.json`):
```json
{ "index": 10, "view": "overview", "level": 2, "parent": "system",
  "parent_icon": "setting", "parent_index": 70 }
```
✅ **`level` semantics — RESOLVED (Phase 0): it is menu depth, not a permission tier.** From the
SPA's menu builder (`app.js`): `if (1===level) topLevel.push(...)` / `else if (2===level)` appends
to the `parent` group / **any other value (incl. `0`) enters neither branch → no menu entry**.
- `0` → route registered, hidden from the menu (`modemsignallog`, `sms`).
- `1` → top-level item; needs its own `icon` + `index`.
- `2` → child of `parent`; needs `parent`, `parent_icon`, `parent_index`, `index`.

Permissions are unrelated: routes get `meta:{needAuth:true}` regardless, and ACL is enforced at
`/rpc` (§3), not by the menu.

**Top-level nav is only 3 items** — `internet`(10), `wireless`(20), `clients`(30). Everything else
is a *parent group* synthesised from the `parent`/`parent_icon`/`parent_index` of level-2 entries
(`network` 48, `security` 50, `system` 70, …). **Our entry is now `level:1, index:15`** → sits
directly under Internet. (It was `level:2` under `network` at index 60 — the last child of a
collapsed group, i.e. as buried as GL's own band dialog.)

**`icon` must name a glyph in GL's iconfont** (`/www/fonts/iconfont.*.ttf`, 247 glyphs). Menu icons
all resolve there. Useful ones GL ships but never puts in the nav: **`modem`** (what we use),
`cellular`, `cellular-lock`, `simcard`, `full-signal`, `internet-cellular`, `modem-reboot`,
`monitor-waveform-regular-full`, `radar-regular-full`.

### ⭐ `global_sockets` — the read path, and why our backend is barely needed
A menu entry may declare `global_sockets`, and the SPA subscribes over **`/ws`**, pushing each named
ubus object into the `statusMap` Vuex store. Read it in a component with the **`moduleStatus(name)`**
getter (`...mapGetters(["moduleStatus"])`).

**`/ws` is not `/rpc`, so the dot restriction (§3) never applies here** — GL's own `internet.json`
subscribes to six dotted `cellular.*` objects. **Ours now declares the same six:**
```json
{ "index": 15, "view": "mudimodem", "title": "Modem", "icon": "modem", "level": 1,
  "global_sockets": ["cellular.modems_info", "cellular.modems_status",
                     "cellular.networks_info", "cellular.networks_status",
                     "cellular.sims_info", "cellular.sims_status"] }
```
⇒ **every read we need — band universe, modem identity, signal, SIM state — arrives free over the
websocket with no RPC and no backend.** The Lua backend is only needed for *writes* and for the AT
passthrough. This is the single biggest simplification to Phase 1.

Verified live: `ui.get_menu_list` returns our entry (44th) with `global_sockets` intact.

**The browser never reads `menu.d` directly** — it calls **`ui.get_menu_list`** (Lua bytecode; scans
`/usr/share/oui/menu.d`) and passes the result to the route builder, which adds each entry with a
`view` as a child of the `home` route at path `/<view>`. Consequences:
- Dropping in a menu JSON needs **no nginx reload** (the dir is re-scanned per call) — just reload the SPA.
- ⚠️ **A malformed menu JSON breaks `get_menu_list` for the *whole admin*, not just our page.**
  `tools/verify.sh` parses it on-device for exactly this reason.
- `title` may be a literal string (`"title": "Modem"`, as `dnsview.json` does) → no i18n key needed.

## 3. The RPC path (verified by reading the Lua)

Browser does `POST /rpc`, JSON-RPC:
```json
{"jsonrpc":"2.0","id":1,"method":"call","params":["<sid>","mudimodem","get_bands",{}]}
```
Chain: `oui-rpc.lua` → `oui.rpc M.call` → `dofile("/usr/lib/oui-httpd/rpc/<object>")` → our fn.
Falls back to `glc_call` (the `.so` via `/cgi-bin/glc`) if no Lua file / no matching method.

### ⚠️ The dot restriction — the single most important constraint
`oui-rpc.lua:91` gates the object name with `object:match('^[%a_][%w%-_]+$')` — **letters, digits,
`-`, `_` only. No dots.** So the browser **cannot** call `cellular.network`, `cellular.modem`, or
`modem.CPU.AT` — every modem ubus object is dotted.

This is why GL's own web-callable objects are all undotted: `sms_manager`, `gl-clients`, `mcu`,
`lpm`, `repeater`, `system`, `uci`. It's the architecture, not an accident.

**Consequence — the whole reason our backend exists:** the page calls **`mudimodem.set_bands`**;
our Lua does the dotted `ubus call modem.CPU.AT ...` **server-side, where no restriction applies.**

### ACL
`rpc.access(scope, entry)` → **`aclgroup == "root"` is always allowed** (`oui/rpc.lua:87`). The
admin session is root-group, so an authenticated admin can call our object with **no ACL file
needed**. Non-admin groups would need perms in oui's db (`oui.db`). Unauthenticated calls are
rejected unless listed no-auth — we want no no-auth methods.

## 4. Backend contract — a Lua file returning a table of functions

`M.call` does `dofile(script)`, keeps `type(v)=="function"` entries, calls `fn(args)`. That's it.
No daemon, no ubus registration, no compilation.

GL ships these **precompiled** (`luac`, `LuaQ` bytecode header, source paths like `./files/led.lua`)
— but **`dofile` loads plain source just fine, so we write readable Lua.**

Available inside a plugin (observed in GL's `led`, the smallest example at 1.5 KB):
```lua
local uci       = require "uci"
local ubus      = require "oui.ubus"      -- ubus.call(object, method, args) — dotted names OK here
local fs        = require "oui.fs"
local rpc       = require "oui.rpc"       -- rpc.ERROR_CODE_INVALID_PARAMS, ...
local validator = require "gl.validator"
-- ngx.pipe.spawn("/etc/init.d/gl_led", "restart") — can spawn processes
return { get_config = function(args) ... end, set_config = function(args) ... end }
```

## 5. Architecture — the files we ship

| File | Role |
|---|---|
| `/usr/lib/oui-httpd/rpc/mudimodem` | Lua backend; safe validated methods; dotted ubus calls |
| `/www/views/gl-sdk4-ui-mudimodem.common.js.gz` | the Vue page (gzipped — `gzip_static on`) |
| `/usr/share/oui/menu.d/mudimodem.json` | menu registration **+ `global_sockets`** (§2) — the read path |
| `/usr/sbin/mudimodem-revert` | detached auto-revert watchdog + ssh panic-restore |
| `/www/mudimodem/at-library.json.gz` | community AT command library (§7a); static, axios-fetched |

Optional: `/usr/share/gl-validator.d/mudimodem.lua` (arg validation).

**Frontend decision: native oui view, hand-written, no toolchain.** The chunk is a webpack UMD
bundle exporting a Vue component (GL's are ~41 KB, core-js polyfills included). We hand-write plain
JS exporting a Vue options object — keeping this repo toolchain-free, in MudiUI's "plain Python, no
C" spirit.
✅ **Template compiler — RESOLVED (Phase 0): ABSENT. The bundle is Vue 2.6.12 runtime-only.**
So **`template:` is forbidden — use `render(h)`.** (Evidence: zero occurrences of `{{` in the
1.9 MB bundle. A full build necessarily contains Vue's own `defaultTagRE = /\{\{...\}\}/g`, so its
absence is conclusive. The usual `"You are using the runtime-only build"` warning proves nothing
either way — it's inside a dev-only block that production strips. `staticRenderFns`/`_withStripped`
are present: GL's chunks ship **precompiled** render functions.)

### How a chunk is actually loaded — it is `eval`'d, not `require`d
From `app.js` (webpack module `a35c`, which escaped minification):
```js
const loadViewBeforeEnter = (view, parent) => (to, from, next) => {
  axios.get(`/views/gl-sdk4-ui-${view}.common.js?_t=${(new Date).getTime()}`).then((res) => {
    const component = eval(res.data);           // <-- eval, so the file must be an EXPRESSION
    to.matched[parent ? matched.length-1 : 0].components.default = component;
    next();
  })
}
```
- **The chunk source must be an expression statement whose value is the component** →
  `module.exports = { ... };` (an assignment *expression* evaluates to the assigned value).
- **`module` is in scope**: it's a *direct* eval inside a webpack module wrapper declared
  `function(module, __webpack_exports__, __webpack_require__)`. This is why GL's chunks are
  `module.exports=(function(t){...})({...}).default;`.
- URL has **no `.gz`** — `gzip_static` serves the `.gz`. Ship only the `.gz` (as GL does). Requires
  the client to send `Accept-Encoding: gzip`; without it nginx finds no plain file and 302s.
  Browsers always send it.
- **`?_t=<timestamp>` is a cache-buster** → chunks are *not* browser-cached; no hard-reload needed
  when iterating (see §8).
- Routes are auto-registered from the menu: `path: "/<view>"`, `name: alias||view`,
  `meta:{needAuth:true}`, as a child of the `home` route. We add no router code.
- The chunk is served **without authentication** (it's a static file; auth lives at `/rpc`) —
  so never put anything secret in it.

### Auto-revert (safety) — why it is NOT in the nginx Lua
Band lock **persists in NV across reboots** and a bad lock can drop cellular — i.e. the link you're
administering over. So changes are **confirm-or-revert**.

**nginx runs 4 workers**, each with its own `dofile`'d copy of the plugin and *no shared state*
(`objects[object]` is per-worker) — a timer there is unreliable. Instead:

1. `set_bands`/`set_lock` writes the **previous** config to `/etc/mudimodem/pending.json`, then
   launches detached `/usr/sbin/mudimodem-revert`.
2. The watchdog sleeps ~60 s, then restores unless `mudimodem.confirm` removed the file.
3. State lives in **`/etc`, not `/tmp`** → survives reboot; a boot-time check catches a
   reboot-mid-window (the NV lock would otherwise outlive the watchdog).

Payoffs: survives nginx reload, and the same script is the **ssh-callable panic restore**.

**Known-good full band lists** (from MudiUI §7 — the panic restore writes these):
- SA: `AT+QNWPREFCFG="nr5g_band",2:5:7:12:13:14:25:26:29:30:38:41:48:66:70:71:77:78`
- NSA: `AT+QNWPREFCFG="nsa_nr5g_band",2:5:7:12:14:25:26:30:38:41:48:66:71:77:78`
- ⚠️ Box is **currently locked to n71** (deliberate, 2026-07-15 — improved RSRP -105→-98, SINR 2→8).
  Don't "fix" it; it's the current desired state.
- ✅ **These two lists are exactly the module-supported sets** (verified 2026-07-17 against
  `cellular.modem info`, band-for-band). "Known-good" is a misnomer: it isn't a curated safe subset,
  it's simply *everything the module supports*. Note that is **not** everything that *works* — see §5a.

## 5a. ⭐ The three-layer band model (verified 2026-07-17 — the core domain insight)

📖 **Full evidence + every captured response: `reference/quectel-at-reference.md`.** Read it before
touching AT. It marks every fact 🟢 verified-on-box vs 📘 from-the-manual (which is for a *different*
module family) — and lists the corrections it makes to earlier work.

**There is no single "supported bands" list. There are three, and they compose:**

> ### **`capability = config ∩ policy`**
> Verified across 6 independent checks including the empty cases.

| Layer | Source | Scope |
|---|---|---|
| **Module supports** — what GL's UI shows you | `ubus call cellular.modem info` → `.modems[0].band` | per **device** |
| **Carrier policy permits** | `AT+QNWPREFCFG="policy_band"` | **per subscription** |
| **You configured** | `AT+QNWPREFCFG="nr5g_band"` | **per subscription** |
| **⇒ Modem actually advertises** | `AT+QNWPREFCFG="ue_capability_band"` | **per subscription** |

Measured on this box — **both SIMs, because policy is per-SIM**:

| | **T-Mobile** (sub_id **1**, slot 1, **active**, n71) | **AT&T** (sub_id **0**, slot 2) |
|---|---|---|
| module SA | 18 | 18 |
| **policy** SA | **6**: 25,41,48,66,71,77 | **0** — none |
| config `nr5g_band` | **71** | all 18 |
| **⇒ capability** SA | **71** ✅ | **0** ✅ |
| **policy** LTE | 17 | 17 |
| config `lte_band` | 19 (adds **7**, **38**) | 19 |
| **⇒ capability** LTE | **17** ✅ | **17** ✅ |

- **LTE bands 7 and 38 are configured on both SIMs and silently dropped** — the lie, live, on Kevin's box.
- ✅ **`0` means EMPTY, not "all"** (resolves the old `nsa_nr5g_band,0` question). AT&T has no SA
  policy ⇒ no SA capability, despite an unrestricted config.
- ⚠️ **The band grid is therefore per-SIM.** Policy *and* config change with the subscription;
  switching SIM must re-fetch both.

**Consequences — this is what MudiModem is for:**
- **GL's band dialog offers 18 SA checkboxes; policy permits 6.** The other 12 write cleanly, return
  success, and the modem never uses them. GL never queries `policy_band` (zero hits for
  `QNWPREFCFG` anywhere in its frontend). **The UI lies, and one AT query proves it.**
- The band grid therefore needs a state we'd never designed: *module-supported but policy-blocked* —
  shown, explained, **not selectable**.
- **`policy_band` is the number that matters**, not the module list. Show all three; lead with policy.

### GL's config layer vs. the modem — they disagree right now
`ubus call cellular.sim get_config` returns **no `band_list` at all** → GL believes there is no band
restriction. The modem says `+QNWPREFCFG: "nr5g_band",71`. Both are true: Kevin set that lock via raw
AT, and **GL only knows about locks written through its own config path.** So GL's band UI is
currently displaying stale state for this box, and would keep doing so until someone used it to write
a band list. Never trust `sim get_config` for band truth — ask the modem.

### NV semantics (verified 2026-07-17)
- **No commit step for band commands.** `AT+QNWPREFCFG` writes NV **immediately**; there is no
  staging area, so a "don't persist this" checkbox is **not possible**. (`AT&V` does show a classic
  Hayes profile — `&W: 0`, S-registers — but `&W` governs only the serial profile, not network config.)
- **NV *can* be backed up:** `AT+QPRTPARA=?` → `(1-4)` (Quectel NV backup/restore) and
  `AT+QNVFR=?` → `<nv_files>` (per-file NV read). ⚠️ **The 1–4 mapping is UNVERIFIED — do not fire
  it while guessing which is backup and which is restore.** Get the manual first.
- ⚠️ **`AT+QNWPREFCFG="restore_band"` is an ACTION, not a query** — it takes no argument in the test
  form. Running it would very likely wipe the deliberate n71 lock. **Never run it to "look".** It may
  be a better panic path than our hardcoded list (it's the modem's own default), but that needs
  verifying somewhere other than Kevin's only cellular link.
- `AT+QNWPREFCFG=?` also exposes: `gw_band`, `srv_domain`, `voice_domain`, `roam_pref`,
  `ue_usage_setting`, `rat_acq_order`, `nr5g_disable_mode`, `rf_band`, `policy_mode`.

## 6. Planned RPC surface (`mudimodem`)
Composed from MudiUI §6/§7 knowledge. All methods admin-only.

**⚠️ Most `get_*` below are now redundant — reads arrive free over `global_sockets`/`/ws` (§2).**
Prefer `moduleStatus("cellular.modems_info")` etc. in the component; only add a backend method when
the websocket genuinely doesn't carry it (`policy_band`, `ue_capability_band` — AT-only, §5a).

| Method | Backing | Still needed? |
|---|---|---|
| `get_status` | `cellular.modem status` + `cellular.network info` + `AT+QSPN` | ❌ websocket |
| `get_bands` | `AT+QNWPREFCFG="nr5g_band"/…` | ⚠️ **yes** — for `policy_band` + `ue_capability_band`, which the websocket does *not* carry (§5a) |
| `set_bands` | `AT+QNWPREFCFG=…` | ✅ yes (write + revert) |
| `get_lock` / `set_lock` / `clear_lock` | `AT+QNWLOCK` (PCI/ARFCN) | ✅ yes |
| `confirm` | clears `pending.json` → commits a pending change | ✅ yes |
| `at` | raw passthrough, `sub_id` = active slot | ✅ yes |
| `get_sim` / `set_slot` | `cellular.sim info`, `cellular.modem` | ❌ websocket / `mvas.switch_sim_slot` |
| `get_apn` / `set_apn` | uci / `cellular.*` | ⚠️ GL's `modem.set_sim_config` may do |

### ⚠️⚠️ `sub_id` — the most dangerous parameter on this box (corrected 2026-07-17)
~~`sub_id` MUST equal the active slot~~ — **that framing is wrong.** `sub_id` is a **subscription
index, not a slot number.** Verified:

| `sub_id` | Operator | Slot |
|---|---|---|
| **0** | AT&T (310410) | 2 | ⚠️ **UNSTABLE** |
| **1** | **T-Mobile (310260)** | **1** — the active/serving SIM | |
| 2 | AT&T | 2 (falls back to 0) |

Slot 1 ↔ sub_id 1 is a **coincidence**; slot 2 ↔ sub_id **0**.

> ⚠️ **`sub_id=0` silently answers for different subscriptions at different times.** Same command,
> minutes apart: `AT+QNWPREFCFG="nr5g_band"` @ sub_id=0 returned `71` (T-Mobile's), then
> `2:5:…:78` (AT&T's). `AT+QSPN` @ sub_id=0 returned T-Mobile once, AT&T on every later pass.
> **This is worse than always-wrong — it looks right most of the time.** A whole band analysis was
> built on it this session and thrown away.

**RULE: never send `sub_id=0`.** Resolve the active slot from ubus (`cellular.sim info` /
`cellular.network info` — the ground truth), then pass its explicit sub_id.

**Build AT payloads with proper JSON escaping** — the inner quotes of `AT+QNWPREFCFG="nr5g_band"`
must be escaped or ubus silently returns empty/ERROR. Working helper in the reference doc §Provenance.

### GL's own modem RPC surface — all undotted, all web-callable, ACL-gated to admin
Extracted from `gl-sdk4-ui-internet`. **These undermine the "we exist because of the dot
restriction" story** (§3) — the browser *can* already reach these. We exist for §5a + consolidation.
```
modem.send_at_command   modem.get/set_operator_config   modem.get/set_sim_config
modem.get/set_cell_tower  modem.scan_cell_tower  modem.get_slot_config
modem.scan_operator_list  modem.get/set_slot_failover_config  modem.set_sim_pin_code
modem.get/set_traffic_config  modem.set_3gpp_rel  modem.get_debug_msg  modem.set_connect
mvas.switch_sim_slot  mvas.get_connect_info  mvas.set/disconnect_slot_net
```
- **GL's band write is `modem.set_sim_config`**, carrying `{band_enable, band_filter_mode,
  band_list:{LTE:[],"NR-NSA":[],"NR-SA":[]}}` — **bare integers, never frequencies**; `modem.so`
  translates to `AT+QNWPREFCFG`. The string `nr5g_band` appears **nowhere** in GL's frontend.
- `band_filter_mode`: `0` = "Open" (allowlist), `1` = "Block" (denylist). Unparseable; we say
  "Auto / Choose bands".
- **You always send band *numbers*, never frequencies.** Any MHz shown in our UI is our own
  annotation, sourced from 3GPP (TS 38.101-1 for NR, 36.101 for LTE) — *not* from the modem.

### The relevant ubus objects (dotted — server-side or `/ws` only)
```
cellular.modem   info{bus} status{bus} get_all_config{bus} get_feature_config{bus} …
cellular.network info{bus,slot} status{} daig_info{} debug_at_info{} get/set_rrc_seg{}
cellular.sim     info{bus} status{bus} get_config{iccid} set_config{iccid,data} set_pincode{}
modem.CPU.AT     get_result_AT{cmd,timeout,source_flag,sub_id}   ← the AT passthrough
cellular.cm  cellular.collect  cellular.failover  cellular.status
```

### Calling our backend from the page — `$rpcRequest` (verified Phase 0)
The frontend RPC helper is **`window.$rpcRequest`** (also `Vue.prototype.$rpcRequest`).
**There is no `$oui` and no `$rpc`** — that earlier guess was wrong. GL's own chunks alias it at
module scope, e.g. from `gl-sdk4-ui-bridge`:
```js
const o = window.$rpcRequest,
      s = function(){ return o("call", ["sid", "cable", "get_ports_config", {}]) },
      c = function(t){ return o("call", ["sid", "network", "check_wan_cable", t], {timeout:2e4}) };
```
Signature: `$rpcRequest(method, params, opts?)`, `opts = {timeout=10000, isCancel=true, cancelMode=1}`.

- **⚠️ The literal string `"sid"` is a placeholder — pass it verbatim.** The helper overwrites
  `params[0]` with the session cookie: `params[0] = params[0] && getCookie("Admin-Token") || ""`.
  It only substitutes if `params[0]` is **truthy**, so passing `null`/`""` yields an empty sid and
  an auth failure. Don't pass a real sid either; just `"sid"`.
- **It resolves to the `result` payload directly** — an axios interceptor unwraps `result` and
  rejects on `error`, so there's no JSON-RPC envelope to unpack. It also rejects when `result`
  contains `err_msg`/`err_code`.
- Rejection shapes to handle: `{type:"accessDenied"}` (also clears the token cookie),
  `{type:"invalidParams"}` (JSON-RPC `-32602`), `{type:"timeout"}`, `{type:"rpcCancel"}`.
- Also global: `window.$axios`, `window.$message`, `window.$getCookie`; `this.$t(...)` for i18n.

So our page calls: `window.$rpcRequest("call", ["sid", "mudimodem", "get_status", {}])`.

## 7. Ruled out / decided (don't re-derive)
- ❌ **Patch GL's SPA or `/www/views/gl-sdk4-ui-*`** — an OTA of the GL ui packages overwrites them.
  We ship our *own* filenames alongside; OTA can't clobber what it doesn't know about.
- ❌ **Extend `modem.so`** — closed 131 KB C plugin behind GL's `modem` object. Same dead end as
  `gl_screen`. We add `mudimodem` alongside it instead.
- ❌ **Call `modem.CPU.AT` from the browser** — impossible, dot restriction (§3). *(But note GL's own
  undotted `modem.send_at_command` reaches AT from the browser anyway — §6.)*
- ❌ **LuCI app** — fully open and easy, but lands in LuCI, not GL's admin. Rejected: the goal is
  integration with the stock admin. (Still a fallback if the chunk path collapses.)
- ❌ **Standalone page on its own port** — no integration. Rejected for the same reason.
- ❌ **Revert timer inside the nginx Lua** — 4 workers, no shared state (§5).
- ❌ **A "don't write to NVRAM" checkbox** — not physically possible for band commands; there is no
  commit step (§5a). Use the NV *backup* instead, once `QPRTPARA` is understood.
- ❌ ~~**"MudiModem exposes controls GL's UI doesn't have."**~~ **This premise was WRONG** and is
  retired (2026-07-17). GL ships band masking, tower lock, operator lock, AT console, SIM failover,
  data caps and 3GPP-rel selection. See the header for the three gaps that actually justify the
  project — **undiscoverable, scattered, and lying**. Don't re-argue this; it cost a whole session.

## 7a. The AT command library (design direction, 2026-07-17)
Kevin's ask: a community-contributed AT snippet library, "similar to code snippets", shipped on the
router and searchable. It's a differentiator no router UI has.
- **Distribution:** entries live in-repo (`src/at-library/<vendor>.json`), deploy to
  `/www/mudimodem/at-library.json.gz`, fetched with axios. **No backend, no RPC**, and updatable
  without rebuilding the chunk. Served unauthenticated — fine, AT commands are public knowledge.
- **The killer field is `decode`** — a list of field names for the response. It turns
  `+QENG: "servingcell","NOCONN","NR5G-SA",…,-98,-11,8` (13 commas of nothing) into a labelled
  table **with no per-command code**. Pure data ⇒ contributable by people who don't write JS.
- **Mandatory `risk`, and it maps to real consequences, not vibes:**
  `read` (query only) · `set` (runtime, gone on reboot) · `nv` (**writes NV; survives factory reset**).
  Badge shown everywhere the entry appears. **Nothing ever auto-runs** — clicking fills the prompt.
  Entries with `{{params}}` refuse to send until filled. Gated behind an **"enable higher-risk
  commands"** checkbox (Kevin, 2026-07-17).
- **`verified: []` + `source` are load-bearing** — an unverified community command must render as
  "*nobody yet*", not hide. Keeps the library from becoming a folk-remedy collection. AT is
  vendor- *and* firmware-specific; `AT+QNWPREFCFG` is Quectel-only.

## 8. Dev gotchas
- **nginx caches the Lua plugin per worker** (`objects[object]` in `oui/rpc.lua`) → after editing
  the backend you must **reload nginx** (`/etc/init.d/nginx reload`) or changes won't take. This is
  the analogue of MudiUI's `/etc/init.d/mudi restart` loop.
- **`gzip_static on`** → the chunk must exist **gzipped on disk** (`gl-sdk4-ui-*.common.js.gz`).
  Ship the `.gz`. ~~browsers cache aggressively — hard-reload when iterating~~ — **wrong**: the SPA
  requests chunks with a `?_t=<timestamp>` cache-buster, so a normal page reload always refetches.
  (Menu JSON needs no reload either — see §2. Only the **Lua backend** needs `nginx reload`.)
- `/usr/lib/oui-httpd/rpc/` is owned `radio:radio`; the files themselves are root-owned.
- Errors surface in `/var/log/nginx/error.log` (`error_log ... notice`). `M.call` logs every
  non-get/load/check call — useful trace.
- Test a method without the browser: `curl -sk -X POST https://<router-ip>/rpc -d '{...}'` with a
  logged-in `sid` (get one via the `login` method).
- **⚠️ Never inline Lua/AT/JSON into `ssh '...'`** — nested quoting mangles it and you'll debug the
  quoting, not the problem. **Write the script locally, `ssh root@mudi 'cat > /tmp/x' < x`, then
  `ssh root@mudi 'sh /tmp/x; rm -f /tmp/x'`.** Cost real time twice this session.
- **Test an rpc backend with no sid and no browser** — `dofile` it under a stubbed `ngx` global
  (plugins pull `resty.http`, which indexes `ngx` at load and dies outside nginx).
  **The minimal stub is not enough — `resty/http.lua:111` also needs `ngx.config`:**
  ```lua
  ngx = { socket={tcp=function() return {settimeout=function() end, connect=function() end} end},
          re={match=function() end, gmatch=function() end, find=function() end},
          log=function() end, ERR=0, WARN=1, NOTICE=2, INFO=3, var={}, req={}, ctx={},
          say=function() end, print=function() end, exit=function() end, HTTP_OK=200,
          timer={at=function() end},
          config={ngx_lua_version=10025, subsystem="http", debug=false},   -- ← REQUIRED
          worker={id=function() return 0 end, count=function() return 4 end},
          now=function() return os.time() end, time=function() return os.time() end }
  local t = dofile("/usr/lib/oui-httpd/rpc/ui")
  local r = t.get_menu_list({})   -- → { menus = { {view=…, level=…}, … } }  (NOTE: r.menus, an ARRAY)
  ```
  `verify.sh` only proves the menu JSON *parses*; this proves it's actually **returned**.
- **Read AT read-only from the shell** (no browser, no sid):
  ```sh
  ubus call modem.CPU.AT get_result_AT '{"cmd":"AT+QNWPREFCFG=\"nr5g_band\"","timeout":6,"sub_id":0}'
  ```
  Response comes back as one escaped string in `.data` — `sed 's/\\r\\n/\n/g'` to read it. **Only
  ever run query (`?`) and test (`=?`) forms unprompted**; a bare param with no value can be an
  *action* (§5a, `restore_band`).
- **The dev box has Node 20** → the chunk is unit-testable locally by `eval`ing it with a stub
  `module` + stub `h`, exactly as the SPA does (`test/chunk.test.js`). Node is dev-only; nothing
  extra is ever shipped to the router.
- **Analysing GL's minified chunks:** pull + gunzip locally, then use **Python**, not `grep`.
  (`grep -c` counts *lines*, and these are one-liners — it will report 1 for 40 hits.) Chunks:
  `ssh root@mudi 'cat /www/views/gl-sdk4-ui-internet.common.js.gz' > x.gz && gzip -dc x.gz > x.js`.
- **GL theme tokens** live in `/www/theme/base.css` + `/www/theme/{default,classic,dark}/index.css.gz`
  — 60 base colours, 74 semantic aliases per theme. **Never hand-pick colours; extract these.**
  GL is *not* on Element UI's stock palette: `--primary #5272f7`, `--success #00c8b5` (mint, not
  green), `--error #e04c7e` (rose, not red), and a purple-tinted text ramp (`#141427`/`#1f1f3d`).
  Signal-quality ramp — reuse GL's own from `modemsignallog`: poor→`--error`, fair→`--warning`,
  good→`--info-hover`, excellent→`--success`.

## 9. Persistence & risk
- All four files live **outside `/etc/config/`** → wiped by a firmware upgrade unless listed in
  **`/etc/sysupgrade.conf`**; a factory reset wipes them regardless. Same story as MudiUI §10 —
  the installer must register them idempotently.
- Band/cell lock persists in **modem NV** — it survives reflash *and* factory reset. The panic
  restore is the only way back.
- The Mudi is a travel router on cellular — reachability is intermittent by design.

## 10. Build phases (risk front-loaded)
| Phase | Deliverable | Why here |
|---|---|---|
| **0** | Hello-world chunk + menu entry | ✅ done. Settled the template-compiler + `level` unknowns. |
| **1** | Read-only diagnostics tab | Now **cheaper than planned** — reads come free over `global_sockets` (§2); no backend needed except `policy_band`/`ue_capability_band` (§5a). |
| **2** | Band grid + cell lock, auto-revert, panic restore | The actual value. Must render the **three-layer** model (§5a), not a flat list. |
| **3** | AT console + community library | Riskiest surface — build on proven plumbing. Design in §7a. |
| **4** | SIM / APN | Most overlap with GL's own pages. |

## 11. Repo layout
```
MudiModem/
├── CLAUDE.md                    ← this file
├── docs/superpowers/specs/      ← design specs
├── docs/superpowers/plans/      ← implementation plans (per phase)
├── src/
│   ├── views/mudimodem.js       ← chunk SOURCE (plain JS; gzipped at build → the shipped .gz)
│   ├── menu/mudimodem.json      ← menu registration + global_sockets (level 1, icon "modem")
│   └── at-library/<vendor>.json ← community AT snippets (§7a) — not yet created
├── tools/
│   ├── build.sh                 ← "build" = gzip to gl-sdk4-ui-mudimodem.common.js.gz
│   ├── deploy.sh                ← model-guarded push over ssh `cat` (no scp: no sftp-server)
│   └── verify.sh                ← on-device assertions (files, JSON parse, gzip_static, eval)
├── test/chunk.test.js           ← local Node test: evals the chunk exactly as the SPA does
├── build/                       ← generated, gitignored
├── docs/
│   └── Quectel_RG50xQ&RM5xxQ_..._V1.1.1_Preliminary_20201009.pdf  ← ⚠️ 5-SERIES; box is 6-series
└── reference/
    ├── quectel-at-reference.md  ← ⭐ AT knowledge; 🟢 verified-on-box vs 📘 from-5series-manual
    ├── gl.conf                  ← nginx site config (/rpc, /ws, gzip_static)
    ├── oui-rpc.lua              ← /rpc endpoint: JSON-RPC, the dot gate (line 91), ACL check
    ├── oui-lib-rpc.lua          ← oui.rpc: M.call/dofile plugin loader, M.access, glc_call
    ├── menu.d-samples.json      ← menu JSON: flat (level 0) + nested (parent/index)
    ├── rpc-objects.txt          ← GL's shipped rpc backends (Lua + .so)
    └── menu-views.txt           ← GL's registered views
```

## 12. Current status / open threads
- ✅ Recon complete: oui page/menu/rpc mechanism mapped, dot restriction + ACL model understood,
  Lua-plugin backend contract confirmed, four-file architecture + auto-revert designed.
- ✅ **Phase 0 done (2026-07-16)** — chunk + menu deployed; `tools/verify.sh` green. Unknowns
  resolved: **template compiler absent** (§5), **`level` = menu depth** (§2), **RPC helper is
  `$rpcRequest`** (§6). Plan: `docs/superpowers/plans/2026-07-16-phase-0-hello-world-view.md`.
- ✅ **Promoted to a top-level nav item (2026-07-17)** — `level:1, index:15, icon:"modem"`, sits
  under Internet. Deployed, `verify.sh` green, and confirmed present in `ui.get_menu_list` with
  `global_sockets` intact.
- ✅ **The premise was rewritten (2026-07-17).** See the header + §7. GL *has* these controls; they
  are undiscoverable, scattered, and **wrong** (§5a). This is now the project's reason to exist.
- ✅ **UI design done** — `docs/superpowers/specs/2026-07-17-mudimodem-ui-design.md`. Signature: the
  status strip is a **live RSRP trace with change-ticks**, not a KPI row, because the revert
  countdown asks a question about the numbers and the strip must hold the evidence. Interactive
  mockups (self-contained HTML, open in any browser) in `.superpowers/brainstorm/*/content/`:
  `design.html` (whole page, 5 tabs) and `console.html` (AT library).
- ⏭ **Next:** rebuild the Bands tab around the **three-layer model** (§5a) — module-supported /
  policy-blocked / configured / serving — and fold the "enable higher-risk commands" toggle into the
  console. Then Phase 1.
- 🔭 Later: `install.sh`/`uninstall.sh` (device-guarded + idempotent, mirroring MudiUI's), ipk.

### Open questions (do not guess these — verify)
📖 All AT detail + evidence lives in **`reference/quectel-at-reference.md`**.
1. ✅ **`AT+QNWLOCK` — SOLVED on capability + syntax (2026-07-17).** Kevin confirms cell lock works;
   the box's `AT+QNWLOCK=?` gave the exact forms (ref §6a): `"common/4g",(0-10),<freq>,<pci>` and
   `"common/5g",<pci>,<freq>,<scs>,<band>` — **NR is PCI-first** (the mockup's guess was backwards).
   There's a `save_ctrl` persistence toggle too. *Still open:* set-side param semantics (`<mode>`,
   `<scs>`, how to clear, auto-persist vs `save_ctrl`) — but these are now "read ranges off the box",
   not "does it exist". **Don't probe set forms blind — a bad lock drops the link.**
2. **`AT+QPRTPARA` mapping** — `(1-4)` exists on our box; the RG50xQ manual doesn't document it at
   all. Per the *BG95/BG77/BG600L File System Backup App Note* (a **different family**):
   `=1` backup · `=3` **force restore** · `=4` **read-only info**. **Not yet run.** Safe test:
   `=4` baseline → `=1` → `=4` again, confirm `<CEFS_backup_cnt>` incremented.
   ❓ Unknown whether it even covers band config (it backs up the modem *file system*).
3. **`AT+QNWPREFCFG="restore_band"`** — takes no argument ⇒ an **action**, not a query. **Do not run
   it to look.** Likely a better panic path than our hardcoded list. Verify off Kevin's only link.
4. **Band→frequency table** — MHz labels in the UI are *ours*; source from **3GPP TS 38.101-1 (NR) /
   36.101 (LTE)**, not memory. The whole spectrum-ordering design rests on them being right.
5. **Is `policy_band` writable?** `policy_mode` exists (undocumented). If policy can be widened, §5a
   changes from "here's why 12 bands are dead" to "here's how to revive them".
6. **NR5G neighbour cells** — `AT+QENG=?` offers `"neighbourcell"`, but the manual documents **only
   LTE and WCDMA** neighbour formats, **no NR5G one**. The Cell-lock tab assumes a neighbour list
   with SINR; on SA it may return nothing. **Test before building.**
7. **`AT+QCAINFO` field order** — `<pcell_state>` is documented `0|1`; our box returned **`5`**.
   Don't decode it positionally until resolved.
- 🧹 Not yet done: nothing is registered in `/etc/sysupgrade.conf` — a firmware upgrade will wipe
  the deployed files. Re-deploy with `./tools/deploy.sh` (idempotent) until the installer exists.
- 🧹 `tools/verify.sh` still only checks the menu JSON *parses*; it should also assert
  `get_menu_list` returns it at `level:1` (§8 has the stub).
