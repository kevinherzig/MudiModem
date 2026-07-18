// MudiModem — Phase 1 diagnostics + Phase 2 interactive three-layer band grid +
// cell-lock tab (pin to the serving cell, confirm-or-revert like band writes).
//
// Loaded by GL's SPA via eval(), so this file MUST be a single expression whose
// value is the component (module.exports = {...}). `module` is in scope at eval
// time. Vue here is runtime-only: render(h) only, never `template:`.
//
// Reads come two ways, both server-trusted:
//   - live status: this.$store.getters.moduleStatus("cellular.*") over /ws
//   - band model:  window.$rpcRequest("call",["sid","mudimodem","get_bands",{}])
// The "sid" string is a verbatim placeholder GL swaps for the session cookie.
//
// The one WRITE (set_bands) is confirm-or-revert: the backend arms the
// /usr/sbin/mudimodem-revert watchdog before writing, and this UI shows the
// countdown + Keep/Revert. A bad lock self-restores within the window.
//
// All colour is GL theme tokens (var(--success) etc.), so light/dark/classic
// all work with zero extra code.
//
// A hidden sibling page (/mudimodem-tracking) shows history gathered by the
// device-side collector (mudimodem-collectd) — this page only links to it via
// the strip's "History ->". User/watchdog events for that timeline are persisted
// server-side by the backend (set_bands/confirm/revert_now) + the watchdog, so
// nothing is recorded here.
module.exports = {
  name: "mudimodem",

  data() {
    return {
      tab: "diag",
      trace: [],
      TRACE_MAX: 90,
      styleId: "mudimodem-css",
      bands: null,          // get_bands result, once fetched
      bandsLoading: false,
      bandsError: "",
      sel: { sa: null, nsa: null, LTE: null },   // desired allowlists per editable RAT
      selMode: null,        // desired network mode (AUTO | NR5G | LTE)
      pending: null,        // { kind, window, applied, remaining } after Apply/Lock
      cdTimer: null,        // countdown interval handle
      applying: false,      // Apply in flight
      applyError: "",
      lockData: null,       // get_lock result, once fetched
      lockLoading: false,
      lockError: "",
      lockBusy: false,      // a lock/unlock RPC in flight
      lockConfirm: null,    // target awaiting inline confirm ({...target,label})
      // Scanned neighbour towers (Task 5 fills the scan card); pinTarget reads
      // scan.towers now to confirm an SCS reading when one is available.
      scan: { towers: [], running: false, error: "", ts: 0 },
      // Tracking tab: the graph lives in its OWN chunk (gl-sdk4-ui-mudimodem-
      // tracking). Rather than route away (which hides our strip + tab bar), we
      // lazy-load that chunk on first open and render it as an in-page child
      // component, exactly as the SPA's own loader evals a view chunk.
      trackingComp: null,   // the loaded tracking component options, once fetched
      trackingLoading: false,
      trackingErr: "",
      // Approximate downlink centre freq (MHz) per band, for spectrum ordering
      // and labels. Source: 3GPP TS 38.101-1 (NR) / 36.101 (LTE), rounded to the
      // marketing figure. Labels only — the modem is never sent a frequency.
      freq: {
        n: { 2: 1900, 5: 850, 7: 2600, 12: 700, 13: 750, 14: 700, 25: 1900, 26: 850,
             29: 700, 30: 2300, 38: 2600, 41: 2500, 48: 3500, 66: 1700, 70: 1700,
             71: 600, 77: 3700, 78: 3500, 79: 4700 },
        B: { 2: 1900, 4: 1700, 5: 850, 7: 2600, 12: 700, 13: 750, 14: 700, 17: 700,
             25: 1900, 26: 850, 29: 700, 30: 2300, 38: 2600, 41: 2500, 42: 3500,
             43: 3600, 48: 3500, 66: 1700, 71: 600 }
      },
      // Default NR SS-block SCS per band (kHz), used ONLY when no scan result
      // covers the serving cell. Source: 3GPP TS 38.104 §5.4.3 band tables —
      // FDD low/mid bands are 15 kHz, the TDD mid bands 30 kHz. The confirm
      // text says when this assumption is in play. Encoding (kHz vs index)
      // verified at the supervised milestone before first use.
      SCS_DEFAULT: { 2: 15, 5: 15, 7: 15, 12: 15, 13: 15, 14: 15, 25: 15, 26: 15,
                     29: 15, 30: 15, 38: 30, 41: 30, 48: 30, 66: 15, 70: 15,
                     71: 15, 77: 30, 78: 30, 79: 30 }
    };
  },

  computed: {
    ms() {
      var s = this.$store && this.$store.getters;
      return (s && s.moduleStatus) ? s.moduleStatus : function () { return {}; };
    },
    modem() {
      var modems = this.ms("cellular.modems_info").modems || [];
      return modems.filter(function (m) { return m.type === 0; })[0] || modems[0] || {};
    },
    modemStatus() {
      var self = this;
      var modems = this.ms("cellular.modems_status").modems || [];
      return modems.filter(function (m) { return m.bus === self.modem.bus; })[0] || modems[0] || {};
    },
    // GL declares ONE active SIM: the SELECTED slot (current_sim_slot). The panel
    // anchors on THAT SIM and shows its state honestly — even when it is
    // unregistered — and never borrows the other slot's cell (which may be
    // carrying failover data; that's GL's own SIM1-active / modem-connected split).
    activeSlot() { return this.modemStatus.current_sim_slot; },
    servingNet() {
      var self = this;
      var bus = this.modem.bus;
      var nets = (this.ms("cellular.networks_info").networks || [])
        .filter(function (n) { return !bus || n.bus == null || n.bus === bus; });
      return nets.filter(function (n) { return String(n.slot) === String(self.activeSlot); })[0] || {};
    },
    serving() { return this.servingNet.cell_info || {}; },
    // Is the active SIM actually registered (has a serving cell)?
    activeRegistered() { return this.serving.rsrp !== undefined && this.serving.rsrp !== null && this.serving.rsrp !== ""; },
    anyNetwork() { return (this.ms("cellular.networks_info").networks || []).length > 0; },
    activeSim() {
      var self = this;
      var sims = this.ms("cellular.sims_info").sims || [];
      return sims.filter(function (s) { return String(s.slot) === String(self.activeSlot); })[0] || {};
    },
    // Carrier of the ACTIVE SIM (from sim status), for the strip label.
    servingCarrier() {
      var self = this;
      var sims = this.ms("cellular.sims_status").sims || [];
      var s = sims.filter(function (x) { return String(x.slot) === String(self.activeSlot); })[0] || {};
      if (s.carrier) return s.carrier;
      return this.activeSim.mcc ? (this.activeSim.mcc + this.activeSim.mnc) : "";
    },
    hasData() { return this.serving.rsrp !== undefined && this.serving.rsrp !== null; },
    isNR() { return /NR5G/.test(this.serving.mode || ""); },
    bandLabel() {
      if (this.serving.band === undefined || this.serving.band === "") return "—";
      return (this.isNR ? "n" : "B") + this.serving.band;
    },
    // Which band group is serving right now (for the "you are here" ring).
    servingGroup() {
      var m = this.serving.mode || "";
      if (/NR5G-SA/.test(m)) return "sa";
      if (/NR5G/.test(m)) return "nsa";
      if (/LTE/.test(m)) return "LTE";
      return null;
    },
    rsrpQ() { return this.qFromLevel(this.serving.rsrp_level); },
    sinrQ() { return this.qFromLevel(this.serving.sinr_level); },
    rsrqQ() { return this.qFromLevel(this.serving.rsrq_level); },
    facts() {
      var c = this.serving, out = [];
      var push = function (k, v) { if (v !== undefined && v !== null && v !== "") out.push([k, v]); };
      push("Mode", c.mode);
      push("Band", this.bandLabel === "—" ? null : this.bandLabel);
      push("Bandwidth", c.dl_bandwidth);
      push("Cell ID", c.id);
      push("Channel", c.tx_channel);
      push("RSRP", c.rsrp !== undefined ? c.rsrp + " dBm" : null);
      push("RSRQ", c.rsrq !== undefined ? c.rsrq + " dB" : null);
      push("SINR", c.sinr !== undefined ? c.sinr + " dB" : null);
      if (c.rssi !== undefined) push("RSSI", c.rssi + " dBm");
      push("Carrier", this.servingCarrier);
      push("SIM slot", this.activeSlot);
      return out;
    }
  },

  watch: {
    "serving.rsrp": {
      immediate: true,
      handler(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return;
        this.trace.push(n);
        if (this.trace.length > this.TRACE_MAX) this.trace.shift();
      }
    },
    tab(t) {
      if (t === "bands" && !this.bands && !this.bandsLoading) this.fetchBands();
      if (t === "lock" && !this.lockData && !this.lockLoading) this.fetchLock();
    }
  },

  created() { this.injectStyle(); },
  beforeDestroy() { this.clearCountdown(); },

  methods: {
    qFromLevel(lvl) {
      return ({ 1: "poor", 2: "fair", 3: "good", 4: "excellent" })[lvl] || "none";
    },
    qColor(q) {
      return ({
        poor: "var(--error)", fair: "var(--warning)", good: "var(--info-hover)",
        excellent: "var(--success)", none: "var(--text-hint)"
      })[q];
    },
    freqOf(group, b) {
      var t = (group === "LTE") ? this.freq.B : this.freq.n;
      return t[b];
    },
    prefixOf(group) { return group === "LTE" ? "B" : "n"; },

    // Open the in-page Tracking tab, lazy-loading its chunk on first use.
    openTracking() { this.tab = "tracking"; this.loadTracking(); },
    // Fetch + eval the tracking chunk the same way the SPA's route loader does
    // (axios GET, then `eval` with `module` in scope → the component object).
    // Cached on the instance; a failed load shows a message and can be retried.
    loadTracking() {
      var self = this;
      if (this.trackingComp || this.trackingLoading) return;
      if (typeof window === "undefined" || !window.$axios) return;
      this.trackingLoading = true; this.trackingErr = "";
      window.$axios.get("/views/gl-sdk4-ui-mudimodem-tracking.common.js?_t=" + Date.now())
        .then(function (res) {
          var module = { exports: {} };            // eslint-disable-line no-unused-vars
          var comp = eval(res.data);               // chunk is `module.exports = {...}`
          if (!comp || typeof comp.render !== "function") throw new Error("bad chunk");
          self.trackingComp = comp; self.trackingLoading = false;
        })
        .catch(function (e) {
          self.trackingLoading = false;
          self.trackingErr = (e && (e.message || e.type)) || "could not load the graph";
        });
    },

    // Fetch the three-layer band model from our backend.
    fetchBands() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.bandsError = "RPC helper unavailable";
        return;
      }
      this.bandsLoading = true;
      this.bandsError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "get_bands", {}], { timeout: 15000 })
        .then(function (res) {
          self.bands = res;
          // Seed each editable selection from the current config; an empty config
          // means "unrestricted", so start from everything the carrier permits.
          self.sel = { sa: self.seedFor("sa"), nsa: self.seedFor("nsa"), LTE: self.seedFor("LTE") };
          self.selMode = (res.meta && res.meta.mode) || "AUTO";
        })
        .catch(function (e) {
          self.bandsError = (e && (e.type || e.message)) || "request failed";
        })
        .then(function () { self.bandsLoading = false; });
    },
    seedFor(group) {
      var cfg = (this.bands.config && this.bands.config[group]) || [];
      var pol = (this.bands.policy && this.bands.policy[group]) || [];
      return (cfg.length ? cfg : pol).slice();
    },

    // Fetch the current cell-lock state (serving cell + any existing lock).
    fetchLock() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.lockError = "RPC helper unavailable"; return;
      }
      this.lockLoading = true; this.lockError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "get_lock", {}], { timeout: 20000 })
        .then(function (res) { self.lockData = res; })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "request failed"; })
        .then(function () { self.lockLoading = false; });
    },
    scsFor(band) { return this.SCS_DEFAULT[band]; },
    // Build the lock target for the serving cell. SCS: last scan result for
    // this pci+arfcn if we have one, else the band default (flagged assumed).
    pinTarget() {
      var s = this.lockData && this.lockData.serving;
      if (!s || !s.pci || !s.arfcn) return null;
      var isNR = /NR5G/.test(s.rat || "");
      var t = { rat: isNR ? "5g" : "4g", pci: s.pci, freq: s.arfcn,
                band: s.band, label: "current cell PCI " + s.pci };
      if (isNR) {
        var match = (this.scan.towers || []).filter(function (tw) {
          return String(tw.pci) === String(s.pci) && String(tw.freq) === String(s.arfcn);
        })[0];
        if (match && match.scs !== undefined) { t.scs = Number(match.scs); t.scsAssumed = false; }
        else { t.scs = this.scsFor(s.band); t.scsAssumed = true; }
        if (t.scs === undefined) return null;   // unknown band: refuse rather than guess
      }
      return t;
    },
    lockCell(target) {
      var self = this;
      if (this.lockBusy || this.pending || !target) return;
      this.lockBusy = true; this.lockError = "";
      var args = { rat: target.rat, pci: target.pci, freq: target.freq };
      if (target.scs !== undefined) args.scs = target.scs;
      if (target.band !== undefined) args.band = target.band;
      if (target.extra) args.extra = target.extra;
      window.$rpcRequest("call", ["sid", "mudimodem", "set_cell_lock", args], { timeout: 30000 })
        .then(function (res) {
          if (!res || res.error) { self.lockError = (res && res.error) || "lock failed"; return; }
          self.lockConfirm = null;
          self.startCountdown(res.window || 60, res.applied, "cell");
        })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "lock failed"; })
        .then(function () { self.lockBusy = false; });
    },
    unlockCell() {
      var self = this;
      if (this.lockBusy || this.pending) return;
      this.lockBusy = true; this.lockError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "clear_cell_lock", {}], { timeout: 30000 })
        .then(function (res) {
          if (res && res.error) { self.lockError = res.error; return; }
          self.fetchLock();
        })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "unlock failed"; })
        .then(function () { self.lockBusy = false; });
    },

    // The interactive RATs (each maps to a set_bands arg).
    interactive(group) { return group === "sa" || group === "nsa" || group === "LTE"; },
    argKey(group) { return group === "LTE" ? "lte" : group; },   // set_bands arg name
    // Which RATs a given network mode actually enables (NSA needs an LTE anchor).
    modeEnables(group, mode) {
      if (group === "sa") return mode === "AUTO" || mode === "NR5G";
      if (group === "nsa") return mode === "AUTO";
      if (group === "LTE") return mode === "AUTO" || mode === "LTE";
      return false;
    },
    ratActive(group) { return this.modeEnables(group, this.selMode); },
    setMode(m) { if (!this.pending) this.selMode = m; },
    modeChanged() { return this.bands && this.selMode !== ((this.bands.meta && this.bands.meta.mode) || "AUTO"); },
    // Only policy-permitted bands are selectable; blocked ones never take.
    selectable(group, b) {
      if (!this.interactive(group) || !this.bands) return false;
      return (this.bands.policy[group] || []).indexOf(b) !== -1;
    },
    isSelected(group, b) {
      var s = this.sel[group];
      return s && s.indexOf(b) !== -1;
    },
    toggleBand(group, b) {
      if (this.pending || !this.sel[group]) return;   // locked during a pending revert
      var i = this.sel[group].indexOf(b);
      if (i === -1) this.sel[group].push(b); else this.sel[group].splice(i, 1);
    },
    selectAll(group) {
      if (this.pending || !this.bands) return;
      this.sel[group] = (this.bands.policy[group] || []).slice();   // all permitted
    },
    selectNone(group) {
      if (this.pending) return;
      this.sel[group] = [];
    },
    invertSel(group) {
      if (this.pending || !this.bands) return;
      var perm = this.bands.policy[group] || [], cur = this.sel[group] || [];
      this.sel[group] = perm.filter(function (b) { return cur.indexOf(b) === -1; });
    },
    changed(group) {
      if (!this.bands || !this.sel[group]) return false;
      var cur = this.seedFor(group).sort(function (a, b) { return a - b; });
      var sel = this.sel[group].slice().sort(function (a, b) { return a - b; });
      if (cur.length !== sel.length) return true;
      for (var i = 0; i < cur.length; i++) if (cur[i] !== sel[i]) return true;
      return false;
    },
    changedAny() {
      return this.changed("sa") || this.changed("nsa") || this.changed("LTE") || this.modeChanged();
    },
    emptyChange() {
      // an edited RAT with zero bands selected — not allowed (would drop the RAT)
      return (this.changed("sa") && this.sel.sa.length === 0) ||
             (this.changed("nsa") && this.sel.nsa.length === 0) ||
             (this.changed("LTE") && this.sel.LTE.length === 0);
    },

    applyBands() {
      var self = this;
      if (this.applying || !this.changedAny() || this.emptyChange()) return;
      if (typeof window === "undefined" || !window.$rpcRequest) return;
      var payload = {};
      if (this.changed("sa")) payload.sa = this.sel.sa.slice();
      if (this.changed("nsa")) payload.nsa = this.sel.nsa.slice();
      if (this.changed("LTE")) payload.lte = this.sel.LTE.slice();
      if (this.modeChanged()) payload.mode = this.selMode;
      this.applying = true;
      this.applyError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "set_bands", payload], { timeout: 20000 })
        .then(function (res) {
          if (!res || res.error) { self.applyError = (res && res.error) || "apply failed"; return; }
          self.startCountdown(res.window || 60, res.applied);
        })
        .catch(function (e) { self.applyError = (e && (e.type || e.message)) || "apply failed"; })
        .then(function () { self.applying = false; });
    },
    // kind defaults to "bands" so the existing bands call sites keep working
    // unchanged; the cell-lock flow passes "cell" so the banner + refetch land
    // on the right tab (§renderRevert / renderBands / renderLock).
    startCountdown(window_s, applied, kind) {
      var self = this;
      this.clearCountdown();
      this.pending = { kind: kind || "bands", remaining: window_s, window: window_s,
                       applied: applied, done: false };
      this.cdTimer = setInterval(function () {
        if (!self.pending) return;
        self.pending.remaining -= 1;
        if (self.pending.remaining <= 0) {
          // The watchdog has reverted server-side. Reflect it and re-read.
          var k = self.pending.kind;
          self.clearCountdown();
          self.pending = { kind: k, done: true, reverted: true };
          if (k === "cell") self.fetchLock(); else self.fetchBands();
          setTimeout(function () { self.pending = null; }, 4000);
        }
      }, 1000);
    },
    clearCountdown() {
      if (this.cdTimer) { clearInterval(this.cdTimer); this.cdTimer = null; }
    },
    keepBands() {
      var self = this;
      this.clearCountdown();
      window.$rpcRequest("call", ["sid", "mudimodem", "confirm", {}])
        .then(function () {}).catch(function () {})
        .then(function () {
          var k = self.pending && self.pending.kind;
          self.pending = null;
          if (k === "cell") self.fetchLock(); else self.fetchBands();
        });
    },
    revertBands() {
      var self = this;
      this.clearCountdown();
      var k = this.pending && this.pending.kind;
      this.pending = { kind: k, done: true, reverting: true };
      window.$rpcRequest("call", ["sid", "mudimodem", "revert_now", {}], { timeout: 20000 })
        .then(function () {}).catch(function () {})
        .then(function () {
          self.pending = null;
          if (k === "cell") self.fetchLock(); else self.fetchBands();
        });
    },

    // Classify one band for the read-only groups: active / permitted / blocked.
    bandState(group, b) {
      var d = this.bands;
      var has = function (list, x) { return (list || []).indexOf(x) !== -1; };
      if (has(d.capability[group], b)) return "active";
      if (has(d.policy[group], b)) return "permitted";
      return "blocked";
    },
    tracePath() {
      var pts = this.trace, n = pts.length;
      if (n < 2) return "";
      var FLOOR = -120, CEIL = -80, W = 320, H = 40;
      var step = W / (this.TRACE_MAX - 1);
      var y = function (v) {
        var cl = Math.max(FLOOR, Math.min(CEIL, v));
        return (H - ((cl - FLOOR) / (CEIL - FLOOR)) * H).toFixed(1);
      };
      var off = this.TRACE_MAX - n, d = "";
      for (var i = 0; i < n; i++) {
        d += (i === 0 ? "M" : "L") + ((off + i) * step).toFixed(1) + "," + y(pts[i]);
      }
      return d;
    },
    injectStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(this.styleId)) return;
      var css =
        '.mm{color:var(--text-regular);font-variant-numeric:tabular-nums}' +
        '.mm-strip{display:flex;align-items:stretch;background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);margin-bottom:11px;overflow:hidden}' +
        '.mm-trace{flex:1;min-width:0;padding:9px 0 6px 13px}' +
        '.mm-eyebrow{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mm-plot{height:40px;margin-top:3px}.mm-plot svg{display:block;width:100%;height:100%;overflow:visible}' +
        '.mm-axis{display:flex;justify-content:space-between;font-size:9.5px;color:var(--text-hint);margin-top:2px}' +
        '.mm-read{flex:none;min-width:120px;padding:10px 14px 9px 15px;text-align:right;border-left:1px solid var(--divider);display:flex;flex-direction:column;justify-content:center}' +
        '.mm-rsrp{font-size:29px;font-weight:600;line-height:1;letter-spacing:-.025em}.mm-rsrp .u{font-size:11px;font-weight:500;color:var(--text-hint);margin-left:2px}' +
        '.mm-facts{display:flex;gap:13px;justify-content:flex-end;margin-top:7px}' +
        '.mm-facts .k{display:block;font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-badge)}.mm-facts b{font-size:12.5px;font-weight:600}' +
        '.mm-tabs{display:flex;gap:22px;border-bottom:1px solid var(--divider);margin-bottom:11px;padding:0 4px}' +
        '.mm-tab{background:none;border:0;padding:9px 0 8px;font:inherit;font-size:13px;cursor:pointer;color:var(--text-weak);border-bottom:2px solid transparent;margin-bottom:-1px}' +
        '.mm-tab.on{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}' +
        '.mm-tab:disabled{color:var(--text-hint);cursor:default}' +
        '.mm-card{background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);padding:13px 14px}' +
        '.mm-sect{font-size:13px;font-weight:600;color:var(--text-title)}.mm-hint{font-size:11.5px;color:var(--text-badge)}' +
        '.mm-dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px 16px;margin-top:11px}' +
        '.mm-dl .k{display:block;font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}.mm-dl b{font-size:13px;font-weight:600;color:var(--text-title)}' +
        '.mm-soon{padding:26px 14px;text-align:center;color:var(--text-hint);font-size:12px;line-height:1.6}' +
        '.mm-empty{padding:30px 14px;text-align:center;color:var(--text-hint);font-size:12.5px}' +
        // band grid
        '.mm-grp{margin-bottom:15px}.mm-grp:last-child{margin-bottom:2px}' +
        '.mm-grp-h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}' +
        '.mm-grp-t{font-size:12px;font-weight:600;color:var(--text-title)}' +
        '.mm-acts{display:flex;gap:2px}' +
        '.mm-act{background:none;border:0;font:inherit;font-size:10.5px;cursor:pointer;color:var(--primary);padding:2px 6px;border-radius:3px}' +
        '.mm-act:hover{background:var(--primary-background)}' +
        '.mm-grp-off .mm-wrap{opacity:.5}' +
        '.mm-gate{font-size:10.5px;color:var(--warning-hover);background:var(--warning-background);border:1px solid var(--warning-disabled);border-radius:3px;padding:4px 8px;margin-bottom:6px}' +
        '.mm-seg{display:inline-flex;border:1px solid var(--border);border-radius:4px;overflow:hidden}' +
        '.mm-seg-b{font:inherit;font-size:12px;background:transparent;border:0;padding:5px 14px;cursor:pointer;color:var(--text-weak);border-right:1px solid var(--border)}' +
        '.mm-seg-b:last-child{border-right:0}' +
        '.mm-seg-b.on{background:var(--primary);color:#fff;font-weight:600}' +
        '.mm-seg-b:disabled{cursor:default;opacity:.6}' +
        '.mm-wrap{display:flex;gap:4px;flex-wrap:wrap}' +
        '.mm-band{position:relative;min-width:44px;padding:4px 6px 3px;text-align:center;border:1px solid var(--border);border-radius:4px;background:var(--background-card);transition:border-color .1s,background .1s}' +
        '.mm-band b{display:block;font-size:12px;font-weight:600;line-height:1.2}.mm-band s{display:block;font-size:9px;line-height:1.2;color:var(--text-hint);text-decoration:none}' +
        // read-only states
        '.mm-band.active{background:var(--success);border-color:var(--success)}.mm-band.active b{color:#fff}.mm-band.active s{color:rgba(255,255,255,.75)}' +
        '.mm-band.permitted{border-color:var(--primary)}.mm-band.permitted b{color:var(--primary)}' +
        // interactive states
        '.mm-band.sel{background:var(--success);border-color:var(--success)}.mm-band.sel b{color:#fff}.mm-band.sel s{color:rgba(255,255,255,.75)}' +
        '.mm-band.unsel b{color:var(--text-regular)}' +
        '.mm-band.blocked{opacity:.5}.mm-band.blocked b{color:var(--text-hint);text-decoration:line-through}' +
        '.mm-band.clickable{cursor:pointer}.mm-band.clickable:hover{border-color:var(--primary)}' +
        '.mm-band.serving{box-shadow:0 0 0 2px var(--success)}' +
        '.mm-band.serving::after{content:"";position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--success);border:1.5px solid var(--background-card)}' +
        '.mm-axis2{display:flex;justify-content:space-between;font-size:9.5px;color:var(--text-hint);margin-top:6px}' +
        '.mm-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:10.5px;color:var(--text-badge);margin-top:12px;padding-top:10px;border-top:1px solid var(--divider)}' +
        '.mm-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}' +
        // apply + revert
        '.mm-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--divider);padding-top:11px;margin-top:11px}' +
        '.mm-btn{font:inherit;font-size:11.5px;font-weight:600;border-radius:3px;padding:6px 13px;cursor:pointer;border:1px solid transparent}' +
        '.mm-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}' +
        '.mm-btn.primary:disabled{background:var(--primary-disabled);border-color:transparent;cursor:default}' +
        '.mm-btn.keep{background:var(--warning);color:#fff;border-color:var(--warning)}' +
        '.mm-btn.danger{background:transparent;color:var(--error);border-color:var(--error)}' +
        '.mm-revert{background:var(--warning-background);border:1px solid var(--warning);border-radius:3px;padding:9px 11px;margin:0 0 12px}' +
        '.mm-revert-row{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:11.5px;color:var(--warning-hover)}' +
        '.mm-revert b{font-weight:600}.mm-cd{font-variant-numeric:tabular-nums}' +
        '.mm-bar{height:2px;background:var(--warning-disabled);border-radius:1px;margin-top:8px;overflow:hidden}.mm-bar i{display:block;height:100%;background:var(--warning);transition:width 1s linear}' +
        '@media(max-width:640px){.mm-strip{flex-direction:column}.mm-read{border-left:0;border-top:1px solid var(--divider);text-align:left;align-items:flex-start}.mm-facts{justify-content:flex-start}.mm-revert-row{flex-direction:column;align-items:flex-start}}';
      var el = document.createElement("style");
      el.id = this.styleId; el.textContent = css;
      document.head.appendChild(el);
    },

    // ---- band grid render helpers ----
    // sa + LTE are interactive (set_bands writes them); nsa stays read-only.
    renderGroup(h, group, title) {
      var self = this, d = this.bands;
      var interactive = this.interactive(group);
      var supported = (d.supported[group] || []).slice();
      supported.sort(function (a, b) {
        var fa = self.freqOf(group, a), fb = self.freqOf(group, b);
        if (fa === undefined) fa = 1e9; if (fb === undefined) fb = 1e9;
        return (fa - fb) || (a - b);
      });
      if (supported.length === 0) return null;
      var pre = this.prefixOf(group);
      var chips = supported.map(function (b) {
        var serving = (self.servingGroup === group && String(self.serving.band) === String(b));
        var f = self.freqOf(group, b);
        var cls, tip;
        if (interactive) {
          if (!self.selectable(group, b)) {
            cls = "blocked"; tip = pre + b + " blocked by carrier policy; selecting has no effect";
          } else if (self.isSelected(group, b)) {
            cls = "sel"; tip = pre + b + " allowed (click to remove)";
          } else {
            cls = "unsel"; tip = pre + b + " permitted (click to allow)";
          }
        } else {
          var st = self.bandState(group, b);
          cls = st;
          tip = pre + b + " " + ({ active: "in use", permitted: "permitted, not active", blocked: "blocked by carrier policy" })[st];
        }
        var clickable = interactive && cls !== "blocked" && !self.pending;
        return h("span", {
          key: b,
          staticClass: "mm-band " + cls + (serving ? " serving" : "") + (clickable ? " clickable" : ""),
          attrs: { title: tip },
          on: clickable ? { click: function () { self.toggleBand(group, b); } } : {}
        }, [h("b", pre + b), h("s", f ? String(f) : " ")]);
      });
      // per-group actions (interactive groups only): All / None / Invert
      var actions = null;
      if (interactive && !this.pending) {
        var mkAct = function (label, fn) {
          return h("button", { staticClass: "mm-act", on: { click: fn } }, label);
        };
        actions = h("span", { staticClass: "mm-acts" }, [
          mkAct("All", function () { self.selectAll(group); }),
          mkAct("None", function () { self.selectNone(group); }),
          mkAct("Invert", function () { self.invertSel(group); })
        ]);
      }
      var counts = (d.supported[group] || []).length + " supported / " +
        (d.policy[group] || []).length + " permitted / " + (d.capability[group] || []).length + " active";
      // Mode gate: if the selected mode doesn't enable this RAT, say so — the
      // selections are inert until the mode includes it.
      var gate = null;
      if (interactive && !this.ratActive(group)) {
        var need = group === "nsa" ? "Auto" : (group === "LTE" ? "Auto or 4G only" : "Auto or 5G only");
        gate = h("div", { staticClass: "mm-gate" },
          "Off under " + this.selMode + " mode - these won't apply. Set mode to " + need + " to use them.");
      }
      return h("div", { staticClass: "mm-grp" + (gate ? " mm-grp-off" : ""), key: group }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, title + (interactive ? "" : "  (read-only)")),
          actions || h("span", { staticClass: "mm-hint" }, counts)
        ]),
        interactive ? h("div", { staticClass: "mm-hint", staticStyle: { margin: "-3px 0 6px" } }, counts) : null,
        gate,
        h("div", { staticClass: "mm-wrap" }, chips),
        h("div", { staticClass: "mm-axis2" }, [
          h("span", "low band, reaches far"),
          h("span", "high band, fast + short range")
        ])
      ]);
    },

    // The network-mode selector (Auto / 5G only / 4G only).
    renderMode(h) {
      var self = this, cur = this.selMode;
      var opts = [["AUTO", "Auto"], ["NR5G", "5G only"], ["LTE", "4G only"]];
      return h("div", { staticClass: "mm-grp" }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, "Network mode"),
          this.modeChanged()
            ? h("span", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)" } }, "changed")
            : h("span", { staticClass: "mm-hint" }, "which radios the modem may use")
        ]),
        h("div", { staticClass: "mm-seg" }, opts.map(function (o) {
          return h("button", {
            key: o[0],
            staticClass: "mm-seg-b" + (cur === o[0] ? " on" : ""),
            attrs: { disabled: !!self.pending },
            on: { click: function () { self.setMode(o[0]); } }
          }, o[1]);
        }))
      ]);
    },

    // Confirm-or-revert banner (design C1: inline, on the tab that caused it).
    renderRevert(h) {
      var self = this, p = this.pending;
      if (p.done) {
        var doneMsg = p.reverting ? "Reverting..." :
          (p.reverted ? (p.kind === "cell" ? "Reverted - cell lock removed." : "Reverted - restored your previous bands.") : "");
        return h("div", { staticClass: "mm-revert" }, [
          h("span", { staticClass: "mm-revert-row" }, doneMsg)
        ]);
      }
      // Summarise what changed (applied = { mode, sa, nsa, lte } for bands;
      // { rat, pci, freq } for a cell lock).
      var a = p.applied || {}, bits = [];
      if (p.kind === "cell") {
        bits.push((a.rat === "4g" ? "LTE" : "5G") + " cell PCI " + a.pci + " / ARFCN " + a.freq);
      } else {
        if (a.mode) bits.push("mode " + a.mode);
        if (a.sa) bits.push("5G-SA " + a.sa.split(":").map(function (b) { return "n" + b; }).join(" "));
        if (a.nsa) bits.push("5G-NSA " + a.nsa.split(":").map(function (b) { return "n" + b; }).join(" "));
        if (a.lte) bits.push("LTE " + a.lte.split(":").map(function (b) { return "B" + b; }).join(" "));
      }
      var pct = Math.max(0, Math.min(100, (p.remaining / p.window) * 100));
      return h("div", { staticClass: "mm-revert" }, [
        h("div", { staticClass: "mm-revert-row" }, [
          h("span", [
            "Applied ", h("b", bits.join("; ") || "band change"),
            ". Reverting in ", h("b", { staticClass: "mm-cd" }, String(p.remaining) + "s"),
            " unless you keep it - watch the trace above."
          ]),
          h("span", { staticStyle: { flex: "none", display: "flex", gap: "6px" } }, [
            h("button", { staticClass: "mm-btn danger", on: { click: function () { self.revertBands(); } } }, "Revert now"),
            h("button", { staticClass: "mm-btn keep", on: { click: function () { self.keepBands(); } } }, "Keep")
          ])
        ]),
        h("div", { staticClass: "mm-bar" }, [h("i", { staticStyle: { width: pct.toFixed(1) + "%" } })])
      ]);
    },

    renderBands(h) {
      if (this.bandsLoading) return h("div", { staticClass: "mm-empty" }, "Reading band configuration from the modem...");
      if (this.bandsError) return h("div", { staticClass: "mm-empty" }, "Couldn't read bands: " + this.bandsError);
      if (!this.bands) return h("div", { staticClass: "mm-empty" }, "...");
      var d = this.bands, self = this;
      var groups = [
        this.renderMode(h),
        this.renderGroup(h, "sa", "5G NR standalone"),
        this.renderGroup(h, "nsa", "5G NR non-standalone"),
        this.renderGroup(h, "LTE", "LTE")
      ].filter(Boolean);
      var op = (d.meta && d.meta.plmn) ? d.meta.plmn : "carrier";
      var warn = (d.meta && d.meta.plmn_matched === false)
        ? h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)", marginTop: "2px" } },
            "Couldn't confirm which SIM answered - values may be for the other slot")
        : null;
      var head = [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Bands"),
          h("span", [
            h("span", { staticClass: "mm-hint", staticStyle: { marginRight: "10px" } }, "carrier " + op),
            h("button", {
              staticClass: "mm-tab", staticStyle: { fontSize: "11.5px", padding: "2px 0", borderBottom: "0" },
              attrs: { disabled: !!this.pending },
              on: { click: function () { if (!self.pending) self.fetchBands(); } }
            }, self.bandsLoading ? "refreshing..." : "refresh")
          ])
        ]),
        h("div", { staticClass: "mm-hint", staticStyle: { margin: "3px 0 12px" } },
          "Choose the network mode and which 5G/LTE bands the modem may use. Blocked bands are ones " +
          "the module supports but your carrier forbids - they can't be selected because they never take."),
        warn,
        (this.pending && this.pending.kind !== "cell") ? this.renderRevert(h) : null
      ];
      var footer = [];
      if (!this.pending) {
        var changed = this.changedAny();
        var empty = this.emptyChange();
        var status;
        if (this.applyError) status = h("span", { staticStyle: { color: "var(--error)" } }, this.applyError);
        else if (empty) status = h("span", { staticStyle: { color: "var(--error)" } }, "Each edited band group needs at least one band");
        else if (changed) {
          var parts = [];
          if (this.modeChanged()) parts.push("mode -> " + this.selMode);
          if (this.changed("sa")) parts.push(this.sel.sa.length + " SA");
          if (this.changed("nsa")) parts.push(this.sel.nsa.length + " NSA");
          if (this.changed("LTE")) parts.push(this.sel.LTE.length + " LTE");
          status = parts.join(" + ") + " changed; applies with a 60s revert";
        } else status = "No changes";
        footer.push(h("div", { staticClass: "mm-foot" }, [
          h("span", { staticClass: "mm-hint" }, [status]),
          h("button", {
            staticClass: "mm-btn primary",
            attrs: { disabled: !changed || this.applying || empty },
            on: { click: function () { self.applyBands(); } }
          }, this.applying ? "Applying..." : "Apply")
        ]));
      }
      var legend = [h("div", { staticClass: "mm-legend" }, [
        h("span", [h("i", { staticStyle: { background: "var(--success)" } }), "allowed"]),
        h("span", [h("i", { staticStyle: { background: "transparent", border: "1px solid var(--border)" } }), "permitted, not selected"]),
        h("span", [h("i", { staticStyle: { background: "var(--text-hint)" } }), "blocked by policy"]),
        h("span", "ring = serving now")
      ])];
      return h("div", { staticClass: "mm-card" }, head.filter(Boolean).concat(groups).concat(footer).concat(legend));
    },

    // ---- cell-lock render helpers ----
    renderCurrentCell(h) {
      var self = this, d = this.lockData;
      var s = d.serving || {};
      var l5 = (d.lock && d.lock.l5g) || {}, l4 = (d.lock && d.lock.l4g) || {};
      var locked = !!(l5.locked || l4.locked || (d.gl && d.gl.locked));
      var rows = [];
      var push = function (k, v) { if (v !== undefined && v !== null && v !== "") rows.push([k, v]); };
      push("RAT", s.rat); push("PCI", s.pci); push("ARFCN", s.arfcn);
      push("Band", s.band !== undefined ? ((/NR5G/.test(s.rat || "") ? "n" : "B") + s.band) : null);
      push("Cell ID", s.cell_id);
      push("RSRP", this.serving.rsrp !== undefined ? this.serving.rsrp + " dBm" : null);
      push("SINR", this.serving.sinr !== undefined ? this.serving.sinr + " dB" : null);

      var action;
      if (locked) {
        // Prefer whichever AT-side lock is actually set; if the lock is known
        // only via GL's store (d.gl.locked, with both l4g/l5g reading unlocked
        // — a documented GL/AT disagreement), fall back to GL's stored tower
        // rather than rendering l4g's empty pci/freq as "undefined".
        var lk = l5.locked ? l5 : (l4.locked ? l4 : ((d.gl && d.gl.tower) || {}));
        var hasPci = lk.pci !== undefined && lk.pci !== null;
        var hasFreq = lk.freq !== undefined && lk.freq !== null;
        var lockedDetail;
        if (hasPci && hasFreq) lockedDetail = " to PCI " + lk.pci + " / ARFCN " + lk.freq;
        else if (hasPci) lockedDetail = " to PCI " + lk.pci;
        else if (hasFreq) lockedDetail = " to ARFCN " + lk.freq;
        else lockedDetail = " (details unavailable)";
        var lockedSuffix = (hasPci || hasFreq) && lk.band ? " (n" + lk.band + ")" : "";
        action = h("div", { staticClass: "mm-foot" }, [
          h("span", { staticClass: "mm-hint" }, [
            h("b", { staticStyle: { color: "var(--success)" } }, "Locked"),
            lockedDetail + lockedSuffix + ". The modem will not hand over."
          ]),
          h("button", {
            staticClass: "mm-btn danger",
            attrs: { disabled: this.lockBusy || !!this.pending },
            on: { click: function () { self.unlockCell(); } }
          }, this.lockBusy ? "Unlocking..." : "Unlock")
        ]);
      } else {
        var target = this.pinTarget();
        if (this.lockConfirm && this.lockConfirm.pin) {
          action = h("div", { staticClass: "mm-foot" }, [
            h("span", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)" } },
              "Lock to PCI " + target.pci + "? Network mode switches to " +
              (target.rat === "5g" ? "5G-only" : "4G-preferred") + " until unlocked." +
              (target.scsAssumed ? " SCS " + target.scs + " kHz is assumed from the band." : "") +
              " Auto-reverts in 60s unless kept."),
            h("span", { staticStyle: { flex: "none", display: "flex", gap: "6px" } }, [
              h("button", { staticClass: "mm-btn", on: { click: function () { self.lockConfirm = null; } } }, "Cancel"),
              h("button", {
                staticClass: "mm-btn primary", attrs: { disabled: this.lockBusy || !!this.pending },
                on: { click: function () { self.lockCell(target); } }
              }, this.lockBusy ? "Locking..." : "Lock it")
            ])
          ]);
        } else {
          action = h("div", { staticClass: "mm-foot" }, [
            h("span", { staticClass: "mm-hint" },
              "Pin the modem to the cell it is using now - the safest lock target."),
            h("button", {
              staticClass: "mm-btn primary",
              attrs: { disabled: !target || this.lockBusy || !!this.pending },
              on: { click: function () { self.lockConfirm = { pin: true }; } }
            }, "Lock to this cell")
          ]);
        }
      }
      return h("div", { staticClass: "mm-grp" }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, "Current cell"),
          h("span", { staticClass: "mm-hint" }, locked ? "locked" : "serving now")
        ]),
        h("div", { staticClass: "mm-dl" }, rows.map(function (r, i) {
          return h("div", { key: i }, [h("span", { staticClass: "k" }, r[0]), h("b", String(r[1]))]);
        })),
        action
      ]);
    },

    renderLock(h) {
      if (this.lockLoading && !this.lockData)
        return h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-empty" }, "Reading lock state from the modem...")]);
      if (this.lockError && !this.lockData)
        return h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-empty" }, "Couldn't read lock state: " + this.lockError)]);
      if (!this.lockData)
        return h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-empty" }, "...")]);
      var kids = [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Cell lock"),
          h("button", {
            staticClass: "mm-tab", staticStyle: { fontSize: "11.5px", padding: "2px 0", borderBottom: "0" },
            attrs: { disabled: !!this.pending },
            on: { click: this.fetchLock }
          }, this.lockLoading ? "refreshing..." : "refresh")
        ]),
        (this.pending && this.pending.kind === "cell") ? this.renderRevert(h) : null,
        this.lockError && this.lockData
          ? h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } }, this.lockError) : null,
        this.renderCurrentCell(h)
        // Task 5 appends: this.renderScanCard(h)
        // Task 6 appends: stale banner + this.renderRecovery(h)
      ];
      return h("div", { staticClass: "mm-card" }, kids.filter(Boolean));
    }
  },

  render(h) {
    var self = this, c = this.serving;
    // Open the in-page Tracking tab (lazy-loads the graph chunk). Shared by the
    // Tracking tab button and the strip's live sparkline.
    var openTracking = function () { self.openTracking(); };

    // ---- status strip ----
    var stripKids;
    if (this.hasData) {
      var rsrpColor = this.qColor(this.rsrpQ);
      stripKids = [
        h("div", {
          staticClass: "mm-trace",
          staticStyle: { cursor: "pointer" },
          attrs: { title: "Open Tracking" },
          on: { click: openTracking }
        }, [
          h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
            h("span", { staticClass: "mm-eyebrow" }, "RSRP live"),
            h("span", {
              staticClass: "mm-eyebrow",
              staticStyle: { color: "var(--primary)", letterSpacing: ".03em" }
            }, "Tracking ↗")
          ]),
          h("div", { staticClass: "mm-plot" }, [
            h("svg", { attrs: { viewBox: "0 0 320 40", preserveAspectRatio: "none" } }, [
              h("path", { attrs: {
                d: this.tracePath(), fill: "none", stroke: rsrpColor,
                "stroke-width": "1.75", "stroke-linejoin": "round", "stroke-linecap": "round"
              } })
            ])
          ]),
          h("div", { staticClass: "mm-axis" }, [
            h("span", "-120"),
            h("span", (c.mode || "") + (this.servingCarrier ? "  " + this.servingCarrier : "") +
              (this.activeSlot ? "  SIM " + this.activeSlot : "")),
            h("span", "-80 dBm")
          ])
        ]),
        h("div", { staticClass: "mm-read" }, [
          h("div", { staticClass: "mm-rsrp", style: { color: rsrpColor } }, [
            String(c.rsrp), h("span", { staticClass: "u" }, "dBm")
          ]),
          h("div", { staticClass: "mm-facts" }, [
            h("div", [h("span", { staticClass: "k" }, "SINR"),
              h("b", { style: { color: this.qColor(this.sinrQ) } }, c.sinr !== undefined ? String(c.sinr) : "-")]),
            h("div", [h("span", { staticClass: "k" }, "RSRQ"),
              h("b", { style: { color: this.qColor(this.rsrqQ) } }, c.rsrq !== undefined ? String(c.rsrq) : "-")]),
            h("div", [h("span", { staticClass: "k" }, "Band"), h("b", this.bandLabel)])
          ])
        ])
      ];
    } else {
      var slot = this.activeSlot;
      stripKids = [h("div", { staticClass: "mm-empty" },
        (slot && this.anyNetwork)
          ? "SIM " + slot + " (active) is not registered on a network right now" +
            (this.servingCarrier ? " - " + this.servingCarrier : "") + "."
          : "Waiting for the modem's first status push over the websocket...")];
    }
    var strip = h("div", { staticClass: "mm-strip" }, stripKids);

    // ---- tabs ----
    // "tracking" is an in-page tab like the rest — the strip + tab bar stay put;
    // its graph chunk is lazy-loaded into the panel on first open.
    var TABS = [["diag", "Diagnostics"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"], ["tracking", "Tracking"]];
    var tabs = h("div", { staticClass: "mm-tabs" }, TABS.map(function (t) {
      return h("button", {
        key: t[0], staticClass: "mm-tab" + (self.tab === t[0] ? " on" : ""),
        on: { click: function () { if (t[0] === "tracking") self.openTracking(); else self.tab = t[0]; } }
      }, t[1]);
    }));

    // ---- panel ----
    var panel;
    if (this.tab === "diag") {
      var m = this.modem;
      panel = h("div", { staticClass: "mm-card" }, [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Serving cell"),
          h("span", { staticClass: "mm-hint" }, m.name ? m.name + " live" : "live")
        ]),
        this.hasData
          ? h("div", { staticClass: "mm-dl" }, this.facts.map(function (f, i) {
              return h("div", { key: i }, [h("span", { staticClass: "k" }, f[0]), h("b", String(f[1]))]);
            }))
          : h("div", { staticClass: "mm-empty" }, "No serving-cell data yet.")
      ]);
    } else if (this.tab === "bands") {
      panel = this.renderBands(h);
    } else if (this.tab === "lock") {
      panel = this.renderLock(h);
    } else if (this.tab === "tracking") {
      if (this.trackingComp) {
        // Render the lazy-loaded graph as a child component. `embedded` tells it
        // to drop its own "← Modem" breadcrumb (redundant inside our tab bar).
        panel = h(this.trackingComp, { props: { embedded: true } });
      } else {
        panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" },
          this.trackingErr ? "Couldn't load the graph: " + this.trackingErr
            : "Loading the signal graph…")]);
      }
    } else {
      var soon = {
        at: "AT console + community library - Phase 3.",
        sim: "SIM / APN - Phase 4."
      }[this.tab];
      panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" }, soon)]);
    }

    return h("div", { staticClass: "mm" }, [strip, tabs, panel]);
  }
};
