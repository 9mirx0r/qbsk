import { eqCell, type Cell } from "./cell.js";

// Differential diffing (spec engine.md §5): only dirty lines are scanned
// (dirtyLines); contiguous changed cells form a run. If ≥ half the line
// changed, rewriting it fully (rewrite) beats per-run jumps.

export interface CellRun {
  x: number;
  cells: Cell[];
}

export interface DiffLine {
  y: number;
  changed: number;
  rewrite: boolean;
  row?: Cell[];
  runs: CellRun[];
}

export function computeDiff(
  front: Cell[],
  back: Cell[],
  width: number,
  dirtyLines: ReadonlySet<number>,
): DiffLine[] {
  const out: DiffLine[] = [];
  const height = front.length / width;
  const ys = [...dirtyLines].sort((a, b) => a - b);
  for (const y of ys) {
    if (y < 0 || y >= height) {
      continue;
    }
    const base = y * width;
    const runs: CellRun[] = [];
    let changed = 0;
    let x = 0;
    while (x < width) {
      if (eqCell(front[base + x]!, back[base + x]!)) {
        x += 1;
        continue;
      }
      changed += 1;
      const cells: Cell[] = [back[base + x]!];
      const runX = x;
      x += 1;
      while (x < width && !eqCell(front[base + x]!, back[base + x]!)) {
        cells.push(back[base + x]!);
        changed += 1;
        x += 1;
      }
      runs.push({ x: runX, cells });
    }
    if (changed === 0) {
      continue;
    }
    const line: DiffLine = {
      y,
      changed,
      rewrite: changed * 2 >= width,
      runs,
    };
    if (line.rewrite) {
      line.row = back.slice(base, base + width);
    }
    out.push(line);
  }
  return out;
}
