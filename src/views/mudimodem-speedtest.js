// MudiModem — Speedtest tab. A hidden /mudimodem-speedtest route, loaded the
// same way as Tracking: eval()'d by GL's SPA (module.exports = {...}), and
// lazy-loaded + embedded by the main page's "Speedtest" tab (props.embedded
// drops the "← Modem" breadcrumb since the tab bar is already visible).
//
// The test itself runs device-side (tools/mudimodem-speedtest.py, spawned
// detached by mudimodem.run_speedtest because a fixed-size download+upload+
// latency test takes ~10-20s -- too long for one $rpcRequest). This page
// polls mudimodem.get_speedtest_status roughly once a second while a test is
// in flight, then refetches history. Results persist in /etc/mudimodem (NOT
// /tmp, unlike the RF-history telemetry) so they survive a normal reboot.
//
// Vue is runtime-only here too: render(h) only, never template:.
module.exports = (function () {
  "use strict";

  var IFACES = [["cellular", "Cellular"], ["wired", "Wired WAN"]];
  var INTERVALS = [[1800, "30 min"], [3600, "1 hour"], [7200, "2 hours"],
    [21600, "6 hours"], [43200, "12 hours"], [86400, "24 hours"]];
  var PHASE_TEXT = { download: "Testing download…", upload: "Testing upload…",
    latency: "Testing latency…" };

  var component = {
    name: "mudimodem-speedtest",
    props: { embedded: { type: Boolean, default: false } },

    data: function () {
      return {
        styleId: "mms-css",
        results: [], resultsLoading: true, resultsErr: "",
        ifaces: null, ifacesErr: "",
        runIface: "cellular",
        filterIface: "cellular",
        status: { running: false },
        statusPoll: null,
        schedule: null, scheduleErr: "", scheduleSaving: false,
        cursor: null, pinned: null, width: 900
      };
    },

    computed: {
      filtered: function () {
        var f = this.filterIface;
        return this.results.filter(function (r) { return r.iface === f; });
      }
    },

    created: function () { this.injectStyle(); },
    mounted: function () {
      var self = this;
      if (typeof window === "undefined") return;
      this.measure();
      this._onResize = function () { self.measure(); };
      window.addEventListener("resize", this._onResize);
      this.fetchInterfaces();
      this.fetchHistory();
      this.fetchSchedule();
      this.fetchStatus(true);
    },
    beforeDestroy: function () {
      if (this.statusPoll) clearInterval(this.statusPoll);
      if (typeof window !== "undefined" && this._onResize) window.removeEventListener("resize", this._onResize);
    },

    methods: {
      measure: function () {
        if (this.$refs && this.$refs.graph && this.$refs.graph.clientWidth)
          this.width = this.$refs.graph.clientWidth;
      },
      rpc: function (method, params) {
        if (typeof window === "undefined" || !window.$rpcRequest) return Promise.reject(new Error("RPC unavailable"));
        return window.$rpcRequest("call", ["sid", "mudimodem", method, params || {}]);
      },
      fetchInterfaces: function () {
        var self = this;
        this.rpc("get_speedtest_interfaces", {})
          .then(function (r) { self.ifaces = r; self.ifacesErr = ""; })
          .catch(function (e) { self.ifacesErr = (e && (e.message || e.type)) || "could not check interfaces"; });
      },
      fetchHistory: function () {
        var self = this;
        this.resultsLoading = true;
        this.rpc("get_speedtest_history", {})
          .then(function (r) {
            self.results = (r && r.results) || [];
            self.resultsErr = ""; self.resultsLoading = false;
          })
          .catch(function (e) {
            self.resultsErr = (e && (e.message || e.type)) || "could not load history";
            self.resultsLoading = false;
          });
      },
      fetchSchedule: function () {
        var self = this;
        this.rpc("get_speedtest_schedule", {})
          .then(function (r) { self.schedule = r; })
          .catch(function () { /* leave schedule null -> honest "unavailable" */ });
      },
      fetchStatus: function (startPollIfRunning) {
        var self = this;
        this.rpc("get_speedtest_status", {})
          .then(function (r) {
            self.status = r || { running: false };
            if (self.status.running && startPollIfRunning) self.startPoll();
            if (!self.status.running && self.statusPoll) self.stopPollAndRefresh();
          })
          .catch(function () { /* transient -- next poll tick tries again */ });
      },
      startPoll: function () {
        var self = this;
        if (this.statusPoll) return;
        this.statusPoll = setInterval(function () { self.fetchStatus(false); }, 1000);
      },
      stopPollAndRefresh: function () {
        clearInterval(this.statusPoll);
        this.statusPoll = null;
        this.fetchHistory();
      },
      runTest: function () {
        var self = this;
        if (this.status.running) return;
        this.status = { running: true, phase: "download", iface: this.runIface };
        this.rpc("run_speedtest", { iface: this.runIface })
          .then(function (r) {
            if (r && r.error === "iface_down") {
              self.status = { running: false, phase: "error",
                message: (self.runIface === "cellular" ? "Cellular" : "Wired WAN") + " is not connected" };
              return;
            }
            if (r && r.error) { self.status = { running: false, phase: "error", message: r.error }; return; }
            self.startPoll();
          })
          .catch(function (e) {
            self.status = { running: false, phase: "error", message: (e && (e.message || e.type)) || "could not start" };
          });
      },
      setSchedule: function (enabled, intervalSeconds) {
        var self = this;
        this.scheduleSaving = true;
        this.rpc("set_speedtest_schedule", { enabled: enabled, interval_seconds: intervalSeconds })
          .then(function () { self.scheduleSaving = false; self.fetchSchedule(); })
          .catch(function (e) {
            self.scheduleSaving = false;
            self.scheduleErr = (e && (e.message || e.type)) || "could not save schedule";
          });
      },
      clearHistory: function () {
        var self = this;
        this.rpc("clear_speedtest_history", {}).then(function () { self.results = []; });
      },
      clock: function (t) {
        var d = new Date(t), p = function (n) { return (n < 10 ? "0" : "") + n; };
        return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
      },

      // ---- render ----
      renderControls: function (h) {
        var self = this;
        var ifaceSel = h("select", {
          domProps: { value: this.runIface },
          attrs: { disabled: this.status.running },
          on: { change: function (ev) { self.runIface = ev.target.value; } }
        }, IFACES.map(function (i) {
          var down = self.ifaces && self.ifaces[i[0]] && !self.ifaces[i[0]].up;
          return h("option", { attrs: { value: i[0] }, key: i[0] }, i[1] + (down ? " (not connected)" : ""));
        }));
        var runBtn = h("button", {
          staticClass: "mms-btn primary",
          attrs: { disabled: this.status.running },
          on: { click: function () { self.runTest(); } }
        }, this.status.running ? (PHASE_TEXT[this.status.phase] || "Testing…") : "Run speed test");
        var err = (!this.status.running && this.status.phase === "error")
          ? h("span", { staticClass: "mms-err" }, this.status.message) : null;
        var ifaceErr = this.ifacesErr
          ? h("span", { staticClass: "mms-err" }, "Couldn't check interfaces: " + this.ifacesErr) : null;
        return h("div", { staticClass: "mms-controls" }, [ifaceSel, runBtn, err, ifaceErr].filter(Boolean));
      },
      renderSchedule: function (h) {
        var self = this;
        if (!this.schedule) return null;
        var toggle = h("label", { staticClass: "mms-sched-toggle" }, [
          h("input", {
            attrs: { type: "checkbox", checked: this.schedule.enabled },
            domProps: { checked: this.schedule.enabled },
            on: { change: function (ev) { self.setSchedule(ev.target.checked, self.schedule.interval_seconds); } }
          }),
          "Automatic background tests"
        ]);
        var sel = h("select", {
          attrs: { disabled: !this.schedule.enabled },
          domProps: { value: this.schedule.interval_seconds },
          on: { change: function (ev) { self.setSchedule(self.schedule.enabled, parseInt(ev.target.value, 10)); } }
        }, INTERVALS.map(function (iv) { return h("option", { attrs: { value: iv[0] }, key: iv[0] }, "Every " + iv[1]); }));
        return h("div", { staticClass: "mms-sched" }, [toggle, sel]);
      },
      renderGraph: function (h) {
        var self = this, results = this.filtered;
        if (this.resultsLoading) return h("div", { staticClass: "mms-empty" }, "Loading history…");
        if (this.resultsErr) return h("div", { staticClass: "mms-empty" }, "Couldn't load history: " + this.resultsErr);
        if (!results.length) return h("div", { staticClass: "mms-empty" },
          "No results yet for this interface. Run a speed test above.");

        var W = this.width, PADL = 34, PADR = 12, PLOT_H = 160, LAT_H = 40, GAP = 14;
        var plotTop = 10, plotBot = plotTop + PLOT_H;
        var latTop = plotBot + GAP, latBot = latTop + LAT_H;
        var t0 = results[0].t, t1 = results[results.length - 1].t;
        var span = Math.max(1, t1 - t0);
        var xOf = function (t) { return PADL + (t - t0) / span * (W - PADL - PADR); };

        var maxMbps = 1;
        results.forEach(function (r) {
          if (r.down_mbps > maxMbps) maxMbps = r.down_mbps;
          if (r.up_mbps > maxMbps) maxMbps = r.up_mbps;
        });
        var yMax = maxMbps * 1.15;
        var yOf = function (v) { return plotBot - (Math.max(0, v || 0) / yMax) * PLOT_H; };
        var maxLatency = 1;
        results.forEach(function (r) { if (r.latency_ms > maxLatency) maxLatency = r.latency_ms; });
        var latYOf = function (v) { return latBot - (Math.max(0, v || 0) / (maxLatency * 1.15)) * LAT_H; };

        var kids = [];
        kids.push(h("rect", { attrs: { x: PADL, y: 0, width: 10, height: 3, fill: "var(--primary)" } }));
        kids.push(h("text", { attrs: { x: PADL + 14, y: 6, "font-size": 9.5, fill: "var(--text-badge)" } }, "Download"));
        kids.push(h("rect", { attrs: { x: PADL + 78, y: 0, width: 10, height: 3, fill: "var(--success)" } }));
        kids.push(h("text", { attrs: { x: PADL + 92, y: 6, "font-size": 9.5, fill: "var(--text-badge)" } }, "Upload"));

        [plotTop, plotBot].forEach(function (yy) {
          kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: yy, y2: yy,
            stroke: "var(--divider)", "stroke-width": 1 } }));
        });

        function linePath(key, color) {
          var d = "", pen = false;
          results.forEach(function (r) {
            var v = r[key];
            if (v == null) { pen = false; return; }
            d += (pen ? "L" : "M") + xOf(r.t).toFixed(1) + " " + yOf(v).toFixed(1) + " ";
            pen = true;
          });
          return d ? h("path", { attrs: { fill: "none", stroke: color, "stroke-width": 1.75, d: d.trim() } }) : null;
        }
        var downLine = linePath("down_mbps", "var(--primary)");
        var upLine = linePath("up_mbps", "var(--success)");
        if (downLine) kids.push(downLine);
        if (upLine) kids.push(upLine);
        results.forEach(function (r) {
          if (r.down_mbps != null) {
            kids.push(h("circle", { attrs: { cx: xOf(r.t).toFixed(1), cy: yOf(r.down_mbps).toFixed(1), r: 2.5, fill: "var(--primary)" } }));
          }
          if (r.up_mbps != null) {
            kids.push(h("circle", { attrs: { cx: xOf(r.t).toFixed(1), cy: yOf(r.up_mbps).toFixed(1), r: 2.5, fill: "var(--success)" } }));
          }
        });

        kids.push(h("text", { attrs: { x: 4, y: latTop + LAT_H / 2 + 3, "font-size": 9, fill: "var(--text-badge)" } }, "MS"));
        kids.push(h("line", { attrs: { x1: PADL, x2: W - PADR, y1: latBot, y2: latBot,
          stroke: "var(--divider)", "stroke-width": 1 } }));
        var latD = "", penL = false;
        results.forEach(function (r) {
          if (r.latency_ms == null) { penL = false; return; }
          latD += (penL ? "L" : "M") + xOf(r.t).toFixed(1) + " " + latYOf(r.latency_ms).toFixed(1) + " ";
          penL = true;
        });
        if (latD) kids.push(h("path", { attrs: { fill: "none", stroke: "var(--warning)", "stroke-width": 1.5, d: latD.trim() } }));

        if (this.cursor != null && results[this.cursor]) {
          var cx = xOf(results[this.cursor].t);
          kids.push(h("line", { attrs: { x1: cx.toFixed(1), x2: cx.toFixed(1), y1: plotTop, y2: latBot,
            stroke: this.pinned != null ? "var(--primary)" : "var(--text-weak)", "stroke-width": 1 } }));
        }

        var svg = h("svg", { ref: "svg", attrs: { viewBox: "0 0 " + W + " " + (latBot + 4),
          width: W, height: latBot + 4, preserveAspectRatio: "none" } }, kids);

        var nearestIdx = function (evX) {
          var best = 0, bestD = Infinity;
          results.forEach(function (r, i) {
            var d = Math.abs(xOf(r.t) - evX);
            if (d < bestD) { bestD = d; best = i; }
          });
          return best;
        };
        var onMove = function (e) {
          if (self.pinned != null) return;
          var el = self.$refs && self.$refs.graph;
          if (!el || !el.getBoundingClientRect) { self.cursor = results.length - 1; return; }
          var rect = el.getBoundingClientRect();
          if (!rect.width) { self.cursor = results.length - 1; return; }
          var ux = ((e.clientX || 0) - rect.left) * self.width / rect.width;
          self.cursor = nearestIdx(ux);
        };
        var onLeave = function () { if (self.pinned == null) self.cursor = null; };
        var onClick = function (e) {
          if (self.pinned != null) { self.pinned = null; return; }
          onMove(e);
          if (self.cursor == null) self.cursor = results.length - 1;
          self.pinned = self.cursor;
        };

        var tip = null;
        if (this.cursor != null && results[this.cursor]) {
          var r = results[this.cursor];
          var rows = [
            ["Down", r.down_mbps == null ? "—" : r.down_mbps + " Mbps"],
            ["Up", r.up_mbps == null ? "—" : r.up_mbps + " Mbps"],
            ["Latency", r.latency_ms == null ? "—" : r.latency_ms + " ms (±" + (r.jitter_ms == null ? "—" : r.jitter_ms) + ")"],
            ["Carrier", (r.carrier || "—") + " · SIM " + (r.slot == null ? "—" : r.slot)],
            ["Band", r.band == null ? "—" : (r.mode && /NR5G/.test(r.mode) ? "n" : "B") + r.band],
            ["Cell", r.cell_id == null ? "—" : r.cell_id],
            ["RSRP", r.rsrp == null ? "—" : r.rsrp + " dBm"],
            ["SINR", r.sinr == null ? "—" : r.sinr + " dB"],
            ["RSRQ", r.rsrq == null ? "—" : r.rsrq + " dB"]
          ];
          tip = h("div", { staticClass: "mms-tip" }, [
            h("div", { staticClass: "t" }, this.clock(r.t) + (this.pinned != null ? " · pinned" : ""))
          ].concat(rows.map(function (row) {
            return h("div", { staticClass: "mms-tip-row" }, [h("span", row[0]), h("b", row[1])]);
          })));
        }

        return h("div", { ref: "graph", staticClass: "mms-graph",
          on: { mousemove: onMove, mouseleave: onLeave, click: onClick } }, [svg, tip]);
      },
      injectStyle: function () {
        if (typeof document === "undefined" || document.getElementById(this.styleId)) return;
        var css =
          '.mms{color:var(--text-regular)}' +
          '.mms-card{background:var(--background-card);border-radius:4px;box-shadow:0 1px 5px rgba(0,0,0,.06);padding:12px 14px;margin-bottom:11px}' +
          '.mms-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}' +
          '.mms-crumb{background:none;border:0;font:inherit;font-size:12px;color:var(--primary);cursor:pointer;padding:0}' +
          '.mms-title{font-size:14px;font-weight:600;color:var(--text-title)}' +
          '.mms-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
          '.mms-btn{font-size:12px;font-weight:600;border-radius:3px;padding:7px 14px;cursor:pointer;font-family:inherit;border:1px solid var(--border);background:var(--background-card);color:var(--text-regular)}' +
          '.mms-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}' +
          '.mms-btn:disabled{opacity:.6;cursor:default}' +
          '.mms-err{color:var(--error);font-size:12px}' +
          '.mms-sched{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px}' +
          '.mms-sched-toggle{display:flex;align-items:center;gap:6px;cursor:pointer}' +
          '.mms-empty{padding:24px 0;text-align:center;color:var(--text-hint);font-size:12.5px}' +
          '.mms-graph{position:relative;cursor:crosshair}.mms-graph svg{display:block;width:100%}' +
          '.mms-tip{position:absolute;top:8px;left:8px;pointer-events:none;z-index:5;background:var(--background-card);border:1px solid var(--border);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:8px 10px;min-width:170px}' +
          '.mms-tip .t{font-size:10.5px;color:var(--text-badge);margin-bottom:5px}' +
          '.mms-tip-row{display:flex;justify-content:space-between;gap:14px;font-size:11.5px;padding:1px 0}' +
          '.mms-tip-row b{font-weight:600;color:var(--text-title)}';
        var el = document.createElement("style");
        el.id = this.styleId; el.textContent = css;
        document.head.appendChild(el);
      },
      renderPage: function (h) {
        var self = this;
        var head = h("div", { staticClass: "mms-head" }, [
          this.embedded ? null : h("button", { staticClass: "mms-crumb", on: { click: function () {
            if (self.$router) self.$router.push("/mudimodem"); } } }, "← Modem"),
          h("span", { staticClass: "mms-title" }, "Speedtest")
        ].filter(Boolean));
        var ifaceFilterSel = h("select", {
          domProps: { value: this.filterIface },
          on: { change: function (ev) { self.filterIface = ev.target.value; } }
        }, IFACES.map(function (i) { return h("option", { attrs: { value: i[0] }, key: i[0] }, i[1]); }));
        return h("div", { staticClass: "mms" }, [
          h("div", { staticClass: "mms-card" }, [head, this.renderControls(h), this.renderSchedule(h)]),
          h("div", { staticClass: "mms-card" }, [
            h("div", { staticClass: "mms-controls" }, [
              h("span", "History"), ifaceFilterSel,
              h("button", { staticClass: "mms-btn", on: { click: function () { self.clearHistory(); } } }, "Clear history")
            ]),
            this.renderGraph(h)
          ])
        ]);
      }
    },

    render: function (h) { return this.renderPage(h); }
  };
  return component;
})();
