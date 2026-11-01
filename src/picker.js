// Choosing a drawing inside Herdr: the .excalidraw files of a folder, a new drawing, another folder.
// Used by the launcher popup (mod.open:excalidraw) and by a pane opened without a file. It sits on
// Herdr's own UI, so it follows Herdr's theme and its picker's look (rows, hover, Esc hint).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home, pickFolder, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { emptyDocument, serializeDocument } from "./document.js";

const EXT = ".excalidraw";
const MAX_FILES = 300;
const ROW = 32;
const LIST_MAX = 320;

export const tildify = (p) => (p === home() ? "~" : p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);

export class Picker {
  constructor(folder) {
    this.folder = folder;
    this.files = [];
    this.error = null;
    this.index = 0;
    this.loaded = false;
  }

  async refresh() {
    try {
      const entries = await fs.readdir(this.folder, { withFileTypes: true });
      this.files = entries.filter((e) => !e.isDirectory() && e.name.toLowerCase().endsWith(EXT) && !e.name.startsWith("."))
        .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_FILES);
      this.error = null;
    } catch (e) {
      this.files = [];
      this.error = `Can't list this folder: ${e?.message ?? e}`;
    }
    this.index = Math.min(this.index, this.items().length - 1);
    this.loaded = true;
  }

  path(name) { return `${this.folder}/${name}`; }

  /** What ↑↓ Enter move over: the files, then the two actions. */
  items() {
    return [...this.files.map((name) => ({ kind: "file", name })), { kind: "new" }, { kind: "folder" }];
  }

  async chooseFolder() {
    const folder = await pickFolder({ prompt: "Folder with drawings" });
    if (!folder) return false;
    this.folder = folder;
    this.index = 0;
    await this.refresh();
    return true;
  }

  /** Creates drawing.excalidraw (or drawing-2, -3, …) in the folder and returns its path. */
  async newDrawing() {
    for (let n = 1; n < 1000; n++) {
      const path = this.path(n === 1 ? `drawing${EXT}` : `drawing-${n}${EXT}`);
      if (await fs.exists(path)) continue;
      await writeTextFile(path, serializeDocument(emptyDocument()), null);
      return path;
    }
    throw new Error("no free drawing-N.excalidraw name");
  }

  /** ↑↓ move (wrapping), Enter returns the item to act on; anything else returns null. */
  key(e) {
    const n = this.items().length;
    if (e.key === "down") this.index = (this.index + 1) % n;
    else if (e.key === "up") this.index = (this.index + n - 1) % n;
    else if (e.key === "enter") return this.items()[this.index];
    return null;
  }

  /**
   * `t` is Herdr's theme; `actions`: open(name), openInTab?(name), newDrawing(), chooseFolder().
   * `title` heads it; `escHint` shows "Esc" at the right, as Herdr's popups do; `bg` overrides
   * the popover background (a pane uses the terminals' background).
   */
  render(t, actions, { title, escHint, bg }) {
    const row = (id, i, content, onPress) => h_flex().id(id).mx(4).px(10).h(ROW).flex_none().items_center().gap(10).rounded(7)
      .cursor_pointer().when(i === this.index, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.index = i; onPress(cx); })
      .children(content);
    const files = this.files.map((name, i) => row(`file-${i}`, i, [
      div().w(14).flex_none().text_color(t.dim).child("◇"),
      div().flex_1().truncate().text_color(t.foreground).child(name.slice(0, -EXT.length)),
      actions.openInTab
        ? div().id(`file-tab-${i}`).px(6).rounded(5).text_size(11).text_color(t.muted).hover((s) => s.text_color(t.foreground).bg(t.raised))
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); actions.openInTab(name, cx); })
          .child("new tab")
        : div(),
    ], (cx) => actions.open(name, cx)));
    const n = this.files.length;
    const action = (i, glyph, label, onPress) => row(i === n ? "new-drawing" : "choose-folder", i, [
      div().w(14).flex_none().text_color(t.muted).child(glyph),
      div().flex_1().text_color(t.foreground).child(label),
    ], onPress);
    const empty = !this.loaded ? "Loading…" : this.error ?? "No drawings in this folder yet.";
    const listHeight = Math.min(LIST_MAX, Math.max(n, 1) * (ROW + 2));
    return v_flex().w_full().min_h(0).p(18).gap(10).bg(bg ?? t.popover).text_size(13).children([
      h_flex().items_center().gap(10).children([
        div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(title),
        escHint ? div().text_size(11).text_color(t.muted).child("Esc") : div(),
      ]),
      div().text_size(11).text_color(t.muted).truncate().child(tildify(this.folder)),
      n
        ? v_flex().id("file-list").h(listHeight).min_h(0).gap(2).overflow_y_scrollbar().children(files)
        : div().mx(4).px(10).h(ROW).flex().items_center().text_color(t.muted).child(empty),
      v_flex().gap(2).pt(6).border_t_1().border_color(t.input).children([
        action(n, "+", "New drawing", (cx) => actions.newDrawing(cx)),
        action(n + 1, "…", "Choose folder", (cx) => actions.chooseFolder(cx)),
      ]),
    ]);
  }
}
