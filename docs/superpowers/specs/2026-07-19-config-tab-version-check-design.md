# Config tab + MudiModem self-update — design

**Date:** 2026-07-19
**Status:** approved (brainstorm), pending implementation plan
**Phase:** 5 (new)

## Goal

Add a **Config** tab to the MudiModem page showing:

1. **Device** info — model number, CPU type, modem type.
2. **MudiModem** info — the installed version, plus an update check that renders as
   `MudiModem v1.0.0 (v1.0.2 available — Update now)` when a newer version exists on GitHub.

Clicking **Update now** re-runs the on-device installer from GitHub `main` (self-update).
The update check runs **every time the Config tab is opened**.

## Non-goals

- No automated/background version polling — the check fires only on tab open (and after a
  self-update completes). No cron, no websocket subscription.
- No real semver comparison — see "Version comparison" below. A conscious simplification.
- No change to the existing AT-library version check (`library_status` / `refresh_library`),
  which is a separate, independent mechanism in the AT console tab. This feature mirrors its
  fail-silent style but shares no code path with it beyond convention.

## Data sources

| Field | Source | New backend? |
|---|---|---|
| Model number | GL's undotted `system` RPC → `board` method (OpenWrt rpcd `system.board`), field `model` | ❌ browser-direct `$rpcRequest` |
| CPU type | same `system.board` call, field `system` | ❌ |
| Modem type | `cellular.modems_info.modems[0].name` (e.g. `"RG650V-NA"`) — already subscribed via `global_sockets`, already surfaced as `this.modem` in the chunk | ❌ already free |
| Installed MudiModem version | `/etc/mudimodem/version.json` written by `install.sh` at install time | ✅ read by new `app_version` method |
| Latest MudiModem version | `version.json` at repo root on `main`, fetched via curl | ✅ fetched by new `app_version` method |

### ⚠️ One open unknown — verify on-device FIRST

`system.board` returning `model` + `system` is the **standard OpenWrt rpcd contract**, and `system`
appears in `reference/rpc-objects.txt` as a web-callable object — but per the project's "trust the
box" rule this MUST be confirmed live before any frontend code is written:

```
ubus call gl-session call '{"module":"system","func":"board","params":{}}'   # test path, root, no sid
# or, browser-side once logged in: $rpcRequest("call", ["sid","system","board",{}])
```

- If it returns `model` / `system` as expected → no backend needed for device info.
- **Fallback** if it doesn't expose what we need: add a tiny `mudimodem.device_info` method
  reading `/proc/device-tree/model` (already used by every model-guard in this repo) and
  `/proc/cpuinfo`. The spec assumes the `system.board` path; the plan carries the fallback.

Modem type needs no verification — it's already read from `modems_info` elsewhere in the chunk.

## UI

### Tab registration

Append `["config", "Config"]` to the `TABS` array in `src/views/mudimodem.js` (currently
`tracking, sim, lock, bands, at`). Config sits **last** — it is meta/administrative, not a
modem-operational surface. No menu-JSON change (the tab list lives entirely in the chunk).

### Panel layout

Two static sections (no live trace/graph — unlike the rest of the app, this data is static or
rarely-changing):

```
┌─ Device ──────────────────────────────┐
│ Model      GL.iNet GL-E5800           │
│ CPU        ARMv8 Processor rev 4      │
│ Modem      RG650V-NA                  │
└────────────────────────────────────────┘

┌─ MudiModem ────────────────────────────┐
│ MudiModem v1.0.0 (v1.0.2 available —   │
│ Update now)                            │
└────────────────────────────────────────┘
```

Style follows GL theme tokens (`/www/theme/base.css`) — never hand-picked colours (§8 CLAUDE.md).

### Behavior

- **Device fields**: fetched once, lazily, the first time the Config tab is opened. Static —
  no re-fetch on subsequent visits. Modem name renders immediately from `moduleStatus` (already
  in the store); model/CPU render once the `system.board` call resolves.
- **Version line**: the installed version (`MudiModem v1.0.0`) renders immediately from the
  `app_version` result's `installed` field. The `(vX.Y.Z available — Update now)` clause appears
  **only** when the check resolves `update_available: true`.
- **Check timing**: `app_version` re-runs every time the tab is opened (per spec), and once more
  after a self-update completes.
- **While checking**: no spinner. Just `MudiModem v<installed>` until the "available" clause can
  be shown. Matches the AT-library status line's quiet style.
- **On check failure** (offline / GitHub unreachable): show only `MudiModem v<installed>`, no
  error text — fail-silent, exactly like `library_status`. If `installed` itself is `unknown`
  (missing/malformed `version.json`), show `MudiModem (version unknown)`.

## Backend — version check

New `version.json` at the repo root:

```json
{"version": "1.0.0"}
```

Bumped manually on release-worthy changes (repo hygiene, not automated).

`install.sh` gains one step: fetch `version.json`, install it to `/etc/mudimodem/version.json`,
and register that path in `/etc/sysupgrade.conf` (survives firmware upgrade — same convention as
every other shipped file). Uses the existing `grab`/`cp_install` helpers.

New backend method `mudimodem.app_version` — modeled on the existing `run_lib` pattern
(`io.popen` + `cjson.decode`; a plain subprocess, no ubus, no cosocket, so `pcall(cjson.decode,…)`
is safe per §8):

```
M.app_version(args) →
  installed = read+decode /etc/mudimodem/version.json → .version  (else "unknown")
  latest    = curl -fsS --max-time 8 https://raw.githubusercontent.com/kevinherzig/MudiModem/main/version.json → .version
  returns { installed, latest, update_available = (checked and latest ~= installed), checked, error? }
```

- Fail-silent on any network/parse error: set `error`, `checked = false`, `update_available = false`.
- The curl URL is a **fixed constant** — no RPC argument reaches the shell.

### Version comparison

`update_available` is a plain **string inequality** (`latest ~= installed`), not semver parsing —
same simplification the AT-library check already makes. Consequence: if `main` were ever *behind*
the installed version (a dev box ahead of a stale `main`), it would report "update available"
backwards. Not a real-world concern for an end user pulling from `main`; no semver parser added.
Documented so it's a conscious choice.

## Backend — self-update

**Problem:** `install.sh` ends with `/etc/init.d/nginx restart`. Running it synchronously inside a
`/rpc` handler would restart nginx out from under the connection serving that response. This needs
the **detached-process + state-file + poll** shape the auto-revert watchdog already uses (§5), not
a synchronous RPC.

### `src/sbin/mudimodem-selfupdate` (→ `/usr/sbin/mudimodem-selfupdate`, POSIX sh)

Sibling to `mudimodem-revert`. Steps:

1. **Atomic lock**: `mkdir /etc/mudimodem/update.lock.d`. `mkdir` is atomic — if it already exists,
   another update is in flight → exit quietly (no-op). Guards against double-click / concurrent runs.
2. Run `curl -fsSL https://raw.githubusercontent.com/kevinherzig/MudiModem/main/install.sh | sh`,
   tee output to `/var/log/mudimodem-update.log`.
3. Write `/etc/mudimodem/update-result.json`: `{ok, finished_at, error?}` (on failure, `error` =
   tail of the log).
4. `rmdir` the lockdir.

The GitHub URL is a **fixed constant**, never derived from an RPC argument.

### Backend methods (thin — mirror how `set_bands` just launches `mudimodem-revert`)

- `mudimodem.self_update` → `mkdir -p /etc/mudimodem; /usr/sbin/mudimodem-selfupdate >/dev/null 2>&1 &`
  then return `{ok: true, started: true}` immediately.
- `mudimodem.update_status` → return `{in_progress = <lockdir exists>, result = <parsed
  update-result.json or null>}`.

### Frontend flow — "Update now"

1. **Inline confirm**: the link/button becomes "Click to confirm — briefly restarts the admin
   panel", reverting after ~5 s if not clicked again. Lightweight two-step, scaled down from the
   band-lock countdown (this doesn't touch the cellular link and isn't a revert-style change).
2. **On confirm**: call `self_update`, show "Updating…", poll `update_status` every ~3 s.
3. **On finished result**:
   - success → "Updated to v<latest> — reload the page" (no auto-reload; a stale in-memory Vue app
     after an nginx restart is surprising if it happens on its own — let the user reload deliberately).
   - failure → "Update failed: <reason> — see /var/log/mudimodem-update.log".

## Files touched

| File | Change |
|---|---|
| `version.json` (repo root) | **new** — `{"version": "1.0.0"}` |
| `src/views/mudimodem.js` | add `config` tab + `renderConfig(h)` + device/version fetch + self-update flow |
| `src/rpc/mudimodem` | add `app_version`, `self_update`, `update_status` |
| `src/sbin/mudimodem-selfupdate` | **new** — detached installer runner + lockdir + result file |
| `install.sh` | install `version.json` → `/etc/mudimodem/version.json`; install `mudimodem-selfupdate`; register both in `sysupgrade.conf` |
| `tools/deploy.sh` | push the two new files (dev-loop parity with install.sh) |
| `test/chunk.test.js` | Config-tab render assertions (up-to-date + update-available cases) |
| `tools/verify.sh` | assert new backend methods present; assert `/etc/mudimodem/version.json` exists |

No menu-JSON change; no new `global_sockets`; no validator change (no free-form param — all three
new methods take no user input, so the default arg-allowlist is a non-issue).

## Testing

- **On-device FIRST**: confirm `system.board` returns `model` + `system`. Decides device-info path
  vs. the `device_info` fallback before any frontend code.
- **`test/chunk.test.js`**: extend fixtures with the Config tab; assert device fields render from
  `modems_info` + stubbed `system.board`, and the version line renders both "up to date" and
  "update available" (stubbed `app_version`).
- **`tools/verify.sh`**: `dofile` + call-shape assertions for `app_version` / `self_update` /
  `update_status`; assert `/etc/mudimodem/version.json` present post-install.
- **Self-update dry run**: exercise the full flow once under degraded conditions — confirm the
  lockdir blocks a double-click race, and that a forced failure (unreachable base URL) surfaces in
  `update-result.json` — before trusting the success path against the box's only admin session.

## Risk notes

- Self-update is the biggest blast-radius action in the project so far: an admin-gated button that
  runs `curl | sh` as root. Mitigations: fixed non-user-controlled URL; atomic lockdir; detached
  so it can't wedge the RPC worker; the installer it runs is itself idempotent and model-guarded
  (refuses on non-E5800). The two-step inline confirm makes it deliberate, not accidental.
- Files live outside `/etc/config` → wiped by firmware upgrade unless in `/etc/sysupgrade.conf`
  (both new persistent files are registered). Factory reset wipes regardless — re-install recovers.
