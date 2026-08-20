// Measuring ink coverage from a rendered glyph strip (docs/engine.md §11.15).
//
// The engine's default ramp is hand-written — the exact thing the ASCII brief warns
// against, because "does `%` cover more than `#`?" is a question about a font, not an
// opinion. This module answers it by measuring: given a strip of glyphs rendered into
// an image, one glyph per equal-width cell, it reports how much of each cell is ink.
//
// It is offline tooling, like spriteGen and pngDecode beside it, and it is pure: pixels
// in, numbers out. No file reading, no PNG decoding, no ramp assembly — the caller owns
// all three, which is what makes the measurement testable against a synthetic strip
// whose coverage is known in advance.

/** One glyph's measured share of ink, in [0, 1]. */
export interface GlyphCoverage {
  glyph: string;
  /** 0 = the cell is entirely background, 1 = entirely ink. */
  coverage: number;
}

export interface MeasureOptions {
  /** Flat pixel bytes, row-major, top to bottom — `DecodedPng.pixels`. */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA, matching `DecodedPng.channels`. */
  channels: 3 | 4;
  /** The glyphs the strip renders, left to right, one per cell. */
  glyphs: string;
  /**
   * Treat ink as dark-on-light (the default) or light-on-dark.
   *
   * Guessing from the image would be one more thing to get silently wrong on a strip
   * that happens to be mostly ink, so the caller says which.
   */
  inkIsDark?: boolean;
}

/**
 * Measures each glyph's ink coverage.
 *
 * Coverage is the mean ink intensity over the cell, not a count of "on" pixels: a
 * rendered glyph is antialiased, and a hard threshold would throw away exactly the
 * partial pixels that distinguish `.` from `,`. Alpha multiplies in, so a strip
 * rendered onto transparency measures the same as one rendered onto white.
 *
 * Cell boundaries are computed by exact division rather than accumulated addition, so
 * a strip whose width is not a multiple of the glyph count distributes the remainder
 * instead of dropping it off the right edge.
 */
export function measureCoverage(options: MeasureOptions): GlyphCoverage[] {
  const { pixels, width, height, channels, glyphs } = options;
  const inkIsDark = options.inkIsDark ?? true;
  const count = [...glyphs].length;
  if (count === 0) {
    return [];
  }
  if (width < count) {
    throw new Error(
      `the strip is ${width}px wide but names ${count} glyphs — one column cannot hold a glyph`,
    );
  }

  const chars = [...glyphs];
  const result: GlyphCoverage[] = [];
  for (let i = 0; i < count; i += 1) {
    const x0 = Math.round((i * width) / count);
    const x1 = Math.round(((i + 1) * width) / count);
    let total = 0;
    let samples = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * channels;
        const r = pixels[at]!;
        const g = pixels[at + 1]!;
        const b = pixels[at + 2]!;
        // Rec. 601 luma: the eye weights green far above blue, and an unweighted mean
        // would call a blue glyph lighter than a green one of the same ink.
        const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const alpha = channels === 4 ? pixels[at + 3]! / 255 : 1;
        const ink = (inkIsDark ? 1 - luma : luma) * alpha;
        total += ink;
        samples += 1;
      }
    }
    result.push({
      glyph: chars[i]!,
      coverage: samples === 0 ? 0 : total / samples,
    });
  }
  return result;
}

/**
 * Rescales coverages so the lightest glyph reads 0 and the heaviest 1.
 *
 * A strip rendered on grey, or one whose lightest glyph is not a space, would otherwise
 * produce a ramp that never reaches either end. Normalising is separate from measuring
 * on purpose: the raw numbers are what a person checks the measurement against, and the
 * normalised ones are what the ramp is built from.
 */
export function normalise(entries: readonly GlyphCoverage[]): GlyphCoverage[] {
  if (entries.length === 0) {
    return [];
  }
  let min = Infinity;
  let max = -Infinity;
  for (const entry of entries) {
    if (entry.coverage < min) min = entry.coverage;
    if (entry.coverage > max) max = entry.coverage;
  }
  const span = max - min;
  return entries.map((entry) => ({
    glyph: entry.glyph,
    // A flat strip — every glyph identical — normalises to 0 rather than dividing by
    // zero. A ramp of one repeated density is useless, but it is not a crash, and the
    // caller can see it in the raw numbers.
    coverage: span === 0 ? 0 : (entry.coverage - min) / span,
  }));
}

/**
 * Finds the two marker cells framing a strip, by looking for near-solid columns.
 *
 * Slicing by equal division needs the image to begin at the left edge of the first cell
 * and end at the right edge of the last, which is more than a screenshot tool will give
 * you. The way out is a **full block `█` at each end**: it fills its cell completely, so
 * its columns are the only ones whose ink runs the whole height. Trimming to plain ink
 * bounds is not enough — a shell that echoes the surrounding quotes puts inked glyphs
 * OUTSIDE the frame, and those quotes ink only a sliver of their cell, so the bounds
 * would land mid-cell and misalign every glyph after it.
 *
 * Returns the inclusive column range **between** the markers, or `null` if fewer than
 * two marker runs are found.
 */
export function markerBounds(options: {
  pixels: Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
  rows?: { y0: number; y1: number };
  inkIsDark?: boolean;
  /** Mean ink over the cell height above which a column counts as solid. */
  threshold?: number;
}): { x0: number; x1: number } | null {
  const { pixels, width, channels } = options;
  const inkIsDark = options.inkIsDark ?? true;
  const threshold = options.threshold ?? 0.55;
  const y0 = options.rows?.y0 ?? 0;
  const y1 = options.rows?.y1 ?? options.height - 1;

  const solid: boolean[] = [];
  for (let x = 0; x < width; x += 1) {
    let total = 0;
    for (let y = y0; y <= y1; y += 1) {
      const at = (y * width + x) * channels;
      const luma = (0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!) / 255;
      const alpha = channels === 4 ? pixels[at + 3]! / 255 : 1;
      total += (inkIsDark ? 1 - luma : luma) * alpha;
    }
    solid.push(total / (y1 - y0 + 1) >= threshold);
  }

  const runs: { start: number; end: number }[] = [];
  let start = -1;
  solid.forEach((isSolid, x) => {
    if (isSolid && start === -1) start = x;
    if (!isSolid && start !== -1) {
      runs.push({ start, end: x - 1 });
      start = -1;
    }
  });
  if (start !== -1) runs.push({ start, end: solid.length - 1 });

  if (runs.length < 2) {
    return null;
  }
  const first = runs[0]!;
  const last = runs[runs.length - 1]!;
  return { x0: first.end + 1, x1: last.start - 1 };
}

/** Restricts a strip to a band of rows — one line of a multi-line screenshot. */
export function cropRows(
  options: { pixels: Uint8Array; width: number; height: number; channels: 3 | 4 },
  y0: number,
  y1: number,
): { pixels: Uint8Array; width: number; height: number; channels: 3 | 4 } {
  const { pixels, width, channels } = options;
  const h = y1 - y0 + 1;
  const out = new Uint8Array(width * h * channels);
  for (let y = 0; y < h; y += 1) {
    const from = ((y0 + y) * width) * channels;
    out.set(pixels.subarray(from, from + width * channels), y * width * channels);
  }
  return { pixels: out, width, height: h, channels };
}

/** Extracts a sub-range of columns as a strip of its own. */
export function cropColumns(
  options: { pixels: Uint8Array; width: number; height: number; channels: 3 | 4 },
  x0: number,
  x1: number,
): { pixels: Uint8Array; width: number; height: number; channels: 3 | 4 } {
  const { pixels, width, height, channels } = options;
  const w = x1 - x0 + 1;
  const out = new Uint8Array(w * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = (y * width + (x0 + x)) * channels;
      const to = (y * w + x) * channels;
      for (let c = 0; c < channels; c += 1) out[to + c] = pixels[from + c]!;
    }
  }
  return { pixels: out, width: w, height, channels };
}
