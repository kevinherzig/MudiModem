# MudiModem — design

**Date:** 2026-07-16
**Status:** approved, unimplemented
**Sibling:** `../MudiUI` (front-LCD renderer; owns the modem/AT/ubus knowledge this builds on)

## Problem

The GL-E5800 "Mudi" web admin exposes no band lock, no cell lock, and no AT console. Those controls
exist only over ssh, as hand-typed `AT+QNWPREFCFG` / `AT+QNWLOCK` calls (documented in MudiUI's
`CLAUDE.md` §7). The goal is a **Modem page inside the stock GL web admin** covering:

1. Band + cell lock
2. Raw AT console
3. Live diagnostics
4. SIM / APN control

## Key discovery

GL's admin is an **oui**-framework Vue SPA served by nginx+lua. **Pages are dynamically loaded, not
compiled in**: a page is a chunk in `/www/views/` plus a JSON file in `/usr/share/oui/menu.d/`, and
a backend RPC object is *a plain Lua file* in `/usr/lib/oui-httpd/rpc/` returning a table of
functions. No rebuild, no toolchain, no closed binary in the way — the opposite of the `gl_screen`
situation that shaped MudiUI.

**The governing constraint:** `oui-rpc.lua:91` gates ubus object names with
`^[%a_][%w%-_]+$` — **no dots**. Every modem object (`cellular.*`, `modem.CPU.AT`) is dotted, so the
browser cannot reach any of them. GL's own web-callable objects are all undotted (`sms_manager`,
`gl-clients`, `mcu`, `lpm`) — this is the architecture, not an accident. Our backend object exists
precisely to bridge that gap: the page calls `mudimodem.set_bands`; our Lua makes the dotted ubus
call server-side, where no restriction applies.

**ACL is not a blocker:** `aclgroup == "root"` is always allowed (`oui/rpc.lua:87`), and the admin
session is root-group. No ACL file needed. No method is registered no-auth.

## Architecture

### Files shipped

| File | Role |
|---|---|
| `/usr/lib/oui-httpd/rpc/mudimodem` | Lua backend — validated methods, dotted ubus calls |
| `/www/views/gl-sdk4-ui-mudimodem.common.js.gz` | the Vue page (gzipped; `gzip_static on`) |
| `/usr/share/oui/menu.d/mudimodem.json` | menu registration |
| `/usr/sbin/mudimodem-revert` | detached auto-revert watchdog + ssh panic restore |

Optional `/usr/share/gl-validator.d/mudimodem.lua` for arg validation.

Nothing is patched or overwritten. Our filenames are ours, so a GL OTA of the `gl-sdk4-ui-*`
packages cannot clobber them.

### Data flow

```
browser  POST /rpc  {"method":"call","params":[sid,"mudimodem","set_bands",{...}]}
  → oui-rpc.lua        name gate (no dots) → ACL (root ⇒ allow)
  → oui.rpc M.call     dofile("/usr/lib/oui-httpd/rpc/mudimodem")
  → our Lua            ubus.call("modem.CPU.AT", "get_result_AT", {...})   ← dotted, server-side
  → modem
```

### Backend contract

`M.call` does `dofile(script)`, keeps `type(v)=="function"` entries, calls `fn(args)`. GL ships
these as `luac` bytecode, but `dofile` loads plain source — **we write readable Lua**.

Available: `uci`, `oui.ubus`, `oui.fs`, `oui.rpc` (error codes), `gl.validator`, `ngx.pipe.spawn`.

Backend returns **display-ready values** (`band` int → `"n71"`, ARFCN → MHz), keeping the frontend
dumb — the same split MudiUI uses between `DataSource` and `Widget`.

### RPC surface (`mudimodem`)

| Method | Backing |
|---|---|
| `get_status` | `cellular.modem status` (active slot) + `cellular.network info` + `AT+QSPN` |
| `get_bands` / `set_bands` | `AT+QNWPREFCFG="nr5g_band"/"nsa_nr5g_band"/"lte_band"/"mode_pref"` |
| `get_lock` / `set_lock` / `clear_lock` | `AT+QNWLOCK` (PCI/ARFCN) |
| `confirm` | clears `pending.json` → commits a pending change |
| `at` | raw passthrough, `sub_id` = active slot |
| `get_sim` / `set_slot` | `cellular.sim info`, `cellular.modem` |
| `get_apn` / `set_apn` | uci / `cellular.*` |

**`sub_id` MUST equal the active slot** — both SIMs stay registered; `sub_id=0` returns the wrong
SIM's operator (MudiUI §6). Build AT payloads with proper JSON escaping.

### Frontend

**Native oui view, hand-written, no toolchain.** GL's chunks are webpack UMD bundles exporting a Vue
component (~41 KB with core-js polyfills). We hand-write plain JS exporting a Vue options object,
keeping the repo toolchain-free — MudiUI's "plain Python, no C" spirit.

**Unresolved (Phase 0):** does the SPA's Vue bundle include the **template compiler**? If yes,
`module.exports = {template: "...", ...}` works. If runtime-only → render functions (`h(...)`:
verbose, still no build). Also unresolved: `level` semantics in the menu JSON, and how GL's chunks
call `/rpc` (likely a `this.$oui`/`$rpc` injection — read a decompiled chunk).

One page, tabs per feature area (Diagnostics / Bands / Lock / AT / SIM), so phases 1–4 each land as
a tab on proven plumbing.

### Safety: confirm-or-revert

Band lock persists in **modem NV** — across reboots, reflash, and factory reset — and a bad lock can
drop the cellular link you're administering over.

**The watchdog must not live in the nginx Lua:** nginx runs **4 workers**, each with its own
`dofile`'d copy and no shared state (`objects[object]` is per-worker), so a timer there is
unreliable.

1. `set_bands`/`set_lock` writes the **previous** config to `/etc/mudimodem/pending.json`, then
   launches detached `/usr/sbin/mudimodem-revert`.
2. The watchdog sleeps ~60 s, then restores unless `mudimodem.confirm` removed the file.
3. State in **`/etc`, not `/tmp`** → survives reboot; a boot-time check catches a
   reboot-mid-window, since the NV lock would otherwise outlive the watchdog.

The same script is the **ssh-callable panic restore**, writing the known-good lists (MudiUI §7):
- SA: `AT+QNWPREFCFG="nr5g_band",2:5:7:12:13:14:25:26:29:30:38:41:48:66:70:71:77:78`
- NSA: `AT+QNWPREFCFG="nsa_nr5g_band",2:5:7:12:14:25:26:30:38:41:48:66:71:77:78`

⚠️ The box is **deliberately locked to n71** (2026-07-15; RSRP -105→-98, SINR 2→8). That is the
desired state — the panic restore is for recovery, not a default to apply.

## Build phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0** | Hello-world chunk + menu entry | Page appears in the admin menu and renders. Template-compiler + `level` questions answered. |
| **1** | Read-only diagnostics tab | Live signal/cell/carrier from `mudimodem.get_status`; rpc path proven end-to-end at zero risk. |
| **2** | Band + cell lock, auto-revert, panic restore | Lock applies; no-confirm reverts within ~60 s; panic restore works over ssh. |
| **3** | Raw AT console | Arbitrary AT with correct `sub_id`; results rendered. |
| **4** | SIM / APN | Slot switch + APN edit. |

Then: `install.sh` / `uninstall.sh` — device-guarded, idempotent, registering all four files in
`/etc/sysupgrade.conf`, mirroring MudiUI's installer.

## Testing

- **Backend without the browser:** `curl -sk -X POST https://<router-ip>/rpc -d '{...}'` with a
  `sid` from the `login` method. Every method testable this way before any UI exists.
- **Phase 2 revert:** apply a lock, don't confirm, verify the modem returns to the prior config.
  Deliberately test the drop-the-link case **while on LAN**, not over cellular.
- **Trace:** `/var/log/nginx/error.log` — `M.call` logs every non-get/load/check call.

## Risks

| Risk | Mitigation |
|---|---|
| Vue is runtime-only → no `template:` | Render functions; still no build. Settled in Phase 0 before anything is built on it. |
| A bad lock drops cellular → lose remote access | Auto-revert + ssh panic restore. Test on LAN. |
| Firmware upgrade wipes our files | Register in `/etc/sysupgrade.conf` (installer). Factory reset wipes regardless — re-deploy from repo. |
| GL OTA overwrites GL's ui packages | We ship our own filenames; nothing of GL's is patched. |
| nginx caches the Lua per worker | `/etc/init.d/nginx reload` after every backend edit. |

## Rejected alternatives

- **Patch GL's SPA / existing view chunks** — an OTA overwrites them.
- **Extend `modem.so`** — closed 131 KB C plugin; same dead end as `gl_screen`.
- **Call `modem.CPU.AT` from the browser** — impossible (dot restriction).
- **LuCI app** — open and easy, but lands in LuCI, not GL's admin. Fallback if the chunk path collapses.
- **Standalone page on its own port** — no integration.
- **Revert timer in the nginx Lua** — 4 workers, no shared state.
