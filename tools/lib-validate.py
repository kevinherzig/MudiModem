#!/usr/bin/env python3
"""Merge + validate the AT library: src/at-library/*.json -> build/at-library.json

Schema: docs/superpowers/specs/2026-07-18-at-console-library-design.md §3.
Run by tools/build.sh; exits 1 with per-entry messages on any violation, so a
bad community PR can never ship. Python 3 stdlib only; dev-box only (the router
receives the merged, gzipped result)."""
import glob, json, os, re, sys

RISKS = {"read", "set", "nv"}
REQUIRED = ["id", "cat", "title", "cmd", "risk", "vendor", "verified", "summary", "source", "by"]
PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def fail(msgs):
    for m in msgs:
        print("at-library: " + m, file=sys.stderr)
    sys.exit(1)


def validate(entries):
    errs, seen = [], set()
    for e in entries:
        eid = e.get("id", "<missing id>")
        for k in REQUIRED:
            if k not in e:
                errs.append("%s: missing field '%s'" % (eid, k))
        if e.get("risk") not in RISKS:
            errs.append("%s: risk must be one of %s" % (eid, sorted(RISKS)))
        if e.get("risk") in ("set", "nv") and not e.get("warn"):
            errs.append("%s: set/nv entries need a 'warn' stating the consequence" % eid)
        if eid in seen:
            errs.append("%s: duplicate id" % eid)
        seen.add(eid)
        if not isinstance(e.get("verified"), list):
            errs.append("%s: verified must be a list (empty = 'nobody yet')" % eid)
        ph = set(PLACEHOLDER.findall(e.get("cmd", "")))
        pnames = set(p.get("name") for p in e.get("params", []))
        if ph != pnames:
            errs.append("%s: params %s must exactly cover placeholders %s"
                        % (eid, sorted(pnames), sorted(ph)))
        for p in e.get("params", []):
            if not p.get("name") or not p.get("hint"):
                errs.append("%s: every param needs name + hint" % eid)
        d = e.get("decode")
        if d is not None:
            if not d.get("prefix"):
                errs.append("%s: decode needs a prefix" % eid)
            if not d.get("fields"):
                errs.append("%s: decode.fields must be non-empty" % eid)
    return errs


def main():
    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    files = sorted(glob.glob(os.path.join(root, "src", "at-library", "*.json")))
    if not files:
        fail(["no library files in src/at-library/"])
    entries = []
    for path in files:
        with open(path) as f:
            try:
                data = json.load(f)
            except ValueError as e:
                fail(["%s: invalid JSON: %s" % (path, e)])
        if not isinstance(data, list):
            fail(["%s: top level must be a list of entries" % path])
        entries += data
    errs = validate(entries)
    if errs:
        fail(errs)
    entries.sort(key=lambda e: (e["cat"], e["title"]))
    out = os.path.join(root, "build", "at-library.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump({"version": 1, "entries": entries}, f, indent=1)
    print("at-library: %d entries from %d files -> %s" % (len(entries), len(files), out))


if __name__ == "__main__":
    main()
