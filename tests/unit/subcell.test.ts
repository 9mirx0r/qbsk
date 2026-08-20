// Subcell resolution (docs/engine.md §11.14).
import { describe, expect, it } from "vitest";
import { cellOf } from "../../src/engine/cell.js";
import {
  BRAILLE_BASE,
  BRAILLE_BITS,
  brailleGlyph,
  FULL_BLOCK,
  HALF_BOTTOM,
  HALF_TOP,
  plotBrailleDot,
  plotHalf,
  readBraille,
  readHalfCell,
  writeHalfCell,
} from "../../src/engine/subcell.js";

const RED = 0xff0000;
const BLUE = 0x0000ff;
const BLANK = cellOf(" ");

describe("half-block cells carry two subpixels", () => {
  it("one subpixel on top gives the upper half block", () => {
    const cell = plotHalf(BLANK, 0, RED);
    expect(cell.char).toBe(HALF_TOP);
    expect(cell.fg).toBe(RED);
    expect(cell.bg).toBe(-1);
  });

  it("one subpixel on the bottom gives the lower half block", () => {
    const cell = plotHalf(BLANK, 1, RED);
    expect(cell.char).toBe(HALF_BOTTOM);
    expect(cell.fg).toBe(RED);
  });

  it("two subpixels of the same colour collapse to a full block", () => {
    const cell = plotHalf(plotHalf(BLANK, 0, RED), 1, RED);
    expect(cell.char).toBe(FULL_BLOCK);
    expect(cell.fg).toBe(RED);
  });

  // Criterion 2 of the stage, and the reason the module exists: `▀` paints its upper
  // half in fg and leaves the lower half showing bg, so one cell holds two
  // independently coloured pixels.
  it("two subpixels of different colours give fg = top, bg = bottom", () => {
    const cell = plotHalf(plotHalf(BLANK, 0, RED), 1, BLUE);
    expect(cell.char).toBe(HALF_TOP);
    expect(cell.fg).toBe(RED);
    expect(cell.bg).toBe(BLUE);
  });

  it("resolves the same pair whichever half was plotted first", () => {
    const topFirst = plotHalf(plotHalf(BLANK, 0, RED), 1, BLUE);
    const bottomFirst = plotHalf(plotHalf(BLANK, 1, BLUE), 0, RED);
    expect(bottomFirst).toEqual(topFirst);
  });

  it("replaces a cell holding something it did not write", () => {
    // Merging into a '#' would mean guessing which half of it was meant to survive.
    const cell = plotHalf(cellOf("#", RED), 1, BLUE);
    expect(cell.char).toBe(HALF_BOTTOM);
    expect(cell.fg).toBe(BLUE);
  });

  it("round-trips through read and write", () => {
    for (const half of [
      { top: null, bottom: null },
      { top: RED, bottom: null },
      { top: null, bottom: RED },
      { top: RED, bottom: RED },
      { top: RED, bottom: BLUE },
    ]) {
      expect(readHalfCell(writeHalfCell(half))).toEqual(half);
    }
  });

  it("keeps an untouched half out of the way instead of colouring it", () => {
    // -1 in bg means "nothing was plotted below", not "black was plotted below".
    // Reading it back as a subpixel would invent a mark the program never made.
    expect(readHalfCell(cellOf(HALF_TOP, RED, -1))).toEqual({ top: RED, bottom: null });
  });
});

describe("braille packs 2 x 4 monochrome dots", () => {
  it("the empty mask is the blank braille cell, not a space", () => {
    expect(brailleGlyph(0)).toBe(String.fromCharCode(BRAILLE_BASE));
    expect(brailleGlyph(0)).not.toBe(" ");
  });

  // The numbering is not raster order — 1-3 run down the left column, 4-6 down the
  // right, 7-8 are the bottom row braille gained when it grew from six dots to eight.
  it("uses the standard dot ordering", () => {
    expect(BRAILLE_BITS[0]).toEqual([0x01, 0x02, 0x04, 0x40]);
    expect(BRAILLE_BITS[1]).toEqual([0x08, 0x10, 0x20, 0x80]);
  });

  it("all eight dots give the solid braille cell", () => {
    expect(brailleGlyph(0xff)).toBe(String.fromCharCode(BRAILLE_BASE + 0xff));
  });

  it("dots accumulate rather than replacing each other", () => {
    let cell = cellOf(" ");
    cell = plotBrailleDot(cell, 0, 0);
    cell = plotBrailleDot(cell, 1, 3);
    expect(readBraille(cell)).toBe(0x01 | 0x80);
  });

  it("replaces a cell that is not braille", () => {
    const cell = plotBrailleDot(cellOf("#"), 0, 0);
    expect(readBraille(cell)).toBe(0x01);
  });

  it("reads a non-braille cell as no dots", () => {
    expect(readBraille(cellOf("#"))).toBe(0);
    expect(readBraille(cellOf(" "))).toBe(0);
  });

  it("every one of the 256 masks round-trips", () => {
    for (let bits = 0; bits < 256; bits += 1) {
      expect(readBraille(cellOf(brailleGlyph(bits)))).toBe(bits);
    }
  });
});
