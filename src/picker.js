// Choosing a drawing inside Herdr: the .excalidraw files of a folder, a new drawing, another folder.
// Used by the launcher overlay (mod.open:excalidraw) and by a pane opened without a file.
import { div } from "gpui-kit";
import { home, pickFolder, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { emptyDocument, serializeDocument } from "./document.js";

const EXT = ".excalidraw";
const MAX_FILES = 300;

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
      this.error = `Can't list ${tildify(this.folder)}: ${e?.message ?? e}`;
    }
    this.index = Math.min(this.index, Math.max(0, this.files.length - 1));
    this.loaded = true;
  }

  path(name) { return `${this.folder}/${name}`; }

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

  /** Up/down move, enter opens; returns the file name to open or null. */
  key(e) {
    if (e.key === "down") this.index = Math.min(this.index + 1, this.files.length - 1);
    else if (e.key === "up") this.index = Math.max(this.index - 1, 0);
    else if (e.key === "enter" && this.files.length) return this.files[this.index];
    return null;
  }

  /**
   * The list. `t` is the light palette; `actions`: open(name), openInTab?(name), newDrawing(),
   * chooseFolder(). `title` heads it; `hint` explains what a click does.
   */
  render(t, actions, { title, hint }) {
    const button = (id, label, onPress) => div().id(id).px(10).py(5).rounded(6).text_size(13).cursor_pointer()
      .border(1).border_color(t.border).bg(t.surface).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onPress(cx); })
      .child(label);
    const rows = this.files.map((name, i) => div().id(`file-${i}`).flex().items_center().gap(8).px(10).py(6).rounded(6)
      .cursor_pointer().bg(i === this.index ? t.selected : t.surface).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.index = i; actions.open(name, cx); })
      .children([
        div().flex_1().text_size(14).text_color(t.foreground).truncate().child(name),
        actions.openInTab
          ? div().id(`file-tab-${i}`).px(8).py(2).rounded(4).text_size(12).text_color(t.muted).border(1).border_color(t.border)
            .hover((s) => s.bg(t.surface))
            .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); actions.openInTab(name, cx); })
            .child("Tab")
          : div(),
      ]));
    const empty = this.error ?? (this.loaded ? "No drawings here yet. Start a new one, or choose another folder." : "Loading…");
    return div().flex().flex_col().gap(10).p(16).size_full().bg(t.surface).text_color(t.foreground).children([
      div().flex().items_center().justify_between().children([
        div().text_size(16).font_semibold().child(title),
        div().flex().gap(6).children([
          button("new-drawing", "New drawing", (cx) => actions.newDrawing(cx)),
          button("choose-folder", "Choose folder…", (cx) => actions.chooseFolder(cx)),
        ]),
      ]),
      div().text_size(12).text_color(t.muted).truncate().child(tildify(this.folder)),
      div().id("file-list").flex_1().flex().flex_col().gap(2).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().p(10).text_size(13).text_color(t.muted).child(empty)]),
      div().text_size(11).text_color(t.muted).child(hint),
    ]);
  }
}
