# External community AT library repo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the community AT library into its own git repo (`kevinherzig/mudi7-at-library`) that governs and publishes it independently; the MudiModem router pulls updates on a **manual** refresh, with an automatic **version check** that surfaces "update available" — while the browser's same-origin library fetch is unchanged.

**Architecture:** New repo owns `at-library/*.json` + `lib-validate.py` + CI that commits a merged, revision-stamped `dist/at-library.json` + tiny `dist/version.json`. Base repo gains a `mudimodem-lib` check/refresh script, two backend methods (`library_status`, `refresh_library`) that spawn it, a version-check UI in the console chunk, and a baked snapshot fallback. The router does all network; the browser stays same-origin, so no CSP fight and offline serves the last-good cache.

**Tech Stack:** CPython stdlib (scripts + validator), GitHub Actions (CI), Lua oui RPC backend, plain-JS Vue 2.6 render-only chunk, Node `node:test`, Python `unittest`, on-device Lua tests over ssh, `curl` for TLS on the box.

## Global Constraints

- **Two repos.** Tasks 1–2 operate in the sibling repo `../mudi7-at-library` (its own git — commits go there). Tasks 3–7 operate in `/Users/kevin/claude/MudiModem` (base repo, branch `main`, commit each task).
- **Repo slug is `kevinherzig/mudi7-at-library`, PUBLIC** (tokenless `raw.githubusercontent.com` fetch). Pinned URL base: `https://raw.githubusercontent.com/kevinherzig/mudi7-at-library/main/dist`.
- **`revision` = first 12 hex of sha256 of the canonical JSON (`sort_keys=True`, `separators=(",",":")`) of the sorted merged `entries`.** Content-derived, no timestamp/git-SHA. Committed `dist/` changes iff content changes.
- Artifact shapes: `dist/at-library.json` = `{version, revision, entries}`; `dist/version.json` = `{revision, count}`.
- **Python stdlib only**; **Vue runtime-only** (`render(h)`, no `template:`, single `module.exports` expression); **never `pcall` an `oui.ubus.call`** (cosocket yields across C) — but `pcall(cjson.decode,…)` is safe and idiomatic here (decode can't yield; already used at `src/rpc/mudimodem:180,598`).
- **No scp** — copy to the box with `ssh root@mudi 'cat > /path' < file`. Deploy is model-guarded on `E5800`.
- **Refresh is manual only** — no cron, no boot hook, no background network.
- Base-repo dev box: Node 20 + Python 3, **no lua** — JS/Python tests run locally; Lua backend tests run on-device via `ssh root@mudi`.
- Commit message bodies end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Stage only the files each task names (explicit `git add`, never `-A`); unrelated working-tree files stay unstaged.
- Spec: `docs/superpowers/specs/2026-07-18-external-at-library-repo-design.md`.

---

## File Structure

**New repo `../mudi7-at-library/`:** `at-library/*.json` (copied from base), `tools/lib-validate.py` (copied + revision/version.json/dist output), `test/lib-validate.test.py` (copied + revision test), `dist/` (CI output), `.github/workflows/validate-publish.yml`, `README.md`, `.gitignore`.

**Base repo `MudiModem/`:**
| File | Task | Responsibility |
|---|---|---|
| `src/at-library.snapshot.json` | 3 | baked fallback (copy of new repo's `dist/at-library.json`) |
| `tools/build.sh` | 3 | gzip the snapshot; stop running lib-validate |
| `tools/mudimodem-lib` | 4 | `check`/`refresh` script (stdlib, curl, model-guarded, atomic) |
| `test/mudimodem-lib.test.py` | 4 | hermetic tests (file:// URLs, temp cache) |
| `src/rpc/mudimodem` | 5 | `library_status` + `refresh_library` methods |
| `test/fake-lib-tool.py`, `test/backend-library.test.lua` | 5 | on-device backend test |
| `src/views/mudimodem-console.js` | 6 | version-check status line + Refresh button |
| `test/console-chunk.test.js` | 6 | frontend tests |
| `tools/deploy.sh`, `tools/verify.sh` | 7 | install/register mudimodem-lib; assertions |
| `src/at-library/*.json`, `tools/lib-validate.py`, `test/lib-validate.test.py` | 7 | REMOVED (now live in the new repo) |

---

# Part A — the new library repo (`../mudi7-at-library`)

## Task 1: Scaffold the repo, move sources, stamp a content revision

**Files (all under `../mudi7-at-library/`):**
- Create dir + `git init`; copy `at-library/*.json`, `tools/lib-validate.py`, `test/lib-validate.test.py` from base
- Modify: `tools/lib-validate.py` (glob path, revision, `version.json`, `dist/` output)
- Create: `README.md`, `.gitignore`
- Test: `test/lib-validate.test.py`

**Interfaces produced:** `dist/at-library.json` = `{version, revision, entries}`, `dist/version.json` = `{revision, count}`; `revision` is deterministic from content. `compute_revision(entries) -> str`.

- [ ] **Step 1: Create the sibling repo and copy the current library in**

```bash
mkdir -p /Users/kevin/claude/mudi7-at-library
cd /Users/kevin/claude/mudi7-at-library
git init -q
mkdir -p at-library tools test dist
cp /Users/kevin/claude/MudiModem/src/at-library/*.json at-library/
cp /Users/kevin/claude/MudiModem/tools/lib-validate.py tools/
cp /Users/kevin/claude/MudiModem/test/lib-validate.test.py test/
```

- [ ] **Step 2: Add a revision test (RED)**

Append to `../mudi7-at-library/test/lib-validate.test.py`:

```python
class RevisionTest(unittest.TestCase):
    def test_stable_and_content_sensitive(self):
        a = [base(cmd="AT+ONE"), base(id="x.z", cmd="AT+TWO")]
        r1 = lv.compute_revision(a)
        r2 = lv.compute_revision(list(a))          # same content, new list
        self.assertEqual(r1, r2, "same content -> same revision")
        self.assertEqual(len(r1), 12)
        b = [base(cmd="AT+ONE"), base(id="x.z", cmd="AT+CHANGED")]
        self.assertNotEqual(r1, lv.compute_revision(b), "content change -> new revision")
```

Run: `cd /Users/kevin/claude/mudi7-at-library && python3 test/lib-validate.test.py -v`
Expected: FAIL — `compute_revision` doesn't exist yet.

- [ ] **Step 3: Extend `tools/lib-validate.py` — content revision + dist output**

In `../mudi7-at-library/tools/lib-validate.py`:

Add `hashlib` to the imports line (`import glob, json, os, re, sys` → add `hashlib`):
```python
import glob, hashlib, json, os, re, sys
```

Add this function above `main()`:
```python
def compute_revision(entries):
    """Deterministic content id: first 12 hex of sha256 of the canonical JSON."""
    canon = json.dumps(entries, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()[:12]
```

In `main()`, change the source glob (the library now lives at `at-library/`, not `src/at-library/`):
```python
    files = sorted(glob.glob(os.path.join(root, "at-library", "*.json")))
```
and replace the output tail (from `entries.sort(...)` to the end of `main()`):
```python
    entries.sort(key=lambda e: (e["cat"], e["title"]))
    revision = compute_revision(entries)
    dist = os.path.join(root, "dist")
    os.makedirs(dist, exist_ok=True)
    with open(os.path.join(dist, "at-library.json"), "w") as f:
        json.dump({"version": 1, "revision": revision, "entries": entries}, f, indent=1)
    with open(os.path.join(dist, "version.json"), "w") as f:
        json.dump({"revision": revision, "count": len(entries)}, f, indent=1)
    print("at-library: %d entries from %d files -> dist/ (rev %s)"
          % (len(entries), len(files), revision))
```

- [ ] **Step 4: Run tests + build the dist (GREEN)**

```bash
cd /Users/kevin/claude/mudi7-at-library
python3 test/lib-validate.test.py -v          # revision + schema tests pass
python3 tools/lib-validate.py                 # builds dist/at-library.json + dist/version.json
python3 -c "import json;d=json.load(open('dist/at-library.json'));assert d['revision'] and d['entries'];print('rev',d['revision'],'count',len(d['entries']))"
```
Expected: tests pass; `dist/` built; revision printed.

- [ ] **Step 5: Add README + .gitignore**

`../mudi7-at-library/.gitignore`:
```
__pycache__/
*.pyc
```

`../mudi7-at-library/README.md`:
```markdown
# mudi7-at-library — community AT command library for MudiModem

JSON snippets of AT commands for the Quectel RG650V-NA (and other modems), consumed by the
**MudiModem** add-on's AT console. Contribute a command by adding an entry to `at-library/<vendor>.json`.

## How it reaches a router
CI validates every PR (`tools/lib-validate.py`). On merge to `main`, CI rebuilds and commits the
merged, validated `dist/at-library.json` + `dist/version.json`. A MudiModem router fetches these on a
**manual** refresh; nothing is pushed to any device automatically.

## ⚠️ Trust boundary
These commands go straight to a cellular modem. **This repo's branch protection + PR review is the
only gate** before a command can appear on someone's router. Nothing auto-runs — the UI fills the
prompt, badges the risk, and a human still confirms — but treat every entry as if it will be run.

## Schema
Each entry: `id, cat, title, risk (read|set|nv), vendor, verified[], summary, source, by`, and either
`cmd` (single) **or** `steps[]` (a sequence), optional `params[]`, optional `decode` (single `cmd`
only). `set`/`nv` entries need a `warn`. `tools/lib-validate.py` is the authority; run it before a PR.
```

- [ ] **Step 6: Commit locally**

```bash
cd /Users/kevin/claude/mudi7-at-library
git add -A
git commit -m "init: community AT library, validated build to dist/ with content revision

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(Remote creation + push is Task 2, Step 3 — gated on Kevin's go-ahead since it publishes a public repo.)

---

## Task 2: CI workflow + publish the repo

**Files:** Create `../mudi7-at-library/.github/workflows/validate-publish.yml`; then create the GitHub remote and push.

- [ ] **Step 1: Add the CI workflow**

`../mudi7-at-library/.github/workflows/validate-publish.yml`:
```yaml
name: validate-publish
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Validate + build library
        run: python3 tools/lib-validate.py
      - name: Commit dist on main if changed
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: |
          if ! git diff --quiet -- dist/; then
            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git add dist/
            rev=$(python3 -c "import json;print(json.load(open('dist/version.json'))['revision'])")
            git commit -m "ci: rebuild dist (rev $rev)"
            git push
          else
            echo "dist unchanged"
          fi
```

- [ ] **Step 2: Sanity-check the workflow locally**

```bash
cd /Users/kevin/claude/mudi7-at-library
python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/validate-publish.yml'));print('yaml ok')" 2>/dev/null \
  || python3 -c "print('note: pyyaml absent; visually verify the YAML')"
python3 tools/lib-validate.py && echo "the exact command CI runs works locally"
git add .github/workflows/validate-publish.yml
git commit -m "ci: validate on PR, commit dist/ on merge to main

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(The auto-commit-on-main loop is self-terminating: revision is content-derived, so the bot's dist commit rebuilds to an identical dist → `git diff --quiet` true → no second commit.)

- [ ] **Step 3: Create the public remote and push — CONFIRM WITH KEVIN FIRST (outward-facing)**

This publishes a public GitHub repo. Only run after Kevin confirms:
```bash
cd /Users/kevin/claude/mudi7-at-library
gh repo create kevinherzig/mudi7-at-library --public --source=. --remote=origin --push
```
Then (optional, recommended) require PR review before merge so the trust boundary holds:
```bash
gh api -X PUT repos/kevinherzig/mudi7-at-library/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F 'enforce_admins=false' -F 'required_status_checks=null' -F 'restrictions=null' 2>/dev/null \
  || echo "note: set branch protection in Settings if the API call is refused"
```
Expected: repo exists at `github.com/kevinherzig/mudi7-at-library`; CI runs green; `dist/` present on main.

---

# Part B — the base-repo consumer (`MudiModem`)

## Task 3: Baked snapshot fallback + build.sh switch

**Files:**
- Create: `src/at-library.snapshot.json`
- Modify: `tools/build.sh`

**Interfaces produced:** `build/at-library.json.gz` now comes from the committed snapshot, independent of `src/at-library/` and `lib-validate.py`.

- [ ] **Step 1: Copy the built library in as the baked snapshot**

```bash
cd /Users/kevin/claude/MudiModem
cp /Users/kevin/claude/mudi7-at-library/dist/at-library.json src/at-library.snapshot.json
python3 -c "import json;d=json.load(open('src/at-library.snapshot.json'));assert d['revision'] and d['entries'];print('snapshot rev',d['revision'])"
```

- [ ] **Step 2: Point build.sh at the snapshot (drop lib-validate)**

In `tools/build.sh`, replace these two lines:
```sh
# Phase 3: merge + validate the AT library, then gzip for gzip_static.
python3 tools/lib-validate.py
gzip -9 -n -c build/at-library.json > build/at-library.json.gz
```
with:
```sh
# The community AT library now lives in ../mudi7-at-library and is refreshed on
# the router at runtime (mudimodem-lib). We ship src/at-library.snapshot.json as
# the baked initial/offline cache; gzip it to the filename the router serves.
gzip -9 -n -c src/at-library.snapshot.json > build/at-library.json.gz
```

- [ ] **Step 3: Verify the build still produces the cache**

Run: `cd /Users/kevin/claude/MudiModem && ./tools/build.sh && python3 -c "import gzip,json;d=json.load(gzip.open('build/at-library.json.gz'));assert d['entries'] and d['revision'];print('gz rev',d['revision'])"`
Expected: build succeeds; the gz parses with entries + revision.

- [ ] **Step 4: Commit**

```bash
git add src/at-library.snapshot.json tools/build.sh
git commit -m "build: ship a baked library snapshot; library sources moved to mudi7-at-library"
```

---

## Task 4: `tools/mudimodem-lib` — check/refresh script

**Files:**
- Create: `tools/mudimodem-lib`
- Test: `test/mudimodem-lib.test.py`

**Interfaces produced:**
- `mudimodem-lib check` → JSON `{local_revision, remote_revision, update_available, checked, error?}`
- `mudimodem-lib refresh` → JSON `{ok, revision, count, error?}`
- Env overrides: `MUDIMODEM_LIB_URL` (base dir URL), `MUDIMODEM_CACHE` (.gz path), `MUDIMODEM_CURL`, `MUDIMODEM_SKIP_MODEL_GUARD=1`.

- [ ] **Step 1: Write the hermetic tests (RED)**

`test/mudimodem-lib.test.py`:
```python
#!/usr/bin/env python3
"""Hermetic tests for tools/mudimodem-lib. No network: a temp dir served via
file:// URLs (curl reads file://), temp cache, model-guard bypassed."""
import gzip, importlib.util, json, os, subprocess, sys, tempfile, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
TOOL = os.path.join(ROOT, "tools", "mudimodem-lib")


def run(mode, url_dir, cache, extra_env=None):
    env = dict(os.environ)
    env["MUDIMODEM_LIB_URL"] = "file://" + url_dir
    env["MUDIMODEM_CACHE"] = cache
    env["MUDIMODEM_SKIP_MODEL_GUARD"] = "1"
    if extra_env:
        env.update(extra_env)
    p = subprocess.run([sys.executable, TOOL, mode], capture_output=True, text=True, env=env)
    return p.returncode, json.loads(p.stdout)


def write_cache(path, revision, n=1):
    with gzip.open(path, "wb") as f:
        f.write(json.dumps({"version": 1, "revision": revision,
                            "entries": [{"id": "x"} for _ in range(n)]}).encode())


def write_remote(url_dir, revision, n=1):
    os.makedirs(url_dir, exist_ok=True)
    with open(os.path.join(url_dir, "version.json"), "w") as f:
        json.dump({"revision": revision, "count": n}, f)
    with open(os.path.join(url_dir, "at-library.json"), "w") as f:
        json.dump({"version": 1, "revision": revision,
                   "entries": [{"id": "e%d" % i} for i in range(n)]}, f)


class LibToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.url = os.path.join(self.tmp, "dist")
        self.cache = os.path.join(self.tmp, "at-library.json.gz")

    def test_check_up_to_date(self):
        write_cache(self.cache, "abc123")
        write_remote(self.url, "abc123")
        rc, r = run("check", self.url, self.cache)
        self.assertTrue(r["checked"]); self.assertFalse(r["update_available"])
        self.assertEqual(r["local_revision"], "abc123")
        self.assertEqual(r["remote_revision"], "abc123")

    def test_check_update_available(self):
        write_cache(self.cache, "old111")
        write_remote(self.url, "new222")
        rc, r = run("check", self.url, self.cache)
        self.assertTrue(r["checked"]); self.assertTrue(r["update_available"])

    def test_check_offline_fail_silent(self):
        write_cache(self.cache, "abc123")           # remote dir absent -> curl fails
        rc, r = run("check", self.url, self.cache)
        self.assertFalse(r["checked"]); self.assertFalse(r["update_available"])
        self.assertIn("error", r); self.assertEqual(r["local_revision"], "abc123")

    def test_check_no_local_cache(self):
        write_remote(self.url, "new222")            # no cache file
        rc, r = run("check", self.url, self.cache)
        self.assertEqual(r["local_revision"], "unknown")
        self.assertTrue(r["update_available"])

    def test_refresh_writes_cache(self):
        write_remote(self.url, "fresh9", n=3)
        rc, r = run("refresh", self.url, self.cache)
        self.assertEqual(rc, 0); self.assertTrue(r["ok"])
        self.assertEqual(r["revision"], "fresh9"); self.assertEqual(r["count"], 3)
        with gzip.open(self.cache) as f:
            self.assertEqual(json.load(f)["revision"], "fresh9")

    def test_refresh_rejects_empty_entries(self):
        os.makedirs(self.url, exist_ok=True)
        with open(os.path.join(self.url, "at-library.json"), "w") as f:
            json.dump({"version": 1, "revision": "x", "entries": []}, f)
        rc, r = run("refresh", self.url, self.cache)
        self.assertNotEqual(rc, 0); self.assertFalse(r["ok"]); self.assertIn("sanity", r["error"])

    def test_refresh_model_guard_refuses(self):
        write_remote(self.url, "fresh9")
        rc, r = run("refresh", self.url, self.cache, extra_env={"MUDIMODEM_SKIP_MODEL_GUARD": "0"})
        # dev box has no /proc/device-tree/model -> not E5800 -> refuse
        self.assertFalse(r["ok"]); self.assertIn("E5800", r["error"])


if __name__ == "__main__":
    unittest.main()
```

Run: `cd /Users/kevin/claude/MudiModem && python3 test/mudimodem-lib.test.py -v`
Expected: FAIL — `tools/mudimodem-lib` doesn't exist.

- [ ] **Step 2: Write the script**

`tools/mudimodem-lib` (make it executable: `chmod +x`):
```python
#!/usr/bin/env python3
"""MudiModem community-library check/refresh. Pulls the library from the external
repo (kevinherzig/mudi7-at-library) to the local cache. MANUAL only — invoked by
the backend (library_status/refresh_library), never by cron.

Modes:
  mudimodem-lib check    -> JSON {local_revision, remote_revision, update_available, checked, error?}
  mudimodem-lib refresh  -> JSON {ok, revision, count, error?}

CPython stdlib only. curl handles TLS (proven on the box; system CA bundle).
Env overrides (tests/forks):
  MUDIMODEM_LIB_URL          base raw dir URL (default = pinned official repo)
  MUDIMODEM_CACHE            cache .gz path (default /www/mudimodem/at-library.json.gz)
  MUDIMODEM_CURL             curl binary (default 'curl')
  MUDIMODEM_SKIP_MODEL_GUARD '1' to bypass the E5800 write guard (tests only)
"""
import gzip, json, os, subprocess, sys, tempfile

DEFAULT_URL = "https://raw.githubusercontent.com/kevinherzig/mudi7-at-library/main/dist"
DEFAULT_CACHE = "/www/mudimodem/at-library.json.gz"
MAX_BYTES = 1 << 20   # 1 MiB sanity cap


def base_url():
    env = os.getenv("MUDIMODEM_LIB_URL")
    if env:
        return env.rstrip("/")
    try:
        with open("/etc/mudimodem/library-url") as f:
            u = f.read().strip()
            if u:
                return u.rstrip("/")
    except OSError:
        pass
    return DEFAULT_URL


def cache_path():
    return os.getenv("MUDIMODEM_CACHE", DEFAULT_CACHE)


def fetch(url, max_time):
    p = subprocess.run([os.getenv("MUDIMODEM_CURL", "curl"), "-fsS",
                        "--max-time", str(max_time), url], capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode(errors="replace").strip() or ("curl exit %d" % p.returncode))
    if len(p.stdout) > MAX_BYTES:
        raise RuntimeError("response too large")
    return p.stdout


def local_revision():
    try:
        with gzip.open(cache_path(), "rb") as f:
            return json.loads(f.read().decode()).get("revision", "unknown")
    except (OSError, ValueError):
        return "unknown"


def is_e5800():
    if os.getenv("MUDIMODEM_SKIP_MODEL_GUARD") == "1":
        return True
    try:
        with open("/proc/device-tree/model") as f:
            return "E5800" in f.read()
    except OSError:
        return False


def cmd_check():
    out = {"local_revision": local_revision(), "remote_revision": None,
           "update_available": False, "checked": False}
    try:
        remote = json.loads(fetch(base_url() + "/version.json", 8).decode()).get("revision")
        out["remote_revision"] = remote
        out["checked"] = True
        out["update_available"] = bool(remote) and remote != out["local_revision"]
    except (RuntimeError, ValueError) as e:
        out["error"] = str(e)
    return out


def cmd_refresh():
    if not is_e5800():
        return {"ok": False, "error": "refusing: not a GL-E5800"}
    try:
        data = json.loads(fetch(base_url() + "/at-library.json", 20).decode())
    except (RuntimeError, ValueError) as e:
        return {"ok": False, "error": "fetch failed: %s" % e}
    if not (isinstance(data, dict) and isinstance(data.get("entries"), list)
            and data["entries"] and data.get("revision")):
        return {"ok": False, "error": "fetched library failed sanity check"}
    path = cache_path()
    d = os.path.dirname(path) or "."
    tmp = None
    try:
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".gz.tmp")
        with os.fdopen(fd, "wb") as f, gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as gz:
            gz.write(json.dumps(data, separators=(",", ":")).encode())
        os.replace(tmp, path)
    except OSError as e:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return {"ok": False, "error": "write failed: %s" % e}
    return {"ok": True, "revision": data["revision"], "count": len(data["entries"])}


def main(argv):
    mode = argv[0] if argv else ""
    if mode == "check":
        print(json.dumps(cmd_check()))
        return 0
    if mode == "refresh":
        r = cmd_refresh()
        print(json.dumps(r))
        return 0 if r.get("ok") else 1
    print(json.dumps({"error": "usage: mudimodem-lib check|refresh"}))
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 3: Run the tests (GREEN)**

```bash
cd /Users/kevin/claude/MudiModem && chmod +x tools/mudimodem-lib && python3 test/mudimodem-lib.test.py -v
```
Expected: all pass. (If `curl` isn't on the dev box, install it — the box has it; the test needs `curl` with `file://` support, which system curl has.)

- [ ] **Step 4: Commit**

```bash
git add tools/mudimodem-lib test/mudimodem-lib.test.py
git commit -m "feat(lib): mudimodem-lib check/refresh — pull library from the external repo"
```

---

## Task 5: Backend methods `library_status` + `refresh_library`

**Files:**
- Modify: `src/rpc/mudimodem`
- Test: `test/fake-lib-tool.py`, `test/backend-library.test.lua`

**Interfaces:** consumes `mudimodem-lib` (spawned); produces `M.library_status()` → the `check` JSON as a table, `M.refresh_library()` → the `refresh` JSON as a table, or `{error}` on spawn/parse failure.

- [ ] **Step 1: Fake tool + on-device backend test (RED)**

`test/fake-lib-tool.py`:
```python
#!/usr/bin/env python3
"""Stands in for mudimodem-lib in backend tests: prints canned JSON per mode.
  check         -> a check envelope with update_available true
  refresh       -> an ok refresh envelope
  __GARBAGE__…  -> (any other first arg) non-JSON, to test the parse-fail path
"""
import json, sys
mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode == "check":
    print(json.dumps({"local_revision": "old111", "remote_revision": "new222",
                      "update_available": True, "checked": True}))
elif mode == "refresh":
    print(json.dumps({"ok": True, "revision": "new222", "count": 7}))
else:
    print("not json")
```

`test/backend-library.test.lua`:
```lua
-- On-device test for mudimodem.library_status / refresh_library. Runs the real
-- plugin against a FAKE lib tool (no network). Env: MM_PLUGIN, MUDIMODEM_LIB_TOOL.
package.loaded["oui.ubus"] = { call = function() error("must not touch ubus") end }

local M = dofile(os.getenv("MM_PLUGIN") or "/usr/lib/oui-httpd/rpc/mudimodem")
assert(type(M.library_status) == "function", "library_status missing")
assert(type(M.refresh_library) == "function", "refresh_library missing")

local s = M.library_status({})
assert(s.checked == true and s.update_available == true, "status must pass the check JSON through")
assert(s.local_revision == "old111" and s.remote_revision == "new222", "revisions passed through")

local r = M.refresh_library({})
assert(r.ok == true and r.revision == "new222" and r.count == 7, "refresh JSON passed through")

print("library backend OK")
```

Run on-device (RED — methods don't exist yet):
```bash
cd /Users/kevin/claude/MudiModem
ssh root@mudi 'cat > /tmp/mm.lua'   < src/rpc/mudimodem
ssh root@mudi 'cat > /tmp/flib.py'  < test/fake-lib-tool.py
ssh root@mudi 'cat > /tmp/lt.lua'   < test/backend-library.test.lua
ssh root@mudi 'MM_PLUGIN=/tmp/mm.lua MUDIMODEM_LIB_TOOL=/tmp/flib.py lua /tmp/lt.lua'
```
Expected: FAIL (`library_status missing`). If `ssh root@mudi` is unreachable, STOP and report BLOCKED.

- [ ] **Step 2: Add the methods to `src/rpc/mudimodem`**

Near the other tool constant (`local AT_TOOL = …`, ~line 757) add:
```lua
local LIB_TOOL = os.getenv("MUDIMODEM_LIB_TOOL") or "/usr/lib/mudimodem/mudimodem-lib"

local function run_lib(mode)
  local q = "'" .. LIB_TOOL:gsub("'", "'\\''") .. "'"
  local f = io.popen("python3 " .. q .. " " .. mode .. " 2>/dev/null")
  if not f then return { error = "failed to spawn the library tool" } end
  local out = f:read("*a") or ""
  f:close()
  local ok, obj = pcall(cjson.decode, out)   -- cjson.decode can't yield; pcall is safe (§8)
  if not ok or type(obj) ~= "table" then
    return { error = "library tool returned no JSON" }
  end
  return obj
end
```
Then, just before the final `return M`, add:
```lua
function M.library_status(args)
  return run_lib("check")
end

function M.refresh_library(args)
  return run_lib("refresh")
end
```
(`mode` is a fixed literal — no injection. Neither method touches ubus, so no cosocket concern.)

- [ ] **Step 3: Run the backend test on-device (GREEN)**

```bash
ssh root@mudi 'cat > /tmp/mm.lua'  < src/rpc/mudimodem
ssh root@mudi 'cat > /tmp/flib.py' < test/fake-lib-tool.py
ssh root@mudi 'cat > /tmp/lt.lua'  < test/backend-library.test.lua
ssh root@mudi 'MM_PLUGIN=/tmp/mm.lua MUDIMODEM_LIB_TOOL=/tmp/flib.py lua /tmp/lt.lua; rc=$?; rm -f /tmp/mm.lua /tmp/flib.py /tmp/lt.lua; exit $rc'
```
Expected: `library backend OK`.

- [ ] **Step 4: Commit**

```bash
git add src/rpc/mudimodem test/fake-lib-tool.py test/backend-library.test.lua
git commit -m "feat(backend): library_status + refresh_library spawn mudimodem-lib"
```

---

## Task 6: Frontend version-check UI

**Files:**
- Modify: `src/views/mudimodem-console.js` (`data`, `created`, `methods`, `render`, `injectStyle`)
- Test: `test/console-chunk.test.js`

**Interfaces:** consumes `library_status` / `refresh_library` return shapes (Task 5). Produces `checkLibraryStatus()`, `refreshLibrary()`, `libStatus`/`refreshing`/`refreshMsg` state, and a rail status line.

- [ ] **Step 1: Write the failing tests (RED)**

Add to `test/console-chunk.test.js`:
```javascript
test('checkLibraryStatus stores the status; render shows "Update available" + button', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.resolve(
      { checked: true, update_available: true, local_revision: 'old111', remote_revision: 'new222' }) };
    return vm.checkLibraryStatus().then(() => {
      assert.ok(vm.libStatus && vm.libStatus.update_available);
      const txt = textOf(c.render.call(vm, h));
      assert.match(txt, /Update available/);
      assert.match(txt, /Refresh now/);
    });
  } finally { global.window = saved; }
});

test('render shows "Up to date · rev" when checked and current', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.libStatus = { checked: true, update_available: false, local_revision: 'abc123' };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /Up to date/);
  assert.match(txt, /abc123/);
  assert.doesNotMatch(txt, /Refresh now/);
});

test('render shows only the local rev when the check did not complete (offline)', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  vm.libStatus = { checked: false, update_available: false, local_revision: 'abc123' };
  const txt = textOf(c.render.call(vm, h));
  assert.match(txt, /rev abc123/);
  assert.doesNotMatch(txt, /Update available/);
});

test('refreshLibrary success re-fetches the library and re-checks', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  let libFetches = 0, statusCalls = 0;
  const saved = global.window;
  try {
    global.window = {
      $axios: { get: () => { libFetches++; return Promise.resolve({ data: { entries: [] } }); } },
      $rpcRequest: (_m, p) => {
        if (p[2] === 'refresh_library') return Promise.resolve({ ok: true, revision: 'new222', count: 7 });
        if (p[2] === 'library_status') { statusCalls++; return Promise.resolve({ checked: true, update_available: false, local_revision: 'new222' }); }
        return Promise.resolve({});
      }
    };
    return vm.refreshLibrary().then(() => {
      assert.strictEqual(vm.refreshing, false);
      assert.ok(libFetches >= 1, 'library re-fetched after refresh');
      assert.ok(statusCalls >= 1, 're-checked status after refresh');
    });
  } finally { global.window = saved; }
});

test('checkLibraryStatus is fail-silent (rejection -> null, no throw)', () => {
  const c = loadChunk();
  const vm = makeVm(c, {});
  const saved = global.window;
  try {
    global.window = { $rpcRequest: () => Promise.reject({ type: 'timeout' }) };
    return vm.checkLibraryStatus().then(() => {
      assert.strictEqual(vm.libStatus, null);
      assert.doesNotThrow(() => c.render.call(vm, h));
    });
  } finally { global.window = saved; }
});
```

Run: `node --test test/console-chunk.test.js`
Expected: FAIL — `checkLibraryStatus`/`refreshLibrary` undefined.

- [ ] **Step 2: Add state + methods**

In `data()` (after `decodeSrc: ""`, add a comma to the prior line):
```javascript
      decodeSrc: "",
      libStatus: null,        // {local_revision, remote_revision, update_available, checked}
      refreshing: false,
      refreshMsg: ""
```

In `created()`, after `this.fetchLib();`:
```javascript
    this.checkLibraryStatus();
```

Add to `methods`:
```javascript
    checkLibraryStatus() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return Promise.resolve();
      return window.$rpcRequest("call", ["sid", "mudimodem", "library_status", {}], { timeout: 12000 })
        .then(function (r) { self.libStatus = r || null; })
        .catch(function () { self.libStatus = null; });   // fail-silent
    },
    refreshLibrary() {
      var self = this;
      if (this.refreshing || typeof window === "undefined" || !window.$rpcRequest) return Promise.resolve();
      this.refreshing = true; this.refreshMsg = "";
      return window.$rpcRequest("call", ["sid", "mudimodem", "refresh_library", {}], { timeout: 30000 })
        .then(function (r) {
          self.refreshing = false;
          if (r && r.ok) {
            self.refreshMsg = "updated — rev " + (r.revision || "");
            self.fetchLib();
            return self.checkLibraryStatus();
          }
          self.refreshMsg = (r && r.error) || "refresh failed";
        })
        .catch(function (e) {
          self.refreshing = false;
          self.refreshMsg = (e && (e.message || e.type)) || "refresh failed";
        });
    },
```

- [ ] **Step 3: Render the status line in the library rail**

In `render(h)`, the `libKids` array starts with the header `mmc-row` and the search `input`. Insert a status row **between** them — after the `h("div", { staticClass: "mmc-row" }, [...])` header block and before the search `h("input", …)`, add:
```javascript
      (function () {
        var st = self.libStatus, kids = [];
        if (st) {
          var rev = st.local_revision || "unknown";
          if (st.checked && st.update_available) {
            kids.push(h("span", { staticClass: "mmc-libupd" }, "Update available"));
            kids.push(h("button", {
              staticClass: "mmc-refresh",
              attrs: { disabled: self.refreshing },
              on: { click: function () { self.refreshLibrary(); } }
            }, self.refreshing ? "Refreshing…" : "Refresh now"));
          } else if (st.checked) {
            kids.push(h("span", { staticClass: "mmc-hint" }, "Up to date · rev " + rev));
          } else {
            kids.push(h("span", { staticClass: "mmc-hint" }, "rev " + rev));
          }
        }
        if (self.refreshMsg) kids.push(h("span", { staticClass: "mmc-hint" }, self.refreshMsg));
        return kids.length ? h("div", { staticClass: "mmc-librow" }, kids) : null;
      })(),
```
(The `libKids` array already tolerates entries; if a `null` slips in, guard it — wrap the array literal's use so nulls are filtered. If `libKids` is passed directly to `h("div", …, libKids)`, change that call to `libKids.filter(Boolean)`.)

- [ ] **Step 4: Add CSS**

In `injectStyle`, add to the `css` string (before the `@media(prefers-reduced-motion…)` rule):
```javascript
        '.mmc-librow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:11.5px}' +
        '.mmc-libupd{font-weight:600;color:var(--primary)}' +
        '.mmc-refresh{font-size:11px;font-weight:600;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:3px;padding:3px 9px;cursor:pointer;font-family:inherit}' +
        '.mmc-refresh:disabled{opacity:.5;cursor:default}' +
```

- [ ] **Step 5: Run the tests (GREEN)**

Run: `node --test test/console-chunk.test.js`
Expected: new tests + all pre-existing pass, output pristine.

- [ ] **Step 6: Commit**

```bash
git add src/views/mudimodem-console.js test/console-chunk.test.js
git commit -m "feat(console): library version-check status line + manual Refresh"
```

---

## Task 7: Remove moved files; deploy + verify

**Files:**
- Remove: `src/at-library/` (dir), `tools/lib-validate.py`, `test/lib-validate.test.py`
- Modify: `tools/deploy.sh`, `tools/verify.sh`

- [ ] **Step 1: Remove the files that moved to the new repo**

```bash
cd /Users/kevin/claude/MudiModem
git rm -r src/at-library
git rm tools/lib-validate.py test/lib-validate.test.py
```

- [ ] **Step 2: Confirm the base build + suites are still green without them**

```bash
./tools/build.sh   # uses the snapshot now (Task 3) — must still produce at-library.json.gz
node --test test/console-chunk.test.js
python3 test/mudimodem-lib.test.py -v
```
Expected: build succeeds; JS + lib-tool suites pass. (Nothing references the removed files.)

- [ ] **Step 3: Install + register `mudimodem-lib` in deploy.sh**

In `tools/deploy.sh`, after the block that installs the AT tool (the `.../mudimodem-at.py` line ~35-36), add:
```sh
ssh -o BatchMode=yes "root@$HOST" 'mkdir -p /usr/lib/mudimodem && cat > /usr/lib/mudimodem/mudimodem-lib && chmod 0755 /usr/lib/mudimodem/mudimodem-lib' \
  < tools/mudimodem-lib
echo "library check/refresh tool deployed"
```
And add `/usr/lib/mudimodem/mudimodem-lib` to the `sysupgrade.conf` file list (the `for p in \ … ; do` block, ~line 84-96):
```sh
  /usr/lib/mudimodem/mudimodem-lib \
```

- [ ] **Step 4: Extend verify.sh**

In `tools/verify.sh`, after the existing step 8 block, add:
```sh
echo "8f. library check/refresh tool installed + backend methods present"
ssh -o BatchMode=yes "root@$HOST" 'test -x /usr/lib/mudimodem/mudimodem-lib' \
  || fail "mudimodem-lib not installed (run ./tools/deploy.sh)"
# `check` must always return valid JSON, even when the remote repo/dist is absent
# (fail-silent -> checked:false). Tolerant: we only assert it emits parseable JSON.
ssh -o BatchMode=yes "root@$HOST" 'python3 /usr/lib/mudimodem/mudimodem-lib check | python3 -c "import json,sys;d=json.load(sys.stdin);assert \"local_revision\" in d and \"checked\" in d"' \
  || fail "mudimodem-lib check did not emit a valid status envelope"
# Backend exposes both methods (dofile under the ngx stub is overkill here; grep the source is enough).
ssh -o BatchMode=yes "root@$HOST" 'grep -q "function M.library_status" /usr/lib/oui-httpd/rpc/mudimodem && grep -q "function M.refresh_library" /usr/lib/oui-httpd/rpc/mudimodem' \
  || fail "backend missing library_status/refresh_library"
```

- [ ] **Step 5: Deploy + run verify against the box**

```bash
./tools/deploy.sh
./tools/verify.sh
```
Expected: deploy succeeds; verify ends `ALL CHECKS PASSED`, including `8f`. (`8f`'s `check` returns `checked:false` until the public repo + dist exist — that's expected and the assertion tolerates it.)

- [ ] **Step 6: Commit**

```bash
git add tools/deploy.sh tools/verify.sh
git commit -m "chore: install+register mudimodem-lib; drop moved library sources; verify.sh 8f"
```

---

## Self-Review Notes

- **Spec coverage:** §2 two-repo split → Tasks 1–2 + base cleanup Task 7; §3 content revision → Task 1; §4 check/refresh script → Task 4; §5 backend methods → Task 5; §6 version-check UI → Task 6; §7 fallback snapshot → Task 3; §8 base cleanup + build/deploy/verify → Tasks 3/7; §9 security (https, pin, size cap, sanity, atomic, model-guard, data-only) → Task 4 script + Task 5 methods.
- **Type consistency:** `mudimodem-lib check`/`refresh` JSON shapes (Task 4) are consumed byte-for-byte by the backend `run_lib` (Task 5) and the frontend `libStatus`/`refreshLibrary` (Task 6); `revision` field name is identical across `lib-validate.py` (Task 1), the snapshot (Task 3), the script's sanity check (Task 4), and the UI (Task 6).
- **Base stays green throughout:** Task 3 switches build.sh to the snapshot *before* Task 7 removes `src/at-library`/`lib-validate.py`, so no intermediate task has a broken build.
- **Cross-repo execution note:** Tasks 1–2 commit to `../mudi7-at-library` (separate git); review those by diffing that repo, not the base. Task 2 Step 3 (public repo creation) is outward-facing — gate on Kevin.
- **Live-verify gaps:** Task 5's backend test and Task 7's verify run on-device (need `ssh root@mudi`); `8f`'s remote check is `checked:false` until the public repo exists. A true end-to-end refresh (router pulls real `dist/`) is only exercisable after Task 2 Step 3 publishes the repo.
