# Community AT library in a separate, runtime-delivered repo — design

*2026-07-18. Brainstormed with Kevin; approved section by section. Moves the community AT command
library out of the MudiModem base repo into its own git repo so it can be contributed to and
delivered to the router independently of the add-on's code — updated on the box by a manual refresh,
with an automatic online version check that surfaces when an update is available.*

## 0. Motivation

Today the library lives in-repo (`src/at-library/<vendor>.json`), is merged + validated at build
time by `tools/lib-validate.py`, gzipped to `/www/mudimodem/at-library.json.gz`, and fetched
same-origin by the console chunk. A new command therefore requires editing the add-on repo and a
full redeploy. Kevin wants the library to be a **separately-governed, separately-delivered**
artifact: its own repo/PRs, and updates that reach the box without redeploying MudiModem.

## 1. Decisions made with Kevin

| Decision | Choice |
|---|---|
| Independence | **Delivery, not just contribution** — updates reach the router without redeploying the add-on |
| Fetch path | **Router does the network; browser stays same-origin.** The chunk keeps `GET /mudimodem/at-library.json`; the router pulls from the repo. No admin-UI CSP fight, offline serves the last-good cache |
| Publish target | **`raw.githubusercontent.com/kevinherzig/mudi7-at-library/main/dist/at-library.json`** — CI validates on PR and commits the merged `dist/` artifact on merge to main |
| Refresh | **Always manual** — no cron, no on-boot pull, no unattended curls on a cellular link |
| Version check | **Automatic on library-tab load, fail-silent** — a tiny `dist/version.json` compared to the local cache; shows "update available" without the admin acting |
| Fallback | Base repo ships a **baked snapshot** as the initial/offline cache; the manual refresh overwrites it |

📌 **Repo slug: `kevinherzig/mudi7-at-library`** (decided 2026-07-18; `gh` installed on the dev box,
pending `gh auth login`). The repo must be **public** so the router can `curl` `raw.githubusercontent.com`
without a token. The slug appears as the pinned URL constant in the refresh script and in CI.

## 2. Two repos, one artifact contract

**New repo** (sibling of the base repo, mirroring `../MudiUI`): `../mudi7-at-library/`
```
at-library/<vendor>.json          ← the sources (moved verbatim from MudiModem/src/at-library/)
tools/lib-validate.py             ← moved here; the CI gate (extended to stamp a revision, §3)
test/lib-validate.test.py         ← moved here
dist/at-library.json              ← CI-built + committed on merge to main (the router's full fetch)
dist/version.json                 ← CI-built tiny marker: {revision, updated, count} (the check)
.github/workflows/validate-publish.yml
README.md                         ← schema + contribution guide + the trust note (§6)
```
- **PR CI:** run `lib-validate.py`; a violation blocks merge. This is the human gate that replaces
  "a maintainer redeploys."
- **Merge-to-main CI:** rebuild `dist/at-library.json` + `dist/version.json` (stamped with the
  revision) and commit them back to main.

**Base repo** (`MudiModem`) loses the sources and the library build; gains the refresh/check script,
two backend methods, the version-check UI, and a baked fallback.

## 3. The revision — content identity, not a hand-bumped number

CI derives a **content-based `revision`** = first 12 hex chars of the sha256 of the canonical JSON
(`sort_keys=True`, compact separators) of the merged, sorted `entries`. `lib-validate.py` (in the
new repo) is extended to:
- compute `revision` deterministically from the built entries (same content ⇒ same revision),
- write it as a top-level `revision` field in `dist/at-library.json` (alongside `version`, `entries`),
- emit `dist/version.json` = `{ "revision": <str>, "count": <n> }`.

"Update available" ≡ `remote.revision != local.revision`. A **content hash — not a git SHA or a
timestamp** — means a docs-only or no-op commit never triggers a spurious "update available", and the
committed `dist/` files change iff the library content changes. CI therefore commits `dist/` only when
`git status` shows a diff, and the artifacts carry no wall-clock field.

## 4. Router refresh/check script (base repo)

New `tools/mudimodem-lib` (CPython stdlib, deployed to `/usr/lib/mudimodem/mudimodem-lib`), two modes:

- **`mudimodem-lib check`** → prints JSON `{ local_revision, remote_revision, update_available,
  checked, error? }`.
  1. Local revision: `gunzip -c /www/mudimodem/at-library.json.gz` → parse → `.revision`
     (`"unknown"` if absent). The cache is the single source of truth — no separate rev file.
  2. Remote revision: `curl -fsS --max-time 8` the pinned **https** `dist/version.json`, parse
     `.revision`. Any failure → `checked:false`, `error` set, `update_available:false` (fail-silent).
- **`mudimodem-lib refresh`** → prints JSON `{ ok, revision, count, error? }`.
  1. `curl -fsS --max-time 20` the pinned `dist/at-library.json` (size cap, e.g. reject > 1 MiB).
  2. Sanity-check: valid JSON, top-level `{version, entries:[…]}`, `entries` non-empty, has a
     `revision`. (Full schema validation already happened in CI; the router only guards against
     replacing a good cache with garbage/empty/truncated.)
  3. **Atomically** gzip to `/www/mudimodem/at-library.json.gz` (write temp in the same dir, `mv`).
     On any failure the existing cache is left untouched.

Both modes:
- **Model-guard on E5800** (`/proc/device-tree/model`) before writing — never the AXT1800 trap.
- Read the URL base from `/etc/mudimodem/library-url` if present, else a hardcoded default constant
  (the official repo). One base → both `dist/at-library.json` and `dist/version.json` derived from it.

## 5. Backend methods (base repo, `src/rpc/mudimodem`)

Two methods, admin-only, each **spawns `mudimodem-lib`** and returns its parsed JSON (mirrors how
`at_console` spawns `mudimodem-at.py`). Neither takes free-form input, so **no validator entry is
needed** (they carry no string params).

| Method | Backing | Returns |
|---|---|---|
| `library_status` | `mudimodem-lib check` | `{ local_revision, remote_revision, update_available, checked, error? }` |
| `refresh_library` | `mudimodem-lib refresh` | `{ ok, revision, count, error? }` |

- Neither touches ubus → no cosocket/`pcall` concern.
- The Lua parses the script's stdout JSON with `cjson` and returns it as a table (or `{error}` on a
  spawn/parse failure).

## 6. Frontend version-check UI (base repo, `src/views/mudimodem-console.js`)

The library rail gains a status line and a refresh control:
- On tab load, after `fetchLib()`, call `library_status` once (fail-silent). Store
  `{ localRev, remoteRev, updateAvailable, checked }`.
- Render:
  - checked + up to date → `Library up to date · rev abc1234`
  - checked + update → `Update available — [Refresh now]`
  - not checked (offline/err) → `rev abc1234` only (no error noise)
- **[Refresh now]** → `refresh_library`; while pending show `Refreshing…`; on success re-run
  `fetchLib()` and re-check; on failure show a one-line inline error. The button is the ONLY thing
  that pulls.
- The library-fetch path itself (`GET /mudimodem/at-library.json`) is **unchanged** — same-origin,
  gzip_static, axios.

## 7. First-install / offline fallback (base repo)

- The base repo commits a baked snapshot `src/at-library.snapshot.json` (a copy of the latest built
  `dist/at-library.json`, revision field included).
- `tools/build.sh` **stops** running `lib-validate.py` / merging per-vendor files, and instead gzips
  the snapshot → `build/at-library.json.gz`. `tools/deploy.sh` installs it as the initial cache.
- ⇒ a fresh install, or a box never online since install, always has a working, revision-tagged
  library; `library_status` shows its rev, and the first successful manual refresh replaces it.
- The snapshot is refreshed occasionally by copying the new repo's `dist/at-library.json` — a
  low-frequency, deliberate act, not a build-time network dependency.

## 8. Base-repo cleanup

- **Delete** `src/at-library/*.json`; **move** `tools/lib-validate.py` + `test/lib-validate.test.py`
  to the new repo (they leave the base repo).
- `tools/build.sh`: drop the lib-validate + merge step; gzip the snapshot instead (§7).
- `tools/verify.sh`: keep `8a` (cache exists + parses; now baked-or-refreshed). Add: `mudimodem-lib`
  installed and `check` returns valid JSON (tolerant of `checked:false` when the remote/repo doesn't
  exist yet); `library_status` + `refresh_library` present in the backend (`dofile`). The `9`/console
  checks are unaffected (same-origin fetch unchanged).
- CLAUDE.md §5/§7a/§11/§12 updated to describe the split (doc-only; committed when Kevin asks).

## 9. Security / trust

- **https-only, host + path pinned**, `--max-time`, size cap, JSON sanity, atomic replace.
- Nothing auto-runs — the library is still **data-only, risk-badged, gated**; the same trust model as
  today's unauthenticated served library.
- The genuinely new exposure: updates arrive without a human redeploying. The **trust boundary is the
  new repo's branch protection + PR CI validation** — stated loudly in both READMEs. A compromised
  or mis-merged library can only mislead a human into running a risky AT command they still have to
  confirm; it cannot execute anything on its own.

## 10. Files

**New repo `../mudi7-at-library/`** (scaffolded locally; Kevin creates the remote + pushes):
`at-library/*.json` (moved), `tools/lib-validate.py` (moved + revision stamping), `test/lib-validate.test.py` (moved), `dist/.gitkeep`, `.github/workflows/validate-publish.yml`, `README.md`.

**Base repo `MudiModem/`:**
| File | Change |
|---|---|
| `tools/mudimodem-lib` | NEW — `check`/`refresh` script (stdlib, model-guarded, atomic) |
| `src/rpc/mudimodem` | NEW methods `library_status`, `refresh_library` |
| `src/views/mudimodem-console.js` | version-check status line + Refresh button |
| `src/at-library.snapshot.json` | NEW — baked fallback (was `src/at-library/*.json`) |
| `tools/build.sh` | gzip the snapshot, drop lib-validate/merge |
| `tools/verify.sh` | refresh-script + new-method assertions |
| `src/at-library/*.json`, `tools/lib-validate.py`, `test/lib-validate.test.py` | REMOVED (moved out) |
| `test/mudimodem-lib.test.py`, `test/console-chunk.test.js`, `test/backend-*.test.lua` | tests for the above |

## 11. Non-goals / YAGNI

- No cron / on-boot / background refresh — manual only.
- No browser-direct cross-origin fetch (router mediates; avoids CSP + keeps offline behavior).
- No signature/GPG verification of the artifact — https + pinned host + CI branch protection is the
  boundary (revisit only if the threat model changes).
- No per-SIM / per-firmware library selection — out of scope.
- No auto-apply of any command — the version check surfaces a message; a human still clicks Refresh
  and still clicks Send.
