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
// Writes: set_bands is confirm-or-revert via the mudimodem backend + watchdog.
// The SIM tab (Phase 4) instead writes browser-direct to GL's own undotted RPC
// (modem.set_sim_config — ALWAYS read-modify-write, the same object carries the
// band config; modem.set_slot_failover_config — also GL's slot-switch path,
// since QUIMSLOT does not exist on this modem). No backend, no AT, no sub_id.
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
      tab: "tracking",
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
      scanConfirm: false,   // explicit confirm gate before firing the disruptive scan
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
      // AT console tab: same lazy-chunk pattern as Tracking.
      consoleComp: null,
      consoleLoading: false,
      consoleErr: "",
      // ---- SIM tab (Phase 4) — all writes browser-direct to GL's own undotted
      // RPC (modem.*); zero mudimodem-backend involvement. Keys 1/2 are the two
      // physical slots, predeclared so plain assignment stays reactive.
      simCfg: { 1: null, 2: null },      // fresh get_sim_config per slot (the RMW base)
      simCfgErr: { 1: "", 2: "" },
      simEdit: { 1: null, 2: null },     // editable dial-profile fields per slot
      simReveal: { 1: true, 2: true },   // ICCID/IMSI/phone shown in full by default
                                         // (admin-only page); "Hide identifiers" masks them
      simApplying: 0,                    // slot with an Apply in flight, else 0
      simApplyErr: { 1: "", 2: "" },
      switchConfirm: 0,                  // slot awaiting "Use this SIM" confirm, else 0
      switchTarget: 0,                   // slot a switch is moving to, else 0
      switchErr: "",
      switchTimer: null,                 // fallback timer clearing the switching state
      failover: null,                    // get_slot_failover_config result (passthrough base)
      failoverEdit: null,                // editable copy
      failoverErr: "",
      failoverApplying: false,
      failoverConfirm: false,            // failover Apply would switch slots — confirm first
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
                     71: 15, 77: 30, 78: 30, 79: 30 },
      // Home-operator names for common PLMNs (MCC+MNC from sims_info). Labels
      // only — used for the "roaming on X" honesty line. Unknown → "MCC-MNC".
      PLMN: {
        "310260": "T-Mobile US", "312250": "T-Mobile US", "310410": "AT&T US",
        "310280": "AT&T US", "311480": "Verizon US", "313100": "FirstNet US",
        "20601": "Proximus BE", "20404": "Vodafone NL", "26201": "Telekom DE",
        "23430": "EE UK", "20801": "Orange FR", "22201": "TIM IT",
        "21407": "Movistar ES", "50501": "Telstra AU", "44010": "docomo JP",
        "302220": "Telus CA", "302610": "Bell CA", "302720": "Rogers CA"
      }
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
    // ---- SIM tab (Phase 4) ----
    // One view-model per physical slot: identity + registration + the two DSDS
    // facts GL never shows together (selected slot vs data-carrying slot).
    slotCards() {
      var self = this;
      var infos = this.ms("cellular.sims_info").sims || [];
      var stats = this.ms("cellular.sims_status").sims || [];
      var nets = this.ms("cellular.networks_status").networks || [];
      return [1, 2].map(function (slot) {
        var bySlot = function (arr) {
          return arr.filter(function (x) { return String(x.slot) === String(slot); })[0] || {};
        };
        var info = bySlot(infos), st = bySlot(stats), net = bySlot(nets);
        var home = self.plmnName(info.mcc, info.mnc);
        var named = !!self.PLMN[String(info.mcc || "") + String(info.mnc || "")];
        return {
          slot: slot,
          selected: String(self.activeSlot) === String(slot),
          data: net.dial_status === 1,
          reg: st.status,
          // A SIM is PRESENT per GL's own status codes (5 searching / 6 registered).
          // status 0 = No SIM: the modem may still report a stale/garbage iccid
          // during a re-scan, so never key identity/form off the iccid string.
          present: st.status === 5 || st.status === 6,
          carrier: st.carrier || "",
          home: home,
          // Roaming claim only when confident: registered, home PLMN known, and
          // the serving carrier's name doesn't contain the home name (or vice
          // versa — "T-Mobile" vs "T-Mobile US" is home, not roaming).
          roaming: st.status === 6 && named && !!st.carrier &&
            !self.nameOverlap(home, st.carrier),
          iccid: info.iccid || "", imsi: info.imsi || "",
          phone: info.phone_number || "",
          mcc: info.mcc || "", mnc: info.mnc || "",
          apn: st.apn || "",
          apnList: (info.apn_list || []).filter(function (a, i, arr) {
            return arr.indexOf(a) === i;
          })
        };
      });
    },
    // IP-type labels come from the modem itself over the websocket — never
    // hardcoded (supports_ip_type: 0 IPv4&IPv6 · 1 IPv4 · 2 IPv6 on this box).
    ipTypeOptions() { return this.modem.supports_ip_type || []; },
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
      if (t === "at" && !this.consoleComp && !this.consoleLoading) this.loadConsole();
      if (t === "sim") this.loadSimTab();
    },
    // A slot switch is done when GL's selected slot lands on the target.
    activeSlot(v) {
      if (this.switchTarget && String(v) === String(this.switchTarget)) {
        this.clearSwitchState();
        this.loadSimTab();   // fresh configs for the new arrangement
      }
    }
  },

  created() { this.injectStyle(); },
  mounted() {
    if (this.tab === "tracking") this.loadTracking();
    // Load the band/lock model up front so the banner's mode + tower badges have
    // data whatever tab we land on (the tab watcher only fires on a change).
    if (!this.bands && !this.bandsLoading) this.fetchBands();
  },
  beforeDestroy() { this.clearCountdown(); this.clearSwitchState(); },

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
    plmnName(mcc, mnc) {
      if (!mcc) return "";
      return this.PLMN[String(mcc) + String(mnc)] || (mcc + "-" + mnc);
    },
    // Case/punctuation-insensitive containment: "T-Mobile US" vs "T-Mobile".
    nameOverlap(a, b) {
      var n = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); };
      var x = n(a), y = n(b);
      return !!x && !!y && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1);
    },
    regLabel(reg) {
      if (reg === undefined || reg === null) return "—";
      return ({ 0: "No SIM", 5: "Not registered", 6: "Registered" })[reg] || ("Status " + reg);
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

    // Fetch + eval the AT-console chunk exactly like loadTracking above.
    loadConsole() {
      var self = this;
      if (this.consoleComp || this.consoleLoading) return;
      if (typeof window === "undefined" || !window.$axios) return;
      this.consoleLoading = true; this.consoleErr = "";
      window.$axios.get("/views/gl-sdk4-ui-mudimodem-console.common.js?_t=" + Date.now())
        .then(function (res) {
          var module = { exports: {} };            // eslint-disable-line no-unused-vars
          var comp = eval(res.data);               // chunk is `module.exports = {...}`
          if (!comp || typeof comp.render !== "function") throw new Error("bad chunk");
          self.consoleComp = comp; self.consoleLoading = false;
        })
        .catch(function (e) {
          self.consoleLoading = false;
          self.consoleErr = (e && e.message) || "load failed";
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
          self.fetchBands();   // refresh meta.lock so the banner tower badge updates
        })
        .catch(function (e) { self.lockError = (e && (e.type || e.message)) || "unlock failed"; })
        .then(function () { self.lockBusy = false; });
    },

    // Disruptive network scan (GL's scan_cells): takes the modem offline for
    // up to ~10 minutes. Only ever fired after an explicit scanConfirm. Stores
    // towers UNSORTED — renderScanCard sorts a slice at paint time so the raw
    // fetch order is never mutated under us.
    scanCells() {
      var self = this;
      if (this.scan.running || this.pending || this.lockBusy) return;
      this.scanConfirm = false;
      this.scan.running = true; this.scan.error = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "scan_cells", {}], { timeout: 600000 })
        .then(function (res) {
          if (!res || res.error) { self.scan.error = (res && res.error) || "scan failed"; return; }
          self.scan.towers = res.towers || [];   // renderScanCard sorts at paint time
          self.scan.ts = res.ts || Date.now();
        })
        .catch(function (e) { self.scan.error = (e && (e.type || e.message)) || "scan failed"; })
        .then(function () { self.scan.running = false; self.fetchLock(); });
    },
    // Lock target from a scan row: GL's own values verbatim, whole row as extra.
    scanTarget(row) {
      var isNR = /5G/.test(row.network_type || "");
      var t = { rat: isNR ? "5g" : "4g", pci: Number(row.pci), freq: Number(row.freq),
                band: row.band !== undefined ? Number(row.band) : undefined,
                label: "scanned cell PCI " + row.pci, extra: row };
      if (isNR) { t.scs = Number(row.scs); t.scsAssumed = false; }
      return t;
    },

    // ---- SIM tab (Phase 4) ----
    // Refetch on every tab entry: cheap, and the RMW base must be fresh anyway.
    loadSimTab() {
      this.fetchFailover();
      this.fetchSimCfg(1);
      this.fetchSimCfg(2);
    },
    fetchSimCfg(slot) {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return;
      var card = this.slotCards[slot - 1];
      // No SIM (or stale garbage during a rescan): nothing to fetch or edit.
      if (!card.present || !card.iccid) { this.simCfgErr[slot] = ""; this.simEdit[slot] = null; return; }
      window.$rpcRequest("call", ["sid", "modem", "get_sim_config",
        { slot: slot, bus: this.modem.bus, iccid: card.iccid }], { timeout: 30000 })
        .then(function (cfg) {
          self.simCfg[slot] = cfg;
          self.simEdit[slot] = {
            apn: cfg.apn || "", auth: cfg.auth || "NONE",
            username: cfg.username || "", password: cfg.password || "",
            ip_type: Number(cfg.ip_type || 0), roaming: !!cfg.roaming
          };
          self.simCfgErr[slot] = "";
        })
        .catch(function (e) {
          self.simCfgErr[slot] = (e && (e.type || e.message)) || "request failed";
        });
    },
    // RMW guard — the ONLY way a set_sim_config payload may be built. The same
    // object carries the band config (band_enable/band_filter_mode/band_list);
    // merging into a fresh read is what keeps the n71 lock unclobberable.
    mergeSimConfig(fresh, edits) {
      var out = {};
      for (var k in fresh) out[k] = fresh[k];
      out.apn = edits.apn;
      out.auth = edits.auth;
      out.username = edits.username;
      out.password = edits.password;
      out.ip_type = Number(edits.ip_type);
      out.roaming = !!edits.roaming;
      // GL coerces these to Number on its own writes; mirror it.
      if (out.ttl !== undefined) out.ttl = Number(out.ttl || 0);
      if (out.hl !== undefined) out.hl = Number(out.hl || 0);
      if (out.mtu !== undefined) out.mtu = Number(out.mtu || 0);
      return out;
    },
    fetchFailover() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) return;
      window.$rpcRequest("call", ["sid", "modem", "get_slot_failover_config",
        { bus: this.modem.bus }], { timeout: 30000 })
        .then(function (cfg) {
          self.failover = cfg;
          self.failoverEdit = {
            enable_switch: !!cfg.enable_switch,
            slot_priority: (cfg.slot_priority || [1, 2]).slice(),
            enable_timing: !!cfg.enable_timing,
            hour: cfg.hour != null ? String(cfg.hour) : "00",
            min: cfg.min != null ? String(cfg.min) : "00"
          };
          self.failoverErr = "";
        })
        .catch(function (e) {
          self.failoverErr = (e && (e.type || e.message)) || "request failed";
        });
    },
    askSwitch(slot) { this.switchConfirm = slot; this.switchErr = ""; },
    clearSwitchState() {
      this.switchTarget = 0;
      if (this.switchTimer) { clearTimeout(this.switchTimer); this.switchTimer = null; }
    },
    // GL's own UI switches slots by applying the failover config with
    // current_sim set — QUIMSLOT does not exist on this modem (GL-layer only).
    doSwitch(slot) {
      var self = this;
      if (this.switchTarget || typeof window === "undefined" || !window.$rpcRequest) return;
      this.switchConfirm = 0;
      this.switchErr = "";
      this.switchTarget = slot;
      window.$rpcRequest("call", ["sid", "modem", "get_slot_failover_config",
        { bus: this.modem.bus }], { timeout: 30000 })
        .then(function (cfg) {
          var payload = {};
          for (var k in cfg) payload[k] = cfg[k];        // esim2_enable, slot_type… intact
          payload.bus = self.modem.bus;
          payload.current_sim = slot;
          // GL's invariant: with auto-switch on, current_sim == slot_priority[0].
          if (payload.enable_switch) payload.slot_priority = [slot, slot === 1 ? 2 : 1];
          return window.$rpcRequest("call", ["sid", "modem", "set_slot_failover_config",
            payload], { timeout: 30000 });
        })
        .then(function () { self.armSwitchFallback(); })
        .catch(function (e) {
          // The data link drops mid-switch; a timeout here means "in progress",
          // not "failed" — keep waiting for the websocket to confirm.
          if (e && e.type === "timeout") { self.armSwitchFallback(); return; }
          self.clearSwitchState();
          self.switchErr = (e && (e.type || e.message)) || "request failed";
        });
    },
    armSwitchFallback() {
      var self = this;
      if (this.switchTimer) clearTimeout(this.switchTimer);
      // If the websocket never confirms (switch failed silently), stop showing
      // "Switching…" after 90 s and let the cards tell the truth again.
      this.switchTimer = setTimeout(function () { self.clearSwitchState(); }, 90000);
    },
    AUTHS() { return ["NONE", "PAP", "CHAP", "PAP/CHAP"]; },
    simDirty(slot) {
      var cfg = this.simCfg[slot], ed = this.simEdit[slot];
      if (!cfg || !ed) return false;
      return ed.apn !== (cfg.apn || "") || ed.auth !== (cfg.auth || "NONE") ||
        ed.username !== (cfg.username || "") || ed.password !== (cfg.password || "") ||
        Number(ed.ip_type) !== Number(cfg.ip_type || 0) || !!ed.roaming !== !!cfg.roaming;
    },
    applySim(slot) {
      var self = this;
      if (this.simApplying || typeof window === "undefined" || !window.$rpcRequest) return;
      var card = this.slotCards[slot - 1];
      if (!card.iccid || !this.simEdit[slot]) return;
      this.simApplying = slot;
      this.simApplyErr[slot] = "";
      // Fresh read immediately before the write, so every passthrough field
      // (band config included) is current — never write from a stale base.
      window.$rpcRequest("call", ["sid", "modem", "get_sim_config",
        { slot: slot, bus: this.modem.bus, iccid: card.iccid }], { timeout: 30000 })
        .then(function (fresh) {
          self.simCfg[slot] = fresh;
          var payload = self.mergeSimConfig(fresh, self.simEdit[slot]);
          payload.slot = slot;
          payload.bus = self.modem.bus;
          payload.iccid = card.iccid;
          return window.$rpcRequest("call", ["sid", "modem", "set_sim_config", payload],
            { timeout: 30000 });
        })
        .then(function () {
          self.simApplying = 0;
          self.fetchSimCfg(slot);   // re-seed edits from what actually stuck
        })
        .catch(function (e) {
          self.simApplying = 0;
          self.simApplyErr[slot] = (e && (e.type || e.message)) || "request failed";
        });
    },
    applyFailover(confirmed) {
      var self = this;
      if (this.failoverApplying || !this.failoverEdit ||
          typeof window === "undefined" || !window.$rpcRequest) return;
      var ed = this.failoverEdit;
      var base = this.failover || {};
      var payload = {};
      for (var k in base) payload[k] = base[k];          // esim2_enable, slot_type… intact
      payload.bus = this.modem.bus;
      payload.enable_switch = !!ed.enable_switch;
      payload.slot_priority = ed.slot_priority.slice();
      payload.enable_timing = !!ed.enable_timing;
      payload.hour = String(ed.hour);
      payload.min = String(ed.min);
      // GL's invariant: with auto-switch on, the preferred slot IS the current one.
      if (payload.enable_switch) payload.current_sim = payload.slot_priority[0];
      // If this apply would change the selected slot, it's a switch — same
      // consequence, same confirmation, no back door.
      var wouldSwitch = payload.current_sim &&
        String(payload.current_sim) !== String(this.activeSlot);
      if (wouldSwitch && !confirmed) { this.failoverConfirm = true; return; }
      this.failoverConfirm = false;
      this.failoverApplying = true;
      this.failoverErr = "";
      if (wouldSwitch) this.switchTarget = Number(payload.current_sim);
      window.$rpcRequest("call", ["sid", "modem", "set_slot_failover_config", payload],
        { timeout: 30000 })
        .then(function () {
          self.failoverApplying = false;
          if (wouldSwitch) self.armSwitchFallback(); else self.fetchFailover();
        })
        .catch(function (e) {
          self.failoverApplying = false;
          if (wouldSwitch && e && e.type === "timeout") { self.armSwitchFallback(); return; }
          if (wouldSwitch) self.clearSwitchState();
          self.failoverErr = (e && (e.type || e.message)) || "request failed";
        });
    },
    renderFailoverCard(h) {
      var self = this, ed = this.failoverEdit;
      var kids = [h("span", { staticClass: "mm-sect" }, "Failover")];
      if (!ed) {
        kids.push(h("div", { staticClass: "mm-hint" },
          this.failoverErr ? "Couldn't load failover config: " + this.failoverErr
            : "Loading failover config…"));
        return h("div", { staticClass: "mm-card", staticStyle: { marginTop: "11px" } }, kids);
      }
      var frow = function (label, ctl) {
        return h("div", { staticClass: "mm-frow" }, [h("span", { staticClass: "k" }, label), ctl]);
      };
      kids.push(frow("Auto failover", h("button", {
        staticClass: "mm-apnchip" + (ed.enable_switch ? " on" : ""),
        attrs: { "aria-pressed": String(!!ed.enable_switch) },
        on: { click: function () { ed.enable_switch = !ed.enable_switch; } }
      }, ed.enable_switch ? "On" : "Off")));
      var names = this.slotCards.map(function (c) {
        return "Slot " + c.slot + (c.carrier ? " · " + c.carrier : "");
      });
      kids.push(frow("Preferred order", h("button", {
        staticClass: "mm-apnchip",
        attrs: { title: "Swap priority" },
        on: { click: function () { ed.slot_priority = ed.slot_priority.slice().reverse(); } }
      }, ed.slot_priority.map(function (s) { return names[s - 1]; }).join("  →  "))));
      kids.push(frow("Scheduled switch to preferred", h("button", {
        staticClass: "mm-apnchip" + (ed.enable_timing ? " on" : ""),
        attrs: { "aria-pressed": String(!!ed.enable_timing) },
        on: { click: function () { ed.enable_timing = !ed.enable_timing; } }
      }, ed.enable_timing ? "On" : "Off")));
      if (ed.enable_timing) {
        kids.push(frow("At", h("input", {
          staticClass: "mm-input",
          attrs: { type: "time", value: ed.hour + ":" + ed.min },
          on: { input: function (ev) {
            var p = String(ev.target.value || "00:00").split(":");
            ed.hour = p[0] || "00"; ed.min = p[1] || "00";
          } }
        })));
      }
      if (this.failoverConfirm) {
        kids.push(h("div", { staticClass: "mm-switchbox" }, [
          h("div", "This change makes slot " + (ed.slot_priority[0]) + " the active SIM — " +
            "it drops connectivity for ~30 seconds."),
          h("div", { staticStyle: { display: "flex", gap: "9px", marginTop: "7px" } }, [
            h("button", { staticClass: "mm-apply", on: { click: function () { self.applyFailover(true); } } }, "Apply anyway"),
            h("button", { staticClass: "mm-reveal", on: { click: function () { self.failoverConfirm = false; } } }, "Cancel")
          ])
        ]));
      } else {
        kids.push(h("button", {
          staticClass: "mm-apply",
          attrs: { disabled: this.failoverApplying },
          on: { click: function () { self.applyFailover(); } }
        }, this.failoverApplying ? "Applying…" : "Apply"));
      }
      if (this.failoverErr && ed) {
        kids.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
          "Failover apply failed: " + this.failoverErr));
      }
      return h("div", { staticClass: "mm-card", staticStyle: { marginTop: "11px" } }, kids);
    },
    maskId(v) { return v ? String(v).slice(0, 4) + "…" : "—"; },
    renderSlotCard(h, card) {
      var self = this, slot = card.slot;
      var revealed = this.simReveal[slot];
      // Fact badges: Selected (mint) and Carrying data (indigo) are different
      // facts and never share a colour (spec §4). Registration is neutral/amber.
      var badges = [];
      if (card.selected) badges.push(h("span", { staticClass: "mm-badge b-sel" }, "Selected"));
      if (card.data) badges.push(h("span", { staticClass: "mm-badge b-data" }, "Carrying data"));
      badges.push(h("span", {
        staticClass: "mm-badge " + (card.reg === 6 ? "b-reg" : card.reg === 5 ? "b-warn" : "b-off")
      }, this.regLabel(card.reg)));

      var idRow = function (label, val) {
        return h("div", { staticClass: "mm-idrow" }, [
          h("span", { staticClass: "k" }, label),
          h("b", revealed ? (val || "—") : self.maskId(val))
        ]);
      };

      var kids = [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, card.present ? (card.carrier || card.home || ("SIM " + slot)) : "Empty"),
          h("span", { staticClass: "mm-hint" }, "Slot " + slot)
        ]),
        h("div", { staticClass: "mm-badges" }, badges)
      ];

      // Identity + form only when a SIM is actually present (status 5/6). A
      // status-0 slot renders as a clean Empty card even if the modem is still
      // reporting a stale iccid mid-rescan.
      if (card.present) {
        if (card.home) {
          kids.push(h("div", { staticClass: "mm-idrow" }, [
            h("span", { staticClass: "k" }, "Home operator"),
            h("b", card.home)
          ]));
        }
        if (card.roaming) {
          kids.push(h("div", {
            staticClass: "mm-hint",
            staticStyle: { color: "var(--warning)", margin: "2px 0 6px" }
          }, "Roaming on " + card.carrier));
        }
        kids.push(idRow("ICCID", card.iccid));
        kids.push(idRow("IMSI", card.imsi));
        if (card.phone) kids.push(idRow("Phone", card.phone));
        kids.push(h("button", {
          staticClass: "mm-reveal",
          on: { click: function () { self.simReveal[slot] = !revealed; } }
        }, revealed ? "Hide identifiers" : "Show identifiers"));
        kids.push(h("div", { staticClass: "mm-idrow" }, [
          h("span", { staticClass: "k" }, "APN in use"),
          h("b", card.apn || "—")
        ]));

        var ed = self.simEdit[slot];
        if (ed) {
          var frow = function (label, ctl) {
            return h("div", { staticClass: "mm-frow" }, [h("span", { staticClass: "k" }, label), ctl]);
          };
          var form = [
            frow("APN", h("input", {
              staticClass: "mm-input",
              attrs: { value: ed.apn, maxlength: 128, placeholder: "APN" },
              on: { input: function (ev) { ed.apn = ev.target.value; } }
            })),
            h("div", { staticClass: "mm-apnchips" }, card.apnList.map(function (a) {
              return h("button", {
                key: a,
                staticClass: "mm-apnchip" + (ed.apn === a ? " on" : ""),
                on: { click: function () { ed.apn = a; } }
              }, a);
            })),
            frow("Auth", h("select", {
              staticClass: "mm-select",
              attrs: { value: ed.auth },
              on: { change: function (ev) { ed.auth = ev.target.value; } }
            }, self.AUTHS().map(function (a) {
              return h("option", { key: a, attrs: { value: a, selected: ed.auth === a } }, a);
            })))
          ];
          if (ed.auth !== "NONE") {
            form.push(frow("Username", h("input", {
              staticClass: "mm-input", attrs: { value: ed.username, placeholder: "Username" },
              on: { input: function (ev) { ed.username = ev.target.value; } }
            })));
            form.push(frow("Password", h("input", {
              staticClass: "mm-input", attrs: { value: ed.password, type: "password", placeholder: "Password" },
              on: { input: function (ev) { ed.password = ev.target.value; } }
            })));
          }
          form.push(frow("IP type", h("select", {
            staticClass: "mm-select",
            attrs: { value: String(ed.ip_type) },
            on: { change: function (ev) { ed.ip_type = Number(ev.target.value); } }
          }, self.ipTypeOptions.map(function (o) {
            return h("option", { key: o.value, attrs: { value: String(o.value), selected: Number(ed.ip_type) === o.value } }, o.label);
          }))));
          form.push(frow("Data roaming", h("button", {
            staticClass: "mm-apnchip" + (ed.roaming ? " on" : ""),
            attrs: { "aria-pressed": String(!!ed.roaming) },
            on: { click: function () { ed.roaming = !ed.roaming; } }
          }, ed.roaming ? "Allowed" : "Blocked")));
          form.push(h("button", {
            staticClass: "mm-apply",
            attrs: { disabled: self.simApplying === slot || !self.simDirty(slot) },
            on: { click: function () { self.applySim(slot); } }
          }, self.simApplying === slot ? "Applying…" : "Apply"));
          if (self.simApplyErr[slot]) {
            form.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
              "Apply failed: " + self.simApplyErr[slot]));
          }
          kids.push(h("div", { staticClass: "mm-form" }, form));
        }

        if (!card.selected) {
          if (self.switchConfirm === slot) {
            kids.push(h("div", { staticClass: "mm-switchbox" }, [
              h("div", "Switching drops connectivity for ~30 seconds while slot " + slot +
                " connects. This admin session will stall until it does."),
              h("div", { staticStyle: { display: "flex", gap: "9px", marginTop: "7px" } }, [
                h("button", { staticClass: "mm-apply", on: { click: function () { self.doSwitch(slot); } } }, "Switch"),
                h("button", { staticClass: "mm-reveal", on: { click: function () { self.switchConfirm = 0; } } }, "Cancel")
              ])
            ]));
          } else {
            kids.push(h("button", {
              staticClass: "mm-apply",
              staticStyle: { marginTop: "9px" },
              attrs: { disabled: !!self.switchTarget },
              on: { click: function () { self.askSwitch(slot); } }
            }, self.switchTarget === slot ? "Switching…" : "Use this SIM"));
          }
        }
        if (self.switchErr && !card.selected) {
          kids.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
            "Switch failed: " + self.switchErr));
        }
      }
      if (this.simCfgErr[slot]) {
        kids.push(h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--error)" } },
          "Couldn't load dial config: " + this.simCfgErr[slot]));
      }
      return h("div", { key: slot, staticClass: "mm-card mm-slot" + (card.selected ? " sel" : "") }, kids);
    },
    renderSim(h) {
      var self = this;
      return h("div", [
        h("div", { staticClass: "mm-simgrid" },
          this.slotCards.map(function (c) { return self.renderSlotCard(h, c); })),
        this.renderFailoverCard(h),
        h("div", { staticClass: "mm-hint", staticStyle: { marginTop: "9px" } },
          "DSDS: both SIMs stay registered; exactly one carries data at a time. " +
          "The selected slot and the data-carrying slot can differ during failover — " +
          "both facts are shown above. (AT users: sub_id must follow the active " +
          "subscription; sub_id=0 answers for the wrong SIM.)")
      ]);
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
    // --- network-type lock conflict ---------------------------------------
    // A cell/tower lock names a RAT (LTE or NR5G). If the network mode excludes
    // that RAT the lock is stranded: stored, reported, but inert (an LTE lock
    // under 5G-only never binds). meta.lock rides on get_bands' feat.tower.
    lockInfo() {
      var lk = this.bands && this.bands.meta && this.bands.meta.lock;
      return (lk && lk.active) ? lk : null;
    },
    appliedMode() { return (this.bands && this.bands.meta && this.bands.meta.mode) || "AUTO"; },
    // Would `mode` strand the active lock? Reuse the band-group RAT gate:
    // a 4g lock needs LTE enabled, a 5g lock needs SA enabled.
    modeStrands(mode) {
      var lk = this.lockInfo();
      if (!lk) return false;
      return !this.modeEnables(lk.rat === "4g" ? "LTE" : "sa", mode);
    },
    lockConflict() { return this.modeStrands(this.appliedMode()); },
    // "LTE B12 / PCI 115" or "5G n71 / PCI 516" for the warning banner + tooltip.
    lockLabel() {
      var lk = this.lockInfo();
      if (!lk) return "";
      var rat = lk.rat === "4g" ? "LTE" : "5G";
      var band = (lk.band !== undefined && lk.band !== null && lk.band !== "")
        ? " " + (lk.rat === "4g" ? "B" : "n") + lk.band : "";
      var pci = (lk.pci !== undefined && lk.pci !== null) ? " / PCI " + lk.pci : "";
      return rat + band + pci;
    },
    // --- banner control-state badges (mode lock + tower lock) ------------
    // Both ride on this.bands (get_bands). Return null until it has loaded, so
    // the strip never asserts a state we don't yet know (a false "Unlocked").
    modeBadge() {
      if (!this.bands) return null;
      var m = this.appliedMode();
      if (m === "LTE") return { text: "4G only", active: true };
      if (m === "NR5G") return { text: "5G only", active: true };
      return { text: "Auto", active: false };
    },
    towerBadge() {
      if (!this.bands) return null;
      var lk = this.lockInfo();
      if (!lk) return { text: "Unlocked", locked: false };
      var rat = lk.rat === "4g" ? "LTE" : "5G";
      var tag = (lk.band !== undefined && lk.band !== null && lk.band !== "")
        ? (lk.rat === "4g" ? "B" : "n") + lk.band
        : (lk.pci !== undefined && lk.pci !== null ? "PCI " + lk.pci : "");
      return { text: rat + (tag ? " " + tag : ""), locked: true, title: this.lockLabel() };
    },
    // Two clickable status badges for the trace header. Each jumps to its tab.
    renderLockBadges(h) {
      var self = this, mb = this.modeBadge(), tb = this.towerBadge();
      if (!mb && !tb) return h("span");   // bands not loaded yet — assert nothing
      var kids = [];
      if (mb) kids.push(h("button", {
        staticClass: "mm-lockbadge" + (mb.active ? " mode" : ""),
        attrs: { type: "button", title: "Network mode — open Bands" },
        on: { click: function () { self.tab = "bands"; } }
      }, mb.text));
      if (tb) kids.push(h("button", {
        staticClass: "mm-lockbadge" + (tb.locked ? " lock" : ""),
        attrs: { type: "button",
                 title: (tb.locked ? tb.title + " — " : "") + "Cell lock — open Cell lock tab" },
        on: { click: function () { self.tab = "lock"; } }
      }, (tb.locked ? "🔒 " : "🔓 ") + tb.text));
      return h("div", { staticClass: "mm-lockbadges" }, kids);
    },
    setMode(m) {
      // Block moving INTO a mode that would strand the lock. The mode the modem
      // is already in is exempt — we never auto-write it away; only a NEW
      // stranding selection is refused (the banner tells the user how to fix it).
      if (this.pending) return;
      if (this.modeStrands(m) && m !== this.appliedMode()) return;
      this.selMode = m;
    },
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
          self.fetchBands(); if (k === "cell") self.fetchLock();
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
          self.fetchBands(); if (k === "cell") self.fetchLock();
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
          self.fetchBands(); if (k === "cell") self.fetchLock();
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
        '.mm-facts{display:flex;flex-wrap:wrap;gap:5px 13px;justify-content:flex-end;margin-top:7px}' +
        '.mm-facts .k{display:block;font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-badge)}.mm-facts b{font-size:12.5px;font-weight:600}' +
        // Control-state badges on the trace header: mode lock + tower lock. Muted
        // when idle (Auto / Unlocked), tinted when a restriction is in force.
        '.mm-lockbadges{display:flex;gap:6px;align-items:center}' +
        '.mm-lockbadge{background:var(--background-3,rgba(0,0,0,.04));border:1px solid transparent;border-radius:9px;padding:1px 8px;font:inherit;font-size:10px;font-weight:600;letter-spacing:.02em;color:var(--text-hint);cursor:pointer;white-space:nowrap}' +
        '.mm-lockbadge.mode{color:var(--warning);border-color:var(--warning-disabled,var(--warning));background:var(--warning-disabled,transparent)}' +
        '.mm-lockbadge.lock{color:var(--error);border-color:var(--error);background:transparent}' +
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
        // SIM tab
        '.mm-simgrid{display:grid;grid-template-columns:1fr 1fr;gap:11px}' +
        '@media (max-width:720px){.mm-simgrid{grid-template-columns:1fr}}' +
        '.mm-slot.sel{box-shadow:0 0 0 1.5px var(--success) inset}' +
        '.mm-badges{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0 9px}' +
        '.mm-badge{font-size:11px;padding:2px 8px;border-radius:9px;border:1px solid var(--divider);color:var(--text-secondary)}' +
        '.mm-badge.b-sel{border-color:var(--success);color:var(--success)}' +
        '.mm-badge.b-data{background:var(--primary);border-color:var(--primary);color:#fff}' +
        '.mm-badge.b-warn{border-color:var(--warning);color:var(--warning)}' +
        '.mm-badge.b-off{color:var(--text-hint)}' +
        '.mm-idrow{display:flex;justify-content:space-between;gap:9px;padding:3px 0;font-size:12.5px}' +
        '.mm-idrow .k{color:var(--text-hint)}' +
        '.mm-reveal{background:none;border:none;color:var(--primary);font-size:12px;padding:2px 0;cursor:pointer}' +
        '.mm-form{margin-top:9px;border-top:1px solid var(--divider);padding-top:7px}' +
        '.mm-frow{display:flex;justify-content:space-between;align-items:center;gap:9px;padding:3px 0;font-size:12.5px}' +
        '.mm-frow .k{color:var(--text-hint);flex:none}' +
        '.mm-input,.mm-select{background:var(--background-title);border:1px solid var(--divider);border-radius:6px;color:var(--text-primary);font-size:12.5px;padding:4px 8px;min-width:0;flex:1;max-width:200px}' +
        '.mm-apnchips{display:flex;gap:5px;flex-wrap:wrap;margin:3px 0 5px}' +
        '.mm-apnchip{font-size:11px;padding:2px 8px;border-radius:9px;border:1px solid var(--divider);background:none;color:var(--text-secondary);cursor:pointer}' +
        '.mm-apnchip.on{border-color:var(--primary);color:var(--primary)}' +
        '.mm-apply{margin-top:7px;padding:5px 14px;border-radius:6px;border:none;background:var(--primary);color:#fff;font-size:12.5px;cursor:pointer}' +
        '.mm-apply:disabled{opacity:.45;cursor:default}' +
        '.mm-switchbox{margin-top:9px;padding:9px;border:1px solid var(--warning);border-radius:8px;font-size:12.5px;color:var(--text-secondary)}' +
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
        // nearby-cells scan card
        '.mm-scan-row{display:flex;gap:10px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--divider);font-size:12px}' +
        '.mm-scan-row>span{min-width:0}.mm-scan-row>span:nth-child(2){flex:1}' +
        '.mm-scan-badge{flex:none;font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;color:var(--text-badge)}' +
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
          // Block the mode that would strand an active cell lock — but never the
          // mode the modem is already in (greying the current option reads as broken).
          var blocked = self.modeStrands(o[0]) && o[0] !== self.appliedMode();
          return h("button", {
            key: o[0],
            staticClass: "mm-seg-b" + (cur === o[0] ? " on" : ""),
            attrs: {
              disabled: !!self.pending || blocked,
              title: blocked
                ? ("Would strand your " + (self.lockInfo().rat === "4g" ? "LTE" : "5G") +
                   " cell lock - clear the lock first")
                : undefined
            },
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
      // Network-type lock conflict: the modem is cell-locked to a RAT the current
      // mode excludes, so the lock can't take effect. Name the lock + the fix.
      var lockWarn = this.lockConflict()
        ? h("div", { staticClass: "mm-revert" }, [
            h("div", { staticClass: "mm-revert-row", staticStyle: { display: "block", color: "var(--warning-hover)" } }, [
              h("b", "⚠ Modem is cell-locked to " + this.lockLabel() + ", "),
              "but network mode is " +
                ({ NR5G: "5G only", LTE: "4G only", AUTO: "Auto" }[this.appliedMode()] || this.appliedMode()) +
                " - the lock can't take effect. Set mode to " +
                (this.lockInfo().rat === "4g" ? "Auto or 4G only" : "Auto or 5G only") +
                ", or clear the lock on the Cell Lock tab."
            ])
          ])
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
        lockWarn,
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

    // Nearby-cells scan card. GL's scan_cells is DISRUPTIVE (modem offline up
    // to ~10 minutes), so it never fires without an explicit confirm step, and
    // the empty state is honest that 5G SA exposes no neighbour list at all.
    renderScanCard(h) {
      var self = this;
      var locked = this.lockData && ((this.lockData.lock.l5g || {}).locked ||
                                     (this.lockData.lock.l4g || {}).locked);
      var head = h("div", { staticClass: "mm-grp-h" }, [
        h("span", { staticClass: "mm-grp-t" }, "Nearby cells"),
        this.scan.ts
          ? h("span", { staticClass: "mm-hint" },
              "scanned " + Math.max(1, Math.round((Date.now() - this.scan.ts) / 60000)) + " min ago")
          : h("span", { staticClass: "mm-hint" }, "requires a scan")
      ]);
      var body;
      if (this.scan.running) {
        body = h("div", { staticClass: "mm-empty" },
          "Scanning... the modem is offline until this finishes (up to ~10 minutes). Watch the strip.");
      } else if (this.scan.towers.length) {
        // Group by carrier (A–Z), then strongest RSRP within each carrier; cells
        // with no RSRP sink to the bottom of their group. Carrier key mirrors the
        // row's own display fallback (carrier name, else mcc-mnc).
        var ckey = function (t) {
          return (t.carrier || ((t.mcc || "") + "-" + (t.mnc || ""))).toLowerCase();
        };
        var sorted = this.scan.towers.slice().sort(function (a, b) {
          var ca = ckey(a), cb = ckey(b);
          if (ca !== cb) return ca < cb ? -1 : 1;
          if (a.rsrp === undefined && b.rsrp === undefined) return 0;
          if (a.rsrp === undefined) return 1;
          if (b.rsrp === undefined) return -1;
          return b.rsrp - a.rsrp;   // -84 before -95 (strongest first)
        });
        var rows = sorted.map(function (tw, i) {
          var q = tw.rsrp !== undefined ? (tw.rsrp >= -95 ? "good" : (tw.rsrp >= -105 ? "fair" : "poor")) : "none";
          var confirming = self.lockConfirm && self.lockConfirm.scanIdx === i;
          var target = self.scanTarget(tw);
          return h("div", { key: i, staticClass: "mm-scan-row" }, [
            h("span", { staticClass: "mm-scan-badge" }, tw.network_type || "?"),
            h("span", (tw.carrier || ((tw.mcc || "") + "-" + (tw.mnc || ""))) + "  " + (tw.cellid || "")),
            h("span", (/5G/.test(tw.network_type || "") ? "n" : "B") + (tw.band !== undefined ? tw.band : "?") +
              "  ARFCN " + tw.freq + "  PCI " + tw.pci),
            h("span", { style: { color: self.qColor(q) } },
              tw.rsrp !== undefined ? tw.rsrp + " dBm" : ""),
            confirming
              ? h("span", { staticStyle: { display: "flex", gap: "6px" } }, [
                  h("button", { staticClass: "mm-btn", on: { click: function () { self.lockConfirm = null; } } }, "Cancel"),
                  h("button", { staticClass: "mm-btn primary", attrs: { disabled: self.lockBusy || !!self.pending },
                    on: { click: function () { self.lockCell(target); } } },
                    self.lockBusy ? "Locking..." : "Confirm")
                ])
              : h("button", { staticClass: "mm-btn",
                  attrs: { disabled: !!self.pending || self.lockBusy || locked ||
                           (/5G/.test(tw.network_type || "") && tw.scs === undefined) },
                  on: { click: function () { self.lockConfirm = { scanIdx: i }; } } }, "Lock")
          ]);
        });
        body = h("div", rows);
      } else {
        body = h("div", { staticClass: "mm-empty" }, this.scan.error
          ? "Scan failed: " + this.scan.error
          : "5G SA exposes no neighbour list - only the serving cell is visible without a scan, " +
            "and a scan takes the modem offline for up to ~10 minutes.");
      }
      var foot;
      if (!this.scan.running) {
        foot = this.scanConfirm
          ? h("div", { staticClass: "mm-foot" }, [
              h("span", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)" } },
                "Scanning takes the modem OFFLINE for up to ~10 minutes. This connection will drop if it runs over cellular."),
              h("span", { staticStyle: { flex: "none", display: "flex", gap: "6px" } }, [
                h("button", { staticClass: "mm-btn", on: { click: function () { self.scanConfirm = false; } } }, "Cancel"),
                h("button", { staticClass: "mm-btn danger",
                  attrs: { disabled: !!self.pending || self.lockBusy },
                  on: { click: function () { self.scanCells(); } } }, "Scan now")
              ])
            ])
          : h("div", { staticClass: "mm-foot" }, [
              h("span", { staticClass: "mm-hint" }, "Find every cell in range, with lockable details."),
              h("button", { staticClass: "mm-btn",
                attrs: { disabled: !!this.pending || this.lockBusy },
                on: { click: function () { self.scanConfirm = true; } } }, "Scan for cells")
            ]);
      }
      return h("div", { staticClass: "mm-grp" }, [head, body, foot].filter(Boolean));
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
        (this.lockData.stale)
          ? h("div", { staticClass: "mm-revert" }, [
              h("div", { staticClass: "mm-revert-row" }, [
                h("span", [
                  "The watchdog reverted a lock, but ", h("b", "GL's stored lock"),
                  " still remembers it - GL may re-apply it later. Clear it to reconcile."
                ]),
                h("button", { staticClass: "mm-btn keep", attrs: { disabled: this.lockBusy },
                  on: { click: this.unlockCell } }, "Clear it")
              ])
            ])
          : null,
        this.renderCurrentCell(h),
        this.renderScanCard(h),
        this.renderRecovery(h)
      ];
      return h("div", { staticClass: "mm-card" }, kids.filter(Boolean));
    },

    renderRecovery(h) {
      return h("div", { staticClass: "mm-grp" }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, "Recovery"),
          h("span", { staticClass: "mm-hint" }, "read before locking")
        ]),
        h("div", { staticClass: "mm-hint", staticStyle: { lineHeight: "1.6" } }, [
          "A kept cell lock lives in the modem's own NV (survives reboot, reflash and factory reset) ",
          "and in GL's store. Every lock made here auto-reverts in 60s unless you keep it, and the ",
          "watchdog fires even if this page is closed. If the router ever becomes unreachable over ",
          "the web, the ssh way back is: ", h("b", "ssh root@<router> /usr/sbin/mudimodem-revert panic"),
          " - it unlocks both RATs, resets lock persistence, and restores the known-good bands."
        ])
      ]);
    }
  },

  render(h) {
    var self = this, c = this.serving;

    // ---- status strip ----
    var stripKids;
    if (this.hasData) {
      var rsrpColor = this.qColor(this.rsrpQ);
      stripKids = [
        h("div", { staticClass: "mm-trace" }, [
          h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, [
            h("span", { staticClass: "mm-eyebrow" }, "RSRP live"),
            this.renderLockBadges(h)
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
          ].concat(
            [["BW", c.dl_bandwidth], ["Cell", c.id], ["Ch", c.tx_channel], ["RSSI", c.rssi]]
              .filter(function (f) { return f[1] !== undefined && f[1] !== null && f[1] !== ""; })
              .map(function (f) {
                return h("div", [h("span", { staticClass: "k" }, f[0]), h("b", String(f[1]))]);
              })
          ))
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
    var TABS = [["tracking", "Tracking"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"]];
    var tabs = h("div", { staticClass: "mm-tabs" }, TABS.map(function (t) {
      return h("button", {
        key: t[0], staticClass: "mm-tab" + (self.tab === t[0] ? " on" : ""),
        on: { click: function () { if (t[0] === "tracking") self.openTracking(); else self.tab = t[0]; } }
      }, t[1]);
    }));

    // ---- panel ----
    var panel;
    if (this.tab === "bands") {
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
    } else if (this.tab === "at") {
      if (this.consoleComp) {
        panel = h(this.consoleComp);
      } else {
        panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" },
          this.consoleErr ? "Couldn't load the AT console: " + this.consoleErr
            : "Loading the AT console…")]);
      }
    } else if (this.tab === "sim") {
      panel = this.renderSim(h);
    } else {
      panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" }, "Unknown tab.")]);
    }

    return h("div", { staticClass: "mm" }, [strip, tabs, panel]);
  }
};
