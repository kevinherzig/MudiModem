// MudiModem — Phase 1: read-only live diagnostics.
//
// Loaded by GL's SPA via eval(), so this file MUST be a single expression whose
// value is the component (module.exports = {...}). `module` is in scope at eval
// time. Vue here is runtime-only: render(h) only, never `template:`.
//
// Reads are FREE: the menu JSON declares `global_sockets` for the cellular.*
// objects, so GL's /ws pushes them into the Vuex statusMap. We read them with
// this.$store.getters.moduleStatus(name) — inherited down the route tree by the
// vuex mixin. No backend, no RPC, no modem risk: this page only observes.
//
// All colour is GL's own theme tokens (var(--success) etc.), so light/dark and
// the three GL themes all work with zero extra code.
module.exports = {
  name: "mudimodem",

  data() {
    return {
      tab: "diag",
      trace: [],        // rolling RSRP history for the strip sparkline
      TRACE_MAX: 90,
      styleId: "mudimodem-css"
    };
  },

  computed: {
    ms() {
      // moduleStatus is a Vuex getter: name -> statusMap[name] || {}
      var s = this.$store && this.$store.getters;
      return (s && s.moduleStatus) ? s.moduleStatus : function () { return {}; };
    },
    // The built-in modem is type === 0 (GL's own convention).
    modem() {
      var modems = this.ms("cellular.modems_info").modems || [];
      return modems.filter(function (m) { return m.type === 0; })[0] || modems[0] || {};
    },
    modemStatus() {
      var self = this;
      var modems = this.ms("cellular.modems_status").modems || [];
      return modems.filter(function (m) { return m.bus === self.modem.bus; })[0] || modems[0] || {};
    },
    activeSlot() {
      return this.modemStatus.current_sim_slot;
    },
    // Serving cell = the network whose slot matches the active SIM slot.
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
    hasData() {
      return this.serving.rsrp !== undefined && this.serving.rsrp !== null;
    },
    isNR() {
      return /NR5G/.test(this.serving.mode || "");
    },
    bandLabel() {
      if (this.serving.band === undefined || this.serving.band === "") return "—";
      return (this.isNR ? "n" : "B") + this.serving.band;
    },
    // GL provides *_level (1..4). Map to its own quality ramp names.
    rsrpQ() { return this.qFromLevel(this.serving.rsrp_level); },
    sinrQ() { return this.qFromLevel(this.serving.sinr_level); },
    rsrqQ() { return this.qFromLevel(this.serving.rsrq_level); },
    // Serving-cell facts as [label, value] pairs, only the ones present.
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
    // Accumulate a live RSRP trace as the websocket pushes new values.
    "serving.rsrp": {
      immediate: true,
      handler(v) {
        var n = parseFloat(v);
        if (isNaN(n)) return;
        this.trace.push(n);
        if (this.trace.length > this.TRACE_MAX) this.trace.shift();
      }
    }
  },

  created() {
    this.injectStyle();
  },

  methods: {
    qFromLevel(lvl) {
      // GL levels: 1 poor, 2 fair, 3 good, 4 excellent.
      return ({ 1: "poor", 2: "fair", 3: "good", 4: "excellent" })[lvl] || "none";
    },
    qColor(q) {
      // GL's modemsignallog ramp: poor->error, fair->warning, good->info, excellent->success.
      return ({
        poor: "var(--error)",
        fair: "var(--warning)",
        good: "var(--info-hover)",
        excellent: "var(--success)",
        none: "var(--text-hint)"
      })[q];
    },
    // Fixed-domain RSRP plot path (never auto-scale: noise must not look like signal).
    tracePath() {
      var pts = this.trace, n = pts.length;
      if (n < 2) return "";
      var FLOOR = -120, CEIL = -80, W = 320, H = 40;
      var step = W / (this.TRACE_MAX - 1);
      var y = function (v) {
        var cl = Math.max(FLOOR, Math.min(CEIL, v));
        return (H - ((cl - FLOOR) / (CEIL - FLOOR)) * H).toFixed(1);
      };
      var off = this.TRACE_MAX - n; // right-align the newest sample
      var d = "";
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
        '.mm-strip{display:flex;align-items:stretch;background:var(--background-card);' +
        'border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);margin-bottom:11px;overflow:hidden}' +
        '.mm-trace{flex:1;min-width:0;padding:9px 0 6px 13px}' +
        '.mm-eyebrow{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mm-plot{height:40px;margin-top:3px}' +
        '.mm-plot svg{display:block;width:100%;height:100%;overflow:visible}' +
        '.mm-axis{display:flex;justify-content:space-between;font-size:9.5px;color:var(--text-hint);margin-top:2px}' +
        '.mm-read{flex:none;min-width:120px;padding:10px 14px 9px 15px;text-align:right;' +
        'border-left:1px solid var(--divider);display:flex;flex-direction:column;justify-content:center}' +
        '.mm-rsrp{font-size:29px;font-weight:600;line-height:1;letter-spacing:-.025em}' +
        '.mm-rsrp .u{font-size:11px;font-weight:500;color:var(--text-hint);margin-left:2px}' +
        '.mm-facts{display:flex;gap:13px;justify-content:flex-end;margin-top:7px}' +
        '.mm-facts .k{display:block;font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mm-facts b{font-size:12.5px;font-weight:600}' +
        '.mm-tabs{display:flex;gap:22px;border-bottom:1px solid var(--divider);margin-bottom:11px;padding:0 4px}' +
        '.mm-tab{background:none;border:0;padding:9px 0 8px;font:inherit;font-size:13px;cursor:pointer;' +
        'color:var(--text-weak);border-bottom:2px solid transparent;margin-bottom:-1px}' +
        '.mm-tab.on{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}' +
        '.mm-card{background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);padding:13px 14px}' +
        '.mm-sect{font-size:13px;font-weight:600;color:var(--text-title)}' +
        '.mm-hint{font-size:11.5px;color:var(--text-badge)}' +
        '.mm-dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px 16px;margin-top:11px}' +
        '.mm-dl .k{display:block;font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mm-dl b{font-size:13px;font-weight:600;color:var(--text-title)}' +
        '.mm-soon{padding:26px 14px;text-align:center;color:var(--text-hint);font-size:12px;line-height:1.6}' +
        '.mm-empty{padding:30px 14px;text-align:center;color:var(--text-hint);font-size:12.5px}' +
        '@media(max-width:640px){.mm-strip{flex-direction:column}.mm-read{border-left:0;' +
        'border-top:1px solid var(--divider);text-align:left;align-items:flex-start}.mm-facts{justify-content:flex-start}}';
      var el = document.createElement("style");
      el.id = this.styleId;
      el.textContent = css;
      document.head.appendChild(el);
    }
  },

  render(h) {
    var self = this;
    var c = this.serving;

    // ---- status strip: live RSRP trace + readout ----
    var stripKids;
    if (this.hasData) {
      var rsrpColor = this.qColor(this.rsrpQ);
      stripKids = [
        h("div", { staticClass: "mm-trace" }, [
          h("div", { staticClass: "mm-eyebrow" }, "RSRP · live"),
          h("div", { staticClass: "mm-plot" }, [
            h("svg", { attrs: { viewBox: "0 0 320 40", preserveAspectRatio: "none" } }, [
              h("path", {
                attrs: {
                  d: this.tracePath(),
                  fill: "none",
                  stroke: rsrpColor,
                  "stroke-width": "1.75",
                  "stroke-linejoin": "round",
                  "stroke-linecap": "round"
                }
              })
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
            String(c.rsrp),
            h("span", { staticClass: "u" }, "dBm")
          ]),
          h("div", { staticClass: "mm-facts" }, [
            h("div", [
              h("span", { staticClass: "k" }, "SINR"),
              h("b", { style: { color: this.qColor(this.sinrQ) } }, c.sinr !== undefined ? String(c.sinr) : "—")
            ]),
            h("div", [
              h("span", { staticClass: "k" }, "RSRQ"),
              h("b", { style: { color: this.qColor(this.rsrqQ) } }, c.rsrq !== undefined ? String(c.rsrq) : "—")
            ]),
            h("div", [
              h("span", { staticClass: "k" }, "Band"),
              h("b", this.bandLabel)
            ])
          ])
        ])
      ];
    } else {
      stripKids = [h("div", { staticClass: "mm-empty" },
        "Waiting for the modem’s first status push over the websocket…")];
    }
    var strip = h("div", { staticClass: "mm-strip" }, stripKids);

    // ---- tabs ----
    var TABS = [
      ["diag", "Diagnostics"], ["bands", "Bands"], ["lock", "Cell lock"],
      ["at", "AT console"], ["sim", "SIM"]
    ];
    var tabs = h("div", { staticClass: "mm-tabs" }, TABS.map(function (t) {
      return h("button", {
        key: t[0],
        staticClass: "mm-tab" + (self.tab === t[0] ? " on" : ""),
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
              return h("div", { key: i }, [
                h("span", { staticClass: "k" }, f[0]),
                h("b", String(f[1]))
              ]);
            }))
          : h("div", { staticClass: "mm-empty" }, "No serving-cell data yet.")
      ]);
    } else {
      var soon = {
        bands: "Band selection — Phase 2. Modem-supported SA bands: " +
               ((this.modem.band && this.modem.band["NR-SA"]) || []).map(function (b) { return "n" + b; }).join(" "),
        lock: "Cell lock — Phase 2.",
        at: "AT console + community library — Phase 3.",
        sim: "SIM / APN — Phase 4."
      }[this.tab];
      panel = h("div", { staticClass: "mm-card" }, [h("div", { staticClass: "mm-soon" }, soon)]);
    }

    return h("div", { staticClass: "mm" }, [strip, tabs, panel]);
  }
};
