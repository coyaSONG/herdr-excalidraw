// Turns Excalidraw elements into native GPUI paths, text and images, grouped into layers.
//
// Units: scene units are Excalidraw's. Paths are built in GPUI logical pixels
// (scene * scale, where scale = view zoom * Herdr zoom); text and image boxes are
// laid out in Herdr layout pixels (scene * view zoom). Herdr scales layout pixels
// by its own zoom, so both land on the same spot.
import { PathBuilder } from "gpui-kit";
import {
  ShapeCache,
  getElementAbsoluteCoords,
  getElementBounds,
  getFreeDrawSvgPath,
} from "@excalidraw/element";

// Upper bound on path commands per layer. One render has an execution deadline in
// Herdr; 2000 hatched shapes in one path (~220k commands) passed, 3000 did not.
const LAYER_OPS = 40000;
// Elements per batch. Elements in a batch don't overlap, so their paths can be merged
// by style without changing what is drawn on top of what.
const BATCH_ITEMS = 200;

const NAMED = { black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", gray: "808080", grey: "808080" };

/** `#rrggbb[aa]` with Excalidraw opacity (0..100) folded in, or null for nothing to paint. */
export function toColor(value, opacity = 100) {
  if (!value || value === "transparent") return null;
  let h = String(value).trim().toLowerCase();
  if (h.startsWith("#")) h = h.slice(1);
  else if (NAMED[h]) h = NAMED[h];
  else return null;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]+$/.test(h) || (h.length !== 6 && h.length !== 8)) return null;
  const base = h.slice(0, 6);
  const alpha = (h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1) * Math.max(0, Math.min(100, opacity)) / 100;
  if (alpha <= 0) return null;
  return alpha >= 1 ? `#${base}` : `#${base}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

// Excalidraw's dash patterns, in scene units.
function dashFor(el) {
  if (el.strokeStyle === "dashed") return [8, 8 + el.strokeWidth];
  if (el.strokeStyle === "dotted") return [1.5, 6 + el.strokeWidth];
  return null;
}

/** Maps an element-local point to GPUI pixels: element offset, rotation about its center, scale. */
function transformFor(el, elementsMap, scale) {
  const angle = el.angle || 0;
  if (!angle) return (lx, ly) => [(el.x + lx) * scale, (el.y + ly) * scale];
  const [, , , , cx, cy] = getElementAbsoluteCoords(el, elementsMap);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (lx, ly) => {
    const dx = el.x + lx - cx;
    const dy = el.y + ly - cy;
    return [(cx + dx * cos - dy * sin) * scale, (cy + dx * sin + dy * cos) * scale];
  };
}

function piece(fill, width, color, dash, n, emit) {
  return { key: `${fill ? "F" : "S"}|${width.toFixed(3)}|${color}|${dash ? dash.join(",") : ""}`, fill, width, color, dash, n, emit };
}

// roughjs sets: "path" is the outline, "fillSketch" the hatching, "fillPath" a solid fill.
function drawablePieces(el, drawable, xf, scale) {
  const out = [];
  if (!drawable?.sets) return out;
  for (const set of drawable.sets) {
    const fill = set.type === "fillPath";
    const outline = set.type === "path";
    const color = toColor(outline ? drawable.options.stroke : drawable.options.fill ?? drawable.options.stroke, el.opacity);
    if (!color) continue;
    const width = fill ? 0 : (set.type === "fillSketch" ? drawable.options.fillWeight ?? el.strokeWidth / 2 : drawable.options.strokeWidth ?? el.strokeWidth) * scale;
    const dash = outline ? dashFor(el)?.map((v) => v * scale) ?? null : null;
    out.push(piece(fill, width, color, dash, set.ops.length, (b) => {
      for (const op of set.ops) {
        const d = op.data;
        if (op.op === "move") b = b.move_to(...xf(d[0], d[1]));
        else if (op.op === "lineTo") b = b.line_to(...xf(d[0], d[1]));
        else if (op.op === "bcurveTo") {
          const [c1x, c1y] = xf(d[0], d[1]);
          const [c2x, c2y] = xf(d[2], d[3]);
          const [tx, ty] = xf(d[4], d[5]);
          b = b.cubic_bezier_to(tx, ty, c1x, c1y, c2x, c2y);
        }
      }
      return b;
    }));
  }
  return out;
}

const SVG_TOKEN = /[MLQTCZmlqtcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g;

/** A filled piece from an absolute SVG path (M L Q T C Z), as free-draw strokes come. */
function svgPiece(d, color, xf) {
  const tok = d.match(SVG_TOKEN) || [];
  return piece(true, 0, color, null, tok.length, (b) => {
    let i = 0, cmd = "", cx = 0, cy = 0, qx = 0, qy = 0;
    const n = () => parseFloat(tok[i++]);
    while (i < tok.length) {
      if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
      if (cmd === "Z" || cmd === "z") { b = b.close(); continue; }
      if (cmd === "M") { cx = n(); cy = n(); b = b.move_to(...xf(cx, cy)); cmd = "L"; }
      else if (cmd === "L") { cx = n(); cy = n(); b = b.line_to(...xf(cx, cy)); }
      else if (cmd === "Q" || cmd === "T") {
        if (cmd === "Q") { qx = n(); qy = n(); } else { qx = 2 * cx - qx; qy = 2 * cy - qy; }
        cx = n(); cy = n();
        const [tx, ty] = xf(cx, cy);
        const [kx, ky] = xf(qx, qy);
        b = b.curve_to(tx, ty, kx, ky);
      } else if (cmd === "C") {
        const a = [n(), n(), n(), n(), n(), n()];
        cx = a[4]; cy = a[5];
        const [tx, ty] = xf(a[4], a[5]);
        const [k1x, k1y] = xf(a[0], a[1]);
        const [k2x, k2y] = xf(a[2], a[3]);
        b = b.cubic_bezier_to(tx, ty, k1x, k1y, k2x, k2y);
      } else throw new Error(`unsupported SVG command ${cmd}`);
    }
    return b;
  });
}

function boxPiece(el, color, xf, scale) {
  const w = el.width, h = el.height;
  return piece(false, 1 * scale, color, [6 * scale, 4 * scale], 5, (b) =>
    b.move_to(...xf(0, 0)).line_to(...xf(w, 0)).line_to(...xf(w, h)).line_to(...xf(0, h)).close());
}

const FONTS = {
  1: "Excalifont", // Virgil: Excalifont is its successor and ships with this mod
  2: "Helvetica",
  3: "JetBrains Mono", // Cascadia; JetBrains Mono ships with Herdr
  5: "Excalifont",
  6: "Helvetica Neue", // Nunito
  7: "Helvetica Neue", // Lilita One
  8: "Comic Sans MS", // Comic Shanns
  9: "Helvetica", // Liberation Sans
};
export const fontName = (family) => FONTS[family] ?? "Excalifont";

/**
 * What one element draws: path pieces, text and image boxes, and its scene bounds.
 * Returns null for elements that draw nothing. `hidden` text (being edited) draws nothing.
 */
export function elementItem(el, elementsMap, scale, opts) {
  if (el.isDeleted || el.type === "selection") return null;
  const bounds = getElementBounds(el, elementsMap);
  const xf = transformFor(el, elementsMap, scale);
  const pieces = [];
  const texts = [];
  const images = [];
  if (el.type === "text") {
    if (opts.hiddenText?.has(el.id)) return null;
    const color = toColor(el.strokeColor, el.opacity);
    if (color) texts.push({ x: el.x, y: el.y, w: el.width, h: el.height, lines: String(el.text).split("\n"), fontSize: el.fontSize, lineHeight: el.lineHeight, font: fontName(el.fontFamily), color, align: el.textAlign });
  } else if (el.type === "freedraw") {
    const color = toColor(el.strokeColor, el.opacity);
    if (color && el.points.length) pieces.push(svgPiece(getFreeDrawSvgPath(el), color, xf));
  } else if (el.type === "image") {
    const file = opts.imagePath?.(el.fileId);
    if (file) images.push({ x: el.x, y: el.y, w: el.width, h: el.height, file });
    else pieces.push(boxPiece(el, "#868e96", xf, scale));
  } else if (el.type === "frame" || el.type === "magicframe") {
    pieces.push(boxPiece(el, "#868e96", xf, scale));
    if (el.name) texts.push({ x: el.x, y: el.y - 20, w: Math.max(el.width, 1), h: 18, lines: [el.name], fontSize: 14, lineHeight: 1.25, font: "Helvetica", color: "#868e96", align: "left" });
  } else {
    let shape = null;
    try { shape = ShapeCache.generateElementShape(el, opts.shapeConfig); } catch { shape = null; }
    const list = Array.isArray(shape) ? shape : shape ? [shape] : [];
    for (const d of list) pieces.push(...drawablePieces(el, d, xf, scale));
    if (!list.length) pieces.push(boxPiece(el, "#868e96", xf, scale));
  }
  if (!pieces.length && !texts.length && !images.length) return null;
  return { id: el.id, bounds, pieces, texts, images, ops: pieces.reduce((s, p) => s + p.n, 0) };
}

const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Paths merged per style for one batch, in drawing order, followed by its text and images. */
function batchDrawList(items) {
  const groups = new Map();
  const extras = [];
  for (const item of items) {
    for (const p of item.pieces) {
      let g = groups.get(p.key);
      if (!g) {
        let b = p.fill ? PathBuilder.fill() : PathBuilder.stroke(p.width);
        if (p.dash) b = b.dash_array(p.dash);
        groups.set(p.key, g = { b, color: p.color, fill: p.fill });
      }
      g.b = p.emit(g.b);
    }
    for (const t of item.texts) extras.push({ kind: "text", ...t });
    for (const i of item.images) extras.push({ kind: "image", ...i });
  }
  // Fills under outlines, as roughjs draws them within one element.
  const paths = [...groups.values()].sort((a, b) => Number(b.fill) - Number(a.fill)).map((g) => ({ kind: "path", path: g.b.build(), color: g.color }));
  return [...paths, ...extras];
}

/**
 * Splits elements (in z-order) into layers. Each layer is a draw list in order plus the
 * scene bounds it covers, so off-screen layers need not be mounted.
 */
export function buildLayers(elements, elementsMap, scale, opts) {
  const batches = [];
  let batch = null;
  for (const el of elements) {
    let item;
    try { item = elementItem(el, elementsMap, scale, opts); } catch (e) { opts.onError?.(el, e); continue; }
    if (!item) continue;
    const pad = (el.strokeWidth || 1) * 2 + 4;
    const box = [item.bounds[0] - pad, item.bounds[1] - pad, item.bounds[2] + pad, item.bounds[3] + pad];
    if (!batch || batch.items.length >= BATCH_ITEMS || batch.boxes.some((b) => overlaps(b, box))) {
      batch = { items: [], boxes: [], ops: 0 };
      batches.push(batch);
    }
    batch.items.push(item);
    batch.boxes.push(box);
    batch.ops += item.ops;
  }
  const layers = [];
  let layer = null;
  for (const b of batches) {
    if (!layer || layer.ops + b.ops > LAYER_OPS) {
      layer = { ops: 0, batches: [], bounds: [Infinity, Infinity, -Infinity, -Infinity] };
      layers.push(layer);
    }
    layer.batches.push(b);
    layer.ops += b.ops;
    for (const box of b.boxes) {
      layer.bounds = [Math.min(layer.bounds[0], box[0]), Math.min(layer.bounds[1], box[1]), Math.max(layer.bounds[2], box[2]), Math.max(layer.bounds[3], box[3])];
    }
  }
  return layers.map((l) => ({ bounds: l.bounds, draw: l.batches.flatMap((b) => batchDrawList(b.items)) }));
}
