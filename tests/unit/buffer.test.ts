import { describe, expect, it } from "vitest";
import { cellOf, DEFAULT_CELL, eqCell } from "../../src/engine/cell.js";
import { ScreenBuffer } from "../../src/engine/buffer.js";

describe("engine/buffer: doble buffer", () => {
  it("beginFrame clears the back with the template cell (no stale state)", () => {
    const buf = new ScreenBuffer(4, 3);
    buf.setCell(1, 1, cellOf("x"));
    buf.beginFrame();
    for (let i = 0; i < 12; i += 1) {
      expect(eqCell(buf.back[i]!, DEFAULT_CELL)).toBe(true);
    }
    expect(buf.dirtyLines.size).toBe(0);
  });

  it("setCell paints the back and marks only the dirty line", () => {
    const buf = new ScreenBuffer(4, 3);
    buf.setCell(2, 1, cellOf("a"));
    buf.setCell(0, 1, cellOf("b"));
    buf.setCell(3, 2, cellOf("c"));
    expect(buf.dirtyLines).toEqual(new Set([1, 2]));
    expect(buf.back[1 * 4 + 2]!.char).toBe("a");
    expect(buf.front[1 * 4 + 2]!.char).toBe(" ");
  });

  it("swap: front mirrors back, back resets to template and dirty clears", () => {
    const buf = new ScreenBuffer(4, 3);
    buf.setCell(1, 0, cellOf("z"));
    buf.swap();
    expect(buf.front[1]!.char).toBe("z");
    for (let i = 0; i < 12; i += 1) {
      expect(eqCell(buf.back[i]!, DEFAULT_CELL)).toBe(true);
    }
    expect(buf.dirtyLines.size).toBe(0);
  });

  it("writing the same frame twice → no dirty lines the second time", () => {
    const buf = new ScreenBuffer(4, 3);
    buf.setCell(1, 1, cellOf("x"));
    buf.swap();
    buf.setCell(1, 1, cellOf("x"));
    buf.swap();
    expect(buf.dirtyLines.size).toBe(0);
  });

  it("reset resizes and clears everything", () => {
    const buf = new ScreenBuffer(4, 3);
    buf.setCell(0, 0, cellOf("q"));
    buf.reset(6, 2);
    expect(buf.width).toBe(6);
    expect(buf.height).toBe(2);
    expect(buf.back).toHaveLength(12);
    expect(buf.front).toHaveLength(12);
    expect(buf.dirtyLines.size).toBe(0);
    expect(eqCell(buf.back[0]!, DEFAULT_CELL)).toBe(true);
  });

  it("setCell out of range is dropped without crashing", () => {
    const buf = new ScreenBuffer(4, 3);
    buf.setCell(-1, 0, cellOf("x"));
    buf.setCell(4, 0, cellOf("x"));
    buf.setCell(0, 3, cellOf("x"));
    expect(buf.dirtyLines.size).toBe(0);
  });
});
