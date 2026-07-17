// MudiModem - Phase 0 hello-world view.
//
// Loaded by GL's SPA via `eval()`, so this file must be a single expression
// statement whose value is the component. `module` is in scope at eval time.
//
// Vue here is runtime-only: render(h) only, never `template:`.
module.exports = {
  name: "mudimodem",
  data() {
    return {
      title: "MudiModem",
      subtitle: "Phase 0 - the view loads, the route resolves, the menu links here."
    };
  },
  render(h) {
    return h("div", { staticClass: "mudimodem-view" }, [
      h("h2", this.title),
      h("p", this.subtitle)
    ]);
  }
};
