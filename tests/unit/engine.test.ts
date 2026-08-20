import { describe, expect, it } from "vitest";
import { Canvas } from "../../src/engine/canvas.js";
import { cellOf, DEFAULT_CELL, eqCell } from "../../src/engine/cell.js";

describe("cell", () => {
  it("eqCell compares all 4 fields", () => {
    expect(eqCell(cellOf("a"), cellOf("a"))).toBe(true);
    expect(eqCell(cellOf("a"), cellOf("b"))).toBe(false);
    expect(eqCell(cellOf("a", 0xff0000), cellOf("a"))).toBe(false);
    expect(eqCell(cellOf("a", -1, 0x00ff00), cellOf("a"))).toBe(false);
    expect(eqCell(cellOf("a", -1, -1, 1), cellOf("a"))).toBe(false);
    expect(eqCell(DEFAULT_CELL, DEFAULT_CELL)).toBe(true);
    expect(eqCell(cellOf(" "), DEFAULT_CELL)).toBe(true);
  });
});

describe("canvas: primitives", () => {
  it("new canvas: all defaults and flat 1D array", () => {
    const c = new Canvas(3, 2);
    expect(c.width).toBe(3);
    expect(c.height).toBe(2);
    expect(c.cells).toHaveLength(6);
    for (const cell of c.cells) {
      expect(eqCell(cell, DEFAULT_CELL)).toBe(true);
    }
  });

  it("setCell in range and out of range is ignored", () => {
    const c = new Canvas(3, 3);
    c.setCell(1, 1, cellOf("x"));
    expect(eqCell(c.cells[4]!, cellOf("x"))).toBe(true);
    c.setCell(-1, 0, cellOf("!")); 
    c.setCell(3, 0, cellOf("!"));
    c.setCell(0, 3, cellOf("!"));
    c.setCell(-5, -5, cellOf("!"));
    expect(c.renderText()).toBe("   \n x \n   ");
  });

  it("fill covers the whole canvas", () => {
    const c = new Canvas(2, 2);
    c.fill("#");
    expect(c.renderText()).toBe("##\n##");
  });

  it("rect fills the area", () => {
    const c = new Canvas(5, 4);
    c.rect(1, 1, 3, 2, cellOf("o"));
    expect(c.renderText()).toBe("     \n ooo \n ooo \n     ");
  });

  it("rect with partial clipping", () => {
    const c = new Canvas(5, 5);
    c.rect(-2, -2, 2, 2, cellOf("*"));
    expect(c.renderText()).toBe("***  \n***  \n***  \n     \n     ");
  });

  it("rect with inverted corners (x1 > x2)", () => {
    const c = new Canvas(4, 3);
    c.rect(3, 0, 0, 2, cellOf("+"));
    expect(c.renderText()).toBe("++++\n++++\n++++");
  });

  it("border draws only the outline", () => {
    const c = new Canvas(5, 4);
    c.border(0, 0, 4, 3, cellOf("+"));
    expect(c.renderText()).toBe("+++++\n+   +\n+   +\n+++++");
  });

  it("border with clipping", () => {
    const c = new Canvas(4, 3);
    c.border(-1, -1, 2, 2, cellOf("+"));
    expect(c.renderText()).toBe("  + \n  + \n+++ ");
  });

  it("line horizontal, vertical and diagonal", () => {
    const c = new Canvas(5, 5);
    c.line(0, 0, 4, 0, cellOf("-"));
    c.line(2, 1, 2, 4, cellOf("|"));
    c.line(0, 4, 4, 0, cellOf("/"));
    expect(c.renderText()).toBe("----/\n  |/ \n  /  \n /|  \n/ |  ");
  });

  it("line out of range does not blow up or draw", () => {
    const c = new Canvas(3, 3);
    c.line(10, 10, 12, 12, cellOf("x"));
    expect(c.renderText()).toBe("   \n   \n   ");
  });

  it("text writes characters and clips at the right edge", () => {
    const c = new Canvas(6, 2);
    c.text(2, 0, "text");
    c.text(5, 1, "xy"); 
    expect(c.renderText()).toBe("  text\n     x");
  });

  it("text with negative offset clips", () => {
    const c = new Canvas(4, 2);
    c.text(-2, 0, "abc");
    expect(c.renderText()).toBe("c   \n    ");
  });

  it("blit copies with clipping and offset", () => {
    const src = new Canvas(2, 2);
    src.fill("s");
    const dst = new Canvas(4, 3);
    dst.blit(src, 1, 1);
    expect(dst.renderText()).toBe("    \n ss \n ss ");
    const dst2 = new Canvas(2, 2);
    dst2.blit(src, 2, 2);
    expect(dst2.renderText()).toBe("  \n  ");
  });

  it("clear restores defaults", () => {
    const c = new Canvas(2, 2);
    c.fill("#");
    c.clear();
    expect(c.renderText()).toBe("  \n  ");
  });
});

describe("canvas: renderText", () => {
  it("exact byte-by-byte output: box + text", () => {
    const c = new Canvas(6, 3);
    c.border(0, 0, 5, 2, cellOf("+"));
    c.text(1, 1, "hi");
    expect(c.renderText()).toBe("++++++\n+hi  +\n++++++");
  });

  it("lines always have full width (padding spaces)", () => {
    const c = new Canvas(4, 2);
    c.text(0, 0, "ab");
    expect(c.renderText()).toBe("ab  \n    ");
  });

  it("does not end with a trailing newline", () => {
    const c = new Canvas(2, 2);
    expect(c.renderText().endsWith("\n")).toBe(false);
  });
});
