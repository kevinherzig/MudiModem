# Battery charge limit (Config tab) — design

**Date:** 2026-07-22  
**Status:** approved (brainstorm)  
**Phase:** Config tab extension (after Phase 5)

## Goal

Make the already-installed **battery charge limit** configurable from the MudiModem
**Config** tab: a toggle to enable/disable limiting, a target percentage, and live
status. MudiModem **ships and owns** the full charge-limit stack so install, deploy,
and sysupgrade stay consistent.

## Background (verified on box 2026-07-22)

The GL-E5800 has no stock “stop charging at N%” setting. Community tool
[ChiliApple/mudi7-battery-limit](https://github.com/ChiliApple/mudi7-battery-limit)
(`glbattlimit`) gates the SGM41600 pump + SGM41542S buck via sysfs so charge current
goes to 0 mA at a configurable SoC while the router stays on USB-C power.

**Already on the box (not previously in this repo):**

| Path | Role |
|---|---|
| `/usr/bin/glbattlimit` | CLI: `on [pct] [gui]`, `off`, `status` |
| `/etc/hotplug.d/i2c/20-glbattlimit` | Re-apply on charger plug (hardcoded `LIMIT=70` **gauge**) |
| `/etc/init.d/glbattlimit` | Boot fallback if already online (same hardcode) |

All three are listed in `/etc/sysupgrade.conf`. The gap is **configuration**: limit
and enablement are baked into two scripts; nothing exposes them in the UI.

**Two percentage scales** (upstream, provisional linear fit):

```
GUI ≈ 1.3867 × gauge − 18.93
```

The fuel gauge (`cw221X-bat/capacity`) is what the script enforces. GL’s web UI and
LCD show a consistently higher “GUI” %. The script accepts either scale (`on 80 gui`
vs `on 71`). The MudiModem UI always speaks **GUI %** to the user and shows gauge as
a secondary estimate.

## Non-goals

- No change to charger IC behaviour beyond what `glbattlimit` already does.
- No continuous battery websocket / strip graph (status on Config open + after set).
- No support claims for non-E5800 hardware (`available: false` if the tool fails).
- No UCI section; durable state stays under `/etc/mudimodem/` like other MudiModem files.
- No background daemon beyond the short-lived watcher `glbattlimit on` already starts
  (exits on unplug).

## Decisions (locked in brainstorm)

| # | Decision |
|---|---|
| 1 | **Toggle + percent** (not presets-only, not percent-without-toggle). |
| 2 | **MudiModem ships the full stack** (tool + hotplug + init), not UI-only. |
| 3 | **UI primary scale = GUI %**; always show **≈ gauge %** as secondary. |
| 4 | **Default: disabled.** Default target when first enabled: **80% GUI** (~71 gauge). |
| 5 | **Apply immediately** when saving if the charger is plugged in; if unplugged, save only and hotplug applies on next plug. |

## Architecture

```
Browser (Config tab)
    │  $rpcRequest → mudimodem.get_battlimit / set_battlimit
    ▼
/usr/lib/oui-httpd/rpc/mudimodem
    │  read/write /etc/mudimodem/battlimit.json
    │  spawn /usr/bin/glbattlimit  (subprocess; no ubus cosocket)
    ▼
/usr/bin/glbattlimit  →  sysfs (pump / buck / gauge)
    │  /tmp/glbattlimit.pid, /tmp/glbattlimit.limit

Parallel paths (same config file):
  /etc/hotplug.d/i2c/20-glbattlimit   plug → if enabled → glbattlimit on <limit_gui> gui
  /etc/init.d/glbattlimit             boot + online → same
```

### Config file

**Path:** `/etc/mudimodem/battlimit.json`  
**Shape:**

```json
{ "enabled": false, "limit_gui": 80 }
```

| Field | Type | Rules |
|---|---|---|
| `enabled` | boolean | When false, hotplug/init no-op; set path runs `glbattlimit off`. |
| `limit_gui` | integer | **20–100** (GUI scale). Matches `glbattlimit on N gui` range. |

**Missing or malformed file:** treat as defaults (`enabled: false`, `limit_gui: 80`).
Never invent `enabled: true` on a bad read.

**Atomic write:** write temp file in `/etc/mudimodem/`, then `rename` into place.

**Shell readers (hotplug / init):** must not hardcode a percent. Read the JSON with a
small, tested ash extract (or `jsonfilter` if present on the box). Call:

```sh
/usr/bin/glbattlimit on "$limit_gui" gui
```

so conversion stays inside the tool (single formula owner).

### RPC

No free-form strings → **no new validator entries** (bool + number pass oui defaults).

#### `get_battlimit` →

```json
{
  "enabled": false,
  "limit_gui": 80,
  "limit_gauge": 71,
  "active": false,
  "active_gauge": null,
  "capacity_gauge": 72,
  "capacity_gui": 81,
  "charger_online": false,
  "available": true,
  "error": null
}
```

| Field | Meaning |
|---|---|
| `enabled` / `limit_gui` | Desired policy from the JSON file (or defaults). |
| `limit_gauge` | Converted estimate of `limit_gui` for secondary display (from status parse or same formula as the tool). |
| `active` | Watcher currently running (`glbattlimit status` reports active). |
| `active_gauge` | Limit the watcher is enforcing, or `null` if off. |
| `capacity_*` | Live fuel gauge / estimated GUI from `status`. |
| `charger_online` | `charger/online == 1`. |
| `available` | `false` if binary missing or `status` fails (wrong model/fw). |
| `error` | Optional short string for UI note; null on success. |

Implementation detail: prefer **parsing `glbattlimit status` text** for live fields so
gauge↔GUI conversion is not duplicated in Lua. Config fields always come from the JSON file.

#### `set_battlimit({ enabled, limit_gui })` →

1. Validate: `enabled` boolean; `limit_gui` integer in **20–100**. On invalid params return
   `{ available, error = "invalid params", ... }` without writing (or use the same shape as
   get with `error` set — no JSON-RPC −32602 required if we validate in-method).
2. Write `battlimit.json` atomically.
3. Apply:
   - `enabled == false` → run `glbattlimit off` (always; safe if already off).
   - `enabled == true` and charger online → `glbattlimit on <limit_gui> gui`.
   - `enabled == true` and charger offline → config only; no error (status will show unplugged).
4. Return the same shape as `get_battlimit` (fresh read after apply).

**Env overrides for tests** (same pattern as version/self-update):

- `MUDIMODEM_BATTLIMIT_FILE` — path to JSON  
- `MUDIMODEM_BATTLIMIT_BIN` — path to `glbattlimit` (or a stub)

### UI — Config tab

Third card under **Device** and **MudiModem**:

```
┌─ Battery charge limit ─────────────────────┐
│ [ ] Limit charging                         │
│ Target   [ 80 ] % GUI   (≈ 71% gauge)      │
│ Status   Off · 72% gauge / ~81% GUI        │
│ Charger  Unplugged                         │
└────────────────────────────────────────────┘
```

Behaviour:

- Fetch `get_battlimit` when the Config tab is opened (every open, like `app_version`).
- Toggle off → percent control disabled (still shows last `limit_gui`).
- Changing toggle or percent calls `set_battlimit` with full `{ enabled, limit_gui }`
  (immediate apply policy).
- After set, replace local state with the response.
- If `available: false`, show a short static note (“Charge limit not available on this
  device”) and hide interactive controls.
- If set fails, keep prior state and show `error` under the card.
- Theme: existing `mm-card` / `mm-kv` / GL CSS variables only. `render(h)` only.

Copy notes:

- Label the target **“% GUI”** so users know it matches the LCD/admin battery number.
- Secondary line always **“≈ N% gauge”**.
- When enabled but unplugged: status should make clear the limit is **armed for next plug**,
  not actively gating (e.g. “Armed · will apply when charger connects” vs “Active · …”).

### Files shipped

| Repo path | On device | Mode |
|---|---|---|
| `src/sbin/glbattlimit` | `/usr/bin/glbattlimit` | 0755 |
| `src/hotplug/20-glbattlimit` | `/etc/hotplug.d/i2c/20-glbattlimit` | 0755 |
| `src/etc/init.d/glbattlimit` | `/etc/init.d/glbattlimit` | 0755 |
| (generated at install if missing) | `/etc/mudimodem/battlimit.json` | 0644 |
| `src/rpc/mudimodem` | methods `get_battlimit`, `set_battlimit` | — |
| `src/views/mudimodem.js` | Config card | — |

**`glbattlimit` provenance:** vendor the on-box / upstream ChiliApple script into
`src/sbin/glbattlimit` (MIT). Do not rewrite the gating logic; keep CLI compatible.
Attribute upstream in a short header comment if not already present.

**Hotplug / init:** rewrite to read config (no hardcoded 70). Keep the existing i2c
driver filter and “already running → exit” interlock.

### Install / deploy / uninstall

- `install.sh` / `tools/deploy.sh`: install the three stack files; `enable` init script;
  write default `battlimit.json` **only if absent** (never clobber user settings on upgrade).
- Register in `/etc/sysupgrade.conf`:
  - `/usr/bin/glbattlimit`
  - `/etc/hotplug.d/i2c/20-glbattlimit`
  - `/etc/init.d/glbattlimit`
  - `/etc/mudimodem/battlimit.json`
- `uninstall.sh`: run `glbattlimit off` if present; stop/disable init; remove files and
  sysupgrade lines; leave no stuck gate (`off` restores factory `vreg`).

### Safety

- All sysfs writes in `glbattlimit` are **restrictive only** (disable pump, lower `vreg`).
  Worst case: charges normally. Never raise charge voltage above factory.
- Before replacing `/usr/bin/glbattlimit` under a running watcher, run `off` first
  (upstream update guidance — ash reads scripts incrementally).
- Model guard on install/deploy remains E5800-only.

## Testing

| Layer | What |
|---|---|
| `test/backend-battlimit.test.lua` | Defaults when file missing; invalid `limit_gui` rejected; set writes JSON; enabled+online stubs `on … gui`; disabled stubs `off`; missing binary → `available: false`. |
| `test/battlimit-hotplug.test.sh` | Disabled config → hotplug no-ops; enabled → invokes tool with GUI args (stub bin). |
| `test/chunk.test.js` | Config card renders toggle/target/status; set payload shape. |
| `tools/verify.sh` | Files present, methods exist, isolation tests run. |

No automated live charge-current assertion (hardware-only).

## Risks / honesty

1. **Gauge↔GUI formula is provisional** (validated ~62–78 gauge upstream). UI always
   shows both numbers.
2. **Apply while unplugged only saves** — copy must not claim “active” until the watcher runs.
3. **Firmware upgrade** without sysupgrade registration would drop the tool; installer must
   keep registration idempotent (box already listed the three paths; add `battlimit.json`).
4. **DSDS / modem work is unrelated** — this feature must not touch AT, band lock, or SIM.

## Open implementation notes (not open product questions)

- Prefer parsing `glbattlimit status` over re-implementing the linear fit in Lua.
- Confirm on-box whether `jsonfilter` exists; if not, use a minimal sed extract or a
  companion `.conf` written alongside JSON by `set_battlimit` (still JSON is source of truth
  for RPC). Pick the approach that verify.sh can exercise without floating-point in ash.
- Chunk growth: Config card only; no new lazy chunk.
