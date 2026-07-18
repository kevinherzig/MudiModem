# AT console + community AT command library — Phase 3 design

*2026-07-18. Brainstormed with Kevin; approved section by section. Builds on CLAUDE.md §7a and the
`console.html` mockup (`.superpowers/brainstorm/782253-1784289176/content/console.html`).*

## 0. Probe findings that shaped this design (2026-07-18, read-only)

1. **`/dev/at_mdm0` CANNOT target a specific `sub_id` — resolved (CLAUDE.md open question 9).**
   The port answers in the active subscription's context (`AT+QSPN` → T-Mobile). No subscription
   selector exists: `AT+QSIMSWITCH=?` / `AT+QDSDS=?` / `AT+QMSIMCFG=?` all ERROR, `AT+QCFG=?` has
   no sim/sub entry, `AT+QNWPREFCFG=?` lists no sub parameter. GL's `sub_id` is a QMI-layer
   abstraction behind `modem_AT`, not AT syntax. ⇒ The console is **active-SIM only, labeled as
   such**; cross-SIM reads stay on GL's `modem.CPU.AT`.
2. **`at_mdm0` is not unclaimed:** GL's `port-bridge` (`/usr/bin/port-bridge at_mdm0 at_usb0 0`)
   holds it permanently as the modem end of the USB-AT passthrough. Coexistence probed clean
   (multiple full responses, no loss), but the transport keeps drain-before-send + strict
   terminator matching as the defense.
3. **The traffic source to quiet is `gl_modem`** (`/usr/bin/gl_modem -B cpu -S 1 connect-auto`) —
   Kevin's requirement: sleep it during sends. `modem_AT` (the ubus AT server) and
   `cellular_manager` are deliberately left running (freezing `modem_AT` turns concurrent GL RPCs
   into errors).
4. **Side finding, flagged (not part of this phase):** T-Mobile `nr5g_band` currently reads
   `25:41:48:66:71:77` — the full policy set, not the n71-only lock CLAUDE.md §5 describes.
5. **Leftover hung probe processes on the box** (two `ash -c ... test_port` scripts + a
   `cat /dev/at_usb0`, PIDs 7912/7990/7992 at probe time) hold `at_usb0`. Cleanup is Kevin's call;
   not this phase's concern beyond noting the `at_usb0` reader exists.

## 1. Decisions made with Kevin

| Decision | Choice |
|---|---|
| Risk gate semantics | **Gate library entries only.** Unchecked: `set`/`nv` entries browse and fill but won't Send. **Free-typed commands always send** — the console is a raw tool. |
| Param UX | **Param form strip** — labeled inputs per param above the prompt; command assembles live; Send arms only when all filled. |
| Transport | **Approach A**: `at_console` RPC spawns `mudimodem-at.py` per command, **plus SIGSTOP/SIGCONT of `gl_modem` around the send** (Kevin's addition). |

## 2. Architecture

| File | Role |
|---|---|
| `src/views/mudimodem-console.js` → `/www/views/gl-sdk4-ui-mudimodem-console.common.js.gz` | Console tab component. Own chunk, lazy-loaded in-page by the main view exactly like Tracking (`loadTracking` pattern). No new menu JSON — the tab lives inside the `mudimodem` view. |
| `src/at-library/quectel.json`, `src/at-library/3gpp.json` → `/www/mudimodem/at-library.json.gz` | The library. Build merges + validates + gzips. Fetched with `$axios`; no RPC, no auth (AT commands are public knowledge; never anything secret in it). |
| `tools/mudimodem-at.py` → `/usr/lib/mudimodem/mudimodem-at.py` | The transport, now shipped to the box. Grows: flock serialization, `gl_modem` sleep, stopped-daemon recovery. |
| `src/rpc/mudimodem` | One new method: `at_console{cmd, timeout}`. |

**Flow:** chunk → `$rpcRequest("call", ["sid","mudimodem","at_console",{cmd,timeout}])` → Lua
`ngx.pipe.spawn("python3", "/usr/lib/mudimodem/mudimodem-at.py", ...)` → `/dev/at_mdm0` → raw
response text (URCs included) returned verbatim. Authenticated admin RPC; no no-auth methods.

**Timeout chain (strictly ordered, so each layer outlives the one below):** tool `select()`
deadline (= requested timeout, default 8 s) < backend spawn timeout (tool + 5 s) < frontend
`$rpcRequest` opts timeout (tool + 10 s — the helper's 10 s default would cut off long commands).

### The `gl_modem` sleep — safety rules
Implemented **inside the Python tool** (single place that can guarantee pairing):
1. `pgrep gl_modem` → `SIGSTOP` each PID → send/read → `SIGCONT` in a `finally`.
2. **Recovery first:** on every startup, `SIGCONT` any `gl_modem` already in `T` state (heals a
   prior kill −9).
3. **Timeout ordering:** the tool's own `select()` deadline is strictly shorter than the backend's
   spawn timeout, so the tool always exits cleanly and runs its `finally` — it is never killed
   mid-stop in normal operation.

### Serialization & guardrails
- `fcntl.flock` on `/tmp/mudimodem/at.lock` around port I/O (serializes the 4 nginx workers).
  Lock not acquired within ~5 s → exit with "channel busy", never queue forever.
- `cmd`: raw by design, but newlines stripped (one command per send), length capped (256 chars),
  `timeout` clamped 1–60 s (default 8).

## 3. Library format

One object per command in `src/at-library/<vendor>.json`:

```json
{ "id": "quectel.policy-band",
  "cat": "Bands",
  "title": "Which bands the carrier actually permits",
  "cmd": "AT+QNWPREFCFG=\"policy_band\"",
  "risk": "read",
  "vendor": "quectel",
  "verified": ["RG650V-NA"],
  "summary": "one or two sentences, plain language",
  "warn": "required for set/nv: the concrete consequence",
  "source": "captured on box 2026-07-17",
  "by": "kevin",
  "params": [ { "name": "pci", "hint": "Physical cell ID — from the Lock tab table",
                "example": "721", "values": null } ],
  "decode": { "prefix": "+QENG: \"servingcell\"",
              "fields": ["state", "rat", "..."],
              "hi": ["rsrp", "sinr"],
              "enums": { "dl_bandwidth": { "2": "15 MHz" } } } }
```

- **`risk` mandatory:** `read` (query only) · `set` (runtime, gone on reboot) · `nv` (writes NV;
  survives factory reset). Badge shown everywhere the entry appears.
- **`params` required whenever `cmd` contains `{{...}}`** — drives the form strip. `values` (when
  present) renders a dropdown.
- **`verified: []` renders "— nobody yet"**, never hides the entry. `source` + `by` always shown.
- **`decode` is per-line prefix matching** — multi-line responses decode line by line; splitting
  respects quoted commas; enum fields map raw → label; missing fields render "—".

**Build validation** (in `tools/build.sh`, small Python check, fails the build): valid JSON,
unique ids, legal `risk`, `params` covers every placeholder exactly, `decode.fields` non-empty when
`decode` present, `warn` present on every `set`/`nv` entry.

**Contribution story:** GitHub PR against `src/at-library/`; schema documented in
`src/at-library/README.md`. Pure data — contributable without writing JS.

### v1 content
The mockup's 14 entries **corrected against `reference/quectel-at-reference.md`**:
- QENG servingcell decode includes `tac` (the mockup historically dropped it, shifting every
  later field).
- QNWLOCK entries use the verified box syntax (`common/4g` mode-first, `common/5g` PCI-first);
  set-side semantics warned as partially unmapped; the inferred lock-clear entry is
  `verified: []` with a warn saying exactly that.
- `AT+QCAINFO` ships **without** positional decode until the `pcell_state=5` question is resolved.
- **Added:** `policy_band` and `ue_capability_band` — the project's signature reads.
- **Excluded:** `restore_band` (action disguised as a query, §5a) and `QPRTPARA` (mapping
  unverified). The library must not hand strangers footguns we refuse to fire ourselves.

## 4. UI

Layout per the `console.html` mockup: caution banner; library rail (search, category groups, risk
badges) beside the console card (transcript, param strip, prompt, Send); decode grid under the
transcript; entry-detail card below (summary/warn, vendor, verified-on, source, contributed-by,
raw JSON). GL theme tokens; collapse under 820px; focus rings; `prefers-reduced-motion` respected.

- **Header truth line:** "own channel `/dev/at_mdm0` · active SIM: T-Mobile (slot 1)" — operator
  live from `moduleStatus("cellular.sims_info")`; follows the active SIM if it changes.
- **Risk gate:** "Enable higher-risk commands" checkbox in the caution banner, off by default,
  persisted in `localStorage`. Blocked Send explains itself with a transcript line.
- **Param strip:** one labeled input per param (hint, example placeholder, dropdown for `values`);
  assembled command previews read-only in the prompt until all params filled, then Send arms.
  No-param entries fill the prompt as editable text.
- **Transcript:** session-only, timestamped; command in primary, `OK` mint, `ERROR` rose; **URC
  lines dimmed with a `URC` tag, never hidden**. Up-arrow command history. "Copy" exports plain
  text.
- **Decode:** shown when the sent command exactly matches a library entry with `decode`; raw
  transcript always shown regardless.

## 5. Error handling

Each failure gets a distinct transcript line:
- Tool timeout: "no terminator after N s — response may still arrive; channel is drained on next
  send".
- Flock busy: "channel busy — another command in flight".
- RPC `timeout` / `accessDenied`: surface; `accessDenied` follows GL's normal re-login flow.
- Spawn failure: backend returns the tool's stderr, shown verbatim.

## 6. Testing & verification

- `test/chunk.test.js`: eval the console chunk exactly as the SPA does (stub `module`/`h`).
- Library validator runs on every build.
- Stubbed-`ngx` backend test: `at_console` clamping (newlines, length, timeout).
- `tools/verify.sh` additions: console chunk + library gz present and gzip-valid; library JSON
  parses on-device; Python tool present/executable; `at_console` returns `OK` for plain `AT`
  (read-only); **no `gl_modem` left in `T` state after the call** — the one failure mode that must
  never survive verification.

## 7. Out of scope (this phase)

- Cell-lock tab (`QNWLOCK` UI) — separate work; the library's lock entries are documentation, not
  the lock UI.
- `set_bands` durability fix (`modem.set_sim_config`) — separate open thread.
- In-UI library contribution/submission — PRs only.
- Cleanup of the stray probe processes and the `nr5g_band` anomaly (§0.4–0.5) — flagged to Kevin.
