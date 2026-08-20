// Subcell resolution (docs/engine.md §11.14).
//
// A character cell is about one wide and two tall. Splitting it horizontally makes each
// half about square, which is the whole visual win here: a circle drawn at 1:1 in the
// doubled grid comes out round instead of squashed.
//
// This module decides a CELL from the subpixels that land in it. It is pure, like
// ramp.ts: no canvas, no I/O, no colour lookup — the caller resolves colour names and
// the caller owns the grid.

import { cellOf, type Cell } from "./cell.js";

/** Upper half painted in fg, lower half showing bg. */
export const HALF_TOP = "▀"; // ▀
/** Lower half painted in fg, upper half showing bg. */
export const HALF_BOTTOM = "▄"; // ▄
/** Both halves in fg. */
export const FULL_BLOCK = "█"; // █

/** No colour, in the cell model's own vocabulary. */
const NONE = -1;

/**
 * What a cell currently says about its two subpixels.
 *
 * `null` means "this half was never plotted", which is different from "plotted with the
 * default colour": the first must stay out of the way of whatever is underneath, the
 * second is a deliberate mark.
 */
export interface HalfCell {
  top: number | null;
  bottom: number | null;
}

/**
 * Reads a cell back into its two subpixels.
 *
 * Only the three glyphs this module writes are decoded. Anything else — a letter, a box
 * character, whatever `fill` left — reports both halves empty, so the next plot replaces
 * it. Merging into a `#` would mean guessing which half of it was meant to survive, and
 * that guess is exactly the kind of invention §15 catalogues.
 */
export function readHalfCell(cell: Cell): HalfCell {
  switch (cell.char) {
    case HALF_TOP:
      return { top: cell.fg, bottom: cell.bg === NONE ? null : cell.bg };
    case HALF_BOTTOM:
      return { top: cell.bg === NONE ? null : cell.bg, bottom: cell.fg };
    case FULL_BLOCK:
      return { top: cell.fg, bottom: cell.fg };
    default:
      return { top: null, bottom: null };
  }
}

/**
 * Encodes two subpixels back into one cell.
 *
 * The two-colour case is the reason this module exists: `▀` paints its upper half in the
 * foreground and leaves the lower half showing the background, so a single cell carries
 * two independently coloured pixels. Nothing else in the engine can express that.
 */
export function writeHalfCell(half: HalfCell, attrs = 0): Cell {
  const { top, bottom } = half;
  if (top === null && bottom === null) {
    return cellOf(" ", NONE, NONE, attrs);
  }
  if (top !== null && bottom === null) {
    return cellOf(HALF_TOP, top, NONE, attrs);
  }
  if (top === null && bottom !== null) {
    return cellOf(HALF_BOTTOM, bottom, NONE, attrs);
  }
  if (top === bottom) {
    return cellOf(FULL_BLOCK, top!, NONE, attrs);
  }
  return cellOf(HALF_TOP, top!, bottom!, attrs);
}

/**
 * Sets one subpixel of a cell, keeping whatever the other half already held.
 *
 * `half` is 0 for the top subpixel and 1 for the bottom — the low bit of a doubled y
 * coordinate, so a caller passes `y % 2` without a lookup.
 */
export function plotHalf(existing: Cell, half: 0 | 1, colour: number): Cell {
  const current = readHalfCell(existing);
  const next: HalfCell = half === 0
    ? { top: colour, bottom: current.bottom }
    : { top: current.top, bottom: colour };
  return writeHalfCell(next, existing.attrs);
}

/**
 * Braille dot bits, `[column][row]`, in the standard Unicode ordering.
 *
 * The block is 2 wide and 4 tall, and the numbering is not raster order: dots 1-3 run
 * down the left column, 4-6 down the right, and 7-8 are the bottom row added when
 * braille grew from six dots to eight. Writing the table out beats deriving it wrongly.
 */
export const BRAILLE_BITS: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/** First code point of the braille block; the dot bits are added to it directly. */
export const BRAILLE_BASE = 0x2800;

/** The empty braille cell — a blank that still occupies its width. */
export const BRAILLE_BLANK = String.fromCharCode(BRAILLE_BASE);

/** Turns a dot bitmask into its braille character. */
export function brailleGlyph(bits: number): string {
  return String.fromCharCode(BRAILLE_BASE + (bits & 0xff));
}

/**
 * Reads a cell back into its dot bitmask, or 0 for anything that is not braille.
 *
 * Same rule as the half-block decoder: a cell holding something else is replaced rather
 * than merged into.
 */
export function readBraille(cell: Cell): number {
  const code = cell.char.codePointAt(0) ?? 0;
  if (code < BRAILLE_BASE || code > BRAILLE_BASE + 0xff) {
    return 0;
  }
  return code - BRAILLE_BASE;
}

/** Sets one dot of a braille cell, keeping the dots already there. */
export function plotBrailleDot(existing: Cell, col: 0 | 1, row: 0 | 1 | 2 | 3): Cell {
  const bits = readBraille(existing) | BRAILLE_BITS[col]![row]!;
  return cellOf(brailleGlyph(bits), existing.fg, existing.bg, existing.attrs);
}
