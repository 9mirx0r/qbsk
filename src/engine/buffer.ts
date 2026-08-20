import { DEFAULT_CELL, type Cell } from "./cell.js";

// Double buffer (spec engine.md §4/§11): FrontBuffer = what is on screen;
// BackBuffer = what is being drawn. The swap exchanges references (no copies);
// the reset back is cleared with fill (no per-cell allocations).

export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  front: Cell[];
  back: Cell[];
  readonly dirtyLines = new Set<number>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.front = new Array<Cell>(n).fill(DEFAULT_CELL);
    this.back = new Array<Cell>(n).fill(DEFAULT_CELL);
  }

  beginFrame(): void {
    this.back.fill(DEFAULT_CELL);
    this.dirtyLines.clear();
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    this.back[y * this.width + x] = cell;
    this.dirtyLines.add(y);
  }

  paintCanvas(canvas: { width: number; height: number; cells: readonly Cell[] }): void {
    for (let i = 0; i < canvas.cells.length; i += 1) {
      this.back[i] = canvas.cells[i]!;
      this.dirtyLines.add(Math.floor(i / this.width));
    }
  }

  swap(): void {
    const tmp = this.front;
    this.front = this.back;
    this.back = tmp;
    this.back.fill(DEFAULT_CELL);
    this.dirtyLines.clear();
  }

  reset(width: number, height: number): void {
    (this as { width: number; height: number }).width = width;
    (this as { width: number; height: number }).height = height;
    const n = width * height;
    this.front = new Array<Cell>(n).fill(DEFAULT_CELL);
    this.back = new Array<Cell>(n).fill(DEFAULT_CELL);
    this.dirtyLines.clear();
  }
}
