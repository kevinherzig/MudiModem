// MudiModem — Phase 1 diagnostics + Phase 2a read-only three-layer band grid.
//
// Loaded by GL's SPA via eval(), so this file MUST be a single expression whose
// value is the component (module.exports = {...}). `module` is in scope at eval
// time. Vue here is runtime-only: render(h) only, never `template:`.
//
// Reads come two ways, both server-trusted:
//   - live status: this.$store.getters.moduleStatus("cellular.*") over /ws
//   - band model:  window.$rpcRequest("call",["sid","mudimodem","get_bands",{}])
// The "sid" string is a verbatim placeholder GL swaps for the session cookie.
// NOTHING here writes: get_bands is read-only, no set_/lock/AT call exists yet.
//
// All colour is GL theme tokens (var(--success) etc.), so light/dark/classic
// all work with zero extra code.
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
    activeSlot() { return this.modemStatus.current_sim_slot; },
    serving() {
      var self = this;
      var nets = this.ms("cellular.networks_info").networks || [];
      var n = nets.filter(function (x) { return x.slot === self.activeSlot; })[0] || nets[0] || {};
      return n.cell_info || {};
    },
    activeSim() {
      var self = this;
      var sims = this.ms("cellular.sims_info").sims || [];
      return sims.filter(function (s) { return s.slot === self.activeSlot; })[0] || {};
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
    }
  },

  created() { this.injectStyle(); },

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
    // Fetch the three-layer band model from our backend (read-only).
    fetchBands() {
      var self = this;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.bandsError = "RPC helper unavailable";
        return;
      }
      this.bandsLoading = true;
      this.bandsError = "";
      window.$rpcRequest("call", ["sid", "mudimodem", "get_bands", {}])
        .then(function (res) { self.bands = res; })
        .catch(function (e) {
          self.bandsError = (e && (e.type || e.message)) || "request failed";
        })
        .then(function () { self.bandsLoading = false; });
    },
    // Classify one band: active (advertised) / permitted (policy only) / blocked.
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
        '.mm-wrap{display:flex;gap:4px;flex-wrap:wrap}' +
        '.mm-band{position:relative;min-width:44px;padding:4px 6px 3px;text-align:center;border:1px solid var(--border);border-radius:4px;background:var(--background-card)}' +
        '.mm-band b{display:block;font-size:12px;font-weight:600;line-height:1.2}.mm-band s{display:block;font-size:9px;line-height:1.2;color:var(--text-hint);text-decoration:none}' +
        '.mm-band.active{background:var(--success);border-color:var(--success)}.mm-band.active b{color:#fff}.mm-band.active s{color:rgba(255,255,255,.75)}' +
        '.mm-band.permitted{border-color:var(--primary)}.mm-band.permitted b{color:var(--primary)}' +
        '.mm-band.blocked{opacity:.5}.mm-band.blocked b{color:var(--text-hint);text-decoration:line-through}' +
        '.mm-band.serving{box-shadow:0 0 0 2px var(--success)}' +
        '.mm-band.serving::after{content:"";position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--success);border:1.5px solid var(--background-card)}' +
        '.mm-axis2{display:flex;justify-content:space-between;font-size:9.5px;color:var(--text-hint);margin-top:6px}' +
        '.mm-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:10.5px;color:var(--text-badge);margin-top:12px;padding-top:10px;border-top:1px solid var(--divider)}' +
        '.mm-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}' +
        '@media(max-width:640px){.mm-strip{flex-direction:column}.mm-read{border-left:0;border-top:1px solid var(--divider);text-align:left;align-items:flex-start}.mm-facts{justify-content:flex-start}}';
      var el = document.createElement("style");
      el.id = this.styleId; el.textContent = css;
      document.head.appendChild(el);
    },

    // ---- band grid render helpers ----
    renderGroup(h, group, title) {
      var self = this, d = this.bands;
      var supported = (d.supported[group] || []).slice();
      supported.sort(function (a, b) {
        var fa = self.freqOf(group, a), fb = self.freqOf(group, b);
        if (fa === undefined) fa = 1e9; if (fb === undefined) fb = 1e9;
        return (fa - fb) || (a - b);
      });
      if (supported.length === 0) return null;
      var pre = this.prefixOf(group);
      var chips = supported.map(function (b) {
        var st = self.bandState(group, b);
        var serving = (self.servingGroup === group && String(self.serving.band) === String(b));
        var f = self.freqOf(group, b);
        var title2 = pre + b + (f ? " · " + f + " MHz" : "") +
          " · " + ({ active: "in use", permitted: "permitted, not active", blocked: "blocked by carrier policy" })[st];
        return h("span", {
          key: b,
          staticClass: "mm-band " + st + (serving ? " serving" : ""),
          attrs: { title: title2 }
        }, [
          h("b", pre + b),
          h("s", f ? String(f) : " ")
        ]);
      });
      var counts = {
        sup: supported.length,
        pol: (d.policy[group] || []).length,
        cap: (d.capability[group] || []).length
      };
      return h("div", { staticClass: "mm-grp", key: group }, [
        h("div", { staticClass: "mm-grp-h" }, [
          h("span", { staticClass: "mm-grp-t" }, title),
          h("span", { staticClass: "mm-hint" },
            counts.sup + " supported · " + counts.pol + " permitted · " + counts.cap + " active")
        ]),
        h("div", { staticClass: "mm-wrap" }, chips),
        h("div", { staticClass: "mm-axis2" }, [
          h("span", "low band — reaches far"),
          h("span", "high band — fast, short range")
        ])
      ]);
    },
    renderBands(h) {
      if (this.bandsLoading) return h("div", { staticClass: "mm-empty" }, "Reading band configuration from the modem…");
      if (this.bandsError) return h("div", { staticClass: "mm-empty" }, "Couldn’t read bands: " + this.bandsError);
      if (!this.bands) return h("div", { staticClass: "mm-empty" }, "…");
      var d = this.bands, self = this;
      var groups = [
        this.renderGroup(h, "sa", "5G NR · standalone"),
        this.renderGroup(h, "nsa", "5G NR · non-standalone"),
        this.renderGroup(h, "LTE", "LTE")
      ].filter(Boolean);
      var op = (d.meta && d.meta.plmn) ? d.meta.plmn : "carrier";
      var warn = (d.meta && d.meta.plmn_matched === false)
        ? h("div", { staticClass: "mm-hint", staticStyle: { color: "var(--warning)", marginTop: "2px" } },
            "⚠ couldn’t confirm which SIM answered — values may be for the other slot")
        : null;
      var m = d.meta || {};
      return h("div", { staticClass: "mm-card" }, [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Bands"),
          h("span", [
            h("span", { staticClass: "mm-hint", staticStyle: { marginRight: "10px" } }, "read-only · carrier " + op),
            h("button", {
              staticClass: "mm-tab", staticStyle: { fontSize: "11.5px", padding: "2px 0", borderBottom: "0" },
              on: { click: function () { self.fetchBands(); } }
            }, self.bandsLoading ? "refreshing…" : "↻ refresh")
          ])
        ]),
        h("div", { staticClass: "mm-hint", staticStyle: { margin: "3px 0 12px" } },
          "What the modem supports, what your carrier permits, and what it’s actually using. " +
          "Blocked bands are ones the module supports but carrier policy forbids — selecting them has no effect."),
        warn
      ].concat(groups).concat([
        h("div", { staticClass: "mm-legend" }, [
          h("span", [h("i", { staticStyle: { background: "var(--success)" } }), "in use / advertised"]),
          h("span", [h("i", { staticStyle: { background: "transparent", border: "1px solid var(--primary)" } }), "permitted by carrier"]),
          h("span", [h("i", { staticStyle: { background: "var(--text-hint)" } }), "blocked by policy"]),
          h("span", "◦ ring = serving now")
        ])
      ]));
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
          h("div", { staticClass: "mm-eyebrow" }, "RSRP · live"),
          h("div", { staticClass: "mm-plot" }, [
            h("svg", { attrs: { viewBox: "0 0 320 40", preserveAspectRatio: "none" } }, [
              h("path", { attrs: {
                d: this.tracePath(), fill: "none", stroke: rsrpColor,
                "stroke-width": "1.75", "stroke-linejoin": "round", "stroke-linecap": "round"
              } })
            ])
          ]),
          h("div", { staticClass: "mm-axis" }, [
            h("span", "−120"),
            h("span", (c.mode || "") + (this.activeSim.mcc ? " · " + this.activeSim.mcc + this.activeSim.mnc : "")),
            h("span", "−80 dBm")
          ])
        ]),
        h("div", { staticClass: "mm-read" }, [
          h("div", { staticClass: "mm-rsrp", style: { color: rsrpColor } }, [
            String(c.rsrp), h("span", { staticClass: "u" }, "dBm")
          ]),
          h("div", { staticClass: "mm-facts" }, [
            h("div", [h("span", { staticClass: "k" }, "SINR"),
              h("b", { style: { color: this.qColor(this.sinrQ) } }, c.sinr !== undefined ? String(c.sinr) : "—")]),
            h("div", [h("span", { staticClass: "k" }, "RSRQ"),
              h("b", { style: { color: this.qColor(this.rsrqQ) } }, c.rsrq !== undefined ? String(c.rsrq) : "—")]),
            h("div", [h("span", { staticClass: "k" }, "Band"), h("b", this.bandLabel)])
          ])
        ])
      ];
    } else {
      stripKids = [h("div", { staticClass: "mm-empty" },
        "Waiting for the modem’s first status push over the websocket…")];
    }
    var strip = h("div", { staticClass: "mm-strip" }, stripKids);

    // ---- tabs ----
    var TABS = [["diag", "Diagnostics"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"]];
    var tabs = h("div", { staticClass: "mm-tabs" }, TABS.map(function (t) {
      return h("button", {
        key: t[0], staticClass: "mm-tab" + (self.tab === t[0] ? " on" : ""),
        on: { click: function () { self.tab = t[0]; } }
      }, t[1]);
    }));

    // ---- panel ----
    var panel;
    if (this.tab === "diag") {
      var m = this.modem;
      panel = h("div", { staticClass: "mm-card" }, [
        h("div", { staticStyle: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("span", { staticClass: "mm-sect" }, "Serving cell"),
          h("span", { staticClass: "mm-hint" }, m.name ? m.name + " · live" : "live")
        ]),
        this.hasData
          ? h("div", { staticClass: "mm-dl" }, this.facts.map(function (f, i) {
              return h("div", { key: i }, [h("span", { staticClass: "k" }, f[0]), h("b", String(f[1]))]);
            }))
          : h("div", { staticClass: "mm-empty" }, "No serving-cell data yet.")
      ]);
    } else if (this.tab === "bands") {
      panel = this.renderBands(h);
    } else {
      var soon = {
        lock: "Cell lock — Phase 2.",
        at: "AT console + community library — Phase 3.",
        sim: "SIM / APN — Phase 4."
      }[this.tab];
      panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" }, soon)]);
    }

    return h("div", { staticClass: "mm" }, [strip, tabs, panel]);
  }
};
