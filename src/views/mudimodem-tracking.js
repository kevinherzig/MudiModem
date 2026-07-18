// MudiModem — Tracking (the uber graph). A hidden /mudimodem-tracking route.
//
// Loaded by GL's SPA via eval(): the file is ONE expression whose value is the
// component. Vue is runtime-only -> render(h) only, never template:. History is
// kept in a window-scoped ring buffer (window.__mmHist) fed by whichever
// MudiModem page is mounted; it is session-scoped and lost on reload (spec §10.6).
//
// The middle bus is CELL ID (cell_info.id) + ARFCN — the box carries NO PCI over
// the websocket; PCI is AT-only. Handover = a change in id; failover = a change
// in the active slot. Metrics arrive as strings with _level (1-4) buckets, reused
// for the GL quality ramp exactly as the main page's strip does. All colour is GL
// theme tokens, so light/dark/classic work with zero extra code.
module.exports = (function () {
  "use strict";

  // ---- the in-memory recorder (IDENTICAL copy lives in mudimodem.js) ----
  // Kept verbatim in both chunks: chunks can't require() each other and the repo
  // is toolchain-free. test/chunk.test.js asserts the two copies are identical.
  function makeMMHist() {
    var SAMPLES_MAX = 5000, MIN_SPACING_MS = 5000, EVENTS_MAX = 500, RECENT_USER_MS = 8000;
    var samples = [], events = [], last = null;
    function now() { return Date.now(); }
    function recentUser(t) {
      for (var i = events.length - 1; i >= 0; i--) {
        if (t - events[i].t > RECENT_USER_MS) break;
        if (events[i].kind === "user" || events[i].kind === "dog") return true;
      }
      return false;
    }
    function pushEvent(e) {
      e.t = (e.t == null) ? now() : e.t;
      events.push(e);
      if (events.length > EVENTS_MAX) events.shift();
      return e;
    }
    function record(s) {
      var t = now();
      // network-event detection vs the last state we saw (independent of storage)
      if (last && !recentUser(t)) {
        if (String(s.slot) !== String(last.slot)) {
          pushEvent({ t: t, kind: "net", label: "Failover",
            detail: "Data now on SIM " + s.slot + (s.carrier ? " · " + s.carrier : "") });
        } else if (s.id != null && last.id != null && String(s.id) !== String(last.id)) {
          pushEvent({ t: t, kind: "net", label: "Handover",
            detail: "Cell " + last.id + " → " + s.id + (s.band != null ? " (" + s.band + ")" : "") });
        }
      }
      var changed = !last || String(s.slot) !== String(last.slot) ||
        String(s.id) !== String(last.id) || String(s.band) !== String(last.band) ||
        String(s.mode) !== String(last.mode);
      last = { slot: s.slot, id: s.id, band: s.band, mode: s.mode };
      var prev = samples[samples.length - 1];
      if (prev && !changed && (t - prev.t) < MIN_SPACING_MS) return null;  // spacing: drop
      var rec = { t: t, slot: s.slot, id: s.id, band: s.band, mode: s.mode,
        rsrp: s.rsrp, sinr: s.sinr, rsrq: s.rsrq, rssi: s.rssi,
        dl_bandwidth: s.dl_bandwidth, tx_channel: s.tx_channel,
        rsrp_level: s.rsrp_level, sinr_level: s.sinr_level, rsrq_level: s.rsrq_level,
        carrier: s.carrier };
      samples.push(rec);
      if (samples.length > SAMPLES_MAX) samples.shift();
      return rec;
    }
    return { samples: samples, events: events, startedAt: now(),
      record: record, pushEvent: pushEvent };
  }

  // ---- lane geometry + constants ----
  var LINES = [
    { key: "rsrp", label: "RSRP · dBm", h: 120, dom: [-120, -80], mid: -100, lvl: "rsrp_level" },
    { key: "sinr", label: "SINR · dB",  h: 84,  dom: [-10, 30],   mid: 13,  lvl: "sinr_level" },
    { key: "rsrq", label: "RSRQ · dB",  h: 84,  dom: [-20, -3],   mid: -15, lvl: "rsrq_level" }
  ];
  var BUSES = [{ key: "band", label: "BAND" }, { key: "id", label: "CELL" }, { key: "sim", label: "SIM" }];
  var FREQ_N = { 2:1900,5:850,7:2600,12:700,13:750,14:700,25:1900,26:850,29:700,30:2300,
    38:2600,41:2500,48:3500,66:1700,70:1700,71:600,77:3700,78:3500,79:4700 };
  var RANGES = [[15,"15 m"],[60,"1 h"],[360,"6 h"],[1440,"24 h"]];
  var TICKSTEP = { 15:2, 60:10, 360:60, 1440:240 };
  var PADL = 46, PADR = 12, BUS_H = 20;

  var component = {
    name: "mudimodem-tracking",

    data: function () {
      return { winW: 60, pinnedM: null, tick: 0, live: true, width: 900,
        styleId: "mmt-css", cursor: null, poll: null };
    },

    computed: {
      ms: function () {
        var s = this.$store && this.$store.getters;
        return (s && s.moduleStatus) ? s.moduleStatus : function () { return {}; };
      },
      modem: function () {
        var modems = this.ms("cellular.modems_info").modems || [];
        return modems.filter(function (m) { return m.type === 0; })[0] || modems[0] || {};
      },
      modemStatus: function () {
        var self = this, modems = this.ms("cellular.modems_status").modems || [];
        return modems.filter(function (m) { return m.bus === self.modem.bus; })[0] || modems[0] || {};
      },
      activeSlot: function () { return this.modemStatus.current_sim_slot; },
      serving: function () {
        var self = this, bus = this.modem.bus;
        var nets = (this.ms("cellular.networks_info").networks || [])
          .filter(function (n) { return !bus || n.bus == null || n.bus === bus; });
        var net = nets.filter(function (n) { return String(n.slot) === String(self.activeSlot); })[0] || {};
        return net.cell_info || {};
      },
      carrier: function () {
        var self = this, sims = this.ms("cellular.sims_status").sims || [];
        var s = sims.filter(function (x) { return String(x.slot) === String(self.activeSlot); })[0] || {};
        return s.carrier || "";
      },
      // Reading `tick` here makes render() depend on our 1 Hz poll, so the
      // (non-reactive) window ring buffer is re-read every second while live.
      H: function () { this.tick; return (typeof window !== "undefined" && window.__mmHist) || null; }
    },

    created: function () { this.injectStyle(); },
    mounted: function () {
      var self = this;
      if (typeof window === "undefined") return;
      this.measure();
      this.parseHash();
      this._onResize = function () { self.measure(); };
      window.addEventListener("resize", this._onResize);
      this.poll = setInterval(function () {
        if (!self.live) return;
        self.recordSample();
        self.tick++;   // force re-render off the (non-reactive) ring buffer
      }, 1000);
    },
    beforeDestroy: function () {
      if (this.poll) clearInterval(this.poll);
      if (typeof window !== "undefined" && this._onResize) window.removeEventListener("resize", this._onResize);
    },

    methods: {
      hist: function () {
        if (typeof window === "undefined") return null;
        return window.__mmHist || (window.__mmHist = makeMMHist());
      },
      measure: function () {
        if (this.$refs && this.$refs.lanes && this.$refs.lanes.clientWidth)
          this.width = this.$refs.lanes.clientWidth;
      },
      nowMs: function () { return (typeof window !== "undefined") ? Date.now() : 0; },
      num: function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; },
      recordSample: function () {
        var H = this.hist(); if (!H) return;
        var c = this.serving;
        if (c.rsrp === undefined || c.rsrp === null || c.rsrp === "") return;
        H.record({ slot: this.activeSlot, id: c.id, band: c.band, mode: c.mode,
          rsrp: this.num(c.rsrp), sinr: this.num(c.sinr), rsrq: this.num(c.rsrq), rssi: this.num(c.rssi),
          dl_bandwidth: c.dl_bandwidth, tx_channel: c.tx_channel,
          rsrp_level: c.rsrp_level, sinr_level: c.sinr_level, rsrq_level: c.rsrq_level,
          carrier: this.carrier });
      },
      qFromLevel: function (l) { return ({1:"poor",2:"fair",3:"good",4:"excellent"})[l] || "none"; },
      qColor: function (q) {
        return ({ poor:"var(--error)", fair:"var(--warning)", good:"var(--info-hover)",
          excellent:"var(--success)", none:"var(--text-hint)" })[q];
      },
      clock: function (t) {
        var d = new Date(t), p = function (n) { return (n < 10 ? "0" : "") + n; };
        return p(d.getHours()) + ":" + p(d.getMinutes());
      },
      freqOf: function (b) { return FREQ_N[b]; },
      bandLabel: function (s) {
        var pre = /NR5G/.test(s.mode || "") ? "n" : "B";
        return (s.band == null || s.band === "") ? "—" : pre + s.band;
      },

      // absolute epoch-ms -> minute offset relative to now (<=0, now=0)
      mOf: function (t) { return -((this.nowMs() - t) / 60000); },
      // minute offset -> x pixel
      xOf: function (m) {
        var plotW = this.width - PADL - PADR;
        return PADL + (m + this.winW) / this.winW * plotW;
      },
      winSamples: function () {
        var H = this.H; if (!H) return [];
        var cutoff = this.nowMs() - this.winW * 60000, self = this;
        return H.samples.filter(function (s) { return s.t >= cutoff; })
          .map(function (s) { return Object.assign({ m: self.mOf(s.t) }, s); });
      },
      winEvents: function () {
        var H = this.H; if (!H) return [];
        var cutoff = this.nowMs() - this.winW * 60000, self = this;
        return H.events.filter(function (e) { return e.t >= cutoff; })
          .map(function (e) { return Object.assign({ m: self.mOf(e.t) }, e); });
      },
      nearestSample: function (m) {
        var ss = this.winSamples(); if (!ss.length) return null;
        var best = ss[0];
        for (var i = 1; i < ss.length; i++)
          if (Math.abs(ss[i].m - m) < Math.abs(best.m - m)) best = ss[i];
        return best;
      },
      // contiguous runs of a bus key across the windowed samples
      busRuns: function (key) {
        var ss = this.winSamples(), runs = [], self = this;
        var label = function (s) {
          return key === "band" ? self.bandLabel(s)
            : key === "id" ? (s.id == null ? "—" : String(s.id))
            : (s.carrier ? s.carrier + " · SIM " + s.slot : "SIM " + s.slot);
        };
        for (var i = 0; i < ss.length; i++) {
          var v = label(ss[i]), lastRun = runs[runs.length - 1];
          if (lastRun && lastRun.v === v) lastRun.m1 = ss[i].m;
          else { if (lastRun) lastRun.m1 = ss[i].m; runs.push({ v: v, m0: ss[i].m, m1: ss[i].m, s: ss[i] }); }
        }
        if (runs.length) runs[runs.length - 1].m1 = 0;   // extend last run to now
        return runs;
      },

      // ---- interaction ----
      mFromEvent: function (e) {
        var el = this.$refs.lanes; if (!el) return null;
        var r = el.getBoundingClientRect(), plotW = this.width - PADL - PADR;
        return -this.winW + (e.clientX - r.left - PADL) / plotW * this.winW;
      },
      clampM: function (m) { return Math.max(-this.winW, Math.min(0, m)); },
      onMove: function (e) {
        if (this.pinnedM != null) return;
        var m = this.mFromEvent(e); if (m == null) return;
        this.cursor = this.clampM(m);
      },
      onLeave: function () { if (this.pinnedM == null) this.cursor = null; },
      onClick: function (e) {
        if (this.pinnedM != null) { this.pinnedM = null; return; }
        var m = this.mFromEvent(e); if (m == null) return;
        this.pinnedM = this.cursor = this.clampM(m);
      },
      setRange: function (w) { this.winW = w; this.pinnedM = null; this.cursor = null; },
      parseHash: function () {
        if (typeof window === "undefined" || !window.location) return;
        var q = {};
        (window.location.hash || "").replace(/^#/, "").split("&").forEach(function (kv) {
          var p = kv.split("="); if (p[0]) q[p[0]] = p[1];
        });
        var w = parseInt(q.w, 10);
        if ([15, 60, 360, 1440].indexOf(w) !== -1) this.winW = w;
        var m = parseFloat(q.m);
        if (!isNaN(m)) this.pinnedM = this.cursor = this.clampM(m);
      },

      // ---- render helpers ----
      renderLanes: function (h) {
        var self = this, W = this.width, kids = [], y = 16, laneY = {};
        var ss = this.winSamples();
        LINES.forEach(function (L) {
          laneY[L.key] = y;
          var d0 = L.dom[0], d1 = L.dom[1];
          var yv = function (v) { return y + L.h - (Math.max(d0, Math.min(d1, v)) - d0) / (d1 - d0) * L.h; };
          kids.push(h("text", { attrs: { x: 8, y: y - 5, "font-size": 9, fill: "var(--text-badge)" } }, L.label));
          [y, y + L.h].forEach(function (yy) {
            kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yy, y2: yy,
              stroke: "var(--divider)", "stroke-width": 1 } }));
          });
          kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yv(L.mid), y2: yv(L.mid),
            stroke: "var(--divider)", "stroke-width": 1, "stroke-dasharray": "2 3" } }));
          [[d1, y], [d0, y + L.h], [L.mid, yv(L.mid)]].forEach(function (p) {
            kids.push(h("text", { attrs: { x: PADL - 4, y: p[1] + 3, "text-anchor": "end",
              "font-size": 8, fill: "var(--text-hint)" } }, String(p[0])));
          });
          var run = [], runQ = null;
          var flush = function () {
            if (run.length > 1) kids.push(h("path", { attrs: { fill: "none", stroke: self.qColor(runQ),
              "stroke-width": 1.75, "stroke-linejoin": "round", "stroke-linecap": "round",
              d: "M" + run.join("L") } }));
            run = [];
          };
          ss.forEach(function (s) {
            var v = s[L.key];
            if (v == null) { flush(); runQ = null; return; }
            var q = self.qFromLevel(s[L.lvl]);
            var pt = self.xOf(s.m).toFixed(1) + " " + yv(v).toFixed(1);
            if (runQ !== null && q !== runQ) { run.push(pt); flush(); }
            runQ = q; run.push(pt);
          });
          flush();
          y += L.h + 22;
        });
        y += 2;
        BUSES.forEach(function (B) {
          laneY[B.key] = y;
          kids.push(h("text", { attrs: { x: 8, y: y + BUS_H / 2 + 3, "font-size": 9,
            fill: "var(--text-badge)" } }, B.label));
          self.busRuns(B.key).forEach(function (r) {
            var x0 = Math.max(PADL, self.xOf(r.m0)), x1 = Math.min(W - PADR, self.xOf(r.m1));
            var w = x1 - x0; if (w < 1.2) return;
            kids.push(h("rect", { attrs: { x: x0.toFixed(1), y: y, width: w.toFixed(1), height: BUS_H,
              rx: 2, fill: "var(--background-title,#f2f2f7)", stroke: "var(--border)", "stroke-width": 1 } }));
            var lab = r.v;
            if (B.key === "band" && self.freqOf(r.s.band)) lab += " · " + self.freqOf(r.s.band) + " MHz";
            if (w > String(lab).length * 6.2 + 10)
              kids.push(h("text", { attrs: { x: ((x0 + x1) / 2).toFixed(1), y: y + BUS_H / 2 + 3.5,
                "text-anchor": "middle", "font-size": 10, fill: "var(--text-weak)",
                "font-family": "var(--mono,ui-monospace,monospace)" } }, lab));
          });
          y += BUS_H + 7;
        });
        var evTop = laneY.rsrp, evBot = y - 7;
        this.winEvents().forEach(function (e) {
          var col = e.kind === "user" ? "var(--primary)" : e.kind === "dog" ? "var(--warning)" : "var(--text-hint)";
          var ex = self.xOf(e.m);
          kids.push(h("line", { attrs: { x1: ex.toFixed(1), x2: ex.toFixed(1), y1: evTop, y2: evBot,
            stroke: col, "stroke-width": 1, "stroke-dasharray": "3 3" } }));
        });
        var step = TICKSTEP[this.winW];
        for (var m = -this.winW; m <= 0; m += step) {
          var xx = self.xOf(m);
          kids.push(h("line", { attrs: { x1: xx.toFixed(1), x2: xx.toFixed(1), y1: y, y2: y + 4,
            stroke: "var(--divider)", "stroke-width": 1 } }));
          kids.push(h("text", { attrs: { x: xx.toFixed(1), y: y + 14, "text-anchor": "middle",
            "font-size": 9, fill: "var(--text-badge)", "font-family": "var(--mono,ui-monospace,monospace)" } },
            this.clock(this.nowMs() + m * 60000)));
        }
        y += 22;
        if (this.cursor != null) {
          var cx = this.xOf(this.cursor);
          kids.push(h("line", { attrs: { x1: cx.toFixed(1), x2: cx.toFixed(1), y1: evTop, y2: evBot,
            stroke: this.pinnedM != null ? "var(--primary)" : "var(--text-weak)",
            "stroke-width": this.pinnedM != null ? 1.25 : 1 } }));
        }
        return h("svg", { ref: "svg", attrs: { viewBox: "0 0 " + W + " " + y, width: W, height: y } }, kids);
      },
      sliceReadout: function (h) {
        var s = this.nearestSample(this.cursor); if (!s) return null;
        var self = this, W = this.width, cx = this.xOf(s.m), near = null, evs = this.winEvents();
        for (var i = 0; i < evs.length; i++)
          if (Math.abs(this.xOf(evs[i].m) - cx) < 6) near = evs[i];
        var val = function (v) { return (v == null) ? "—" : String(v); };
        var row = function (k, v, u, q) {
          return h("tr", [h("td", { staticClass: "k" }, k),
            h("td", { staticClass: "v", staticStyle: q ? { color: self.qColor(q) } : {} },
              val(v) + (u ? " " + u : ""))]);
        };
        var rows = [
          row("RSRP", s.rsrp, "dBm", this.qFromLevel(s.rsrp_level)),
          row("SINR", s.sinr, "dB", this.qFromLevel(s.sinr_level)),
          row("RSRQ", s.rsrq, "dB", this.qFromLevel(s.rsrq_level)),
          row("Band", this.bandLabel(s), this.freqOf(s.band) ? "· " + this.freqOf(s.band) + " MHz" : "", null),
          row("Cell", s.id == null ? "—" : s.id, "", null),
          row("SIM", (s.carrier || "SIM") + " · " + s.slot, "", null)
        ];
        var kids = [h("div", { staticClass: "t" },
          this.clock(this.nowMs() + s.m * 60000) + (this.pinnedM != null ? " · pinned" : ""))];
        if (near) kids.push(h("div", { staticClass: "e",
          staticStyle: { color: near.kind === "user" ? "var(--primary)"
            : near.kind === "dog" ? "var(--warning-hover,#c4851c)" : "var(--text-weak)" } },
          near.label + " — " + near.detail));
        kids.push(h("table", rows));
        var tw = 180, left = cx + 12;
        if (left + tw > W - 4) left = cx - tw - 12;
        return h("div", { staticClass: "mmt-tip", staticStyle: { left: Math.max(4, left) + "px" } }, kids);
      },
      renderLog: function (h) {
        var self = this, H = this.H;
        var evs = (H ? H.events.slice() : []).reverse();
        var rows = evs.map(function (e, i) {
          var src = { user: "You", dog: "Watchdog", net: "Network" }[e.kind];
          return h("tr", { key: i }, [
            h("td", { staticClass: "tm" }, self.clock(e.t)),
            h("td", [h("span", { staticClass: "mmt-chip " + e.kind }, src)]),
            h("td", { staticStyle: { fontWeight: "600", color: "var(--text-title)" } }, e.label),
            h("td", { staticStyle: { color: "var(--text-weak)" } }, e.detail || "")
          ]);
        });
        return h("div", { staticClass: "mmt-card" }, [
          h("div", { staticClass: "mmt-head" }, [
            h("span", { staticClass: "mmt-title" }, "Event log"),
            h("span", { staticClass: "mmt-hint" }, "newest first")
          ]),
          rows.length
            ? h("table", { staticClass: "mmt-log" }, [
                h("thead", [h("tr", [h("th", "Time"), h("th", "Source"), h("th", "Event"), h("th", "Detail")])]),
                h("tbody", rows)])
            : h("div", { staticClass: "mmt-empty" }, "No band changes, handovers or failovers recorded yet.")
        ]);
      },
      renderPage: function (h) {
        var self = this, H = this.H;
        var hasData = !!(H && this.winSamples().length > 0);
        var head = h("div", { staticClass: "mmt-head" }, [
          h("button", { staticClass: "mmt-crumb", on: { click: function () {
            if (self.$router) self.$router.push("/mudimodem"); } } }, "← Modem"),
          h("span", { staticClass: "mmt-title" }, "Tracking"),
          h("span", { staticClass: "mmt-hint" }, "one clock, every lane — hover for a slice, click to pin"),
          h("span", { staticClass: "mmt-sp" }),
          h("span", { staticClass: "mmt-seg" }, RANGES.map(function (r) {
            return h("button", { key: r[0], staticClass: self.winW === r[0] ? "on" : "",
              on: { click: function () { self.setRange(r[0]); } } }, r[1]);
          })),
          h("button", { staticClass: "mmt-live" + (self.live ? "" : " off"),
            on: { click: function () { self.live = !self.live; } } },
            [h("span", { staticClass: "d" }), self.live ? "LIVE" : "PAUSED"])
        ]);
        var body = hasData
          ? h("div", { ref: "lanes", staticClass: "mmt-lanes",
              on: { mousemove: this.onMove, mouseleave: this.onLeave, click: this.onClick } },
              [this.renderLanes(h), this.cursor != null ? this.sliceReadout(h) : null])
          : h("div", { staticClass: "mmt-empty" }, [
              "Collecting modem history in this browser session.", h("br"),
              (H ? "Since " + this.clock(H.startedAt) + " · " : ""), "reloading the page clears it."]);
        var foot = h("div", { staticClass: "mmt-foot" }, [
          h("span", { staticClass: "mmt-lg" }, "■ You"),
          h("span", { staticClass: "mmt-lg" }, "▲ Watchdog"),
          h("span", { staticClass: "mmt-lg" }, "○ Network"),
          h("span", "a tick marks the moment — everything to its right is the radio's answer")
        ]);
        return h("div", { staticClass: "mmt" }, [
          h("div", { staticClass: "mmt-card" }, [head, body, foot]),
          this.renderLog(h)
        ]);
      },

      injectStyle: function () {
        if (typeof document === "undefined" || document.getElementById(this.styleId)) return;
        var css =
          '.mmt{color:var(--text-regular);font-variant-numeric:tabular-nums}' +
          '.mmt-card{background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);margin-bottom:11px}' +
          '.mmt-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px 10px}' +
          '.mmt-title{font-size:14px;font-weight:600;color:var(--text-title)}' +
          '.mmt-hint{font-size:11.5px;color:var(--text-badge)}.mmt-sp{flex:1}' +
          '.mmt-crumb{background:none;border:0;font:inherit;font-size:12px;color:var(--primary);cursor:pointer;padding:0}' +
          '.mmt-seg{display:inline-flex;border:1px solid var(--border);border-radius:3px;overflow:hidden}' +
          '.mmt-seg button{font:inherit;font-size:11.5px;background:transparent;border:0;padding:5px 12px;cursor:pointer;color:var(--text-weak);border-right:1px solid var(--border)}' +
          '.mmt-seg button:last-child{border-right:0}.mmt-seg button.on{background:var(--primary);color:#fff;font-weight:600}' +
          '.mmt-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--success);cursor:pointer;background:none;border:1px solid var(--border);border-radius:3px;padding:5px 10px}' +
          '.mmt-live .d{width:7px;height:7px;border-radius:50%;background:var(--success)}' +
          '.mmt-live.off{color:var(--text-badge)}.mmt-live.off .d{background:var(--text-hint)}' +
          '.mmt-lanes{position:relative;padding:2px 0 6px;cursor:crosshair}.mmt-lanes svg{display:block;width:100%;overflow:visible}' +
          '.mmt-foot{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:8px 14px 11px;border-top:1px solid var(--divider);font-size:11px;color:var(--text-badge)}' +
          '.mmt-lg{display:inline-flex;align-items:center;gap:5px}' +
          '.mmt-tip{position:absolute;top:8px;pointer-events:none;z-index:5;background:var(--background-card);border:1px solid var(--border);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:8px 10px;min-width:170px}' +
          '.mmt-tip .t{font-size:10.5px;color:var(--text-badge);margin-bottom:5px}' +
          '.mmt-tip .e{font-size:11px;font-weight:600;margin:-1px 0 5px;padding-bottom:5px;border-bottom:1px solid var(--divider)}' +
          '.mmt-tip table{border-collapse:collapse;width:100%}.mmt-tip td{padding:1px 0;font-size:11.5px}' +
          '.mmt-tip td.k{color:var(--text-badge);font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding-right:10px}' +
          '.mmt-tip td.v{font-weight:600;color:var(--text-title);text-align:right;white-space:nowrap}' +
          '.mmt-empty{padding:30px 14px;text-align:center;color:var(--text-hint);font-size:12.5px;line-height:1.6}' +
          '.mmt-log{width:100%;border-collapse:collapse}' +
          '.mmt-log th{font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge);text-align:left;padding:7px 14px 6px;border-bottom:1px solid var(--divider)}' +
          '.mmt-log td{font-size:12px;padding:6px 14px;border-bottom:1px solid var(--divider);color:var(--text-regular)}' +
          '.mmt-log td.tm{font-family:var(--mono,ui-monospace,monospace);font-size:11px;color:var(--text-weak);white-space:nowrap}' +
          '.mmt-chip{display:inline-block;font-size:10px;font-weight:600;border-radius:2px;padding:1px 6px}' +
          '.mmt-chip.user{background:var(--primary-background,#eef1fe);color:var(--primary)}' +
          '.mmt-chip.dog{background:var(--warning-background,#fef6e9);color:var(--warning-hover,#c4851c)}' +
          '.mmt-chip.net{background:var(--background-title,#f2f2f7);color:var(--text-badge)}' +
          '@media(max-width:720px){.mmt-hint{display:none}}';
        var el = document.createElement("style");
        el.id = this.styleId; el.textContent = css;
        document.head.appendChild(el);
      }
    },

    render: function (h) { return this.renderPage(h); }
  };
  component.makeMMHist = makeMMHist;   // exposed for tests (harmless Vue option)
  return component;
})();
