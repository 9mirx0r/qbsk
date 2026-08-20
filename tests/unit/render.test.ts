import { describe, expect, it } from "vitest";
import { cellOf, DEFAULT_CELL } from "../../src/engine/cell.js";
import { computeDiff } from "../../src/engine/diff.js";
import { renderFrame } from "../../src/engine/render.js";
import { ScreenBuffer } from "../../src/engine/buffer.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const W = 10;
const H = 3;

function blank(): { front: import("../../src/engine/cell.js").Cell[]; back: import("../../src/engine/cell.js").Cell[] } {
  return {
    front: new Array(W * H).fill(DEFAULT_CELL),
    back: new Array(W * H).fill(DEFAULT_CELL),
  };
}

const CYAN = 0x00cdcd;
const RED = 0xcd0000;

describe("engine/render: emisor ANSI", () => {
  it("unchanged frame → 0 bytes", () => {
    const { front, back } = blank();
    expect(renderFrame(computeDiff(front, back, W, new Set([0, 1, 2])), W)).toBe("");
  });

  it("run with default style: cursor jump + text, no SGR", () => {
    const { front, back } = blank();
    back[0 * W + 3] = cellOf("x");
    const diff = computeDiff(front, back, W, new Set([0]));
    expect(renderFrame(diff, W)).toBe("\x1b[1;4Hx");
  });

  it("cell with truecolor fg → SGR 38;2;r;g;b and reset", () => {
    const { front, back } = blank();
    back[1 * W + 2] = cellOf("x", CYAN);
    const diff = computeDiff(front, back, W, new Set([1]));
    expect(renderFrame(diff, W)).toBe("\x1b[2;3H\x1b[38;2;0;205;205mx\x1b[0m");
  });

  it("run of cells with the same style → one SGR + all the text", () => {
    const { front, back } = blank();
    for (let i = 0; i < 3; i += 1) {
      back[0 * W + 5 + i] = cellOf("abc"[i]!, RED);
    }
    const diff = computeDiff(front, back, W, new Set([0]));
    expect(renderFrame(diff, W)).toBe("\x1b[1;6H\x1b[38;2;205;0;0mabc\x1b[0m");
  });

  it("style change inside a run → reset + second SGR, without repeating the previous one", () => {
    const { front, back } = blank();
    back[0 * W + 1] = cellOf("a", RED);
    back[0 * W + 2] = cellOf("b", RED);
    back[0 * W + 3] = cellOf("c", CYAN);
    const diff = computeDiff(front, back, W, new Set([0]));
    expect(renderFrame(diff, W)).toBe(
      "\x1b[1;2H\x1b[38;2;205;0;0mab\x1b[0m\x1b[38;2;0;205;205mc\x1b[0m",
    );
  });

  it("bold attribute → \\x1b[1m; bold + fg → 1;38;2;r;g;b", () => {
    const { front, back } = blank();
    back[2 * W + 0] = cellOf("b", -1, -1, 1);
    back[2 * W + 1] = cellOf("f", RED, -1, 1);
    const diff = computeDiff(front, back, W, new Set([2]));
    expect(renderFrame(diff, W)).toBe(
      "\x1b[3;1H\x1b[1mb\x1b[0m\x1b[1;38;2;205;0;0mf\x1b[0m",
    );
  });

  it("bg truecolor → SGR 48;2;r;g;b", () => {
    const { front, back } = blank();
    back[0 * W + 0] = cellOf("x", -1, 0x00cd00);
    const diff = computeDiff(front, back, W, new Set([0]));
    expect(renderFrame(diff, W)).toBe("\x1b[1;1H\x1b[48;2;0;205;0mx\x1b[0m");
  });

  it("line with rewrite: jump to line start + full row + reset", () => {
    const { front, back } = blank();
    for (let x = 0; x < W; x += 1) {
      back[1 * W + x] = cellOf("=");
    }
    const diff = computeDiff(front, back, W, new Set([1]));
    expect(diff[0]!.rewrite).toBe(true);
    expect(renderFrame(diff, W)).toBe("\x1b[2;1H==========\x1b[0m");
  });

  it("rewrite with a mixed-style row → SGR grouped in the full row", () => {
    const { front, back } = blank();
    for (let x = 0; x < 5; x += 1) {
      back[0 * W + x] = cellOf("A", CYAN);
    }
    for (let x = 5; x < W; x += 1) {
      back[0 * W + x] = cellOf("B");
    }
    const diff = computeDiff(front, back, W, new Set([0]));
    expect(diff[0]!.rewrite).toBe(true);
    expect(renderFrame(diff, W)).toBe(
      "\x1b[1;1H\x1b[38;2;0;205;205mAAAAA\x1b[0mBBBBB\x1b[0m",
    );
  });

  it("two dirty lines → two cursor jumps in order", () => {
    const { front, back } = blank();
    back[0 * W + 0] = cellOf("a");
    back[2 * W + 7] = cellOf("b", CYAN);
    const diff = computeDiff(front, back, W, new Set([0, 1, 2]));
    expect(renderFrame(diff, W)).toBe(
      "\x1b[1;1Ha\x1b[3;8H\x1b[38;2;0;205;205mb\x1b[0m",
    );
  });

  it("full pipeline: scene → canvas → buffer → diff → ANSI (run, no rewrite)", () => {
    const r = runQbsk(
      'scene S(width: 10, height: 2)\nlayer l z: 1\n    text "abc" at (3, 0)',
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    const canvas = r.canvas!;
    const buf = new ScreenBuffer(canvas.width, canvas.height);
    buf.paintCanvas(canvas);
    const ansi = renderFrame(computeDiff(buf.front, buf.back, buf.width, buf.dirtyLines), buf.width);
    expect(ansi).toBe("\x1b[1;4Habc");
  });
});
