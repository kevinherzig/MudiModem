# Multi-step AT sequences (library + free-typed) — design

*2026-07-18. Brainstormed with Kevin; approved section by section. Extends the Phase 3 AT console
(`2026-07-18-at-console-library-design.md`) so a single Send can run an ordered sequence of AT
commands — the "set, then commit/save" pattern — from either a curated library entry or free-typed
multi-line input.*

## 0. Motivation

Some AT commands need a follow-up in the same session: a setter followed by a commit or NV-save
(`AT&W`, `AT+QPRTPARA=1`), or a `CFUN` bounce around a config change. Today the console is strictly
one command per Send — three places enforce it:

1. Backend `at_console` collapses `[\r\n]+` to a single space (`src/rpc/mudimodem:763`).
2. The Python tool's `--envelope` path sends only `cmds[0]` (`tools/mudimodem-at.py:251`).
3. The library schema is a single `cmd` string per entry (`lib-validate.py`).

> ⚠️ **Box-specific caveat, carried from CLAUDE.md §5a:** this modem's *band* commands
> (`AT+QNWPREFCFG`) write NV immediately and have **no commit step**, so the existing Quectel band
> entries don't need this. The feature exists for the general/multi-vendor case (`AT&W`,
> `AT+QPRTPARA`, `CFUN` resets) — the library is explicitly community and cross-vendor.

## 1. Decisions made with Kevin

| Decision | Choice |
|---|---|
| Where multi-step lives | **Both** — curated library entries *and* free-typed console input |
| On step error/timeout | **Stop-on-error, uniform** — abort remaining steps; no per-entry `continueOnError` escape hatch (YAGNI) |
| Execution model | **One RPC, one invocation** — the whole sequence runs in a single `mudimodem-at.py` call, holding the flock + `gl_modem` SIGSTOP across every step (GL can't wake between a setter and its commit) |
| Free-type UX | **Auto-expand on newline** — single-line `<input>` by default; Shift+Enter or a multi-line paste morphs it into an auto-growing textarea; Enter still sends the whole block |
| Decode on multi-step | **Forbidden on `steps` entries** — decode allowed only with a single `cmd` (multi-step entries are actions, not reads) |
| Max steps | **8** per sequence; 256 chars/step |

## 2. Library schema — `cmd` XOR `steps`

An entry carries **exactly one of**:
- `cmd` — a single AT string (today's form, unchanged), or
- `steps` — a non-empty array of AT strings, run in order.

```json
{ "id": "example.set-and-commit", "cat": "Bands", "title": "Set SA bands + commit",
  "risk": "nv", "vendor": "quectel", "verified": [],
  "summary": "…", "source": "…", "by": "…",
  "warn": "Writes NV…",
  "params": [ { "name": "bands", "hint": "Colon-separated band numbers", "example": "41:66:71" } ],
  "steps": [
    "AT+QNWPREFCFG=\"nr5g_band\",{{bands}}",
    "AT+QNWPREFCFG=\"nr5g_band\""
  ] }
```

Rules (enforced by `lib-validate.py`):
- **Exactly one** of `cmd` / `steps`. `cmd` is no longer unconditionally required; `steps` (when
  present) must be a non-empty list of non-empty strings.
- **Placeholder coverage** — the union of `{{param}}` placeholders across all steps (or across the
  single `cmd`) must exactly equal the declared `params`. (Same rule as today, generalized to the
  union.)
- **`decode` forbidden when `steps` is present** — allowed only with a single `cmd`. This preserves
  the existing invariant that decode matches the literal `cmd` string. (Also keeps the current
  "decode ⊕ params" rule.)
- **Risk is entry-level and covers the whole sequence** — the single `risk` badge is the highest of
  the steps' risks (author's responsibility; `nv` if any step writes NV). `warn` still required for
  `set`/`nv`. No per-step risk.

## 3. Wire contract — unchanged shape, `cmd` may now contain newlines

The RPC call **keeps its param shape**: `mudimodem.at_console({ cmd, timeout })`. The frontend
assembles the sequence into a single newline-joined `cmd` string:
- Library `steps` entry → `steps.join("\n")` with `{{params}}` substituted.
- Library `cmd` entry / single free-typed line → unchanged.
- Free-typed textarea → its raw multi-line text.

**Why keep `cmd` rather than add a `steps` array param:** it avoids oui array-argument validation
entirely. The validator stays `at_console = { cmd = '.-' }` (`src/validator/mudimodem.lua`). Lua's
`.` matches `\n`, so `'.-'` accepts a multi-line string — **but this MUST be proven over a real
`/rpc` round-trip** (CLAUDE.md §3: our on-device `dofile` tests bypass the validation layer and
cannot catch a `-32602`). See §7.

## 4. Backend — split, run, per-step envelope

`M.at_console` (`src/rpc/mudimodem`) changes:
1. **Split, don't collapse.** Replace `cmd:gsub("[\r\n]+", " ")` with a split on newlines into an
   ordered list of steps; trim each, drop blanks.
2. **Enforce limits.** Max **8** steps; each step ≤ 256 chars (reject with a clear `error`
   otherwise). Empty after split → `cmd required`.
3. **One spawn.** Pass all steps to a single `mudimodem-at.py --envelope` invocation (see §5).
4. **Parse per-step envelopes** and return:

```lua
{ ok = true,
  requested = N,           -- steps sent
  ran       = M,           -- steps that actually executed (M < N ⇒ aborted early)
  aborted   = (M < N),
  steps = {
    { cmd = "AT+…", status = "ok"|"error"|"timeout", response = "…", elapsed_ms = 42 },
    …
  } }
```

Channel-level failures (`busy`, `openfail`) are returned as today: `{ error = "…" }` (no `steps`).
A single typed command yields `steps` of length 1 — today's behavior, just re-shaped. The console
chunk is the **only** caller, so re-shaping the return is safe.

## 5. Transport — `mudimodem-at.py` multi-step envelope

Today `--envelope` runs `ch.send(cmds[0])` and prints one `MM-AT:<status>:<ms>` line + the raw
response. New behavior in envelope mode:

- Run **all** `cmds` in the single held window (flock + `GlModemSleep` unchanged — one quiet window
  for the whole sequence).
- Emit, **per step**:

  ```
  MM-AT:<status>:<ms>:<idx>/<count>
  <raw response for that step, verbatim>
  ```

  where `idx` is 1-based and `count` is the total steps requested.
- **`status` ∈ `ok` | `error` | `timeout`.** This requires `send()` to distinguish the OK
  terminator from the ERROR terminator (today both set `ok=True`). Proposed: `send()` returns a
  terminator kind — `"ok"` (saw `\nOK\r`), `"error"` (saw `\nERROR\r` / `+CME ERROR` / `+CMS
  ERROR`), or `"timeout"` (no terminator within the deadline).
- **Stop-on-error:** after a step whose status is `error` or `timeout`, emit no further headers and
  stop. The backend infers `ran = highest idx emitted`, `aborted = ran < count`.
- **Channel-level failures** (`busy`, `openfail`) are emitted **once** with no `idx` — same lines as
  today (`MM-AT:busy:<ms>` / `MM-AT:openfail:<ms>`), so the backend distinguishes "couldn't open the
  channel at all" from "a step failed".

Framing safety: the `MM-AT:` header only ever appears at column 0 after a newline; AT response lines
start with `+`, `OK`, `ERROR`, or digits — never `MM-AT:` — so the backend can split responses on the
header regex `^MM%-AT:(%w+):(%d+):(%d+)/(%d+)$` without a length prefix.

The human-readable (non-`--envelope`) path already loops over `cmds`; it stays for shell debugging
and gains stop-on-error for parity.

## 6. Frontend — `src/views/mudimodem-console.js`

**Prompt (auto-expand).**
- Default: single-line `<input>`, Enter = send, ArrowUp/Down = history (all preserved for the
  single-line case).
- Shift+Enter, or an input event whose value contains a newline (paste), morphs the control into a
  small auto-growing `<textarea>` (cap ~8 rows). Enter still sends the whole block; Shift+Enter
  inserts a newline. History navigation is disabled while multi-line (the textarea owns Arrow keys).
- On send, the assembled multi-line string is trimmed and blank lines dropped before the RPC call;
  the visible step count feeds the RPC timeout (below).

**Sending.**
- Wire `cmd` = assembled sequence (library `steps` joined, or textarea text). `timeout` stays the
  per-step deadline (`TOOL_T = 8`).
- **RPC timeout = `TOOL_T × nSteps + 10 s`** (was `TOOL_T + 10`), so a legitimate multi-step run
  isn't cut off by the axios deadline.
- Gate unchanged: `set`/`nv` library entries need the "Enable higher-risk commands" checkbox;
  **free-typed always sends**, including multi-line (Kevin's standing call from Phase 3).

**Transcript rendering (per-step).**
- For each returned step: push the `>` command line, then its response lines classified as today
  (`ok`/`err`/`resp`/`urc`).
- If `aborted`, render the remaining `requested − ran` steps as a `note`:
  `skipped — previous step failed`.
- A `timeout` step keeps the existing "no terminator after Ns…" note.

**Library detail.**
- A `steps` entry lists its sequence in the detail card (one line per step). Picking it fills the
  multi-line prompt (params strip still drives `{{param}}` substitution across all steps).

**Decode.** Unchanged — only single-`cmd` entries carry `decode`; it runs over that one command's
response exactly as today.

## 7. Testing

| Layer | Test | Where |
|---|---|---|
| Library schema | `cmd` XOR `steps`; union placeholder coverage; `decode` forbidden with `steps`; non-empty steps | `lib-validate.py` self-tests / a `test/` harness |
| Transport | multi-step envelope framing; `ok`/`error`/`timeout` per step; stop-on-error halts emission; single-command back-compat | local, stubbed fd (Node/Python, dev box) |
| Backend | split-not-collapse; 8-step + 256-char caps; return shape (`requested`/`ran`/`aborted`/`steps`); envelope parse; `busy`/`openfail` still `{error}` | on-device `dofile` under the `ngx` stub (CLAUDE.md §8) |
| Frontend | multi-line assembly + param substitution across steps; textarea morph on newline; per-step transcript; skipped rendering; RPC-timeout scales with step count | `test/chunk.test.js` (eval-the-chunk) |
| **/rpc round-trip** | **send a two-line `cmd`, assert no `-32602` and both steps run** — proves the validator passes newlines (the §3 trap the `dofile` tests can't catch) | `tools/verify.sh` (new step, alongside §9) |

## 8. Files touched

| File | Change |
|---|---|
| `src/at-library/*.json` (schema) | `steps` supported alongside `cmd` (one example entry optional, not required to ship) |
| `tools/lib-validate.py` | `cmd` XOR `steps`; union placeholder coverage; decode-forbidden-on-steps |
| `tools/mudimodem-at.py` | multi-step envelope framing; `send()` returns terminator kind; stop-on-error |
| `src/rpc/mudimodem` (`M.at_console`) | split-not-collapse; step/char caps; per-step envelope parse; new return shape |
| `src/views/mudimodem-console.js` | auto-expand prompt; per-step transcript + skipped rows; RPC timeout scales with step count; `steps` entries in detail card |
| `src/validator/mudimodem.lua` | unchanged (`cmd = '.-'`), but §3 round-trip must confirm it |
| `tools/verify.sh` | new `/rpc` multi-line round-trip assertion |
| `test/chunk.test.js` | multi-step frontend cases |

## 9. Non-goals / YAGNI

- No `continueOnError` — stop-on-error is uniform.
- No per-step risk badges — risk stays entry-level.
- No decode on multi-step entries.
- No conditional / branching sequences (if step N then …) — a linear list only.
- No change to the RPC param *shape* — `cmd` carries newlines rather than a new `steps` array param.
