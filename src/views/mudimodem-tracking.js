// MudiModem — Tracking (the uber graph). A hidden /mudimodem-tracking route.
//
// Loaded by GL's SPA via eval(): the file is ONE expression whose value is the
// component. Vue is runtime-only -> render(h) only, never template:.
//
// History comes from the device-side collector (mudimodem-collectd), read via a
// SILENT POST to /rpc (window.$axios directly, NOT $rpcRequest) so a failed
// background poll can't trigger GL's global "Unknown error" banner — see
// rpcSilent(). -> { samples:[...], events:[...], now }. The page fetches the full
// 24h once on mount, then polls incrementally with `since`.
// Handover/failover ticks are DERIVED here from the sample stream (net events
// aren't persisted); user/watchdog events come from the server.
//
// Times are the box clock (os.time()*1000). We render relative to a skew-
// corrected box-now so the axis doesn't jump if the browser clock differs.
//
// The middle bus is CELL ID (cell_info.id) + ARFCN — the box carries NO PCI over
// ubus. Metrics arrive as numbers already (parsed by the collector); _level
// buckets drive the GL quality ramp. All colour is GL theme tokens.
module.exports = (function () {
  "use strict";

  // Three metrics OVERLAID in one plot. Each keeps its own domain (`dom`) but
  // maps into the same shared rectangle (PLOT_H) — a normalized overlay, so the
  // lines are comparable in shape. Fixed GL-token colour per metric keeps them
  // apart: RSRP=primary(blue), SINR=success(mint), RSRQ=error(rose). (GL ships no
  // saturated purple that survives the dark theme — its --gl-purple ramp is the
  // desaturated text ramp — so rose is the third distinct hue.) Signal QUALITY is
  // no longer painted on the lines; it lives in the hover readout + the strip.
  // `lvl` is retained for the readout's quality colouring.
  var LINES = [
    { key: "rsrp", label: "RSRP · dBm", dom: [-120, -80], color: "var(--primary)", lvl: "rsrp_level" },
    { key: "sinr", label: "SINR · dB",  dom: [-10, 30],   color: "var(--success)", lvl: "sinr_level" },
    { key: "rsrq", label: "RSRQ · dB",  dom: [-20, -3],   color: "var(--error)",   lvl: "rsrq_level" }
  ];
  var BUSES = [{ key: "band", label: "BAND" }, { key: "id", label: "CELL" }, { key: "sim", label: "SIM" }];
  var FREQ_N = { 2:1900,5:850,7:2600,12:700,13:750,14:700,25:1900,26:850,29:700,30:2300,
    38:2600,41:2500,48:3500,66:1700,70:1700,71:600,77:3700,78:3500,79:4700 };
  var RANGES = [[15,"15 m"],[60,"1 h"],[360,"6 h"],[1440,"24 h"]];
  var TICKSTEP = { 15:2, 60:10, 360:60, 1440:240 };
  var RECENT_USER_MS = 8000;
  var PADL = 30, PADR = 12, BUS_H = 20, PLOT_H = 230;

  var component = {
    name: "mudimodem-tracking",

    // `embedded` is set when the main Modem page renders us inside its own
    // "Tracking" tab (vs. the standalone /mudimodem-tracking route). When
    // embedded we drop the "← Modem" breadcrumb — the tab bar is right above us.
    props: { embedded: { type: Boolean, default: false } },

    data: function () {
      return { winW: 60, pinnedM: null, tick: 0, live: true, width: 900,
        styleId: "mmt-css", cursor: null, poll: null,
        samples: [], events: [], lastT: 0, serverNow: 0, serverNowAt: 0,
        loading: true, err: "" };
    },

    computed: {
      // handover/failover ticks derived from the sample stream, merged with the
      // server's user/watchdog events, newest last. Depends on `tick` for polling.
      allEvents: function () {
        this.tick;
        var derived = this.deriveNetEvents(this.samples, this.events);
        return this.events.concat(derived).sort(function (a, b) { return a.t - b.t; });
      }
    },

    created: function () { this.injectStyle(); },
    mounted: function () {
      var self = this;
      if (typeof window === "undefined") return;
      this.measure();
      this.parseHash();
      this._onResize = function () { self.measure(); };
      window.addEventListener("resize", this._onResize);
      this.fetchHistory(false);
      this.poll = setInterval(function () { if (self.live) self.fetchHistory(true); }, 10000);
    },
    // Keep the viewBox width in sync with the rendered width. At mount the lanes
    // element is usually absent (loading state), so the initial measure() no-ops
    // and this.width stays at its default until data arrives and the SVG renders.
    // Re-measuring here makes the SVG scale ≈ 1 (no stretched text) and keeps the
    // pointer→time mapping exact. measure() only sets when clientWidth is truthy,
    // and Vue skips the reactive write when unchanged, so this converges — no loop.
    updated: function () { this.measure(); },
    beforeDestroy: function () {
      if (this.poll) clearInterval(this.poll);
      if (typeof window !== "undefined" && this._onResize) window.removeEventListener("resize", this._onResize);
    },

    methods: {
      // ---- data ----
      // Post to /rpc via $axios DIRECTLY, not $rpcRequest. $rpcRequest's axios
      // interceptor pops GL's global "Unknown error" banner on any 500 or
      // JSON-RPC error BEFORE our .catch can run — unacceptable for a silent 10s
      // background poll on a flaky cellular link (GL exempts only its own "alive"
      // heartbeat). We handle the envelope ourselves and fail silently: a bad
      // poll just retries next tick. Returns the result object, or null.
      rpcSilent: function (method, params) {
        if (typeof window === "undefined" || !window.$axios) return Promise.resolve(null);
        var sid = (window.$getCookie && window.$getCookie("Admin-Token")) || "";
        return window.$axios.post("/rpc", {
          jsonrpc: "2.0", id: 1, method: "call",
          params: [sid, "mudimodem", method, params || {}]
        }, { timeout: 20000 })
          .then(function (r) { return (r && r.data && r.data.result) || null; })
          .catch(function () { return null; });
      },
      fetchHistory: function (incremental) {
        var self = this;
        if (typeof window === "undefined" || !window.$axios) { self.loading = false; return; }
        var since = incremental ? self.lastT : 0;
        this.rpcSilent("get_history", { since: since })
          .then(function (res) {
            if (!res) { self.loading = false; if (!incremental) self.err = ""; return; }
            var ns = res.samples || [], ne = res.events || [];
            if (incremental) {
              if (ns.length) self.samples = self.samples.concat(ns);
              if (ne.length) self.events = self.events.concat(ne);
            } else { self.samples = ns; self.events = ne; }
            self.serverNow = res.now || Date.now();
            self.serverNowAt = Date.now();
            var cut = self.serverNow - 24 * 3600 * 1000;
            self.samples = self.samples.filter(function (s) { return s.t >= cut; });
            self.events = self.events.filter(function (e) { return e.t >= cut; });
            if (self.samples.length) self.lastT = self.samples[self.samples.length - 1].t;
            self.err = ""; self.loading = false; self.tick++;
          })
          .catch(function (e) {
            self.err = (e && (e.type || e.message)) || "couldn't load history"; self.loading = false;
          });
      },
      // pure: derive net (handover/failover) events from consecutive samples,
      // suppressing any within RECENT_USER_MS of a known user/watchdog event so a
      // change WE applied isn't double-counted as a network event.
      deriveNetEvents: function (samples, known) {
        var out = [], last = null;
        var recentUser = function (t) {
          for (var i = 0; i < known.length; i++)
            if (Math.abs(known[i].t - t) <= RECENT_USER_MS &&
                (known[i].kind === "user" || known[i].kind === "dog")) return true;
          return false;
        };
        for (var i = 0; i < samples.length; i++) {
          var s = samples[i];
          if (last && !recentUser(s.t)) {
            if (String(s.slot) !== String(last.slot)) {
              out.push({ t: s.t, kind: "net", label: "Failover",
                detail: "Data now on SIM " + s.slot + (s.carrier ? " · " + s.carrier : "") });
            } else if (s.id != null && last.id != null && String(s.id) !== String(last.id)) {
              out.push({ t: s.t, kind: "net", label: "Handover",
                detail: "Cell " + last.id + " → " + s.id + (s.band != null ? " (" + s.band + ")" : "") });
            }
          }
          last = s;
        }
        return out;
      },

      measure: function () {
        if (this.$refs && this.$refs.lanes && this.$refs.lanes.clientWidth)
          this.width = this.$refs.lanes.clientWidth;
      },
      // skew-corrected box-now: server clock advanced by browser elapsed time.
      // Before the first fetch, fall back to the local clock (Date is universal).
      nowMs: function () {
        if (this.serverNow) return this.serverNow + (Date.now() - this.serverNowAt);
        return Date.now();
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

      mOf: function (t) { return -((this.nowMs() - t) / 60000); },
      xOf: function (m) {
        var plotW = this.width - PADL - PADR;
        return PADL + (m + this.winW) / this.winW * plotW;
      },
      winSamples: function () {
        var cutoff = this.nowMs() - this.winW * 60000, self = this;
        return this.samples.filter(function (s) { return s.t >= cutoff; })
          .map(function (s) { return Object.assign({ m: self.mOf(s.t) }, s); });
      },
      winEvents: function () {
        var cutoff = this.nowMs() - this.winW * 60000, self = this;
        return this.allEvents.filter(function (e) { return e.t >= cutoff; })
          .map(function (e) { return Object.assign({ m: self.mOf(e.t) }, e); });
      },
      nearestSample: function (m) {
        var ss = this.winSamples(); if (!ss.length) return null;
        var best = ss[0];
        for (var i = 1; i < ss.length; i++)
          if (Math.abs(ss[i].m - m) < Math.abs(best.m - m)) best = ss[i];
        return best;
      },
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
        if (runs.length) runs[runs.length - 1].m1 = 0;
        return runs;
      },

      // ---- interaction ----
      mFromEvent: function (e) {
        var el = this.$refs.lanes; if (!el) return null;
        var r = el.getBoundingClientRect(); if (!r.width) return null;
        // clientX is CSS px within the container; the SVG scales its viewBox
        // (this.width user-units) to the container's rendered width (width:100%).
        // Convert CSS px -> viewBox units before applying the plot geometry, so
        // the cursor tracks the mouse even when this.width != rendered width
        // (e.g. embedded, before measure() catches up). Otherwise the drawn line
        // (xOf, in viewBox units) drifts right of the pointer.
        var ux = (e.clientX - r.left) * this.width / r.width;
        var plotW = this.width - PADL - PADR;
        return -this.winW + (ux - PADL) / plotW * this.winW;
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
        var self = this, W = this.width, kids = [];
        var ss = this.winSamples();

        // ---- legend: one swatch + name + domain range per metric. A single
        // shared Y-axis can't label three scales, so the ranges live here; exact
        // per-sample values are in the hover readout.
        var lx = PADL;
        LINES.forEach(function (L) {
          var lab = L.label + "  " + L.dom[0] + "…" + L.dom[1];
          kids.push(h("rect", { attrs: { x: lx, y: 3, width: 13, height: 3, rx: 1.5, fill: L.color } }));
          kids.push(h("text", { attrs: { x: lx + 18, y: 9, "font-size": 9.5,
            fill: "var(--text-badge)" } }, lab));
          lx += 18 + String(lab).length * 5.7 + 20;
        });

        // ---- one shared plot rectangle; each metric normalized into it.
        var plotTop = 22, plotBot = plotTop + PLOT_H;
        [plotTop, plotBot].forEach(function (yy) {
          kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yy, y2: yy,
            stroke: "var(--divider)", "stroke-width": 1 } }));
        });
        kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR,
          y1: plotTop + PLOT_H / 2, y2: plotTop + PLOT_H / 2,
          stroke: "var(--divider)", "stroke-width": 1, "stroke-dasharray": "2 3" } }));

        LINES.forEach(function (L) {
          var d0 = L.dom[0], d1 = L.dom[1];
          var yv = function (v) {
            return plotBot - (Math.max(d0, Math.min(d1, v)) - d0) / (d1 - d0) * PLOT_H;
          };
          var d = "", pen = false;                       // one path per metric
          ss.forEach(function (s) {
            var v = s[L.key];
            if (v == null) { pen = false; return; }       // break into a gap
            d += (pen ? "L" : "M") + self.xOf(s.m).toFixed(1) + " " + yv(v).toFixed(1) + " ";
            pen = true;
          });
          if (d) kids.push(h("path", { attrs: { fill: "none", stroke: L.color,
            "stroke-width": 1.75, "stroke-linejoin": "round", "stroke-linecap": "round",
            d: d.trim() } }));
        });

        // ---- buses below the plot (unchanged layout, new origin).
        var y = plotBot + 12;
        BUSES.forEach(function (B) {
          kids.push(h("text", { attrs: { x: 6, y: y + BUS_H / 2 + 3, "font-size": 9,
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
        var evTop = plotTop, evBot = y - 7;
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
        // preserveAspectRatio:none — STRETCH the viewBox to fill the container
        // width (CSS width:100%). The default "meet" would uniformly scale and
        // CENTRE the content (elemH == viewBox H makes its scale 1), so whenever
        // this.width != the rendered width the cursor line lags the pointer
        // toward both edges. "none" keeps X mapping = rendered/viewBox, matching
        // mFromEvent's inverse. (Y is unaffected: elemH == viewBox H already.)
        return h("svg", { ref: "svg", attrs: { viewBox: "0 0 " + W + " " + y,
          width: W, height: y, preserveAspectRatio: "none" } }, kids);
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
        var self = this;
        var evs = this.allEvents.slice().reverse();
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
        var self = this;
        var hasData = this.winSamples().length > 0;
        var head = h("div", { staticClass: "mmt-head" }, [
          this.embedded ? null : h("button", { staticClass: "mmt-crumb", on: { click: function () {
            if (self.$router) self.$router.push("/mudimodem"); } } }, "← Modem"),
          h("span", { staticClass: "mmt-title" }, "Tracking"),
          h("span", { staticClass: "mmt-hint" }, "one clock, all three metrics — hover for a slice, click to pin"),
          h("span", { staticClass: "mmt-sp" }),
          h("span", { staticClass: "mmt-seg" }, RANGES.map(function (r) {
            return h("button", { key: r[0], staticClass: self.winW === r[0] ? "on" : "",
              on: { click: function () { self.setRange(r[0]); } } }, r[1]);
          })),
          h("button", { staticClass: "mmt-live" + (self.live ? "" : " off"),
            on: { click: function () { self.live = !self.live; } } },
            [h("span", { staticClass: "d" }), self.live ? "LIVE" : "PAUSED"])
        ]);
        var body;
        if (hasData) {
          body = h("div", { ref: "lanes", staticClass: "mmt-lanes",
            on: { mousemove: this.onMove, mouseleave: this.onLeave, click: this.onClick } },
            [this.renderLanes(h), this.cursor != null ? this.sliceReadout(h) : null]);
        } else {
          var msg = this.err ? "Couldn't load history: " + this.err
            : this.loading ? "Loading history from the router…"
            : "No samples yet. The collector runs on the router and gathers continuously — "
              + "check back in a minute, or confirm the mudimodem-collectd service is running.";
          body = h("div", { staticClass: "mmt-empty" }, msg);
        }
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
  return component;
})();
