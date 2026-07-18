# Quectel AT reference — as it actually behaves on *this* box

**Purpose:** the AT knowledge MudiModem depends on, in one place, with device-verified evidence.
Written 2026-07-17.

## Provenance — read this before trusting anything below

Two sources, and they are **not** equally authoritative:

| Mark | Meaning |
|---|---|
| 🟢 **VERIFIED** | Captured from **this box** (`RG650V-NA`, fw `RG650VNA01ACR02A04G8G`) this session. Authoritative. |
| 📘 **MANUAL** | From `docs/Quectel_RG50xQ&RM5xxQ_Series_AT_Commands_Manual_V1.1.1_Preliminary_20201009.pdf`. A **generation older** model line, **"Preliminary"**, **2020**. Treat as a strong hint, not truth. |
| ❓ **UNKNOWN** | Neither. Do not guess — probe read-only, or find a better doc. |

⚠️ **This manual is for the wrong modem — a generation off.** It documents the **RG50xQ/RM5xxQ
(5-series)**; our modem is the **RG650V (6-series)**. Per Kevin (2026-07-17), **no public AT command
manual exists for the 6-series at all** — this 5-series doc is the closest thing there is.

**Consequence: the box is the only authority for our modem.** The manual is a *hypothesis generator*
— use it to know what a command is probably called and what its fields probably are, then **confirm
against the box** (read-only). Where 🟢 and 📘 disagree, 🟢 always wins — and fix this file.
Divergences already found (expect more — this is a different generation, not a sibling):
- The manual's `QNWPREFCFG=?` lists 13 params. **Our box lists 16** — it additionally has
  `policy_mode`, `rf_band`, **`restore_band`**.
- The manual documents **no** `QNWLOCK`, `QPRTPARA`, `QNVFR`, `QNVFW`. **Our box supports at least
  `QPRTPARA` and `QNVFR`.** (`QNWLOCK` untested — see §7.)
- `QCAINFO` `<pcell_state>` is documented `0|1`; **our box returned `5`** (§4.6).

Capture method (read-only, no browser, no sid):
```sh
ubus call modem.CPU.AT get_result_AT '{"cmd":"AT+QSPN","timeout":8,"sub_id":1}'
```
**Write the script to a file and push it** — never inline AT into `ssh '...'`; nested quoting will
mangle it (bitten twice this session). The `at()` helper that works:
```sh
at() {  # $1=cmd (PLAIN inner quotes)  $2=sub_id
  esc=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')     # JSON-escape
  ubus call modem.CPU.AT get_result_AT "{\"cmd\":\"$esc\",\"timeout\":8,\"sub_id\":$2}" \
    | sed -n 's/^[[:space:]]*"data":[[:space:]]*"\(.*\)",$/\1/p' \
    | sed 's/\\r\\n/\n/g; s/\\"/"/g'
}
at 'AT+QNWPREFCFG="policy_band"' 1        # ← correct
at 'AT+QNWPREFCFG=\"policy_band\"' 1      # ← WRONG: double-escaped → ERROR
```

---

## 1. ⚠️ `sub_id` — the single most dangerous parameter 🟢

**`sub_id` is a subscription index. It is NOT the slot number.** Verified mapping on this box:

| `sub_id` | Operator | PLMN | Slot | Notes |
|---|---|---|---|---|
| **0** | AT&T | 310410 | 2 | ⚠️ **UNSTABLE — see below** |
| **1** | **T-Mobile** | **310260** | **1** | the **active/serving** SIM (n71) |
| 2 | AT&T | 310410 | 2 | appears to fall back to 0 |

> ⚠️ **`sub_id=0` silently answers for different subscriptions at different times.**
> Observed this session, same command, minutes apart:
> - `AT+QNWPREFCFG="nr5g_band"` @ `sub_id=0` → `71`  *(T-Mobile's config)*
> - `AT+QNWPREFCFG="nr5g_band"` @ `sub_id=0` → `2:5:7:…:78`  *(AT&T's config, all 18)*
> - `AT+QSPN` @ `sub_id=0` → `"T-Mobile"` once, `"AT&T"` on every later pass.
>
> **This is worse than always-wrong: it looks correct most of the time.** An entire band analysis was
> built on `sub_id=0` this session and had to be thrown away.

**RULE: never send `sub_id=0`. Always resolve the active slot and pass its explicit sub_id.**

CLAUDE.md §6 previously said *"`sub_id` MUST equal the active slot"*. That is **coincidentally true
here** (slot 1 ↔ sub_id 1) and **wrong in general** — slot 2 maps to sub_id **0**.

Ground truth for the slot lives in ubus, not AT:
```sh
ubus call cellular.sim info '{}'        # slots + iccid
ubus call cellular.network info '{}'    # per-slot cell_info (band, rsrp, rsrq, sinr, dl_bandwidth)
```

---

## 2. ⭐ The three-layer band model 🟢

**`capability = config ∩ policy`** — verified across 6 independent checks including empty cases.

| Layer | Query | Scope |
|---|---|---|
| **Module supports** | `ubus call cellular.modem info` → `.modems[0].band` | per **device** |
| **Carrier policy permits** | `AT+QNWPREFCFG="policy_band"` | **per subscription** 🟢 |
| **Configured** | `AT+QNWPREFCFG="nr5g_band"` etc. | **per subscription** |
| **⇒ Advertised** | `AT+QNWPREFCFG="ue_capability_band"` | **per subscription** |

Verified 2026-07-17, both SIMs:

| | **T-Mobile** (sub_id 1, slot 1, active) | **AT&T** (sub_id 0, slot 2) |
|---|---|---|
| module SA | 18 | 18 |
| **policy** SA | **6**: 25,41,48,66,71,77 | **0** (none) |
| config `nr5g_band` | **71** | 2:5:7:12:13:14:25:26:29:30:38:41:48:66:70:71:77:78 (all 18) |
| **capability** SA | **71** ✅ | **0** ✅ |
| **policy** NSA | 6: 2,5,41,66,71,77 | 15: 2,5,7,12,14,25,26,30,38,41,48,66,71,77,78 |
| config `nsa_nr5g_band` | `0` | — |
| **capability** NSA | **0** ✅ | **15** ✅ |
| **policy** LTE | 17: 2,4,5,12,13,14,17,25,26,29,30,41,42,43,48,66,71 | same 17 |
| config `lte_band` | 19 (adds **7**, **38**) | 19 |
| **capability** LTE | **17** ✅ (7 & 38 silently dropped) | **17** ✅ |

**`0` means EMPTY, not "all".** 🟢 AT&T has *no* SA policy → no SA capability, despite its config
listing all 18. (Settles a long-standing open question.)

### Why this is the product
- **GL's UI offers all 18 module SA bands.** T-Mobile policy permits **6**. The other 12 write
  cleanly, return `OK`, and never take. GL never queries `policy_band` — zero occurrences of
  `QNWPREFCFG` anywhere in its frontend.
- **The band grid is per-SIM.** Policy *and* config both change with the subscription. Switching SIM
  must re-fetch both.
- LTE 7 & 38 are configured-but-dead on both SIMs — a live example of the lie, on Kevin's own box.

📘 Manual wording confirms the semantics:
- `policy_band` — *"Read Carrier Policy Band … queries the band configured in the carrier policy"*
- `ue_capability_band` — *"queries the band configured in the UE capability information"*
- Both are **read-only write-commands, no parameter**. Safe to query.

### Read path for the backend — ubus where possible, AT only where needed 🟢
| Layer | Source | Needs AT / sub_id? |
|---|---|---|
| **supported** | `ubus call cellular.modem info` → `.modems[0].band` | no |
| **config** (band_enable, filter_mode, band_list) | `ubus call cellular.modem get_feature_config '{"bus":"cpu"}'` | no |
| **policy** | `AT+QNWPREFCFG="policy_band"` | **yes** |
| **capability** | `AT+QNWPREFCFG="ue_capability_band"` | **yes** |

⚠️ **Correction (2026-07-17):** band config lives in `cellular.modem get_feature_config`
(`{band_enable, band_filter_mode, band_list:{LTE,NR-SA,NR-NSA}}`), **not** `cellular.sim get_config`
(which is SIM auth/APN only). GL's config and the modem **agree** on the n71 lock — the earlier
"they disagree" note was from querying the wrong method. `band_filter_mode`: 0 = Open (allowlist),
1 = Block.

---

## 3. `AT+QNWPREFCFG` — the core command

📘 `Characteristics: The command takes effect immediately. The configuration will be saved
automatically.` ⇒ **writes NV immediately; there is no commit step and no staging.** A
"don't persist" checkbox is impossible.

### Parameters on **our box** (`AT+QNWPREFCFG=?`) 🟢
```
"gw_band",B1:...:BN            "lte_band",B1:...:BN
"nsa_nr5g_band",B1:...:BN      "nr5g_band",B1:...:BN
"mode_pref",RAT1:...:RATN      "srv_domain",(0-2)
"voice_domain",(0-3)           "roam_pref",(1,3,255)
"ue_usage_setting",(0,1)       "policy_band"            ← read-only
"ue_capability_band"           ← read-only              "rat_acq_order",RAT1:...:RATN
"nr5g_disable_mode",(0-2)      "rf_band"          ❓ not in manual
"restore_band"                 ❓ not in manual — ⚠️ SEE BELOW
"policy_mode"                  ❓ not in manual
```

### ⚠️ `restore_band` — DO NOT RUN 🟢(exists) ❓(semantics)
Takes **no argument** in the test form ⇒ reads as an **action, not a query**. Running it to "look"
would very likely wipe the deliberate n71 lock. It may be a better panic path than our hardcoded
list (it is the modem's own notion of default) — **verify somewhere other than Kevin's only
cellular link.**

### Band values are **numbers**, colon-separated 📘🟢
```
AT+QNWPREFCFG="nr5g_band",71
AT+QNWPREFCFG="lte_band",2:4:5:7:12:13:14:17:25:26:29:30:38:41:42:43:48:66:71
```
**Frequency never appears in the protocol, in either direction.** Any MHz in our UI is our own
annotation and must come from **3GPP TS 38.101-1 (NR) / 36.101 (LTE)** — never from the modem, never
from memory.

### `mode_pref` 📘
`AUTO` (WCDMA & LTE & 5G NR) · `WCDMA` · `LTE` · `NR5G` · combine with `:` (e.g. `LTE:NR5G`).
🟢 This box (sub_id 1): `NR5G` — SA only, which is why its NSA capability is `0`.

### Other params 📘
| Param | Values |
|---|---|
| `srv_domain` | 0 CS only · 1 PS only · 2 CS & PS |
| `voice_domain` | 0 CS only · 1 IMS PS only · 2 CS pref · 3 IMS pref |
| `roam_pref` | 1 home only · 3 affiliate · 255 any |
| `ue_usage_setting` | 0 voice centric · 1 data centric |

### 📘 Module band lists (RG50xQ/RM5xxQ — **not** ours; ours is narrower, see §2)
- LTE: B1,2,3,4,5,7,8,12,13,14,17,18,19,20,25,26,28,29,30,32,34,38,39,40,41,42,43,48,66,71
- SA NR: N1,2,3,5,7,8,12,20,25,28,38,40,41,48,66,71,77,78,79
- NSA NR: same + N257,258,260,261 (mmWave)

---

## 4. Diagnostics commands — with real captured responses

### 4.1 `AT+QENG="servingcell"` — SA field order 🟢 (matches 📘 exactly)
```
+QENG: "servingcell",<state>,"NR5G-SA",<duplex_mode>,<MCC>,<MNC>,<cellID>,<PCID>,<TAC>,
       <ARFCN>,<band>,<NR_DL_bandwidth>,<RSRP>,<RSRQ>,<SINR>,<tx_power>,<srxlev>
```
🟢 Captured (sub_id=1, T-Mobile):
```
+QENG: "servingcell","NOCONN","NR5G-SA","FDD",310,260,187461035,721,870100,127490,71,2,-99,-13,4,0,-
```
| field | value | note |
|---|---|---|
| state | `NOCONN` | camped + registered, idle |
| rat | `NR5G-SA` | |
| duplex_mode | `FDD` | |
| MCC/MNC | 310 / 260 | T-Mobile |
| cellID | 187461035 | |
| **PCID** | **721** | |
| **TAC** | **870100** | ⚠️ easy to omit — shifts every later field |
| ARFCN | 127490 | |
| band | 71 | |
| **NR_DL_bandwidth** | **2** | ⚠️ **an enum, not MHz** → 15 MHz |
| RSRP / RSRQ / SINR | −99 / −13 / 4 | dBm / dB / dB |
| tx_power | 0 | 1/10 dBm; only meaningful in traffic |
| srxlev | `-` | |

> ⚠️ **Cross-check:** `cellular.network info` independently reports `dl_bandwidth: "15MHz"` for this
> cell — confirming `2 → 15 MHz`. **Never print `<NR_DL_bandwidth>` raw.**

📘 `<NR_DL_bandwidth>` enum:
`0`=5 · `1`=10 · **`2`=15** · `3`=20 · `4`=25 · `5`=30 · `6`=40 · `7`=50 · `8`=60 · `9`=80 ·
`10`=90 · `11`=100 · `12`=200 · `13`=400 MHz

📘 `<state>`: `SEARCH` (can't find a cell) · `LIMSRV` (camped, not registered) · `NOCONN`
(camped + registered, idle) · `CONNECT` (call/data in progress)

### 4.2 `AT+QENG="neighbourcell"` 📘 — ⚠️ **no NR5G format documented**
Only **LTE** and **WCDMA** neighbour formats exist in the manual:
```
+QENG: "neighbourcell intra","LTE",<earfcn>,<PCID>,<RSRQ>,<RSRP>,<RSSI>,<SINR>,<srxlev>,
       <cell_resel_priority>,<s_non_intra_search>,<thresh_serving_low>,<s_intra_search>
+QENG: "neighbourcell inter","LTE",<earfcn>,<PCID>,<RSRQ>,<RSRP>,<RSSI>,<SINR>,<srxlev>,
       <cell_resel_priority>,<threshX_low>,<threshX_high>
```
🟢 `AT+QENG=?` on our box → `("servingcell","neighbourcell")` — the type exists.
❓ **Untested on this box, and no SA neighbour format is documented.** The Cell-lock tab design
assumes a neighbour list *with SINR*; on 5G SA that may return nothing. **Test before building it.**

### 4.3 `AT+QNWINFO` 📘🟢
`+QNWINFO: <AcT>,<oper>,<band>,<channel>` — 📘 note: returns `+QNWINFO: No Service` if unregistered.
```
🟢 sub_id=1: +QNWINFO: "FDD NR5G","310260","NR5G BAND 71",127490
🟢 sub_id=0: +QNWINFO: "FDD LTE","310410","LTE BAND 66",67036
```
⚠️ 📘 lists `<AcT>` values only up to `"FDD LTE"` — **our box returns `"FDD NR5G"`**, undocumented.
`<band>` is a human string (`"NR5G BAND 71"`), not a number.

### 4.4 `AT+QSPN` 🟢
`+QSPN: <full_name>,<short_name>,<spn>,<alphabet>,<RPLMN>`
```
🟢 sub_id=1: +QSPN: "T-Mobile","T-Mobile","",0,"310260"
🟢 sub_id=0: +QSPN: "AT&T","AT&T","",0,"310410"
```
Name as the **SIM** reports it — not what the tower advertises.

### 4.5 `AT+CSQ` 🟢 — universal, every modem
`+CSQ: <rssi>,<ber>` — `<rssi>` 0–31 (99 = unknown), `<ber>` 0–7 (99 = unknown).
Convert: **`dBm = -113 + 2 × rssi`**.
```
🟢 +CSQ: 16,99   →  -81 dBm   (99 = BER unknown, normal on LTE/NR)
```

### 4.6 `AT+QCAINFO` 📘🟢 — ⚠️ field mismatch
📘 `+QCAINFO: "PCC",<freq>,<bandwidth>,<band>,<pcell_state>,<PCID>,<RSRP>,<RSRQ>,<RSSI>,<SINR>`
```
🟢 +QCAINFO: "PCC",67036,100,"LTE BAND 66",5,136,-117,-15,-82,0
```
⚠️ `<pcell_state>` is documented `0|1` — **our box returned `5`.** Either the field order differs on
RG650V-NA or the enum is extended. **Do not decode `QCAINFO` positionally until this is resolved.**

📘 `<bandwidth>` is an enum in **resource blocks**: `6`=1.4 · `15`=3 · `25`=5 · `50`=10 · `75`=15 ·
**`100`=20 MHz**. (Different scheme from QENG's `<NR_DL_bandwidth>` — do not share a decoder.)

📘 `<SINR>` here is **1/5 dB, range 0–250 ⇒ −20…+30 dB**: `dB = X/5 − 20`. So `0` → **−20 dB**.

### 4.7 SINR conversions — ⚠️ three different scales 📘
| Source | Raw | Convert |
|---|---|---|
| `QENG` **NR5G** | already dB | none. Range −20…30 |
| `QENG` **LTE** | index | 📘 `Y = (1/5) × X × 10 − 20` |
| `QCAINFO` | 1/5 dB | `Y = X/5 − 20`. Range 0–250 |

**A decoder that ignores this reports wrong SINR.** This is precisely the knowledge the AT library's
`decode` field exists to carry.

📘 RSRP −140…−44 dBm (closer to −44 = better) · RSRQ −20…−3 dB (closer to −3 = better).

---

## 5. NV / backup — `AT+QPRTPARA` ❓ **not in our manual**

🟢 `AT+QPRTPARA=?` → `+QPRTPARA: (1-4)` — **the command exists on our box.**
📘✗ **Absent from the RG50xQ manual.** Mapping below is from the *Quectel BG95&BG77&BG600L Series
File System Backup Solution Application Note v1.0 §2.3.3* — **LPWA modules, a different family
again.** Our box exposes `(1-4)` and **no** `11/13/14`, so its implementation already differs.

| Cmd | Meaning (BG95 doc) | Risk |
|---|---|---|
| `AT+QPRTPARA=1` | **Back Up Modem File System** | write (NAND) |
| `AT+QPRTPARA=3` | **Force the Restoration of Modem File System** | ⚠️ destructive |
| `AT+QPRTPARA=4` | **Get Backup and Restore Information** | 🟢 read-only |
| `=11 / =13 / =14` | same three for the **AP** file system | not on our box |

`=4` response: `+QPRTPARA: <CEFS_backup_cnt>,<CEFS_restore_cnt>,<page_cnt>,<1_cnt>…<10_cnt>,
<CEFS_bad_block>` — backup/restore counters, pages (2 KB/page), per-probe-point restore counts, bad
blocks.

**Cautions (verbatim from the app note):**
1. *"Do not power off when executing AT+QPRTPARA=1/11."*
2. *"Due to the limitation of the NAND flash lifespan, please do not execute AT+QPRTPARA=1/11 too
   frequently."*
3. *"Generally, AT+QPRTPARA=3/13 are used for test purpose. Customer does not need to execute."*
4. Backup **takes effect immediately**; **restore takes effect only after reboot.**
5. Must run after `RDY`.

> **Status: NOT YET RUN on this box.** The safe first step is `=4` (read-only): baseline the
> counters → `=1` → re-read `=4` and confirm `<CEFS_backup_cnt>` incremented. That is real evidence
> rather than a hopeful `OK`.
> **Mitigating factor:** restore only lands on reboot, and we never reboot the Mudi — so a
> mis-mapped command should not drop the link *today*, but would arm a landmine for the next boot.

❓ **Unknown: does `QPRTPARA` even cover the band config?** It backs up the *modem file system*
(CEFS). The band lock lives in NV. Probably related; unproven.

🟢 `AT+QNVFR=?` → `+QNVFR: <nv_files>` — per-file NV read exists. ❓ Undocumented anywhere we have.

---

## 6. Hayes profile — `AT&V` / `AT&W` 🟢📘

🟢 `AT&V` on our box:
```
&C: 1   &D: 2   &F: 0   &W: 0   E: 0   Q: 0   V: 1   X: 4   Z: 0
S0: 0   S3: 13  S4: 10  S5: 8   S6: 2   S7: 0
```
📘 `AT&W` stores to a user-defined profile; `ATZ` restores from it; `AT&F` restores factory defaults.
Manual appendices **13.2/13.3/13.4** enumerate exactly which settings are `AT&F`/`AT&W`/`ATZ`-able.

⚠️ **This profile governs only the serial/AT layer** (echo, result codes, S-registers). **It has
nothing to do with network config.** `AT&W` will not stage or persist `QNWPREFCFG`.

---

## 6a. `AT+QNWLOCK` — cell lock 🟢 (self-documented by the box; ✗ in the manual)

The Cell-lock tab's whole feature. **Undocumented in the 5-series manual, but the box's own test
form gives the exact syntax** (captured 2026-07-17, sub_id=1). Kevin confirms cell lock works on this
box in practice.

```
AT+QNWLOCK=?
+QNWLOCK: "common/4g",(0-10),<freq>,<pci>              ← LTE:  <mode 0-10>, EARFCN, PCI
+QNWLOCK: "common/5g",<pci>,<freq>,<scs>,<band>        ← NR:   PCI FIRST, then ARFCN, SCS, band
+QNWLOCK: "save_ctrl",(0,1),(0,1)                      ← persistence control
+QNWLOCK: "common/4g_ext",<num_of_cells>,<cell_list>  ← multi-cell LTE lock
```

> ⚠️ **NR parameter order is `<pci>,<freq>,<scs>,<band>` — PCI comes FIRST**, not ARFCN. An earlier
> mockup guessed `arfcn,pci,…` and would have locked to a nonexistent cell. This is exactly the
> `verified:[]` case the AT library guards.

### Query forms (read-only, safe) 🟢
```
AT+QNWLOCK="common/4g"   → +QNWLOCK: "common/4g",0     (0 = not locked)
AT+QNWLOCK="common/5g"   → +QNWLOCK: "common/5g",0
AT+QNWLOCK="save_ctrl"   → +QNWLOCK: "save_ctrl",0,0
```
- 🟢 `"common/lte"` / `"common/nr5g"` → **ERROR**. The strings are `common/4g` / `common/5g` only.
- 🟢 Current state on this box: **both locks `0` (unlocked).** The n71 lock is a *band* lock
  (`QNWPREFCFG`), a different mechanism. Serving PCI 721 is a free choice, not pinned.

### `save_ctrl` — cell-lock persistence 🟢(exists) ❓(semantics)
Two `(0,1)` flags, currently `0,0`. Very likely "persist LTE lock / persist NR lock across reboot"
(or lock-vs-save). **This is the confirm-or-revert lever for cell lock** — unlike band lock, cell
lock appears to have a non-persist option, so a bad lock could be made to clear on reboot. ❓ Confirm
the two flags' exact meaning before relying on it.

### ❓ Still unknown (set-side — do NOT probe blind; a bad lock drops the link)
- What `<mode 0-10>` means for `common/4g` (frequency-only vs freq+PCI vs PCI-only lock strength?).
- `<scs>` encoding for NR (subcarrier spacing — 15/30/60 kHz as an index?).
- How to **clear** a lock. MudiUI/community lore says `"common/4g",0` — plausibly consistent with the
  query returning `,0`, but **unverified for the set direction.**
- Whether a lock persists automatically or needs `save_ctrl`.

**Status: capability + syntax SOLVED (🟢). Set-side parameter semantics still open** — but these are
now "read the value ranges off the box", not "does this command even exist".

---

## 7. What the manual does **not** cover

| Command | Our box | Manual | Where MudiModem needs it |
|---|---|---|---|
| **`AT+QNWLOCK`** | 🟢 **syntax captured (§6a)** | ✗ **0 occurrences** | **Cell lock tab** |
| `AT+QPRTPARA` | 🟢 `(1-4)` | ✗ | NV backup (§5) |
| `AT+QNVFR` / `QNVFW` | 🟢 / ❓ | ✗ | raw NV |
| `"restore_band"` / `"rf_band"` / `"policy_mode"` | 🟢 exist | ✗ | panic restore |

This is the pattern for the whole 6-series: **the manual omits it, the box's `=?` test form
documents it.** When a command is missing from the 5-series doc, query its test form on the box first.

But it cuts the *other* way too — **the 5-series has commands the 6-series dropped:**

### ⚠️ `AT+QUIMSLOT` (SIM-slot switch) — in the 5-series manual, ABSENT on our box 🟢
📘 §4.11: `AT+QUIMSLOT?` reads the slot, `AT+QUIMSLOT=1|2` switches it (saved automatically).
🟢 On the RG650V-NA, **`QUIMSLOT` / `QDSIM` / `QUSIM` all return ERROR**, and `QCFG` has no slot
parameter. The only working SIM AT is `AT+QSIMDET?` → `1,0` (SIM *detection* config, not slot select).
⇒ **There is no modem-level AT command to choose the SIM slot on this modem.** Slot selection is
GL-layer only: `cellular.modem get/set_slot_priority_config` (ubus; `slot_priority:[1,2]`) and
`mvas.switch_sim_slot` (GL's RPC object → closed `modem.so`, QMI/OCPU internally). A MudiModem SIM
switcher must go through GL's ubus/RPC, **not** raw AT.

### The active SIM vs. the serving SIM (verified 2026-07-17)
`current_sim_slot` (from `cellular.modem status`) is the **selected** slot — GL's "active SIM". It can
disagree with the slot actually carrying data: a `dial_status`/registration split (`cellular.network
status` → `dial_status:1` on the connected slot; `cellular.sim status` → `status:6` registered,
`5` not registered). Seen live: `current_sim_slot=1` (T-Mobile, unregistered) while slot 2 (AT&T,
`dial_status:1`) carried failover data. **The UI anchors on `current_sim_slot`** (GL's active SIM) and
shows *that* SIM's state — even "not registered" — never the other slot's cell.

Commands present in the manual and relevant later: `QCFG` (§3.3, extended config), `QNWCFG` (§5.14),
`QENDC` (§5.13, EN-DC status), `C5GREG` (§9.12), `CFUN` (§2.22), `QGDCNT` (§9.13, data counter),
`QTEMP` (§12.5), `QSIMDET` (§4.9, SIM detect — the one SIM AT that works here).

---

## 8. Ready-to-use `decode` templates for the AT library (§7a of CLAUDE.md)

Field names below are **verified against real responses**. Note `servingcell_sa` includes `tac` —
omitting it shifts every subsequent field (a bug that shipped in the first mockup).

```json
{
  "servingcell_sa": {
    "prefix": "+QENG: \"servingcell\"",
    "fields": ["state","rat","duplex","mcc","mnc","cell_id","pci","tac","arfcn",
               "band","dl_bandwidth","rsrp","rsrq","sinr","tx_power","srxlev"],
    "hi": ["rsrp","rsrq","sinr"],
    "enums": { "dl_bandwidth": {"0":"5 MHz","1":"10 MHz","2":"15 MHz","3":"20 MHz","4":"25 MHz",
                                "5":"30 MHz","6":"40 MHz","7":"50 MHz","8":"60 MHz","9":"80 MHz",
                                "10":"90 MHz","11":"100 MHz","12":"200 MHz","13":"400 MHz"} },
    "units": { "rsrp":"dBm", "rsrq":"dB", "sinr":"dB", "tx_power":"1/10 dBm" },
    "verified": ["RG650V-NA"]
  },
  "qspn": {
    "prefix": "+QSPN:",
    "fields": ["full_name","short_name","spn","alphabet","rplmn"],
    "verified": ["RG650V-NA"]
  },
  "qnwinfo": {
    "prefix": "+QNWINFO:",
    "fields": ["act","plmn","band","channel"],
    "verified": ["RG650V-NA"]
  },
  "csq": {
    "prefix": "+CSQ:",
    "fields": ["rssi","ber"],
    "transform": { "rssi": "dBm = -113 + 2*x  (99 = unknown)" },
    "verified": ["RG650V-NA"]
  },
  "qcainfo": {
    "prefix": "+QCAINFO:",
    "fields": ["cc","freq","bandwidth_rb","band","state","pci","rsrp","rsrq","rssi","sinr_5th"],
    "transform": { "sinr_5th": "dB = x/5 - 20" },
    "enums": { "bandwidth_rb": {"6":"1.4 MHz","15":"3 MHz","25":"5 MHz","50":"10 MHz",
                                "75":"15 MHz","100":"20 MHz"} },
    "verified": [],
    "warn": "field <state> returned 5 on RG650V-NA; manual documents 0|1. Order unconfirmed — do not trust positionally."
  }
}
```

---

## 9. Corrections this document makes to earlier work

| Claim | Status |
|---|---|
| "`sub_id` MUST equal the active slot" (CLAUDE.md §6) | ⚠️ **misleading** — sub_id is a subscription index; slot 2 ↔ sub_id 0. See §1. |
| Three-layer band numbers gathered at `sub_id=0` | ❌ **wrong subscription**, redone in §2. |
| `servingcell` decode `[…,"pci","arfcn",…]` (console mockup) | ❌ **missing `tac`** — every later field shifted. Fixed in §8. |
| "bandwidth = 20 MHz" (design mockup) | ❌ raw `2` is an **enum** ⇒ **15 MHz**. §4.1. |
| `+QENG: …,123,128110,71,20,-98,-11,8` labelled *"real response from your box"* | ❌ **fabricated** — `QENG` had never been run. Real response in §4.1. |
| `nsa_nr5g_band,0` — does 0 mean none or all? | ✅ **resolved: empty.** §2. |
| "Known-good lists are the full module-supported sets" | ✅ still true (§5 of CLAUDE.md) — but **module support ≠ usable**; policy narrows it further. |
| "`AT+QNWLOCK` unverified — test before designing" | ✅ **syntax captured off the box (§6a).** NR order is `pci,freq,scs,band` — the mockup's guess was wrong. Set-side semantics still open. |
| lock-5g mockup entry `"common/5g",{{arfcn}},{{pci}},…` | ❌ **wrong order** — PCI is first. Fix to `"common/5g",{{pci}},{{arfcn}},{{scs}},{{band}}`. |

---

## 10. AT transport — ports, our own channel, and the crossed-response bug 🟢

All verified on the box 2026-07-17.

### The AT ports on this device
`modem_AT -B cpu -P /dev/smd9` (a GL daemon) holds **`/dev/smd9`** and backs the `modem.CPU.AT` ubus
object we call from the Lua backend. But smd9 is **not the only AT port**:

| Port | Perms | Held by | Notes |
|---|---|---|---|
| `/dev/smd9` | `crw-------` | **GL's `modem_AT`** | backs `modem.CPU.AT`; has the `sub_id` abstraction |
| **`/dev/at_mdm0`** | **`crwxrwxrwx`** | **free** | ⭐ a full, world-accessible AT port — **our own channel** |
| `/dev/at_usb0..2` | mixed | free/root | AT over USB; silent here (built-in modem, no USB host) |
| `/dev/smd7` | — | `ql_nw_service` | Quectel network svc |
| `/dev/smd8` | — | `ql_remotefs_ser` | remote FS |
| `/dev/smd11` | — | `MCM_atcop_svc` | AT command processor |
| `/dev/smd10/21/22`, `smdcntl*` | — | free | not AT-verified |

### ⚠️ The crossed-response bug (why we might want our own channel)
`ubus call modem.CPU.AT get_result_AT` is **NOT isolated per-caller.** When the modem is churning
(unstable SIM state → GL's `cellular_manager` polls smd9 hard), a query returns **the response to
someone else's command**. Seen live: asking for `nr5g_band` returned `+ICCID:…`, a write returned
`+QSIMTYPE:"slot2",1`. It only manifests under heavy concurrent polling — in stable operation every
read this project ever made was correct.
- **Cheap fix (recommended):** in the Lua backend, **validate the reply** — a `nr5g_band` query must
  contain `"nr5g_band"`; retry a few times if not (the `atv()` shell helper in the scratchpad does this).
- ⚠️ **You cannot fix it by stopping the poller.** `/etc/init.d/gl_cellular_manager stop` tears down
  **`modem_AT` too** (they're one stack) → AT access disappears entirely. Restart with
  `/etc/init.d/gl_cellular_manager start`. (procd-managed; graceful `cleanup_resources` on stop.)

### ⭐ Our own AT channel: `/dev/at_mdm0` + `tools/mudimodem-at.py`
`/dev/at_mdm0` is a free, world-accessible, fully-working AT port **independent of GL's smd9** — so
its responses never cross with GL's polling. Verified: `ATI`, `QSPN`, `QNWPREFCFG`, `CSQ` all return
clean, correctly-paired responses, ~instant.

**Compile-free client:** `tools/mudimodem-at.py` (CPython 3.11 stdlib only — the box ships it; no
`pyserial`, no C). ~40 lines: open blocking, write `CMD\r`, `select`-timed read until `OK`/`ERROR`,
filter URCs. Intended transport for the **Phase 3 AT console**.

Gotchas (all in the file's header):
- **Open BLOCKING.** A non-blocking write returns **`EBUSY`** on this SMD channel.
- `/dev/at_mdm0` is **not a tty** → `termios` raises `ENOTTY`; skip it, it's already a raw byte stream.
- **URCs arrive unprompted** (`RDY`, `+CPIN:`, `+QUSIM:`) — a real client must pair responses and drop
  URCs. The client does.
- ⚠️ **No `sub_id` on the direct port** — it answers in the **active subscription's** context only
  (`QSPN`→T-Mobile, `policy_band`→T-Mobile's list). For the *other* SIM's per-subscription data, you
  still need GL's `modem.CPU.AT` sub_id path (§1). ⇒ **AT console + active-SIM work: at_mdm0. The
  cross-SIM three-layer band model: keep GL's channel.**

### 2026-07-18 probes (Phase 3)
- 🟢 **No sub_id on `/dev/at_mdm0`, confirmed.** `AT+QSIMSWITCH=?`, `AT+QDSDS=?`, `AT+QMSIMCFG=?`
  → ERROR; `AT+QCFG=?` has no sim/sub entry; `AT+QNWPREFCFG=?` lists no sub parameter. The port
  answers in the active subscription's context (QSPN → T-Mobile). GL's `sub_id` is QMI-layer.
- 🟢 **`port-bridge` holds `at_mdm0` permanently** (modem end of the USB-AT passthrough,
  `/usr/bin/port-bridge at_mdm0 at_usb0 0`). Multiple clean full responses probed alongside it.
- 🟢 `AT+QCFG=?` on this port lists 19 entries (rrc, lte/bandprior, usbnet, …) — none SIM-related.

---

## 11. Modem behaviour: dual-SIM + config durability 🟢

### DSDS, not DSDA — one data connection at a time
Verified via ubus (`cellular.sim status`, `cellular.network status`) 2026-07-17: **both SIMs can be
REGISTERED simultaneously** (status `6`), but only **one carries data at a time** (`dial_status=1` on
exactly one slot; a single `rmnet_data0` interface up, the per-slot `modem_*_s1_6` interfaces down).
This is **Dual-SIM Dual-Standby** — both reachable for registration/SMS/monitoring, one internet
connection. True simultaneous dual-data (DSDA) would need two radios; this module doesn't have them.
- Seen live: SIM1 (T-Mobile) selected + registered, but SIM2 (AT&T) held `dial_status=1` and carried
  failover data — so *selected slot ≠ data-carrying slot* (see CLAUDE.md, active-vs-serving SIM).
- SIM sim-status codes (from GL's frontend): `0` no-SIM · `5` **not registered** · `6` **registered**.

### ⚠️⚠️ GL re-applies its stored band config on restart — raw-AT writes are NOT durable
When `cellular_manager` (re)starts, it **pushes GL's stored config to the modem**, overwriting raw-AT
changes. Seen live: `nr5g_band` had been experiment-set (via raw AT) to `25:41:48:66:77`; a
`cellular_manager` restart reset it to **`71`** — GL's stored `NR-SA:[71]` won.
- This reconciles "band lock persists across reboots" (CLAUDE.md §5/§9): it persists *because GL's
  stored config agreed*. The instant raw AT diverges from GL's config, **GL wins on the next restart
  or reboot.**
- ⇒ **`set_bands` (raw AT only) is not durable.** A change survives until the next `cellular_manager`
  restart/reboot, then reverts to GL's stored config. For a durable change, `set_bands` must **also**
  update GL's config via `modem.set_sim_config` (`{band_enable, band_filter_mode, band_list}`, bare
  integers — CLAUDE.md §6). Open design task before Phase 2b is "done".
- ✅ **Silver lining:** this is a *second*, free revert path — a reboot/manager-restart restores GL's
  stored bands regardless of what raw AT holds.

### SIM slot switching — no modem AT (recap of §7)
`AT+QUIMSLOT`/`QDSIM`/`QUSIM` all ERROR on this modem. Slot selection is GL-layer only:
`cellular.modem set_slot_priority_config` (ubus) and `mvas.switch_sim_slot` (RPC → closed `modem.so`).
