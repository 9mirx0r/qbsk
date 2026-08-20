// Play mode sizing (docs/studio.md §13).
//
// Pure arithmetic, deliberately separated from the DOM so it can be unit-tested
// headless. This is the only part of play mode that can be *wrong*: hiding chrome
// is structural, but a bad fit either overflows the window or wastes half of it.
//
// The character grid NEVER changes here. Play mode scales the font; the number of
// rows and columns is whatever the scene declared. That is what keeps a scaled
// frame byte-identical to an unscaled one (criterion 3).

/** Cell geometry of the grid, as CSS applies it. */
export const CELL_ASPECT = 1.15; // .cell height is 1.15em (see .dom-grid line-height)

/**
 * The cell's height divided by its width — the engine's `cellAspect` (§11.16).
 *
 * A cell is `chPerEm` em wide and `CELL_ASPECT` em tall, so the shape the engine draws
 * diagonals in is one over the other. Derived from the same two numbers `applyFit` hands
 * the GPU painter, which is what stops the drawn ANGLE and the drawn PIXELS disagreeing:
 * two expressions of the same fact drift, and this one drifts invisibly, as a diagonal
 * that is subtly wrong rather than as an error.
 *
 * F0's own table read `chPerEm` as the ratio (2.0 for Unifont, 1.67 for JetBrains Mono),
 * which assumed a line height of exactly 1 em. Studio's is 1.15, so the real shapes are
 * 2.30 and 1.92 — and the engine's default of 2.0 is therefore wrong for ALL FOUR
 * registered fonts in Studio, not for two of them.
 */
export function cellAspectFor(chPerEm: number): number {
  return CELL_ASPECT / chPerEm;
}

export interface FitInput {
  cols: number;
  rows: number;
  availWidth: number;
  availHeight: number;
  minPx?: number;
  maxPx?: number;
  /**
   * Cell advance in em units for the font in use. Defaults to CH_PER_EM for the
   * legacy single-font case, but every caller that knows its font should pass the
   * measured value from `fonts.ts` — the ratio differs by 20% between Iosevka
   * (0.5) and JetBrains Mono (0.6), which is the difference between filling the
   * window and leaving a fifth of it empty.
   */
  chPerEm?: number;
}

/**
 * Largest font size in px at which a cols x rows grid still fits in the given box.
 *
 * A cell is 1ch wide and CELL_ASPECT em tall. For a monospace font, 1ch is about
 * 0.6em — measured from the actual font at runtime would be better, but 0.6 is the
 * standard advance ratio for the monospace stack Studio uses, and being slightly
 * conservative costs a few pixels while being wrong the other way clips the scene.
 */
export const CH_PER_EM = 0.6;

export function fitFontSize(input: FitInput): number {
  const { cols, rows, availWidth, availHeight } = input;
  const minPx = input.minPx ?? 6;
  const maxPx = input.maxPx ?? 64;
  if (cols <= 0 || rows <= 0 || availWidth <= 0 || availHeight <= 0) {
    return minPx;
  }
  const ch = input.chPerEm ?? CH_PER_EM;
  const byWidth = availWidth / (cols * ch);
  const byHeight = availHeight / (rows * CELL_ASPECT);
  const px = Math.floor(Math.min(byWidth, byHeight));
  return Math.max(minPx, Math.min(maxPx, px));
}

/** The pixel grid the project font is drawn on (font/LICENSE.md). */
export const FONT_PIXEL_GRID = 8;

/**
 * Snaps a fitted size DOWN to the font's pixel grid.
 *
 * GNU Unifont is designed on a 16-pixel grid: it is crisp at 16 and at multiples of
 * 8, and goes soft in between. Snapping *down* keeps the guarantee that matters —
 * the scene still fits — at the cost of a few pixels of unused margin. Snapping up
 * would look better and clip the scene, which is the wrong trade.
 *
 * Below one grid step there is nothing to snap to, so the raw size is returned:
 * a tiny-but-legible frame beats one clamped to 8px that no longer fits.
 */
export function snapToFontGrid(px: number, grid = FONT_PIXEL_GRID): number {
  if (px < grid) {
    return px;
  }
  return Math.floor(px / grid) * grid;
}
