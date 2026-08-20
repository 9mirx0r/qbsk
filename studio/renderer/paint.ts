// PURE DOM painter (docs/studio.md §4): consumes DiffLine[] produced by
// src/engine/diff.ts and patches DOM cells. It has no runtime imports — the
// Cell/DiffLine types are erased — and must never import "electron".
import type { Cell } from "../../src/engine/cell.js";
import type { DiffLine } from "../../src/engine/diff.js";

const ATTR_BOLD = 1;
const ATTR_UNDERLINE = 2;
const ATTR_REVERSE = 4;

// 0xRRGGBB -> "rgb(r,g,b)"; -1 (terminal default) -> null (inherits CSS).
export function cellColor(packed: number): string | null {
  if (packed === -1) {
    return null;
  }
  return `rgb(${(packed >> 16) & 255}, ${(packed >> 8) & 255}, ${packed & 255})`;
}

export function applyCell(
  el: HTMLSpanElement,
  cell: Cell,
  tiles?: ReadonlyMap<string, string> | null,
): void {
  let fg = cell.fg;
  let bg = cell.bg;
  if (cell.attrs & ATTR_REVERSE) {
    const t = fg;
    fg = bg;
    bg = t;
  }
  el.textContent = cell.char;
  // A tile owns the cell's pixels: its image becomes the background and the
  // character is still painted underneath, made transparent so only the tile shows
  // (docs/engine.md §15.1 — the grid stays the truth; renderText still reads the
  // character). A cell whose char has no tile paints exactly as before.
  const tile = tiles?.get(cell.char);
  if (tile !== undefined) {
    el.style.color = "transparent";
    el.style.backgroundColor = "transparent";
    el.style.backgroundImage = `url("${tile}")`;
    el.style.backgroundSize = "100% 100%";
    el.style.backgroundRepeat = "no-repeat";
  } else {
    el.style.color = cellColor(fg) ?? "";
    el.style.backgroundColor = cellColor(bg) ?? "";
    el.style.backgroundImage = "";
  }
  el.style.fontWeight = cell.attrs & ATTR_BOLD ? "700" : "";
  el.style.textDecoration = cell.attrs & ATTR_UNDERLINE ? "underline" : "";
}

export class DomGrid {
  private cells: HTMLSpanElement[] = [];
  private width = 0;
  private height = 0;
  private tiles: Map<string, string> | null = null;
  /**
   * The last cell painted at each index, or null where nothing has been.
   *
   * Kept so a tileset arriving can repaint what is already on screen. It holds
   * references to cells the diff already allocated, so it costs one pointer per cell
   * and nothing per frame.
   */
  private painted: (Cell | null)[] = [];

  constructor(private readonly container: HTMLElement) {}

  /**
   * The glyph -> data URL map to paint as cell backgrounds (docs/engine.md §15).
   * Null (or absent) paints characters, which is always the fallback.
   *
   * **Repaints what is already on screen.** The tile lookup rides the diff for a
   * FRAME (docs/studio.md §4.1) — 18 cells instead of 4800 — but a tileset arriving
   * changes every cell at once, and the diff has nothing to say about that. The first
   * version only stored the map, so choosing a tileset logged success and left the
   * window unchanged: a static scene never updated at all, and a live one tiled
   * progressively as unrelated cells happened to be redrawn.
   *
   * Repainting HERE rather than asking the caller to follow up is deliberate. A
   * `repaint()` that must be remembered is a bug waiting for the second caller; a
   * setter that does the whole job cannot be half-used.
   */
  setTiles(tiles: Map<string, string> | null): void {
    this.tiles = tiles;
    for (let i = 0; i < this.painted.length; i += 1) {
      const cell = this.painted[i];
      const el = this.cells[i];
      if (cell !== undefined && cell !== null && el !== undefined) {
        applyCell(el, cell, this.tiles);
      }
    }
  }

  reset(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.container.textContent = "";
    this.container.style.gridTemplateColumns = `repeat(${width}, 1ch)`;
    const cells: HTMLSpanElement[] = new Array<HTMLSpanElement>(width * height);
    for (let i = 0; i < cells.length; i += 1) {
      const el = document.createElement("span");
      el.className = "cell";
      cells[i] = el;
      this.container.append(el);
    }
    this.cells = cells;
    // A new grid has nothing painted: without this a resize would let the old scene's
    // cells be repainted into the new one on the next setTiles.
    this.painted = new Array<Cell | null>(width * height).fill(null);
  }

  // Only the changed cells are patched — the diff already decided what moved.
  paint(diff: DiffLine[]): void {
    for (const line of diff) {
      if (line.rewrite) {
        const row = line.row ?? [];
        for (let x = 0; x < row.length; x += 1) {
          this.applyAt(line.y, x, row[x]!);
        }
      } else {
        for (const run of line.runs) {
          for (let i = 0; i < run.cells.length; i += 1) {
            this.applyAt(line.y, run.x + i, run.cells[i]!);
          }
        }
      }
    }
  }

  // Read the grid back as text (unpainted default cells are " "). Used by the
  // automated smoke check to prove the window paints what the terminal paints.
  renderText(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let line = "";
      for (let x = 0; x < this.width; x += 1) {
        const el = this.cells[y * this.width + x];
        line += el !== undefined && el.textContent ? el.textContent : " ";
      }
      rows.push(line);
    }
    return rows.join("\n");
  }

  private applyAt(y: number, x: number, cell: Cell): void {
    const i = y * this.width + x;
    const el = this.cells[i];
    if (el !== undefined) {
      this.painted[i] = cell;
      applyCell(el, cell, this.tiles);
    }
  }
}
