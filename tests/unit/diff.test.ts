import { describe, expect, it } from "vitest";
import { cellOf, DEFAULT_CELL } from "../../src/engine/cell.js";
import { computeDiff } from "../../src/engine/diff.js";

const W = 10;
const H = 3;

function blank(): { front: import("../../src/engine/cell.js").Cell[]; back: import("../../src/engine/cell.js").Cell[] } {
  const front = new Array(W * H).fill(DEFAULT_CELL);
  const back = new Array(W * H).fill(DEFAULT_CELL);
  return { front, back };
}

function allDirty(): Set<number> {
  return new Set([0, 1, 2]);
}

describe("engine/diff: diffing diferencial", () => {
  it("unchanged frame → no lines", () => {
    const { front, back } = blank();
    expect(computeDiff(front, back, W, allDirty())).toEqual([]);
  });

  it("one changed cell → a single-cell run", () => {
    const { front, back } = blank();
    back[1 * W + 3] = cellOf("x");
    const diff = computeDiff(front, back, W, allDirty());
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ y: 1, changed: 1, rewrite: false });
    expect(diff[0]!.runs).toEqual([{ x: 3, cells: [cellOf("x")] }]);
  });

  it("contiguous changed cells merge into a single run", () => {
    const { front, back } = blank();
    back[0 * W + 2] = cellOf("a");
    back[0 * W + 3] = cellOf("b");
    back[0 * W + 4] = cellOf("c");
    const diff = computeDiff(front, back, W, allDirty());
    expect(diff[0]!.runs).toEqual([{ x: 2, cells: [cellOf("a"), cellOf("b"), cellOf("c")] }]);
  });

  it("separate changes → separate runs in the same order", () => {
    const { front, back } = blank();
    back[2 * W + 1] = cellOf("a");
    back[2 * W + 5] = cellOf("b");
    back[2 * W + 9] = cellOf("c");
    const diff = computeDiff(front, back, W, allDirty());
    expect(diff[0]!.runs.map((r) => r.x)).toEqual([1, 5, 9]);
  });

  it("only scans lines in dirtyLines (changes outside are ignored)", () => {
    const { front, back } = blank();
    back[0 * W + 4] = cellOf("x");
    back[2 * W + 4] = cellOf("y");
    const diff = computeDiff(front, back, W, new Set([1]));
    expect(diff).toEqual([]);
  });

  it("heuristic: changing ≥ half the line → rewrite it fully", () => {
    const { front, back } = blank();
    for (let x = 0; x < 5; x += 1) {
      back[0 * W + x] = cellOf("z");
    }
    const diff = computeDiff(front, back, W, allDirty());
    expect(diff[0]!.rewrite).toBe(true);
    expect(diff[0]!.row).toHaveLength(W);
  });

  it("heuristic: changing less than half → jumps per run (no rewrite)", () => {
    const { front, back } = blank();
    back[1 * W + 2] = cellOf("z");
    back[1 * W + 7] = cellOf("z");
    const diff = computeDiff(front, back, W, allDirty());
    expect(diff[0]!.rewrite).toBe(false);
    expect(diff[0]!.row).toBeUndefined();
  });

  it("dirty lines are returned ordered by y", () => {
    const { front, back } = blank();
    back[2 * W + 0] = cellOf("a");
    back[0 * W + 0] = cellOf("b");
    const diff = computeDiff(front, back, W, allDirty());
    expect(diff.map((d) => d.y)).toEqual([0, 2]);
  });
});
