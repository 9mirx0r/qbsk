import { cellOf, type Cell } from "../engine/cell.js";
import { Canvas } from "../engine/canvas.js";
import { DepthBuffer } from "../engine/depth.js";
import { DEFAULT_CELL_ASPECT, strokeGlyph } from "../engine/stroke.js";

// Scene graph: Scene tree → Layer[] → items (drawing ops).
// Composition is bottom→top by ascending z; the highest-z layer wins.

export type BorderStyle = "single" | "double" | "rounded";

export interface PrimitiveStyle {
  fg?: number;
  bg?: number;
}

// Per-primitive z/visible (M15): composition order inside the layer and
// hiding. Defaults: z=0, visible=true — legacy items without these fields
// still compose (spec language.md §7.1b).
// world (M16): true = absolute canvas position (ignores layer.at).
export type PrimitiveOp =
  | ({ op: "fill"; ch: string; z?: number; visible?: boolean; world?: boolean } & PrimitiveStyle)
  | ({ op: "rect"; x1: number; y1: number; x2: number; y2: number; ch: string; z?: number; visible?: boolean; world?: boolean } & PrimitiveStyle)
  | ({ op: "border"; x1: number; y1: number; x2: number; y2: number; style: BorderStyle; z?: number; visible?: boolean; world?: boolean } & PrimitiveStyle)
  | ({ op: "line"; x1: number; y1: number; x2: number; y2: number; ch: string; stroke?: boolean; z?: number; visible?: boolean; world?: boolean } & PrimitiveStyle)
  | ({ op: "text"; x: number; y: number; text: string; z?: number; visible?: boolean; world?: boolean; depth?: number } & PrimitiveStyle)
  | ({ op: "blit"; x: number; y: number; lines: string[]; z?: number; visible?: boolean; world?: boolean } & PrimitiveStyle)
  // The masked map (docs/engine.md §11.12). One bulk operation carrying the cells the
  // composite resolved, never N `text` ops: moving the loop from the interpreter into
  // the compositor would not remove it. `cells` holds only the glyphs the mask showed,
  // so an unmasked position is absent rather than painted with a space.
  // A bulk cell write: the masked map (§11.12) and a blitted canvas (§11.13) both
  // land here. One operation carrying the cells it resolved, never N `text` ops —
  // moving the loop from the interpreter into the compositor would not remove it.
  // `fg`/`bg`/`attrs` per entry are for sources that carry their own colour (a
  // canvas does); when absent the primitive's style applies, as for any other op.
  | ({
      op: "cells";
      cells: {
        x: number;
        y: number;
        ch: string;
        fg?: number;
        bg?: number;
        attrs?: number;
      }[];
      z?: number;
      visible?: boolean;
      world?: boolean;
      depth?: number;
    } & PrimitiveStyle);

export interface LayerDef {
  name: string;
  z: number;
  visible: boolean;
  at?: { x: number; y: number };
  items: PrimitiveOp[];
  /** Internal static-layer identity; absent layers always compose normally. */
  cacheKey?: number;
}

export interface SceneDef {
  name: string;
  width: number;
  height: number;
  /**
   * What the scene declared about itself beyond its size (§14.3). `null` means the
   * program did not say — never a default invented here. `fps: null` is information
   * ("this scene has no opinion, the host decides"); `fps: 60` fabricated by the
   * runtime would be a lie, and the host already owns the frame rate (`--fps`, §7.6).
   *
   * Optional because they are metadata, not structure: `composeScene` never reads
   * them, so a caller that only wants a grid should not have to supply them. The
   * mount path always sets both explicitly.
   */
  title?: string | null;
  fps?: number | null;
  layers: LayerDef[];
}

const BORDER_STYLES: Record<BorderStyle, { h: string; v: string; tl: string; tr: string; bl: string; br: string }> = {
  single: { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+" },
  double: { h: "═", v: "║", tl: "╔", tr: "╗", bl: "╚", br: "╝" },
  rounded: { h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯" },
};

export interface LayerCellRun {
  start: number;
  cells: Cell[];
}

interface CachedLayer {
  width: number;
  height: number;
  runs: LayerCellRun[];
}

/** Whole-layer cell-run storage owned by one persistent SceneProgram. */
export class StaticLayerCache {
  private readonly layers = new Map<number, CachedLayer>();
  private hitCount = 0;
  private missCount = 0;
  private invalidationCount = 0;

  get(key: number, width: number, height: number): LayerCellRun[] | null {
    const cached = this.layers.get(key);
    if (cached === undefined || cached.width !== width || cached.height !== height) {
      this.missCount += 1;
      return null;
    }
    this.hitCount += 1;
    return cached.runs;
  }

  set(key: number, width: number, height: number, runs: LayerCellRun[]): void {
    this.layers.set(key, { width, height, runs });
  }

  /** Mount-time fast path: avoids rebuilding thousands of PrimitiveOps on a hit. */
  has(key: number, width: number, height: number): boolean {
    const cached = this.layers.get(key);
    return cached !== undefined && cached.width === width && cached.height === height;
  }

  invalidate(): void {
    this.layers.clear();
    this.invalidationCount += 1;
  }

  stats(): { hits: number; misses: number; invalidations: number } {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      invalidations: this.invalidationCount,
    };
  }
}

/**
 * A layer-local canvas that records which cells were written. Comparing final cells to
 * DEFAULT_CELL is insufficient: an explicitly painted space must overwrite a lower
 * layer while an untouched cell must remain transparent to it.
 */
class LayerCanvas extends Canvas {
  readonly touched: Uint8Array;

  constructor(width: number, height: number) {
    super(width, height);
    this.touched = new Uint8Array(width * height);
  }

  override setCell(x: number, y: number, cell: Cell): void {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
      this.touched[y * this.width + x] = 1;
    }
    super.setCell(x, y, cell);
  }

  override fill(ch: string, fg = -1, bg = -1, attrs = 0): void {
    super.fill(ch, fg, bg, attrs);
    this.touched.fill(1);
  }

  override rect(x1: number, y1: number, x2: number, y2: number, cell: Cell): void {
    super.rect(x1, y1, x2, y2, cell);
    const xMin = Math.max(0, Math.min(x1, x2));
    const xMax = Math.min(this.width - 1, Math.max(x1, x2));
    const yMin = Math.max(0, Math.min(y1, y2));
    const yMax = Math.min(this.height - 1, Math.max(y1, y2));
    for (let y = yMin; y <= yMax; y += 1) {
      this.touched.fill(1, y * this.width + xMin, y * this.width + xMax + 1);
    }
  }
}

function cellRuns(canvas: LayerCanvas): LayerCellRun[] {
  const runs: LayerCellRun[] = [];
  for (let row = 0; row < canvas.height; row += 1) {
    const rowStart = row * canvas.width;
    const rowEnd = rowStart + canvas.width;
    let index = rowStart;
    while (index < rowEnd) {
      if (canvas.touched[index] === 0) {
        index += 1;
        continue;
      }
      const start = index;
      const cells: Cell[] = [];
      while (index < rowEnd && canvas.touched[index] !== 0) {
        cells.push(canvas.cells[index]!);
        index += 1;
      }
      runs.push({ start, cells });
    }
  }
  return runs;
}

function replayRuns(canvas: Canvas, runs: readonly LayerCellRun[]): void {
  for (const run of runs) {
    for (let i = 0; i < run.cells.length; i += 1) {
      canvas.cells[run.start + i] = run.cells[i]!;
    }
  }
}

export function composeScene(
  def: SceneDef,
  staticCache?: StaticLayerCache,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): Canvas {
  const canvas = new Canvas(def.width, def.height);
  // Depth testing (docs/engine.md §11.8). Allocated once per composition and only
  // consulted by primitives that actually carry a `depth:` — a scene that never
  // mentions depth composes exactly as it always did, byte for byte.
  const depth = new DepthBuffer(def.width, def.height);
  const layers = def.layers
    .filter((layer) => layer.visible)
    .sort((a, b) => a.z - b.z);
  for (const layer of layers) {
    if (staticCache !== undefined && layer.cacheKey !== undefined) {
      let runs = staticCache.get(layer.cacheKey, def.width, def.height);
      if (runs === null) {
        const layerCanvas = new LayerCanvas(def.width, def.height);
        const layerDepth = new DepthBuffer(def.width, def.height);
        // The cache stores composed cells, so a layer drawn at one aspect must never be
        // replayed at another. It cannot happen today because the aspect is fixed for a
        // SceneProgram's lifetime and the cache belongs to that program — but the two
        // facts sit in different files, so this is where the dependency is written down.
        drawLayer(layerCanvas, layer, layerDepth, cellAspect);
        runs = cellRuns(layerCanvas);
        staticCache.set(layer.cacheKey, def.width, def.height, runs);
      }
      replayRuns(canvas, runs);
      continue;
    }
    drawLayer(canvas, layer, depth, cellAspect);
  }
  return canvas;
}

function drawLayer(
  canvas: Canvas,
  layer: LayerDef,
  depth: DepthBuffer,
  cellAspect: number,
): void {
    // M15: inside the layer, order by ascending z (stable → ties = declaration
    // order); visible: false drops the primitive.
    // M16: local primitives compose at at + local; world: true as-is.
    const ox = layer.at?.x ?? 0;
    const oy = layer.at?.y ?? 0;
    const items = layer.items
      .filter((item) => item.visible !== false)
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    for (const item of items) {
      drawItem(
        canvas,
        item,
        item.world === true ? 0 : ox,
        item.world === true ? 0 : oy,
        depth,
        cellAspect,
      );
    }
}

function cellFor(ch: string, style: PrimitiveStyle): Cell {
  return cellOf(ch, style.fg ?? -1, style.bg ?? -1);
}

function drawItem(
  canvas: Canvas,
  item: PrimitiveOp,
  ox: number,
  oy: number,
  depth: DepthBuffer,
  cellAspect: number,
): void {
  switch (item.op) {
    case "fill":
      canvas.fill(item.ch, item.fg ?? -1, item.bg ?? -1);
      return;
    case "rect":
      canvas.rect(item.x1 + ox, item.y1 + oy, item.x2 + ox, item.y2 + oy, cellFor(item.ch, item));
      return;
    case "border": {
      const style = BORDER_STYLES[item.style];
      const xMin = Math.min(item.x1, item.x2) + ox;
      const xMax = Math.max(item.x1, item.x2) + ox;
      const yMin = Math.min(item.y1, item.y2) + oy;
      const yMax = Math.max(item.y1, item.y2) + oy;
      for (let x = xMin; x <= xMax; x += 1) {
        canvas.setCell(x, yMin, cellFor(style.h, item));
        canvas.setCell(x, yMax, cellFor(style.h, item));
      }
      for (let y = yMin; y <= yMax; y += 1) {
        canvas.setCell(xMin, y, cellFor(style.v, item));
        canvas.setCell(xMax, y, cellFor(style.v, item));
      }
      canvas.setCell(xMin, yMin, cellFor(style.tl, item));
      canvas.setCell(xMax, yMin, cellFor(style.tr, item));
      canvas.setCell(xMin, yMax, cellFor(style.bl, item));
      canvas.setCell(xMax, yMax, cellFor(style.br, item));
      return;
    }
    case "line": {
      // §11.16 — one glyph for the whole line, chosen from its direction. A straight
      // line has one direction, so this is not a per-cell decision pretending to be
      // one: Bresenham's steps wobble around the true slope, and glyphs picked from
      // the wobble would flicker between two characters along a single edge.
      const ch = item.stroke === true
        ? strokeGlyph(item.x2 - item.x1, item.y2 - item.y1, cellAspect)
        : item.ch;
      canvas.line(item.x1 + ox, item.y1 + oy, item.x2 + ox, item.y2 + oy, cellFor(ch, item));
      return;
    }
    case "text": {
      const x = item.x + ox;
      const y = item.y + oy;
      if (item.depth === undefined) {
        canvas.text(x, y, item.text, item.fg ?? -1, item.bg ?? -1);
        return;
      }
      // Depth-tested: each character claims its own cell, so a nearer glyph wins
      // per cell rather than the whole string winning or losing together.
      for (let i = 0; i < item.text.length; i += 1) {
        if (depth.testAndSet(x + i, y, item.depth)) {
          canvas.setCell(x + i, y, cellFor(item.text[i]!, item));
        }
      }
      return;
    }
    case "blit":
      for (let i = 0; i < item.lines.length; i += 1) {
        canvas.text(item.x + ox, item.y + oy + i, item.lines[i]!, item.fg ?? -1, item.bg ?? -1);
      }
      return;
    case "cells": {
      const style = cellFor(" ", item);
      for (const cell of item.cells) {
        const x = cell.x + ox;
        const y = cell.y + oy;
        // Depth competes per CELL, as §11.8 specifies — a composite is many cells,
        // not one object that wins or loses as a whole.
        if (item.depth !== undefined && !depth.testAndSet(x, y, item.depth)) {
          continue;
        }
        canvas.setCell(x, y, {
          char: cell.ch,
          fg: cell.fg ?? style.fg,
          bg: cell.bg ?? style.bg,
          attrs: cell.attrs ?? style.attrs,
        });
      }
      return;
    }
  }
}
