import { cellOf, DEFAULT_CELL, type Cell } from "./cell.js";

// Virtual canvas: flat 1D array indexed y * width + x (never 2D).
// All primitives clip against the bounds; they never index out of range.
export class Canvas {
  readonly width: number;
  readonly height: number;
  cells: Cell[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Array(width * height).fill(DEFAULT_CELL);
  }

  // clear() without allocations: fills with a single template instance.
  clear(cell: Cell = DEFAULT_CELL): void {
    this.cells.fill(cell);
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    this.cells[y * this.width + x] = cell;
  }

  fill(ch: string, fg = -1, bg = -1, attrs = 0): void {
    this.clear(cellOf(ch, fg, bg, attrs));
  }

  rect(x1: number, y1: number, x2: number, y2: number, cell: Cell): void {
    const xMin = Math.max(0, Math.min(x1, x2));
    const xMax = Math.min(this.width - 1, Math.max(x1, x2));
    const yMin = Math.max(0, Math.min(y1, y2));
    const yMax = Math.min(this.height - 1, Math.max(y1, y2));
    if (xMin > xMax || yMin > yMax) {
      return;
    }
    for (let y = yMin; y <= yMax; y += 1) {
      const row = y * this.width;
      for (let x = xMin; x <= xMax; x += 1) {
        this.cells[row + x] = cell;
      }
    }
  }

  border(x1: number, y1: number, x2: number, y2: number, cell: Cell): void {
    const xMin = Math.min(x1, x2);
    const xMax = Math.max(x1, x2);
    const yMin = Math.min(y1, y2);
    const yMax = Math.max(y1, y2);
    this.hLine(xMin, xMax, yMin, cell);
    this.hLine(xMin, xMax, yMax, cell);
    this.vLine(xMin, yMin, yMax, cell);
    this.vLine(xMax, yMin, yMax, cell);
  }

  private hLine(x1: number, x2: number, y: number, cell: Cell): void {
    if (y < 0 || y >= this.height) {
      return;
    }
    const from = Math.max(0, Math.min(x1, x2));
    const to = Math.min(this.width - 1, Math.max(x1, x2));
    const row = y * this.width;
    for (let x = from; x <= to; x += 1) {
      this.cells[row + x] = cell;
    }
  }

  private vLine(x: number, y1: number, y2: number, cell: Cell): void {
    if (x < 0 || x >= this.width) {
      return;
    }
    const from = Math.max(0, Math.min(y1, y2));
    const to = Math.min(this.height - 1, Math.max(y1, y2));
    for (let y = from; y <= to; y += 1) {
      this.cells[y * this.width + x] = cell;
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, cell: Cell): void {
    // Bresenham (setCell does the clipping and drops out-of-range cells).
    let cx = x1;
    let cy = y1;
    const dx = Math.abs(x2 - x1);
    const sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1);
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setCell(cx, cy, cell);
      if (cx === x2 && cy === y2) {
        break;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        cx += sx;
      }
      if (e2 <= dx) {
        err += dx;
        cy += sy;
      }
    }
  }

  text(x: number, y: number, str: string, fg = -1, bg = -1, attrs = 0): void {
    for (let i = 0; i < str.length; i += 1) {
      this.setCell(x + i, y, cellOf(str[i]!, fg, bg, attrs));
    }
  }

  blit(src: Canvas, dx: number, dy: number): void {
    for (let y = 0; y < src.height; y += 1) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) {
        continue;
      }
      for (let x = 0; x < src.width; x += 1) {
        this.setCell(dx + x, ty, src.cells[y * src.width + x]!);
      }
    }
  }

  // Plain-text output (no ANSI): full-width lines, no trailing \n.
  renderText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      const row = y * this.width;
      let line = "";
      for (let x = 0; x < this.width; x += 1) {
        line += this.cells[row + x]!.char;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }
}
