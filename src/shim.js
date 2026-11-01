// The Excalidraw packages read a few browser globals while loading. Herdr runs mods in
// QuickJS with no DOM, and its sandbox refuses `Function("return this")()`, which
// lodash falls back to when `self` is missing.
globalThis.self ??= globalThis;
globalThis.navigator ??= { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" };
globalThis.document ??= { createElement: () => ({ src: "" }) };
// Free-draw shapes come back as Path2D over an SVG path string; keep the string.
globalThis.Path2D ??= class Path2D { constructor(d) { this.d = d; } };
// Herdr has no setTimeout (mods use cx.timer); Scene throttles its update callbacks with
// lodash, which needs one. Queue them here; the editor drains due ones from its own timer.
{
  const timers = new Map();
  let next = 0;
  globalThis.setTimeout = (fn, ms = 0, ...args) => { timers.set(++next, { fn, at: Date.now() + ms, args }); return next; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.__runDueTimers = () => {
    const now = Date.now();
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue;
      timers.delete(id);
      t.fn(...t.args);
    }
  };
}
