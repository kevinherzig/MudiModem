# The MudiModem AT command library

Community-contributed AT snippets, shipped on the router and rendered by the
AT-console tab. Pure data — you can contribute without writing a line of JS.
Send a PR adding/editing entries in `<vendor>.json` here; `tools/lib-validate.py`
(run by every build) enforces this schema.

## Entry schema

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique, `vendor.slug` |
| `cat` | yes | grouping shown in the rail (Diagnostics, Bands, Cell lock, Power, …) |
| `title` | yes | short human title |
| `cmd` | yes | the AT command; `{{name}}` placeholders for parameters |
| `risk` | yes | `read` (query only) · `set` (runtime state, gone on reboot) · `nv` (writes NV — survives reboot, reflash AND factory reset) |
| `warn` | for set/nv | the concrete consequence, plainly stated |
| `vendor` | yes | `quectel`, `any`, … — AT is vendor- and firmware-specific |
| `verified` | yes | list of module names this was confirmed on. `[]` renders as "nobody yet" — entries are never hidden for being unverified, but never pretend either |
| `summary` | yes | one or two plain-language sentences |
| `source` | yes | where this knowledge comes from (manual §, box capture, forum post) |
| `by` | yes | contributor handle |
| `params` | iff `cmd` has `{{…}}` | `[{name, hint, example?, values?}]` — drives the fill-in form; `values` renders a dropdown |
| `decode` | optional | `{prefix, fields, hi?, enums?}` — response lines starting with `prefix` are split (quote-aware) and labelled with `fields`; `hi` names get highlighted; `enums` maps raw values to labels (a raw `2` can mean `15 MHz` — never show an enum raw) |

## House rules

- Nothing ever auto-runs; entries only fill the console prompt.
- `risk` maps to real consequences, not vibes. When in doubt, rate it higher.
- No entry for commands that are actions disguised as queries (`restore_band`)
  or whose argument mapping is unverified and dangerous (`QPRTPARA`).
- If you verified an entry on your module, add the module name to `verified`
  in a PR — that's the whole review process.
