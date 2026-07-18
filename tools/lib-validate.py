#!/usr/bin/env python3
"""Merge + validate the AT library: src/at-library/*.json -> build/at-library.json

Schema: docs/superpowers/specs/2026-07-18-at-console-library-design.md §3.
Run by tools/build.sh; exits 1 with per-entry messages on any violation, so a
bad community PR can never ship. Python 3 stdlib only; dev-box only (the router
receives the merged, gzipped result)."""
import glob, json, os, re, sys

RISKS = {"read", "set", "nv"}
REQUIRED = ["id", "cat", "title", "cmd", "risk", "vendor", "verified", "summary", "source", "by"]
# Required fields that must be non-empty strings. `risk` is covered by the RISKS
# check and `verified` by its list check, so they're excluded to avoid double
# messages; the rest — including the sort keys `cat`/`title` — must be strings or
# the sort in main() would raise a raw TypeError instead of a clean per-entry msg.
STR_REQUIRED = ["id", "cat", "title", "cmd", "vendor", "summary", "source", "by"]
PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def fail(msgs):
    for m in msgs:
        print("at-library: " + m, file=sys.stderr)
    sys.exit(1)


def validate(entries):
    errs, seen = [], set()
    for e in entries:
        rawid = e.get("id")
        eid = rawid if isinstance(rawid, str) and rawid else "<missing id>"
        for k in REQUIRED:
            if k not in e:
                errs.append("%s: missing field '%s'" % (eid, k))
        # Present-but-wrong-type string fields: caught here with a clean message
        # rather than as a raw TypeError at the sort (a null `cat`/`title` would
        # otherwise blow up main()'s sort key).
        for k in STR_REQUIRED:
            if k in e and not (isinstance(e[k], str) and e[k]):
                errs.append("%s: field '%s' must be a non-empty string" % (eid, k))
        if e.get("risk") not in RISKS:
            errs.append("%s: risk must be one of %s" % (eid, sorted(RISKS)))
        if e.get("risk") in ("set", "nv") and not e.get("warn"):
            errs.append("%s: set/nv entries need a 'warn' stating the consequence" % eid)
        # Duplicate-id only means anything for entries that HAVE a usable id;
        # otherwise every missing-id entry collapses to one sentinel and trips a
        # spurious duplicate on top of its own "missing field 'id'".
        if isinstance(rawid, str) and rawid:
            if rawid in seen:
                errs.append("%s: duplicate id" % eid)
            seen.add(rawid)
        if not isinstance(e.get("verified"), list):
            errs.append("%s: verified must be a list (empty = 'nobody yet')" % eid)
        cmd = e.get("cmd")
        ph = set(PLACEHOLDER.findall(cmd if isinstance(cmd, str) else ""))
        pnames = set(p.get("name") for p in e.get("params", []))
        if ph != pnames:
            errs.append("%s: params %s must exactly cover placeholders %s"
                        % (eid, sorted(n for n in pnames if n), sorted(ph)))
        for p in e.get("params", []):
            if not p.get("name") or not p.get("hint"):
                errs.append("%s: every param needs name + hint" % eid)
        # A parameterized entry can't also decode: the chunk matches decode by the
        # literal `cmd` string, but the SENT command has {{params}} substituted, so
        # it never matches the template — decode would silently no-op.
        if e.get("decode") and e.get("params"):
            errs.append("%s: an entry cannot have both params and decode "
                        "(the substituted command never matches the template, so decode would silently no-op)" % eid)
        d = e.get("decode")
        if d is not None:
            if not (isinstance(d.get("prefix"), str) and d.get("prefix")):
                errs.append("%s: decode.prefix must be a non-empty string" % eid)
            if not (isinstance(d.get("fields"), list) and d.get("fields")):
                errs.append("%s: decode.fields must be a non-empty list" % eid)
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
