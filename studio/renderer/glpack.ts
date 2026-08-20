// Packing a grid into the two data textures the shader samples (docs/studio.md §4.2).
//
// One texel per cell in each of two RGBA textures:
//
//   fg.rgb  foreground colour        bg.rgb  background colour
//   fg.a    glyph slot, low 8 bits   bg.a    slot high bits | attribute flags
//
// A glyph slot needs more than eight bits — the atlas holds 1024 and braille alone is
// 256 of them (§11.15) — so the slot is split across both alphas. An implementation that
// keeps it in one byte wraps slot 256 to 0 and draws a space, silently, on exactly the
// scenes that use the most glyphs.
//
// PURE, and no WebGL import. This is where the painter is wrong or right; the GL calls
// around it are four lines.
import type { Cell } from "../../src/engine/cell.js";

const ATTR_BOLD = 1;
const ATTR_UNDERLINE = 2;
const ATTR_REVERSE = 4;

/** The slot's high bits occupy the low nibble of `bg.a`, leaving room above for flags. */
export const SLOT_HIGH_MASK = 0x0f;
export const ATTR_BOLD_BIT = 0x10;
export const ATTR_UNDERLINE_BIT = 0x20;

/**
 * What a terminal-default colour becomes.
 *
 * `cellColor` returns null for -1 in the DOM painter and CSS inherits from the theme. A
 * texture has no inheritance, so the default has to be resolved somewhere, and here is
 * the only place that sees every cell. Packing -1 as white would repaint every default
 * cell — which is most of them — a colour nobody chose.
 */
const DEFAULT_FG = 0xcccccc;
const DEFAULT_BG = 0x000000;

interface SlotSource {
  slotOf(char: string): number;
}

/**
 * Writes one cell's eight bytes at `fgAt` / `bgAt`.
 *
 * Reverse is resolved HERE by swapping the two colours, so the shader never learns about
 * it: the swap is exact and free at pack time, and a branch in a fragment shader is
 * neither. Bold and underline cannot be — they change how the glyph is drawn, not which
 * one — so they travel as flags.
 */
export function packCell(
  cell: Cell,
  atlas: SlotSource,
  fg: Uint8Array,
  fgAt: number,
  bg: Uint8Array,
  bgAt: number,
): void {
  let ink = cell.fg === -1 ? DEFAULT_FG : cell.fg;
  let paper = cell.bg === -1 ? DEFAULT_BG : cell.bg;
  if (cell.attrs & ATTR_REVERSE) {
    const swap = ink;
    ink = paper;
    paper = swap;
  }

  const slot = atlas.slotOf(cell.char);

  fg[fgAt] = (ink >> 16) & 255;
  fg[fgAt + 1] = (ink >> 8) & 255;
  fg[fgAt + 2] = ink & 255;
  fg[fgAt + 3] = slot & 255;

  bg[bgAt] = (paper >> 16) & 255;
  bg[bgAt + 1] = (paper >> 8) & 255;
  bg[bgAt + 2] = paper & 255;
  bg[bgAt + 3] = ((slot >> 8) & SLOT_HIGH_MASK) |
    (cell.attrs & ATTR_BOLD ? ATTR_BOLD_BIT : 0) |
    (cell.attrs & ATTR_UNDERLINE ? ATTR_UNDERLINE_BIT : 0);
}
