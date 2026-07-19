# MudiModem

The Mudi 7 is a great cell modem/router but I found one thing a bit lacking, which is modem control.   I spent a weekend vibe coding a new modem control panel that brings all things modem into one section of the built in UI.



---

## Features

MudiModem has five tabs. Every screen anchors to a persistent **live signal strip** across the top
(RSRP, updating in real time) so you can always see what a change did to the connection.

### 📈 Tracking

![Tracking tab](docs/screenshots/01-tracking.jpg)

Watch the radio over time. RSRP, SINR, and RSRQ share one time axis so you can see them move together,
with lanes below showing exactly when the **band**, **cell**, or **SIM** changed — and an **event log**
that records every change with a timestamp and who caused it (*you*, the *network*, or the safety
watchdog). Pick a window from 15 minutes to 24 hours. Two badges on the signal strip show at a glance
whether a **mode lock** (Auto / 4G-only / 5G-only) or a **tower lock** is in force; click either to jump
to its tab.

### 📶 Bands

![Bands tab](docs/screenshots/02-bands.jpg)

Choose which cellular bands the modem may use. Each band is colored for its **real** state — *active*,
*permitted but not selected*, or **blocked by carrier policy** (shown and explained, but not selectable,
because the modem will never use it ). A network-mode selector (Auto /
5G only / 4G only) sits on top.

Band changes are **confirm-or-revert**: applying one starts a ~60-second countdown and automatically
rolls back unless you confirm you want to keep it — so a bad lock can't strand the cellular link you're
administering over.

### 🔒 Cell lock

![Cell lock tab](docs/screenshots/03-cell-lock.jpg)

Pin the modem to a specific cell so it won't hand over. The tab shows your current serving cell and can
**scan for nearby lockable cells**, listed with your **serving carrier's cells first** and **5G above
LTE**, each with a one-click Lock. Same confirm-or-revert safety as Bands.

⚠️ A kept cell lock lives in the modem's own memory and survives reboot, reflash, *and* factory reset —
the panel documents the ssh recovery path right on the page. (A scan takes the modem offline for up to
~10 minutes.)

### ⌨️ AT console

![AT console tab](docs/screenshots/04-at-console.jpg)

A raw AT terminal to the modem, on its **own** channel so it doesn't collide with GL's polling. Alongside
it, a searchable **community command library** where every entry carries a **risk badge** — `read` (query
only), `set` (runtime, gone on reboot), or `nv` (**writes permanent memory; survives factory reset**).
Nothing ever runs by itself: clicking a library entry just fills the prompt, and `set`/`nv` commands stay
locked until you tick "enable higher-risk commands."

### 📇 SIM

![SIM tab](docs/screenshots/05-sim.jpg)

Both SIM slots, side by side. This box is DSDS — both SIMs register, but only one carries data — and the
tab makes the split the stock UI hides plainly visible: the **selected** slot and the **data-carrying**
slot can differ. Each card shows identity (hidden by default), APN with quick-pick suggestions, auth, IP
type, and roaming state, with an editable dial profile, a one-click slot switch, and a failover summary.

---

## Installing it

One line — no app store, no firmware flash. From a **root shell on the router** (`ssh root@<router>`
first if you're remote):

```sh
curl -fsSL https://raw.githubusercontent.com/kevinherzig/MudiModem/main/install.sh | sh
```

The installer downloads every file from GitHub, gzips the page chunks with the box's own `gzip`, and drops
them into place — no toolchain, nothing to build. Then **reload the GL admin in your browser** and a
**MODEM** item appears in the top navigation. There's no reboot.

**Uninstall** is the mirror image:

```sh
curl -fsSL https://raw.githubusercontent.com/kevinherzig/MudiModem/main/uninstall.sh | sh
```

Both scripts **refuse to run against anything that isn't a GL-E5800** (they check the model first — a
safeguard because GL's default `192.168.8.1` may be a *different* router on your LAN), are idempotent, and
register/de-register the files in `/etc/sysupgrade.conf` so a firmware upgrade doesn't wipe them.

> Developing on it? `./tools/deploy.sh` pushes your local checkout to the box over ssh (set
> `MUDI_HOST`), and `./tools/verify.sh` runs the on-device assertions.

> **Heads up — it's a travel router on cellular.** If you administer the Mudi *over* its own cellular
> link, a bad band or cell lock can drop the connection you're using. MudiModem's confirm-or-revert
> watchdog is built for exactly this, and the panel documents an ssh panic-restore for the worst case —
> but treat band/lock changes with care when you're remote.

## Hardware / compatibility

- **Router:** GL.iNet GL-E5800 ("Mudi"), GL firmware 4.8.5 / OpenWrt 23.05.4
- **Modem:** Quectel **RG650V-NA** (the North America variant)

This was built and verified against one specific box. The band model and AT commands are Quectel- and
firmware-specific; treat other hardware as untested.

## Under the hood

MudiModem is a native page in GL's own **oui**/Vue admin — a view chunk plus a menu entry, so it loads
alongside GL's UI with no rebuild and no patched binaries. Most data arrives free over GL's existing
websocket; a small Lua backend handles the writes and the AT passthrough, guarded by a detached
auto-revert watchdog.

The full reverse-engineering notes live in [`CLAUDE.md`](CLAUDE.md), and the Quectel AT knowledge (marked
verified-on-box vs. from-the-manual) in
[`reference/quectel-at-reference.md`](reference/quectel-at-reference.md). The community AT library is its
own project at [`kevinherzig/mudi7-at-library`](https://github.com/kevinherzig/mudi7-at-library).

## Status

Working today: live tracking, band read/write with auto-revert, cell scan + lock, the AT console and
library, and the SIM/APN tab. Still in progress: making band writes durable across a modem-manager
restart, finishing the cell-lock write path, and a one-shot install/uninstall script. See `CLAUDE.md` §12
for the live status.
