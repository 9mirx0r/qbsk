// Glyph density ramps (docs/engine.md §11.9).
//
// Maps an intensity in [0, 1] to a character. This is the piece that makes a
// character grid read as a lit surface rather than a stencil: with `project()` and
// `depth:` a shape has position and occlusion, and a ramp gives it shading.
//
// It decides a CHARACTER. Colour is `shade`'s job (§11.6), and keeping the two apart
// means a scene can shade a monochrome terminal by glyph alone, or colour without
// touching glyphs, or both.

/**
 * The default ramp, sparse to dense.
 *
 * A space at the lowest step is deliberate: an unlit surface should disappear rather
 * than sit there as a faint dot. A scene that wants a visible floor passes its own
 * ramp starting at '.'.
 */
export const DENSITY_RAMP = " .:-=+*#%@";

/**
 * Picks the glyph for an intensity.
 *
 * Intensity is clamped rather than rejected: shading maths routinely produces small
 * overshoots (a dot product a hair over 1, a falloff a hair under 0), and throwing on
 * those would make every caller clamp defensively before every call.
 *
 * `floor`, not `round`: the ramp's steps are buckets of equal width, so step k covers
 * [k/n, (k+1)/n). Rounding would give the first and last buckets half the width of
 * the others and quietly bias the whole image.
 */
export function rampGlyph(intensity: number, ramp: string = DENSITY_RAMP): string {
  if (ramp.length === 0) {
    return " ";
  }
  if (!Number.isFinite(intensity)) {
    return ramp[0]!;
  }
  const t = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
  const index = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
  return ramp[index]!;
}

/**
 * Intensity from distance: 1 at `near`, 0 at `far`, linear between.
 *
 * The common case for a depth-shaded scene, and worth having rather than open-coding:
 * getting the direction backwards makes distant things bright, which looks like a
 * bug in the geometry rather than in the shading.
 */
export function intensityFromDepth(
  depth: number,
  near: number,
  far: number,
): number {
  if (!Number.isFinite(depth)) {
    return 0;
  }
  if (far <= near) {
    // A degenerate range would divide by zero or invert. Anything at or nearer than
    // `near` is fully lit; everything else is not.
    return depth <= near ? 1 : 0;
  }
  const t = (depth - near) / (far - near);
  return t < 0 ? 1 : t > 1 ? 0 : 1 - t;
}

/**
 * Builds a ramp string from measured coverages (docs/engine.md §11.15).
 *
 * Sorted sparse to dense, which is the order `rampGlyph` indexes. Ties keep the order
 * they were measured in, so a strip listing `-` before `~` at identical coverage yields
 * a stable table rather than one that depends on the sort's internals.
 *
 * **Duplicate coverages are kept, not collapsed.** Two glyphs that measure the same are
 * two buckets the ramp can spend on the same density, which is wasteful but honest; a
 * silent drop would make the emitted table disagree with the measurement it came from,
 * and the whole point of measuring is that the table and the font agree.
 */
export function rampFromTable(entries: readonly { glyph: string; coverage: number }[]): string {
  return entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => (a.coverage - b.coverage) || (a.index - b.index))
    .map((entry) => entry.glyph)
    .join("");
}
