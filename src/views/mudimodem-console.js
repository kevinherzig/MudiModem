// MudiModem — Phase 3: AT console + community AT library.
//
// Loaded lazily by the main mudimodem chunk into its "AT console" tab (same
// mechanism the SPA uses for views): axios GET + eval with `module` in scope,
// so this file MUST be a single expression (module.exports = {...}).
// Vue is runtime-only: render(h) only, never `template:`.
//
// Transport: mudimodem.at_console — OUR OWN channel (/dev/at_mdm0), which
// answers for the ACTIVE subscription only (no sub_id exists on that port;
// probed 2026-07-18). The library is static JSON at /mudimodem/at-library.json
// (gzip_static), fetched with $axios. Entries only ever FILL the prompt —
// nothing auto-runs. set/nv entries need the banner checkbox to Send;
// free-typed commands always send (Kevin's call, spec §1).
module.exports = {
  name: "mudimodem-console",

  data() {
    return {
      styleId: "mudimodem-console-css",
      lib: null,            // library entries once fetched
      libLoading: false,
      libErr: "",
      q: "",                // rail search text
      selId: null,          // selected entry id; null = free-typing
      riskOK: false,        // "Enable higher-risk commands" (localStorage)
      lines: [],            // transcript { t, kind: cmd|resp|ok|err|urc|note, text }
      LINES_MAX: 400,
      history: [],
      histIdx: null,
      prompt: "",
      params: {},           // param values for the selected entry
      sending: false,
      decodeRows: null,     // [[{f,v,hi},…] per matched response line]
      decodeSrc: ""
    };
  },

  computed: {
    ms() {
      var s = this.$store && this.$store.getters;
      return (s && s.moduleStatus) ? s.moduleStatus : function () { return {}; };
    },
    activeSlot() {
      var m = (this.ms("cellular.modems_status").modems || [])[0] || {};
      return m.current_sim_slot;
    },
    activeCarrier() {
      var self = this;
      var sims = this.ms("cellular.sims_status").sims || [];
      var s = sims.filter(function (x) { return String(x.slot) === String(self.activeSlot); })[0] || {};
      return s.carrier || "";
    },
    // The port answers for the active subscription ONLY — say so, always.
    truthLine() {
      var who = this.activeCarrier
        ? this.activeCarrier + " (slot " + this.activeSlot + ")"
        : (this.activeSlot ? "slot " + this.activeSlot : "resolving…");
      return "own channel /dev/at_mdm0 · active SIM: " + who;
    },
    entries() {
      var lib = this.lib || [];
      var q = this.q.toLowerCase();
      if (!q) return lib;
      return lib.filter(function (e) {
        return (e.title + " " + e.cmd + " " + e.summary + " " + e.cat)
          .toLowerCase().indexOf(q) !== -1;
      });
    },
    cats() {
      var seen = [];
      this.entries.forEach(function (e) {
        if (seen.indexOf(e.cat) === -1) seen.push(e.cat);
      });
      return seen;
    },
    sel() {
      var id = this.selId;
      return (this.lib || []).filter(function (e) { return e.id === id; })[0] || null;
    },
    selParams() { return (this.sel && this.sel.params) || []; },
    paramMode() { return this.selParams.length > 0; },
    // The command text that would be sent: the entry's cmd OR its steps joined
    // by newline, with {{params}} substituted (unfilled ones stay visible).
    assembled() {
      if (!this.sel || !this.paramMode) return this.prompt;
      var base = this.sel.steps ? this.sel.steps.join("\n") : this.sel.cmd;
      var p = this.params;
      return base.replace(/\{\{(\w+)\}\}/g, function (m, name) {
        var v = ((p[name] || "") + "").trim();
        return v !== "" ? v : m;
      });
    },
    // The wire command split into individual AT steps (trimmed, blanks dropped).
    stepLines() {
      var v = ((this.paramMode ? this.assembled : this.prompt) || "").trim();
      if (!v) return [];
      return v.split(/\r?\n/).map(function (s) { return s.trim(); })
              .filter(function (s) { return s !== ""; });
    },
    paramsFilled() {
      var p = this.params;
      return this.selParams.every(function (x) {
        return ((p[x.name] || "") + "").trim() !== "";
      });
    },
    gateBlocked() { return !!(this.sel && this.sel.risk !== "read" && !this.riskOK); }
  },

  created() {
    this.injectStyle();
    if (typeof window !== "undefined" && window.localStorage) {
      this.riskOK = window.localStorage.getItem("mudimodem.riskEnabled") === "1";
    }
    this.fetchLib();
  },

  methods: {
    fetchLib() {
      var self = this;
      if (this.libLoading) return;
      if (typeof window === "undefined" || !window.$axios) return;
      this.libLoading = true; this.libErr = "";
      window.$axios.get("/mudimodem/at-library.json?_t=" + Date.now())
        .then(function (res) {
          self.lib = (res.data && res.data.entries) || [];
          self.libLoading = false;
        })
        .catch(function (e) {
          self.libLoading = false;
          self.libErr = (e && e.message) || "load failed";
        });
    },
    toggleGate() {
      this.riskOK = !this.riskOK;
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem("mudimodem.riskEnabled", this.riskOK ? "1" : "0");
      }
    },
    pick(e) {
      this.selId = e.id;
      var ps = {};
      (e.params || []).forEach(function (p) { ps[p.name] = ""; });
      this.params = ps;               // fresh object => later key writes are reactive
      this.prompt = (e.params && e.params.length) ? "" : e.cmd;
      this.decodeRows = null; this.decodeSrc = "";
    },
    onPromptInput(v) {
      this.prompt = v;
      // Hand-editing away from the entry's command = free-typing (gate no
      // longer applies; the entry stops claiming the prompt).
      if (this.sel && !this.paramMode && v !== this.sel.cmd) this.selId = null;
    },
    promptKey(ev) {
      if (ev.key === "Enter") { this.send(); return; }
      if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && !this.paramMode) {
        if (!this.history.length) return;
        if (ev.preventDefault) ev.preventDefault();
        var i = this.histIdx === null ? this.history.length : this.histIdx;
        i += (ev.key === "ArrowUp" ? -1 : 1);
        if (i < 0) i = 0;
        if (i >= this.history.length) { this.histIdx = null; this.prompt = ""; return; }
        this.histIdx = i;
        this.prompt = this.history[i];
        this.selId = null;
      }
    },
    stamp() {
      var d = new Date();
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    push(kind, text) {
      this.lines.push({ t: this.stamp(), kind: kind, text: text });
      if (this.lines.length > this.LINES_MAX) {
        this.lines.splice(0, this.lines.length - this.LINES_MAX);
      }
    },
    note(text) { this.push("note", text); },
    classifyLine(l) {
      var URCS = ["RDY", "+CPIN:", "+QUSIM", "+CPINDS:", "+QIND:", "+CFUN:",
                  "+CGEV:", "+QNETDEVSTATUS:", "POWERED DOWN"];
      if (l === "OK") return "ok";
      if (l === "ERROR" || l.indexOf("+CME ERROR") === 0 || l.indexOf("+CMS ERROR") === 0) return "err";
      for (var i = 0; i < URCS.length; i++) if (l.indexOf(URCS[i]) === 0) return "urc";
      return "resp";
    },
    // Quote-aware CSV split: '"a,b",c' -> ['a,b','c'] (AT responses quote text).
    splitFields(s) {
      var out = [], cur = "", inQ = false;
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch === '"') { inQ = !inQ; cur += ch; }
        else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(function (x) { return x.trim().replace(/^"|"$/g, ""); });
    },
    // Label matched response lines with the entry's decode fields. `entry` may
    // be null (free-typed): fall back to an exact cmd match in the library.
    applyDecode(entry, cmd, resp) {
      var e = (entry && entry.cmd === cmd) ? entry : null;
      if (!e) {
        e = (this.lib || []).filter(function (x) { return x.cmd === cmd; })[0] || null;
      }
      if (!e || !e.decode) { this.decodeRows = null; this.decodeSrc = ""; return; }
      var d = e.decode, self = this, rows = [];
      resp.replace(/\r/g, "\n").split("\n").forEach(function (line) {
        line = line.trim();
        if (!line || line.indexOf(d.prefix) !== 0) return;
        var rest = line.slice(d.prefix.length).replace(/^[,\s]+/, "");
        var parts = self.splitFields(rest);
        rows.push(d.fields.map(function (f, i) {
          var v = (parts[i] !== undefined && parts[i] !== "") ? parts[i] : "—";
          var en = (d.enums || {})[f];
          // An enum field is NOT its own value — raw 2 means 15 MHz, not 2 MHz.
          if (en && en[v] !== undefined) v = en[v];
          return { f: f, v: v, hi: (d.hi || []).indexOf(f) !== -1 };
        }));
      });
      this.decodeRows = rows.length ? rows : null;
      this.decodeSrc = e.id;
    },
    send() {
      var self = this;
      var entry = this.sel;
      var steps = this.stepLines;
      if (!steps.length || this.sending) return;
      if (steps.some(function (s) { return /\{\{/.test(s); })) {
        this.note("fill in every parameter before sending"); return;
      }
      if (this.gateBlocked) {
        this.note('this is a ' + entry.risk + ' entry — tick "Enable higher-risk commands" in the banner to send it');
        return;
      }
      var wire = steps.join("\n");
      steps.forEach(function (s) { self.push("cmd", s); });
      this.history.push(wire); this.histIdx = null;
      this.decodeRows = null;
      if (typeof window === "undefined" || !window.$rpcRequest) {
        this.push("err", "RPC unavailable"); return;
      }
      var TOOL_T = 8;   // per-step deadline; rpc timeout = TOOL_T*steps + 10 s
      this.sending = true;
      return window.$rpcRequest("call", ["sid", "mudimodem", "at_console",
                                         { cmd: wire, timeout: TOOL_T }],
                         { timeout: (TOOL_T * steps.length + 10) * 1000 })
        .then(function (r) {
          self.sending = false;
          if (r && r.error) { self.push("err", r.error); return; }
          var got = (r && r.steps) || [];
          var combined = "";
          got.forEach(function (st) {
            var resp = (st.response || "");
            combined += resp + "\n";
            resp.replace(/\r/g, "\n").split("\n").forEach(function (l) {
              l = l.trim();
              if (l) self.push(self.classifyLine(l), l);
            });
            if (st.status === "timeout") {
              self.push("err", "no terminator after " + TOOL_T +
                "s — the response may still arrive; the channel is drained on the next send");
            }
          });
          if (r && r.aborted) {
            var skipped = (r.requested || steps.length) - (r.ran || got.length);
            for (var i = 0; i < skipped; i++) self.note("skipped — previous step failed");
          }
          self.applyDecode(entry, wire, combined);
        })
        .catch(function (e) {
          self.sending = false;
          self.push("err", (e && (e.message || e.type)) || "request failed");
        });
    },
    copyTranscript() {
      var txt = this.lines.map(function (l) { return l.t + "  " + l.text; }).join("\n");
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
      }
    },
    riskText(r) {
      return { read: "safe — reads only",
               set: "changes runtime state — gone on reboot",
               nv: "WRITES MODEM NV — survives factory reset" }[r] || r;
    },
    injectStyle() {
      if (typeof document === "undefined" || document.getElementById(this.styleId)) return;
      var css =
        '.mmc{color:var(--text-regular)}' +
        '.mmc-caution{display:flex;gap:8px;align-items:baseline;background:var(--error-bg);border:1px solid var(--error-100);border-radius:3px;padding:8px 10px;font-size:11.5px;color:var(--error-700);margin-bottom:11px;flex-wrap:wrap}' +
        '.mmc-caution b{color:var(--error);flex:none}' +
        '.mmc-gate{margin-left:auto;display:flex;gap:5px;align-items:center;white-space:nowrap;cursor:pointer;font-size:11.5px}' +
        '.mmc-split{display:grid;grid-template-columns:270px 1fr;gap:10px}' +
        '@media(max-width:820px){.mmc-split{grid-template-columns:1fr}}' +
        '.mmc-card{background:var(--bg-card);border-radius:4px;box-shadow:0 1px 5px var(--shadow);padding:11px 12px}' +
        '.mmc-sect{font-size:13px;font-weight:600;color:var(--text-title)}' +
        '.mmc-hint{font-size:11.5px;color:var(--text-badge)}' +
        '.mmc-row{display:flex;justify-content:space-between;align-items:center;gap:12px}' +
        '.mmc-search{width:100%;font:12px inherit;padding:5px 9px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular);margin-top:8px}' +
        '.mmc-search:focus{outline:0;border-color:var(--primary)}' +
        '.mmc-libbody{overflow-y:auto;max-height:430px;margin:6px -12px 0;padding:0}' +
        '.mmc-cat{font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-badge);padding:8px 12px 4px}' +
        '.mmc-snip{display:block;width:100%;text-align:left;background:none;border:0;cursor:pointer;padding:6px 12px;border-left:2px solid transparent;font:inherit;color:inherit}' +
        '.mmc-snip:hover{background:var(--bg-title)}' +
        '.mmc-snip.on{background:var(--primary-bg);border-left-color:var(--primary)}' +
        '.mmc-snip:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}' +
        '.mmc-snip-t{display:flex;align-items:center;gap:6px}' +
        '.mmc-snip-t b{font-size:12px;font-weight:600;color:var(--text-title)}' +
        '.mmc-snip code{display:block;font-family:monospace;font-size:10.5px;color:var(--text-weak);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.mmc-risk{font-size:8.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:2px;padding:1px 4px;flex:none}' +
        '.mmc-risk.read{background:var(--success-bg);color:var(--success-700);border:1px solid var(--success-100)}' +
        '.mmc-risk.set{background:var(--warning-bg);color:var(--warning-700);border:1px solid var(--warning-100)}' +
        '.mmc-risk.nv{background:var(--error-bg);color:var(--error-700);border:1px solid var(--error-100)}' +
        '.mmc-term{background:var(--bg-title);border:1px solid var(--divider);border-radius:3px;padding:9px 11px;font-family:monospace;font-size:11.5px;line-height:1.6;height:224px;overflow:auto;margin-top:9px}' +
        '.mmc-l-cmd{color:var(--primary)}.mmc-l-ok{color:var(--success-700)}' +
        '.mmc-l-err{color:var(--error)}.mmc-l-resp{color:var(--text-weak)}' +
        '.mmc-l-urc{color:var(--text-hint)}.mmc-l-note{color:var(--warning-700)}' +
        '.mmc-t{color:var(--text-hint);margin-right:6px}' +
        '.mmc-urctag{font-size:8.5px;border:1px solid var(--divider);border-radius:2px;padding:0 3px;margin-left:5px;color:var(--text-hint)}' +
        '.mmc-pstrip{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}' +
        '.mmc-pstrip label{display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--text-badge)}' +
        '.mmc-pstrip input,.mmc-pstrip select{font-family:monospace;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular);width:130px}' +
        '.mmc-prompt{display:flex;gap:7px;margin-top:9px}' +
        '.mmc-prompt>span{font-family:monospace;font-size:12px;color:var(--primary);padding-top:6px}' +
        '.mmc-prompt input{flex:1;font-family:monospace;font-size:12px;padding:6px 9px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text-regular)}' +
        '.mmc-prompt input:focus{outline:0;border-color:var(--primary)}' +
        '.mmc-send{font-size:11.5px;font-weight:600;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:3px;padding:6px 13px;cursor:pointer;font-family:inherit}' +
        '.mmc-send:disabled{opacity:.5;cursor:default}' +
        '.mmc-send:focus-visible{outline:2px solid var(--primary);outline-offset:2px}' +
        '.mmc-dec{margin-top:9px;border:1px solid var(--divider);border-radius:3px;overflow:hidden}' +
        '.mmc-dec-h{background:var(--bg-title);padding:5px 10px;display:flex;justify-content:space-between;align-items:center}' +
        '.mmc-dec-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:1px;background:var(--divider)}' +
        '.mmc-dc{background:var(--bg-card);padding:6px 9px}' +
        '.mmc-dc span{display:block;font-size:8.5px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mmc-dc b{font-size:12px;font-weight:600;font-family:monospace;color:var(--text-title)}' +
        '.mmc-dc.hi b{color:var(--success)}' +
        '.mmc-detail{margin-top:10px}' +
        '.mmc-meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}' +
        '.mmc-meta span{display:block;font-size:9px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:var(--text-badge)}' +
        '.mmc-meta b{font-size:11.5px;font-weight:600;color:var(--text-title)}' +
        '.mmc-warn{color:var(--error-700)}' +
        '@media(prefers-reduced-motion:reduce){.mmc *{transition:none!important}}';
      var el = document.createElement("style");
      el.id = this.styleId;
      el.textContent = css;
      document.head.appendChild(el);
    }
  },

  render(h) {
    var self = this;

    // ---- caution banner + risk gate ----
    var banner = h("div", { staticClass: "mmc-caution" }, [
      h("b", "Sharp edge."),
      h("span", "Commands go straight to the RG650V-NA. Nothing is validated. " +
        "Entries marked nv write modem memory that survives a factory reset."),
      h("label", { staticClass: "mmc-gate" }, [
        h("input", {
          attrs: { type: "checkbox", checked: this.riskOK },
          domProps: { checked: this.riskOK },
          on: { change: function () { self.toggleGate(); } }
        }),
        "Enable higher-risk commands"
      ])
    ]);

    // ---- library rail ----
    var libKids = [
      h("div", { staticClass: "mmc-row" }, [
        h("span", { staticClass: "mmc-sect" }, "Library"),
        h("span", { staticClass: "mmc-hint" },
          this.lib ? String(this.entries.length) + " commands" : "")
      ]),
      h("input", {
        staticClass: "mmc-search",
        attrs: { placeholder: "Search — band, lock, signal…", "aria-label": "Search library" },
        domProps: { value: this.q },
        on: { input: function (ev) { self.q = ev.target.value; } }
      })
    ];
    var body;
    if (this.libLoading) {
      body = h("div", { staticClass: "mmc-hint", staticStyle: { padding: "10px 0" } }, "Loading the library…");
    } else if (this.libErr) {
      body = h("div", { staticStyle: { padding: "10px 0" } }, [
        h("div", { staticClass: "mmc-hint" }, "Couldn't load the library: " + this.libErr + " "),
        h("button", { staticClass: "mmc-send", staticStyle: { marginTop: "6px" },
          on: { click: function () { self.fetchLib(); } } }, "Retry")
      ]);
    } else if (!this.lib) {
      body = h("div", { staticClass: "mmc-hint", staticStyle: { padding: "10px 0" } }, "Library not loaded.");
    } else if (!this.entries.length) {
      body = h("div", { staticClass: "mmc-hint", staticStyle: { padding: "10px 0" } }, "No matches.");
    } else {
      var items = [];
      this.cats.forEach(function (cat) {
        items.push(h("div", { staticClass: "mmc-cat", key: "cat-" + cat }, cat));
        self.entries.filter(function (e) { return e.cat === cat; }).forEach(function (e) {
          items.push(h("button", {
            key: e.id,
            staticClass: "mmc-snip" + (self.selId === e.id ? " on" : ""),
            on: { click: function () { self.pick(e); } }
          }, [
            h("span", { staticClass: "mmc-snip-t" }, [
              h("b", e.title),
              h("span", { staticClass: "mmc-risk " + e.risk }, e.risk)
            ]),
            h("code", e.cmd)
          ]));
        });
      });
      body = h("div", { staticClass: "mmc-libbody" }, items);
    }
    libKids.push(body);
    var rail = h("div", { staticClass: "mmc-card" }, libKids);

    // ---- transcript ----
    var termKids = this.lines.length
      ? this.lines.map(function (l, i) {
          return h("div", { key: i, staticClass: "mmc-l-" + l.kind }, [
            h("span", { staticClass: "mmc-t" }, l.t),
            l.text,
            l.kind === "urc" ? h("span", { staticClass: "mmc-urctag" }, "URC") : null
          ]);
        })
      : [h("div", { staticClass: "mmc-hint" },
          "ready. Pick a command from the library, or type one.")];
    var term = h("div", { staticClass: "mmc-term" }, termKids);

    // ---- param strip ----
    var pstrip = null;
    if (this.paramMode) {
      pstrip = h("div", { staticClass: "mmc-pstrip" }, this.selParams.map(function (p) {
        var field;
        if (p.values && p.values.length) {
          field = h("select", {
            domProps: { value: self.params[p.name] || "" },
            on: { change: function (ev) { self.params[p.name] = ev.target.value; } }
          }, [h("option", { attrs: { value: "" } }, "—")].concat(
            p.values.map(function (v) { return h("option", { attrs: { value: v }, key: v }, v); })));
        } else {
          field = h("input", {
            attrs: { placeholder: p.example || "", title: p.hint },
            domProps: { value: self.params[p.name] || "" },
            on: { input: function (ev) { self.params[p.name] = ev.target.value; } }
          });
        }
        return h("label", { key: p.name }, [p.name + " — " + p.hint, field]);
      }));
    }

    // ---- prompt + send ----
    var promptRow = h("div", { staticClass: "mmc-prompt" }, [
      h("span", ">"),
      h("input", {
        attrs: {
          placeholder: "AT+…", "aria-label": "AT command",
          readonly: this.paramMode || null
        },
        domProps: { value: this.paramMode ? this.assembled : this.prompt },
        on: {
          input: function (ev) { if (!self.paramMode) self.onPromptInput(ev.target.value); },
          keydown: function (ev) { self.promptKey(ev); }
        }
      }),
      h("button", {
        staticClass: "mmc-send",
        attrs: { disabled: this.sending || (this.paramMode && !this.paramsFilled) },
        on: { click: function () { self.send(); } }
      }, this.sending ? "Sending…" : "Send")
    ]);

    // ---- decode grid ----
    var dec = null;
    if (this.decodeRows) {
      dec = h("div", { staticClass: "mmc-dec" }, [
        h("div", { staticClass: "mmc-dec-h" }, [
          h("span", { staticClass: "mmc-hint" }, "Decoded — field names from the library entry"),
          h("span", { staticClass: "mmc-hint" }, this.decodeSrc)
        ])
      ].concat(this.decodeRows.map(function (row, ri) {
        return h("div", { staticClass: "mmc-dec-g", key: ri }, row.map(function (cell) {
          return h("div", { staticClass: "mmc-dc" + (cell.hi ? " hi" : ""), key: cell.f }, [
            h("span", cell.f.replace(/_/g, " ")),
            h("b", String(cell.v))
          ]);
        }));
      })));
    }

    // ---- console card ----
    var con = h("div", { staticClass: "mmc-card" }, [
      h("div", { staticClass: "mmc-row" }, [
        h("span", { staticClass: "mmc-sect" }, "Raw AT"),
        h("span", { staticClass: "mmc-row" }, [
          h("button", {
            staticClass: "mmc-send", staticStyle: { background: "transparent",
              color: "var(--text-weak)", borderColor: "var(--border)", fontWeight: "400" },
            attrs: { title: "Copy the transcript" },
            on: { click: function () { self.copyTranscript(); } }
          }, "Copy"),
          h("span", { staticClass: "mmc-hint" }, this.truthLine)
        ])
      ]),
      term, pstrip, promptRow, dec
    ].filter(Boolean));

    // ---- entry detail card ----
    var detail = null;
    var e = this.sel;
    if (e) {
      detail = h("div", { staticClass: "mmc-card mmc-detail" }, [
        h("div", { staticClass: "mmc-row" }, [
          h("span", { staticClass: "mmc-sect" }, e.title),
          h("span", [
            h("span", { staticClass: "mmc-risk " + e.risk }, e.risk),
            h("span", { staticClass: "mmc-hint", staticStyle: { marginLeft: "6px" } },
              this.riskText(e.risk))
          ])
        ]),
        h("div", { staticClass: "mmc-hint", staticStyle: { marginTop: "3px", fontSize: "12px" } }, [
          e.summary + " ",
          e.warn ? h("span", { staticClass: "mmc-warn" }, e.warn) : null
        ]),
        h("div", { staticClass: "mmc-meta" }, [
          h("div", [h("span", "Vendor"), h("b", e.vendor)]),
          h("div", [h("span", "Verified on"),
            h("b", e.verified && e.verified.length ? e.verified.join(", ") : "— nobody yet")]),
          h("div", [h("span", "Source"), h("b", e.source)]),
          h("div", [h("span", "Contributed by"), h("b", e.by)])
        ])
      ]);
    }

    return h("div", { staticClass: "mmc" }, [
      banner,
      h("div", { staticClass: "mmc-split" }, [rail, con]),
      detail
    ].filter(Boolean));
  }
};
