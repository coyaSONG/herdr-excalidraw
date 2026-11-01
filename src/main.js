// Excalidraw editor as a Herdr mod. As a pane it edits props.file (or a drawing chosen in the
// pane); opened with mod.open:excalidraw it is a launcher that opens drawings beside the pane.
import { View, div, PathBuilder, image } from "gpui-kit";
import { TextareaState, Textarea } from "gpui-base";
import { props, settings, theme, readTextFile, writeTextFile, watchFolder, notify, home, appHome, run, focused, panes, closeOverlay } from "herdr";
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import {
  Scene,
  newElement,
  newArrowElement,
  newLinearElement,
  newFreeDrawElement,
  newTextElement,
  hitElementItself,
  hitElementBoundingBox,
  getElementBounds,
  getCommonBounds,
  getBoundTextElement,
  redrawTextBoundingBox,
  refreshTextDimensions,
  setCustomTextMetricsProvider,
  updateBoundElements,
  bindOrUnbindLinearElement,
  getHoveredElementForBinding,
  fixBindingsAfterDeletion,
} from "@excalidraw/element";
import { ROUNDNESS, FONT_FAMILY, getLineHeight } from "@excalidraw/common";
import { buildLayers, toColor, fontName } from "./geometry.js";
import { Picker } from "./picker.js";
import { History, emptyDocument, parseDocument, serializeDocument } from "./document.js";

// There is no text measuring API in Herdr mods. Excalidraw sizes text boxes with this:
// Excalifont averages ~0.55em per Latin glyph; CJK and Hangul take a full em.
const isWide = (c) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff);
setCustomTextMetricsProvider({
  getLineWidth(text, font) {
    const size = parseFloat(font) || 20;
    let w = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      w += (isWide(c) ? 1 : c === 32 ? 0.3 : 0.55) * size;
    }
    return w;
  },
});

const TOOLS = [
  { id: "selection", label: "↖", key: "v / 1", title: "Select" },
  { id: "hand", label: "✋", key: "h", title: "Hand" },
  { id: "rectangle", label: "▭", key: "r / 2", title: "Rectangle" },
  { id: "diamond", label: "◇", key: "d / 3", title: "Diamond" },
  { id: "ellipse", label: "◯", key: "o / 4", title: "Ellipse" },
  { id: "arrow", label: "→", key: "a / 5", title: "Arrow" },
  { id: "line", label: "╱", key: "l / 6", title: "Line" },
  { id: "freedraw", label: "✎", key: "p / 7", title: "Draw" },
  { id: "text", label: "T", key: "t / 8", title: "Text" },
  { id: "eraser", label: "⌫", key: "e / 0", title: "Eraser" },
];
const TOOL_KEYS = {
  v: "selection", 1: "selection", h: "hand", r: "rectangle", 2: "rectangle", d: "diamond", 3: "diamond",
  o: "ellipse", 4: "ellipse", a: "arrow", 5: "arrow", l: "line", 6: "line", p: "freedraw", 7: "freedraw",
  t: "text", 8: "text", e: "eraser", 0: "eraser",
};
const STROKES = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const BACKGROUNDS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];
const FONT_SIZES = [["S", 16], ["M", 20], ["L", 28], ["XL", 36]];
const SELECTION = "#6965db";
// The toolbar and panels float on the drawing's (light) canvas, so they keep Excalidraw's
// light palette rather than Herdr's theme, which may be dark.
const UI = { surface: "#ffffff", border: "#e9ecef", swatchBorder: "#ced4da", foreground: "#1e1e1e", muted: "#868e96", selected: "#e0dfff", hover: "#f1f0ff" };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
// macOS reports /tmp paths as /private/tmp in file events.
const samePath = (a, b) => a === b || a === `/private${b}` || `/private${a}` === b;

function resolveFile(file) {
  if (typeof file !== "string" || !file.trim()) return null;
  const f = file.trim();
  if (f === "~" || f.startsWith("~/")) return home() + f.slice(1);
  return f.startsWith("/") ? f : null;
}

const rectPath = (x1, y1, x2, y2, width, dash) => {
  let b = width ? PathBuilder.stroke(width) : PathBuilder.fill();
  if (dash) b = b.dash_array(dash);
  return b.move_to(x1, y1).line_to(x2, y1).line_to(x2, y2).line_to(x1, y2).close().build();
};

export default class Excalidraw extends View {
  init(_props, cx) {
    this.focus = cx.focus_handle();
    this.vz = 1;
    this.scrollX = 0;
    this.scrollY = 0;
    this.size = null;
    this.tool = "selection";
    this.style = { strokeColor: STROKES[0], backgroundColor: "transparent", fillStyle: "hachure", strokeWidth: 2, strokeStyle: "solid", roughness: 1, fontSize: 20 };
    this.selected = new Set();
    this.pointer = null;
    this.editing = null;
    this.spaceDown = false;
    this.history = new History();
    this.scene = new Scene([]);
    this.doc = emptyDocument();
    this.lastText = null;
    this.dirty = false;
    this.saving = false;
    this.saveAt = 0;
    this.saveError = null;
    this.imageFiles = new Map();
    this.layers = [];
    this.builtVz = 1;
    this.builtZ = 1;
    this.active = new Set(); // elements drawn live, outside the static layers
    this.status = "loading";

    // Retained children: notifying one rebuilds only its description, so a drag redraws the
    // live layer while the static layers keep theirs.
    const editor = this;
    this.Layer = class Layer extends View {
      init(p) { this.idx = p.idx; }
      render() { return editor.renderLayer(this.idx); }
    };
    this.layerViews = [];
    this.liveView = cx.new(class Live extends View { render() { return editor.renderLive(); } });
    // Escape ends text editing; the textarea keeps plain key events to itself, but bindings in an
    // enclosing key context still reach the wrapper's on_action.
    cx.bind_keys([{ keystroke: "escape", action: "excalidraw_end_edit", context: "ExcalidrawTextEditor" }]);

    this.watchGen = 0;
    const p = props() ?? {};
    // Opened with mod.open: a launcher overlay. Drawings it opens go beside the pane it was opened from.
    this.overlay = p.overlay ?? null;
    this.fromPane = this.overlay ? focused()?.pane ?? null : null;
    cx.timer.every(200, (cx) => this.tick(cx));
    // A pane remembers the drawing chosen in it (props carry the one it was opened with).
    const file = resolveFile(p.file) ?? (this.overlay ? null : resolveFile(localStorage.getItem("file")));
    if (file) this.openFile(file, cx);
    else this.showPicker(cx);
  }

  // ---- choosing a drawing ------------------------------------------------------------

  openFile(file, cx) {
    this.file = file;
    this.status = "loading";
    this.picker = null;
    this.history = new History();
    this.selected = new Set();
    this.active = new Set();
    this.pointer = null;
    this.editing = null;
    this.vz = 1;
    this.scrollX = 0;
    this.scrollY = 0;
    this.dirty = false;
    this.saveError = null;
    this.lastText = null;
    const gen = ++this.watchGen;
    cx.spawn(async (cx) => {
      if (await this.load(cx)) await this.watch(cx, gen);
    });
    cx.notify();
  }

  /** The folder a list starts in: the current drawing's, else the terminal you were in, else home. */
  startFolder() {
    if (this.file) return dirname(this.file);
    const f = focused();
    return f?.cwd ?? panes().find((p) => p.tab === f?.tab && p.cwd)?.cwd ?? home();
  }

  showPicker(cx) {
    this.status = "pick";
    this.picker = new Picker(this.startFolder());
    cx.spawn(async (cx) => {
      await this.picker?.refresh();
      cx.notify();
      // The list takes the keyboard once it is on screen.
      await cx.sleep(16);
      this.focus.focus();
    });
    cx.notify();
  }

  /** From the editor: save, then show the list to pick another drawing for this pane. */
  switchFile(cx) {
    cx.spawn(async (cx) => {
      if (this.editing) this.endEdit(cx, {});
      if (this.dirty) await this.save(cx);
      this.showPicker(cx);
    });
  }

  /** Opens a drawing: beside the launcher's pane (or in a new tab), or in this pane. */
  choose(path, cx, { tab = false } = {}) {
    if (!this.overlay) {
      localStorage.setItem("file", path);
      this.openFile(path, cx);
      return;
    }
    const spec = { mod: "excalidraw", props: { file: path } };
    if (tab || !this.fromPane) run("tab.new", { name: basename(path), ...spec });
    else run("pane.split", { direction: "right", pane: this.fromPane, ...spec });
    closeOverlay(this.overlay);
  }

  pickerActions() {
    const fail = (what, e) => notify({ title: `Excalidraw: ${what}`, body: String(e?.message ?? e), level: "error" });
    return {
      open: (name, cx) => this.choose(this.picker.path(name), cx),
      openInTab: this.overlay ? (name, cx) => this.choose(this.picker.path(name), cx, { tab: true }) : null,
      newDrawing: (cx) => cx.spawn(async (cx) => {
        try { this.choose(await this.picker.newDrawing(), cx); } catch (e) { fail("can't create a drawing", e); }
      }),
      chooseFolder: (cx) => cx.spawn(async (cx) => {
        if (await this.picker.chooseFolder()) cx.notify();
      }),
    };
  }

  pickerKey(e, cx) {
    if (e.key === "escape") {
      if (this.overlay) closeOverlay(this.overlay);
      else if (this.file) this.openFile(this.file, cx);
      return;
    }
    const name = this.picker.key(e);
    if (name) this.choose(this.picker.path(name), cx);
    cx.notify();
  }

  // ---- coordinates -------------------------------------------------------------------

  herdrZoom() { return Number(settings()?.zoom) || 1; }
  /** GPUI pixels (paths, pointer positions) per scene unit. */
  scale() { return this.vz * this.herdrZoom(); }
  toScene(local) { const s = this.scale(); return { x: local.x / s - this.scrollX, y: local.y / s - this.scrollY }; }
  map() { return this.scene.getNonDeletedElementsMap(); }
  elements() { return this.scene.getNonDeletedElements(); }

  // ---- file --------------------------------------------------------------------------

  async load(cx) {
    let text;
    try { text = await readTextFile(this.file); } catch (e) { return this.fail(cx, `can't read ${this.file}: ${e?.message ?? e}`); }
    if (text == null) {
      this.doc = emptyDocument();
      this.lastText = null;
    } else {
      try { this.doc = parseDocument(text); } catch (e) { return this.fail(cx, `${this.file}: ${e.message}`); }
      this.lastText = text;
    }
    this.scene.replaceAllElements(this.doc.elements);
    await this.writeImages();
    const els = this.elements();
    if (els.length) {
      const [x1, y1] = getCommonBounds(els);
      this.scrollX = 40 - x1;
      this.scrollY = 80 - y1;
    }
    this.status = "ready";
    this.rebuild(cx);
    return true;
  }

  fail(cx, message) {
    this.status = "error";
    this.error = message;
    cx.notify();
    return false;
  }

  /** Reloads when the file changes on disk (another editor, an agent, git). */
  async watch(cx, gen) {
    const dir = dirname(this.file);
    for (;;) {
      let changed;
      try { changed = await watchFolder(dir); } catch { return; }
      if (this.closed || gen !== this.watchGen) return;
      if (!changed.some((p) => samePath(p, this.file))) continue;
      const text = await readTextFile(this.file).catch(() => null);
      if (text != null && text !== this.lastText) await this.applyExternal(text, cx);
    }
  }

  async applyExternal(text, cx) {
    let doc;
    try { doc = parseDocument(text); } catch (e) {
      notify({ title: `${basename(this.file)} changed on disk`, body: `Not loaded: ${e.message}`, level: "warning" });
      return;
    }
    if (this.dirty) {
      notify({ title: `${basename(this.file)} changed on disk`, body: "Loaded the file's version; undo brings back your unsaved changes.", level: "warning" });
    }
    if (this.editing) this.endEdit(cx, { discard: true });
    this.history.record(this.scene.getElementsIncludingDeleted());
    this.doc = doc;
    this.lastText = text;
    this.dirty = false;
    this.scene.replaceAllElements(doc.elements);
    const live = this.map();
    this.selected = new Set([...this.selected].filter((id) => live.has(id)));
    this.pointer = null;
    this.active = new Set();
    await this.writeImages();
    this.rebuild(cx);
  }

  /** Image files live in the drawing as data URLs; Herdr draws images from files under its home. */
  async writeImages() {
    const entries = Object.entries(this.doc.files ?? {}).filter(([id]) => !this.imageFiles.has(id));
    if (!entries.length) return;
    const dir = `${appHome()}/data/herdr-excalidraw`;
    await fs.mkdir(dir, { recursive: true });
    for (const [id, f] of entries) {
      const m = /^data:image\/([a-z0-9+.-]+);base64,(.*)$/is.exec(f?.dataURL ?? "");
      if (!m) continue;
      const ext = { jpeg: "jpg", "svg+xml": "svg" }[m[1].toLowerCase()] ?? m[1].toLowerCase();
      const name = `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`;
      try {
        await fs.writeFile(`${dir}/${name}`, Buffer.from(m[2], "base64"));
        this.imageFiles.set(id, `data/herdr-excalidraw/${name}`);
      } catch (e) { console.log(`excalidraw: image ${id}: ${e?.message ?? e}`); }
    }
  }

  markDirty() {
    this.dirty = true;
    this.saveAt = Date.now() + 400;
  }

  tick(cx) {
    globalThis.__runDueTimers();
    if (this.status !== "ready") return;
    if (this.herdrZoom() !== this.builtZ) this.rebuild(cx);
    if (this.dirty && !this.saving && Date.now() >= this.saveAt && !this.pointer && !this.editing) {
      cx.spawn(async (cx) => this.save(cx));
    }
  }

  async save(cx) {
    this.saving = true;
    const text = serializeDocument({ ...this.doc, elements: this.scene.getElementsIncludingDeleted() });
    const seq = this.saveAt;
    try {
      await writeTextFile(this.file, text, this.lastText);
      this.lastText = text;
      if (this.saveAt === seq) this.dirty = false;
      this.saveError = null;
    } catch (e) {
      // A stale `expected` means the file changed under us: take the disk version.
      const disk = await readTextFile(this.file).catch(() => null);
      if (disk != null && disk !== this.lastText) await this.applyExternal(disk, cx);
      else this.saveError = String(e?.message ?? e);
    } finally {
      this.saving = false;
      cx.notify();
    }
  }

  async close(cx) {
    this.closed = true;
    if (this.editing) this.endEdit(cx, {});
    if (this.dirty && this.status === "ready") await this.save(cx);
  }

  // ---- rendering ---------------------------------------------------------------------

  shapeOptions() {
    return {
      shapeConfig: { isExporting: false, canvasBackgroundColor: this.doc.appState.viewBackgroundColor ?? "#ffffff", embedsValidationStatus: new Map() },
      imagePath: (id) => this.imageFiles.get(id),
      hiddenText: this.editing ? new Set([this.editing.id]) : null,
      onError: (el, e) => console.log(`excalidraw: can't draw ${el.type} ${el.id}: ${e?.message ?? e}`),
    };
  }

  /** Rebuilds the static layers from every element not drawn live. */
  rebuild(cx) {
    const scale = this.scale();
    const els = this.elements().filter((e) => !this.active.has(e.id));
    this.layers = buildLayers(els, this.map(), scale, this.shapeOptions());
    this.builtVz = this.vz;
    this.builtZ = this.herdrZoom();
    while (this.layerViews.length < this.layers.length) this.layerViews.push(cx.new(this.Layer, { idx: this.layerViews.length }));
    for (const v of this.layerViews) cx.notify(v);
    cx.notify(this.liveView);
    cx.notify();
  }

  drawList(draw, vz) {
    return draw.map((d) => {
      if (d.kind === "path") return window.paint_path(d.path, d.color).absolute().top(0).left(0).size_full();
      if (d.kind === "image") return image(d.file).absolute().left(d.x * vz).top(d.y * vz).w(d.w * vz).h(d.h * vz);
      const lineHeight = d.fontSize * d.lineHeight * vz;
      return div().absolute().left(d.x * vz).top(d.y * vz).w(Math.max(d.w, 1) * vz).font_family(d.font).text_size(d.fontSize * vz)
        // A bare number would be a multiple of the font size; Excalidraw's line height is in px here.
        .line_height(`${lineHeight}px`).text_color(d.color).whitespace_nowrap()
        .children(d.lines.map((line) => {
          const row = div().w_full().h(lineHeight).child(line || " ");
          return d.align === "center" ? row.text_center() : d.align === "right" ? row.text_right() : row;
        }));
    });
  }

  renderLayer(idx) {
    const layer = this.layers[idx];
    return div().absolute().top(0).left(0).size_full().children(layer ? this.drawList(layer.draw, this.builtVz) : []);
  }

  /** Elements being drawn or dragged, the selection outline, the marquee. */
  renderLive() {
    const s = this.scale();
    const map = this.map();
    const els = [...this.active].map((id) => map.get(id)).filter(Boolean);
    const draw = buildLayers(els, map, s, this.shapeOptions()).flatMap((l) => l.draw);
    const pad = 6 / this.vz;
    const outline = (b, color, dash) => ({ kind: "path", color, path: rectPath((b[0] - pad) * s, (b[1] - pad) * s, (b[2] + pad) * s, (b[3] + pad) * s, 1.5, dash) });
    const selected = [...this.selected].map((id) => map.get(id)).filter(Boolean);
    if (!this.editing) {
      for (const el of selected) draw.push(outline(getElementBounds(el, map), SELECTION, null));
      if (selected.length > 1) draw.push(outline(getCommonBounds(selected), SELECTION, [4, 4]));
    }
    const p = this.pointer;
    if (p?.mode === "marquee") {
      const [x1, x2] = [Math.min(p.start.x, p.cur.x), Math.max(p.start.x, p.cur.x)];
      const [y1, y2] = [Math.min(p.start.y, p.cur.y), Math.max(p.start.y, p.cur.y)];
      draw.push({ kind: "path", color: `${SELECTION}1f`, path: rectPath(x1 * s, y1 * s, x2 * s, y2 * s, 0) });
      draw.push({ kind: "path", color: SELECTION, path: rectPath(x1 * s, y1 * s, x2 * s, y2 * s, 1) });
    }
    if (p?.mode === "erase") {
      for (const id of p.ids) { const el = map.get(id); if (el) draw.push(outline(getElementBounds(el, map), "#e03131", [4, 3])); }
    }
    return div().absolute().top(0).left(0).size_full().children(this.drawList(draw, this.vz));
  }

  /** Static layers whose bounds meet the view. */
  visibleLayerViews() {
    // size is in GPUI pixels, as pointer positions are.
    const s = this.scale();
    const w = (this.size?.width ?? 4000) / s;
    const h = (this.size?.height ?? 4000) / s;
    const view = [-this.scrollX - w * 0.25, -this.scrollY - h * 0.25, -this.scrollX + w * 1.25, -this.scrollY + h * 1.25];
    return this.layers.map((l, i) => [l.bounds, this.layerViews[i]])
      .filter(([b]) => b[0] <= view[2] && view[0] <= b[2] && b[1] <= view[3] && view[1] <= b[3])
      .map(([, v]) => v);
  }

  render(_cx) {
    const t = theme();
    const root = div().id("excalidraw").size_full().relative().overflow_hidden().bg(t.background ?? "#ffffff")
      .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    if (this.status === "pick") {
      const hint = this.overlay
        ? "Click opens it beside the current pane · Tab: in a new tab · ↑↓ Enter · Esc closes"
        : "Click opens it in this pane · ↑↓ Enter";
      return root.track_focus(this.focus).on_key_down((e, cx) => this.pickerKey(e, cx))
        .child(this.picker.render(UI, this.pickerActions(), { title: this.overlay ? "Open a drawing" : "Excalidraw", hint }));
    }
    if (this.status !== "ready") {
      const message = this.status === "error" ? ["Can't open the drawing.", this.error] : ["Loading…"];
      return root.child(div().p(16).gap(8).text_size(13).text_color(t.foreground ?? "#1e1e1e").children(message.map((m) => div().child(m))));
    }
    const bg = toColor(this.doc.appState.viewBackgroundColor) ?? "#ffffff";
    const cursor = (el) => this.tool === "hand" || this.spaceDown ? el.cursor_grab()
      : this.tool === "text" ? el.cursor_text()
      : this.tool === "selection" ? el.cursor_default() : el.cursor_crosshair();
    const canvas = cursor(div().id("canvas").absolute().top(0).left(0).size_full().bg(bg).overflow_hidden())
      .on_mouse_down("left", (e, cx) => this.onDown(e, cx))
      .on_mouse_down("middle", (e, cx) => this.onPanStart(e, cx))
      .on_mouse_move((e, cx) => this.onMove(e, cx))
      .on_mouse_up("left", (e, cx) => this.onUp(cx))
      .on_mouse_up("middle", (e, cx) => this.onUp(cx))
      .on_scroll_wheel((e, cx) => this.onWheel(e, cx))
      .child(div().absolute().left(this.scrollX * this.vz).top(this.scrollY * this.vz).size_full()
        .children([...this.visibleLayerViews(), this.liveView, ...this.textEditor()]));
    return root.track_focus(this.focus)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_key_up((e, cx) => { if (e.key === "space") { this.spaceDown = false; cx.notify(); } })
      .children([canvas, this.toolbar(UI), this.stylePanel(UI), this.statusBar(UI)]);
  }

  textEditor() {
    if (!this.editing) return [];
    const el = this.scene.getElement(this.editing.id);
    if (!el) return [];
    const vz = this.vz;
    const container = el.containerId ? this.scene.getElement(el.containerId) : null;
    const x = container ? container.x : el.x;
    const width = container ? container.width : Math.max(el.width + el.fontSize * 2, 120);
    const top = container ? container.y + Math.max(0, (container.height - el.height) / 2) : el.y;
    let editor = Textarea.new(this.editing.state).font_family(fontName(el.fontFamily)).text_size(el.fontSize * vz)
      .text_color(toColor(el.strokeColor) ?? "#1e1e1e");
    if (container) editor = editor.text_center();
    return [div().id("text-editor").absolute().left(x * vz).top(top * vz).w(width * vz).p(2).border(1).border_dashed().border_color(SELECTION)
      .key_context("ExcalidrawTextEditor")
      .on_action("excalidraw_end_edit", (_e, cx) => this.endEdit(cx, {}))
      .on_key_down((e, cx) => { if (e.key === "escape") this.endEdit(cx, {}); })
      .child(editor)];
  }

  button(id, label, active, t, onPress) {
    return div().id(id).px(8).py(4).rounded(6).text_size(14).cursor_pointer()
      .bg(active ? t.selected : "#00000000").text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onPress(cx); })
      .child(label);
  }

  toolbar(t) {
    return div().absolute().top(8).left(0).w_full().flex().justify_center().child(
      div().flex().gap(2).p(4).rounded(8).bg(t.surface).border(1).border_color(t.border)
        .children(TOOLS.map((tool) => this.button(`tool-${tool.id}`, tool.label, this.tool === tool.id, t, (cx) => this.setTool(tool.id, cx)))));
  }

  stylePanel(t) {
    const map = this.map();
    const selected = [...this.selected].map((id) => map.get(id)).filter(Boolean);
    const drawing = !["selection", "hand", "eraser"].includes(this.tool);
    if (!drawing && !selected.length) return div();
    const current = selected[0] ?? this.style;
    const swatch = (prop, color) => div().id(`${prop}-${color}`).w(20).h(20).rounded(4).cursor_pointer().border(current[prop] === color ? 2 : 1)
      .border_color(current[prop] === color ? SELECTION : t.swatchBorder).bg(toColor(color) ?? "#ffffff")
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.applyStyle(prop, color, cx); })
      .child(color === "transparent" ? div().text_size(11).text_center().child("∅") : "");
    const option = (prop, value, label) => this.button(`${prop}-${value}`, label, current[prop] === value, t, (cx) => this.applyStyle(prop, value, cx));
    const row = (name, items) => div().flex().flex_col().gap(4).child(div().text_size(11).text_color(t.muted).child(name)).child(div().flex().gap(4).children(items));
    const hasText = selected.some((e) => e.type === "text" || getBoundTextElement(e, map)) || this.tool === "text";
    const rows = [
      row("Stroke", STROKES.map((c) => swatch("strokeColor", c))),
      row("Background", BACKGROUNDS.map((c) => swatch("backgroundColor", c))),
      row("Fill", [option("fillStyle", "hachure", "▤"), option("fillStyle", "cross-hatch", "▦"), option("fillStyle", "solid", "■")]),
      row("Stroke width", [option("strokeWidth", 1, "─"), option("strokeWidth", 2, "━"), option("strokeWidth", 4, "▬")]),
      row("Stroke style", [option("strokeStyle", "solid", "──"), option("strokeStyle", "dashed", "- -"), option("strokeStyle", "dotted", "···")]),
      row("Sloppiness", [option("roughness", 0, "0"), option("roughness", 1, "1"), option("roughness", 2, "2")]),
    ];
    if (hasText) rows.push(row("Font size", FONT_SIZES.map(([label, size]) => this.button(`fontSize-${size}`, label, (selected.find((e) => e.type === "text")?.fontSize ?? this.style.fontSize) === size, t, (cx) => this.applyStyle("fontSize", size, cx)))));
    return div().id("style-panel").absolute().top(60).left(8).flex().flex_col().gap(10).p(10).rounded(8)
      .bg(t.surface).border(1).border_color(t.border).text_color(t.foreground)
      .on_mouse_down("left", (e, cx) => cx.stop_propagation())
      .children(rows);
  }

  statusBar(t) {
    const state = this.saveError ? `Save failed: ${this.saveError}` : this.saving ? "Saving…" : this.dirty ? "Unsaved" : this.lastText == null ? "New file" : "Saved";
    return div().absolute().bottom(8).left(8).flex().gap(6).items_center().text_size(12).text_color(t.muted).children([
      this.button("zoom-out", "−", false, t, (cx) => this.zoomBy(1 / 1.2, null, cx)),
      this.button("zoom-reset", `${Math.round(this.vz * 100)}%`, false, t, (cx) => this.setZoom(1, null, cx)),
      this.button("zoom-in", "+", false, t, (cx) => this.zoomBy(1.2, null, cx)),
      this.button("undo", "↶", false, t, (cx) => this.undo(cx)),
      this.button("redo", "↷", false, t, (cx) => this.redo(cx)),
      this.button("open", "Open…", false, t, (cx) => this.switchFile(cx)),
      div().child(`${basename(this.file)} · ${state}`),
    ]);
  }

  // ---- tools and styles --------------------------------------------------------------

  setTool(tool, cx) {
    if (this.editing) this.endEdit(cx, {});
    this.tool = tool;
    if (tool !== "selection") this.selected = new Set();
    cx.notify(this.liveView);
    cx.notify();
  }

  newStyle(type) {
    const s = this.style;
    const roundness = type === "rectangle" || type === "diamond" ? { type: ROUNDNESS.ADAPTIVE_RADIUS }
      : type === "arrow" || type === "line" ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null;
    return { strokeColor: s.strokeColor, backgroundColor: s.backgroundColor, fillStyle: s.fillStyle, strokeWidth: s.strokeWidth, strokeStyle: s.strokeStyle, roughness: s.roughness, opacity: 100, roundness };
  }

  applyStyle(prop, value, cx) {
    this.style[prop] = value;
    const map = this.map();
    const selected = [...this.selected].map((id) => map.get(id)).filter(Boolean);
    if (selected.length) {
      this.history.record(this.scene.getElementsIncludingDeleted());
      for (const el of selected) {
        const text = el.type === "text" ? el : getBoundTextElement(el, map);
        if (prop === "fontSize") {
          if (text) this.setTextSize(text, value);
        } else if (prop === "strokeColor" && text && text !== el) {
          this.scene.mutateElement(el, { strokeColor: value });
          this.scene.mutateElement(text, { strokeColor: value });
        } else if (el.type !== "text" || prop === "strokeColor") {
          this.scene.mutateElement(el, { [prop]: value });
        }
      }
      this.rebuild(cx);
      this.markDirty();
    }
    cx.notify();
  }

  setTextSize(text, fontSize) {
    const container = text.containerId ? this.scene.getElement(text.containerId) : null;
    this.scene.mutateElement(text, { fontSize, lineHeight: getLineHeight(text.fontFamily) });
    if (container) redrawTextBoundingBox(text, container, this.scene);
    else this.scene.mutateElement(text, refreshTextDimensions(text, null, this.map()));
  }

  // ---- hit testing and selection -----------------------------------------------------

  /** The topmost element under a scene point; bound text answers with its container. */
  hit(p) {
    const map = this.map();
    const els = this.elements();
    const point = [p.x, p.y];
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.locked) continue;
      let hit;
      try {
        hit = el.type === "text" || el.type === "image" || el.type === "frame"
          ? hitElementBoundingBox(point, el, map)
          : hitElementItself({ point, element: el, threshold: 10 / this.vz, elementsMap: map });
      } catch {
        const b = getElementBounds(el, map);
        hit = p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3];
      }
      if (hit) return el.type === "text" && el.containerId ? map.get(el.containerId) ?? el : el;
    }
    return null;
  }

  /** The element and everything in its outermost group. */
  groupOf(el) {
    const outer = el.groupIds?.[el.groupIds.length - 1];
    if (!outer) return [el.id];
    return this.elements().filter((e) => e.groupIds?.includes(outer)).map((e) => e.id);
  }

  /** Selected elements plus the text inside them: what moves and deletes together. */
  withBoundText(ids) {
    const map = this.map();
    const out = new Set(ids);
    for (const id of ids) { const t = getBoundTextElement(map.get(id) ?? null, map); if (t) out.add(t.id); }
    return out;
  }

  // ---- pointer -----------------------------------------------------------------------

  onDown(e, cx) {
    this.focus.focus();
    if (this.editing) { this.endEdit(cx, {}); return; }
    if (this.pointer) this.onUp(cx);
    if (!e.local_position) return;
    const p = this.toScene(e.local_position);
    const tool = this.spaceDown ? "hand" : this.tool;
    if (tool === "hand") return this.onPanStart(e, cx);
    if (tool === "selection") return this.selectDown(e, p, cx);
    if (tool === "eraser") {
      this.pointer = { mode: "erase", ids: new Set() };
      this.eraseAt(p);
      cx.notify(this.liveView);
      return;
    }
    if (tool === "text") return this.startText(p, null, cx);
    this.history.record(this.scene.getElementsIncludingDeleted());
    const base = { x: p.x, y: p.y, ...this.newStyle(tool) };
    let el;
    if (tool === "arrow") el = newArrowElement({ type: "arrow", ...base, points: [[0, 0], [0, 0]], startArrowhead: null, endArrowhead: "arrow" });
    else if (tool === "line") el = newLinearElement({ type: "line", ...base, points: [[0, 0], [0, 0]] });
    else if (tool === "freedraw") el = newFreeDrawElement({ type: "freedraw", ...base, roundness: null, points: [[0, 0]], simulatePressure: true });
    else el = newElement({ type: tool, ...base, width: 0, height: 0 });
    this.scene.insertElement(el);
    this.active = new Set([el.id]);
    this.pointer = { mode: "create", id: el.id, origin: p, shift: false };
    cx.notify(this.liveView);
  }

  selectDown(e, p, cx) {
    const hit = this.hit(p);
    if (e.click_count >= 2) {
      if (hit?.type === "text") return this.startText(p, hit, cx);
      if (hit && ["rectangle", "diamond", "ellipse"].includes(hit.type)) return this.startText(p, hit, cx);
      if (!hit) return this.startText(p, null, cx);
    }
    if (hit) {
      const ids = this.groupOf(hit);
      if (e.modifiers?.shift) {
        const on = this.selected.has(hit.id);
        for (const id of ids) on ? this.selected.delete(id) : this.selected.add(id);
      } else if (!this.selected.has(hit.id)) {
        this.selected = new Set(ids);
      }
      this.pointer = { mode: "move", last: p, started: false };
    } else {
      if (!e.modifiers?.shift) this.selected = new Set();
      this.pointer = { mode: "marquee", start: p, cur: p };
    }
    cx.notify(this.liveView);
    cx.notify();
  }

  onPanStart(e, cx) {
    if (!e.local_position) return;
    this.pointer = { mode: "pan", start: e.local_position, scroll: [this.scrollX, this.scrollY] };
  }

  onMove(e, cx) {
    const ptr = this.pointer;
    if (!ptr || !e.local_position) return;
    const p = this.toScene(e.local_position);
    if (ptr.mode === "pan") {
      const s = this.scale();
      this.scrollX = ptr.scroll[0] + (e.local_position.x - ptr.start.x) / s;
      this.scrollY = ptr.scroll[1] + (e.local_position.y - ptr.start.y) / s;
      cx.notify();
      return;
    }
    if (ptr.mode === "marquee") { ptr.cur = p; cx.notify(this.liveView); return; }
    if (ptr.mode === "erase") { this.eraseAt(p); cx.notify(this.liveView); return; }
    if (ptr.mode === "move") return this.moveSelection(p, cx);
    if (ptr.mode === "create") return this.resizeNew(p, e.modifiers?.shift, cx);
  }

  eraseAt(p) {
    const hit = this.hit(p);
    if (hit) for (const id of this.groupOf(hit)) this.pointer.ids.add(id);
  }

  moveSelection(p, cx) {
    const ptr = this.pointer;
    const dx = p.x - ptr.last.x;
    const dy = p.y - ptr.last.y;
    if (!dx && !dy) return;
    const map = this.map();
    if (!ptr.started) {
      ptr.started = true;
      this.history.record(this.scene.getElementsIncludingDeleted());
      ptr.ids = this.withBoundText(this.selected);
      // An arrow dragged without the shapes it is attached to comes loose from them.
      for (const id of ptr.ids) {
        const el = map.get(id);
        if ((el?.type === "arrow" || el?.type === "line") && (el.startBinding || el.endBinding)) {
          const keep = (b) => b && ptr.ids.has(b.elementId) ? "keep" : null;
          bindOrUnbindLinearElement(el, keep(el.startBinding), keep(el.endBinding), this.scene);
        }
      }
      // Arrows attached to moving shapes follow them, so they are drawn live too.
      const live = new Set(ptr.ids);
      for (const id of ptr.ids) for (const b of map.get(id)?.boundElements ?? []) if (b.type === "arrow") live.add(b.id);
      this.active = live;
      this.rebuild(cx);
    }
    const moving = [...ptr.ids].map((id) => map.get(id)).filter(Boolean);
    for (const el of moving) this.scene.mutateElement(el, { x: el.x + dx, y: el.y + dy }, { informMutation: false, isDragging: true });
    for (const el of moving) if (el.boundElements?.some((b) => b.type === "arrow")) updateBoundElements(el, this.scene, { simultaneouslyUpdated: moving });
    ptr.last = p;
    cx.notify(this.liveView);
  }

  resizeNew(p, square, cx) {
    const ptr = this.pointer;
    const el = this.scene.getElement(ptr.id);
    if (!el) return;
    const o = ptr.origin;
    let dx = p.x - o.x;
    let dy = p.y - o.y;
    if (el.type === "freedraw") {
      const points = [...el.points, [dx, dy]];
      const xs = points.map((q) => q[0]);
      const ys = points.map((q) => q[1]);
      this.scene.mutateElement(el, { points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, { informMutation: false, isDragging: true });
    } else if (el.type === "arrow" || el.type === "line") {
      this.scene.mutateElement(el, { points: [[0, 0], [dx, dy]], width: Math.abs(dx), height: Math.abs(dy) }, { informMutation: false, isDragging: true });
    } else {
      if (square) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
      this.scene.mutateElement(el, { x: Math.min(o.x, o.x + dx), y: Math.min(o.y, o.y + dy), width: Math.abs(dx), height: Math.abs(dy) }, { informMutation: false, isDragging: true });
    }
    cx.notify(this.liveView);
  }

  onUp(cx) {
    const ptr = this.pointer;
    if (!ptr) return;
    this.pointer = null;
    const map = this.map();
    if (ptr.mode === "pan") return;
    if (ptr.mode === "marquee") {
      const [x1, x2] = [Math.min(ptr.start.x, ptr.cur.x), Math.max(ptr.start.x, ptr.cur.x)];
      const [y1, y2] = [Math.min(ptr.start.y, ptr.cur.y), Math.max(ptr.start.y, ptr.cur.y)];
      if (x2 - x1 > 1 || y2 - y1 > 1) {
        for (const el of this.elements()) {
          if (el.locked || (el.type === "text" && el.containerId)) continue;
          const b = getElementBounds(el, map);
          if (b[0] >= x1 && b[2] <= x2 && b[1] >= y1 && b[3] <= y2) for (const id of this.groupOf(el)) this.selected.add(id);
        }
      }
      cx.notify(this.liveView);
      cx.notify();
      return;
    }
    if (ptr.mode === "erase") {
      if (ptr.ids.size) {
        this.history.record(this.scene.getElementsIncludingDeleted());
        this.deleteIds(ptr.ids);
        this.markDirty();
      }
      this.rebuild(cx);
      return;
    }
    if (ptr.mode === "move") {
      if (ptr.started) {
        this.active = new Set();
        this.rebuild(cx);
        this.markDirty();
      }
      return;
    }
    if (ptr.mode === "create") this.finishNew(ptr, cx);
  }

  finishNew(ptr, cx) {
    const map = this.map();
    const el = this.scene.getElement(ptr.id);
    this.active = new Set();
    const tiny = !el || (el.type === "freedraw" ? el.points.length < 2 : Math.hypot(el.width, el.height) < 3);
    if (tiny) {
      if (el) this.scene.mutateElement(el, { isDeleted: true });
      this.history.undoStack.pop();
    } else {
      if (el.type === "arrow") {
        const others = this.elements().filter((e) => e.id !== el.id);
        const [sx, sy] = [el.x, el.y];
        const end = el.points[el.points.length - 1];
        // fullShape: an end dropped inside a shape binds to it, as in Excalidraw.
        const at = (x, y) => getHoveredElementForBinding({ x, y }, others, map, { value: this.vz }, true);
        const start = at(sx, sy);
        const finish = at(sx + end[0], sy + end[1]);
        bindOrUnbindLinearElement(el, start, finish && finish !== start ? finish : null, this.scene);
        // An end dropped deep inside a shape gets a gap measured from there (or none, for
        // ellipses); use Excalidraw's usual small gap so the end sits just off the outline.
        const gap = (b) => b && { ...b, gap: 4 };
        this.scene.mutateElement(el, { startBinding: gap(el.startBinding), endBinding: gap(el.endBinding) });
        for (const shape of new Set([start, finish])) if (shape) updateBoundElements(shape, this.scene);
      }
      this.selected = new Set([el.id]);
      if (el.type !== "freedraw") this.tool = "selection";
      this.markDirty();
    }
    this.rebuild(cx);
  }

  deleteIds(ids) {
    const map = this.map();
    const all = this.withBoundText(ids);
    const deleted = [];
    for (const id of all) {
      const el = map.get(id);
      if (!el) continue;
      if (el.type === "text" && el.containerId && !all.has(el.containerId)) {
        const c = map.get(el.containerId);
        if (c) this.scene.mutateElement(c, { boundElements: (c.boundElements ?? []).filter((b) => b.id !== el.id) });
      }
      this.scene.mutateElement(el, { isDeleted: true });
      deleted.push(el);
    }
    fixBindingsAfterDeletion(this.scene.getNonDeletedElements(), deleted);
    for (const id of all) this.selected.delete(id);
  }

  // ---- text --------------------------------------------------------------------------

  /** Edits `target` text, adds text to a `target` shape, or (no target) starts new text at p. */
  startText(p, target, cx) {
    const map = this.map();
    this.history.record(this.scene.getElementsIncludingDeleted());
    let el = target?.type === "text" ? target : target ? getBoundTextElement(target, map) : null;
    let isNew = false;
    if (!el) {
      isNew = true;
      const fontFamily = FONT_FAMILY.Excalifont;
      const lineHeight = getLineHeight(fontFamily);
      el = newTextElement({
        text: "", x: p.x, y: p.y - (this.style.fontSize * lineHeight) / 2, fontSize: this.style.fontSize, fontFamily, lineHeight,
        strokeColor: this.style.strokeColor, opacity: 100, roughness: this.style.roughness,
        ...(target ? { containerId: target.id, textAlign: "center", verticalAlign: "middle" } : {}),
      });
      this.scene.insertElement(el);
      if (target) this.scene.mutateElement(target, { boundElements: [...(target.boundElements ?? []), { type: "text", id: el.id }] });
    }
    const state = TextareaState.new({ value: el.originalText ?? el.text });
    state.set_soft_wrap(!!el.containerId);
    state.set_auto_grow(1, 200);
    state.on("blur", (_e, cx) => this.endEdit(cx, {}));
    state.on("submit", (_e, cx) => this.endEdit(cx, {}));
    this.editing = { id: el.id, state, isNew, before: el.originalText ?? el.text };
    this.selected = new Set();
    this.tool = "selection";
    this.rebuild(cx);
    // The textarea mounts on the next frame; focusing it now would leave keys with the canvas.
    cx.spawn(async (cx) => {
      await cx.sleep(16);
      if (this.editing?.state === state) state.focus();
    });
  }

  endEdit(cx, { discard }) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const value = discard ? ed.before : ed.state.value();
    ed.state.release();
    const el = this.scene.getElement(ed.id);
    if (el && !el.isDeleted) {
      if (!value.trim()) {
        this.deleteIds(new Set([el.id]));
        if (ed.isNew) this.history.undoStack.pop();
        else this.markDirty();
      } else if (value === ed.before && !ed.isNew) {
        this.history.undoStack.pop();
      } else {
        const container = el.containerId ? this.scene.getElement(el.containerId) : null;
        this.scene.mutateElement(el, { originalText: value, text: value });
        if (container) redrawTextBoundingBox(el, container, this.scene);
        else this.scene.mutateElement(el, refreshTextDimensions(el, null, this.map(), value));
        this.selected = new Set([container?.id ?? el.id]);
        this.markDirty();
      }
    }
    this.focus.focus();
    this.rebuild(cx);
  }

  // ---- view --------------------------------------------------------------------------

  onWheel(e, cx) {
    const m = e.modifiers ?? {};
    if (m.platform || m.control) {
      this.zoomBy(Math.exp(-e.delta.y * 0.01), e.local_position ?? null, cx);
      return;
    }
    const s = this.scale();
    const dx = m.shift && !e.delta.x ? e.delta.y : e.delta.x;
    const dy = m.shift && !e.delta.x ? 0 : e.delta.y;
    this.scrollX += dx / s;
    this.scrollY += dy / s;
    cx.notify();
  }

  zoomBy(factor, at, cx) { this.setZoom(this.vz * factor, at, cx); }

  /** Zooms about `at` (pointer, GPUI px) or the view's center, keeping that point still. */
  setZoom(vz, at, cx) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vz));
    if (next === this.vz) return;
    const anchor = at ?? { x: (this.size?.width ?? 800) / 2, y: (this.size?.height ?? 600) / 2 };
    const before = this.toScene(anchor);
    this.vz = next;
    const s = this.scale();
    this.scrollX = anchor.x / s - before.x;
    this.scrollY = anchor.y / s - before.y;
    // Paths are built at a scale; rebuild once per burst of wheel events.
    if (!this.zoomPending) {
      this.zoomPending = true;
      cx.spawn(async (cx) => {
        await cx.sleep(40);
        this.zoomPending = false;
        this.rebuild(cx);
      });
    }
    cx.notify();
  }

  fitView(cx) {
    const els = this.elements();
    if (!els.length) return this.setZoom(1, null, cx);
    const [x1, y1, x2, y2] = getCommonBounds(els);
    // In layout pixels: one scene unit is one layout pixel at view zoom 1.
    const w = (this.size?.width ?? 800) / this.herdrZoom();
    const h = (this.size?.height ?? 600) / this.herdrZoom();
    this.vz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - 80) / Math.max(x2 - x1, 1), (h - 120) / Math.max(y2 - y1, 1))));
    this.scrollX = (w / this.vz - (x2 - x1)) / 2 - x1;
    this.scrollY = (h / this.vz - (y2 - y1)) / 2 - y1;
    this.rebuild(cx);
  }

  undo(cx) {
    if (this.editing) this.endEdit(cx, {});
    const prev = this.history.undo(this.scene.getElementsIncludingDeleted());
    if (prev) this.restore(prev, cx);
  }

  redo(cx) {
    const next = this.history.redo(this.scene.getElementsIncludingDeleted());
    if (next) this.restore(next, cx);
  }

  restore(elements, cx) {
    this.scene.replaceAllElements(elements);
    const live = this.map();
    this.selected = new Set([...this.selected].filter((id) => live.has(id)));
    this.active = new Set();
    this.markDirty();
    this.rebuild(cx);
  }

  // ---- keys --------------------------------------------------------------------------

  onKey(e, cx) {
    if (this.editing) {
      if (e.key === "escape") this.endEdit(cx, {});
      return;
    }
    const k = e.keystroke;
    const map = this.map();
    if (k === "cmd-z") return this.undo(cx);
    if (k === "cmd-shift-z" || k === "cmd-y") return this.redo(cx);
    if (k === "cmd-a") { this.tool = "selection"; this.selected = new Set(this.elements().filter((el) => !(el.type === "text" && el.containerId)).map((el) => el.id)); cx.notify(this.liveView); cx.notify(); return; }
    // Herdr owns cmd-= / cmd-- / cmd-0 (its own zoom); the canvas zooms with shift-0 and the wheel.
    // Shift+1 / Shift+0 arrive as "!" / ")" with shift already consumed (US layout), or as the
    // digit with shift held on layouts that type something else there.
    const plain = !e.modifiers.platform && !e.modifiers.control && !e.modifiers.alt;
    if (plain && (e.key === ")" || (e.modifiers.shift && e.key === "0"))) return this.setZoom(1, null, cx);
    if (plain && (e.key === "!" || (e.modifiers.shift && e.key === "1"))) return this.fitView(cx);
    if (k === "space") { if (!this.spaceDown) { this.spaceDown = true; cx.notify(); } return; }
    if (k === "escape") { this.selected = new Set(); this.tool = "selection"; cx.notify(this.liveView); cx.notify(); return; }
    if ((k === "backspace" || k === "delete") && this.selected.size) {
      this.history.record(this.scene.getElementsIncludingDeleted());
      this.deleteIds(new Set(this.selected));
      this.markDirty();
      this.rebuild(cx);
      return;
    }
    if (k === "enter" && this.selected.size === 1) {
      const el = map.get([...this.selected][0]);
      if (el && (el.type === "text" || ["rectangle", "diamond", "ellipse"].includes(el.type))) return this.startText({ x: el.x, y: el.y }, el, cx);
    }
    const nudge = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[e.key];
    if (nudge && this.selected.size && !e.modifiers.platform) {
      const step = e.modifiers.shift ? 10 : 1;
      this.history.record(this.scene.getElementsIncludingDeleted());
      const moving = [...this.withBoundText(this.selected)].map((id) => map.get(id)).filter(Boolean);
      for (const el of moving) this.scene.mutateElement(el, { x: el.x + nudge[0] * step, y: el.y + nudge[1] * step });
      for (const el of moving) if (el.boundElements?.some((b) => b.type === "arrow")) updateBoundElements(el, this.scene, { simultaneouslyUpdated: moving });
      this.markDirty();
      this.rebuild(cx);
      return;
    }
    const m = e.modifiers;
    if (!m.platform && !m.control && !m.alt && TOOL_KEYS[e.key]) this.setTool(TOOL_KEYS[e.key], cx);
  }
}
