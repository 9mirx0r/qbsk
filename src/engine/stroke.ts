// Orientation glyphs (docs/engine.md §11.16).
//
// A ramp says how much ink a cell holds; it cannot say which way the ink runs. Two
// cells of equal density can be a horizontal edge and a vertical one, and a
// density-only render draws them identically — which is why diagonal edges in ASCII
// look like gravel.
//
// Pure, like ramp.ts and subcell.ts: a direction in, a character out.

/** Mostly across. */
export const STROKE_HORIZONTAL = "─";
/** Mostly up and down. */
export const STROKE_VERTICAL = "│";
/** Diagonal, rising to the right. */
export const STROKE_RISING = "╱";
/** Diagonal, falling to the right. */
export const STROKE_FALLING = "╲";

/**
 * How horizontal a stroke must read before it is drawn as `─`.
 *
 * cos(29°) ≈ 0.87. Named because the number is a decision, not a constant of nature:
 * raising it widens the diagonal band and makes shallow slopes look stepped, lowering
 * it makes near-horizontal edges wobble between two glyphs.
 */
export const HORIZONTAL_THRESHOLD = 0.87;

/** How vertical a stroke must read before it is drawn as `│`. cos(71°) ≈ 0.32. */
export const VERTICAL_THRESHOLD = 0.32;

/**
 * The cell's height divided by its width, when nobody says otherwise.
 *
 * **This is an assumption, not a constant of nature**, and it was written as a constant
 * once. `studio/renderer/fonts.ts` carries the real advance width per font, read out of
 * the font file: GNU Unifont and Iosevka are 0.5 em — a 1:2 cell, so 2.0 — while
 * JetBrains Mono and IBM Plex Mono are 0.6 em, which is 1.667. Half the registered fonts
 * disagree with this default, and on them a hardcoded 2.0 draws slopes between roughly
 * `dy/dx` 0.283 and 0.340 as `─` where the geometry says `╲`.
 *
 * 2.0 stays the default because it is right for the default font and because changing it
 * would move every existing picture. `src/` cannot read the font registry — the
 * dependency arrow points `studio/ → src/` and never back (docs/studio.md §2) — so the
 * real ratio arrives as an argument from whoever knows it.
 */
export const DEFAULT_CELL_ASPECT = 2.0;

/**
 * A cell aspect has to be a positive finite number.
 *
 * Exported because the host should be told at construction, not on the first primitive
 * that happens to need the number: a scene drawing no strokes would otherwise accept an
 * impossible cell shape in silence and only fail once someone added a diagonal.
 *
 * Rejected rather than clamped, and this is the opposite choice from the one `dx`/`dy`
 * get below — deliberately. A degenerate direction is ordinary DATA: a path that repeats
 * a point is a normal thing for a program to produce, so it gets a documented convention
 * instead of a crash. An impossible cell shape is CONFIGURATION: somebody stated how tall
 * a character is and stated something that cannot be true. Zero would flatten every
 * stroke to horizontal and a negative would mirror every diagonal — both are pictures
 * that look deliberate while being wrong, which is the §15 I3 failure this project
 * refuses to ship.
 */
export function assertCellAspect(cellAspect: number): void {
  if (!Number.isFinite(cellAspect) || cellAspect <= 0) {
    throw new Error(
      `cell aspect must be a positive finite number, got ${cellAspect}`,
    );
  }
}

/**
 * The glyph that best carries the direction `(dx, dy)`.
 *
 * **The aspect correction is the whole subtlety.** A cell is taller than it is wide, so a
 * stroke moving one cell right and one cell down is not at 45° on screen — at the usual
 * 1:2 it is at about 63°. Scaling dy by `cellAspect` measures the angle in the shape the
 * reader actually sees rather than in grid indices.
 *
 * `cellAspect` is the cell's height divided by its width, and it defaults to
 * {@link DEFAULT_CELL_ASPECT}. Pass the real one when it is known — see that constant for
 * why half the project's registered fonts disagree with the default.
 *
 * Screen `y` grows downward, which is why right-and-down is the FALLING glyph.
 *
 * `(0, 0)` has no direction and returns the horizontal glyph, following `atan2(0, 0)`'s
 * own convention. Throwing would force a guard into every loop that walks a path and
 * meets a repeated point; this is documented instead of silent (§11.16).
 */
export function strokeGlyph(
  dx: number,
  dy: number,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): string {
  assertCellAspect(cellAspect);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return STROKE_HORIZONTAL;
  }
  // The cell's real shape, corrected: the angle is taken in what the reader sees.
  const angle = Math.atan2(dy * cellAspect, dx);
  const c = Math.abs(Math.cos(angle));
  if (c > HORIZONTAL_THRESHOLD) {
    return STROKE_HORIZONTAL;
  }
  if (c < VERTICAL_THRESHOLD) {
    return STROKE_VERTICAL;
  }
  return dx * dy > 0 ? STROKE_FALLING : STROKE_RISING;
}

/**
 * The glyph for an EDGE from the image gradient at that point.
 *
 * A gradient points across an edge, so the edge runs perpendicular to it: rotating by
 * 90° is `(-gy, gx)`. Getting this backwards draws every edge at right angles to where
 * it is, which looks like a bug in the sampling rather than in one sign.
 *
 * `cellAspect` is passed straight through, and it matters more here than anywhere else:
 * an image converter writes these glyphs into an ASSET. A wrong aspect at draw time is a
 * setting somebody can change later; a wrong aspect at conversion time is baked into the
 * art and only a reconversion removes it.
 */
export function edgeGlyph(
  gx: number,
  gy: number,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): string {
  return strokeGlyph(-gy, gx, cellAspect);
}

/**
 * Sobel gradient at `(x, y)` of a single-channel grid.
 *
 * Offline only (docs/engine.md §11.16): this exists for the sprite-generation path,
 * where a pixel grid genuinely exists. At run time the engine has no pixel source, and
 * a native that pretended otherwise would be inventing its input.
 *
 * Out-of-range samples clamp to the edge pixel rather than reading zero, so the border
 * of an image does not grow an edge that is not in it.
 */
export function sobelAt(
  values: readonly number[],
  width: number,
  height: number,
  x: number,
  y: number,
): { gx: number; gy: number } {
  const at = (sx: number, sy: number): number => {
    const cx = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
    const cy = sy < 0 ? 0 : sy >= height ? height - 1 : sy;
    return values[cy * width + cx] ?? 0;
  };
  const tl = at(x - 1, y - 1), tc = at(x, y - 1), tr = at(x + 1, y - 1);
  const ml = at(x - 1, y), mr = at(x + 1, y);
  const bl = at(x - 1, y + 1), bc = at(x, y + 1), br = at(x + 1, y + 1);
  return {
    gx: (tr + 2 * mr + br) - (tl + 2 * ml + bl),
    gy: (bl + 2 * bc + br) - (tl + 2 * tc + tr),
  };
}
