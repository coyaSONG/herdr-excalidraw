// .excalidraw files: reading (with defaults for fields older files lack), writing, and undo history.
import { getNonDeletedElements, syncInvalidIndices, clearElementsForExport } from "@excalidraw/element";
import { DEFAULT_ELEMENT_PROPS, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, ROUNDNESS, getLineHeight, randomInteger } from "@excalidraw/common";

const SOURCE = "herdr-excalidraw";

function legacyRoundness(el) {
  if (el.roundness !== undefined) return el.roundness;
  // Files before roundness had strokeSharpness: "round" | "sharp".
  if (el.strokeSharpness === "round") {
    return { type: el.type === "rectangle" || el.type === "diamond" ? ROUNDNESS.LEGACY : ROUNDNESS.PROPORTIONAL_RADIUS };
  }
  return null;
}

/** Fills in what Excalidraw's own restore would, for the fields this editor reads. */
export function normalizeElement(el) {
  const base = {
    ...DEFAULT_ELEMENT_PROPS,
    angle: 0,
    groupIds: [],
    frameId: null,
    boundElements: null,
    link: null,
    locked: false,
    isDeleted: false,
    version: 1,
    updated: Date.now(),
    index: null,
    ...el,
  };
  base.seed ??= randomInteger();
  base.versionNonce ??= randomInteger();
  base.roundness = legacyRoundness(el);
  delete base.strokeSharpness;
  base.width ??= 0;
  base.height ??= 0;
  if (base.type === "text") {
    base.fontSize ??= DEFAULT_FONT_SIZE;
    base.fontFamily ??= DEFAULT_FONT_FAMILY;
    base.textAlign ??= "left";
    base.verticalAlign ??= "top";
    base.lineHeight ??= getLineHeight(base.fontFamily);
    base.text ??= "";
    base.originalText ??= base.text;
    base.containerId ??= null;
    base.autoResize ??= true;
  }
  if (base.type === "arrow" || base.type === "line" || base.type === "freedraw") {
    base.points ??= [[0, 0]];
  }
  if (base.type === "arrow" || base.type === "line") {
    base.startBinding ??= null;
    base.endBinding ??= null;
    base.startArrowhead ??= null;
    base.endArrowhead ??= base.type === "arrow" ? "arrow" : null;
    if (base.type === "arrow") base.elbowed ??= false;
    if (base.type === "line") base.polygon ??= false;
  }
  if (base.type === "freedraw") {
    base.pressures ??= [];
    base.simulatePressure ??= true;
  }
  return base;
}

/** An empty drawing, for a file that does not exist yet. */
export const emptyDocument = () => ({ elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {}, source: SOURCE });

export function parseDocument(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || (data.type && data.type !== "excalidraw") || !Array.isArray(data.elements)) {
    throw new Error("not an Excalidraw file (expected type \"excalidraw\" with an elements array)");
  }
  return {
    elements: data.elements.filter((e) => e && typeof e === "object" && e.type && e.id).map(normalizeElement),
    // Kept whole so saving round-trips settings this editor doesn't use.
    appState: { viewBackgroundColor: "#ffffff", ...(data.appState ?? {}) },
    files: data.files ?? {},
    source: data.source ?? SOURCE,
  };
}

export function serializeDocument({ elements, appState, files, source }) {
  const live = clearElementsForExport(syncInvalidIndices(getNonDeletedElements(elements)));
  return JSON.stringify({ type: "excalidraw", version: 2, source, elements: live, appState, files }, null, 2) + "\n";
}

const clone = (elements) => elements.map((e) => ({ ...e }));

/** Snapshots of the element list; each committed change is one step. */
export class History {
  constructor(limit = 100) { this.limit = limit; this.undoStack = []; this.redoStack = []; }
  /** Call before a change, with the elements as they are. */
  record(elements) {
    this.undoStack.push(clone(elements));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  /** Returns the elements to restore, or null. */
  undo(current) {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(clone(current));
    return clone(prev);
  }
  redo(current) {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(clone(current));
    return clone(next);
  }
}
