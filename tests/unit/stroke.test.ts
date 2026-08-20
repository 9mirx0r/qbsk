// Orientation glyphs (docs/engine.md §11.16).
import { describe, expect, it } from "vitest";
import {
  edgeGlyph,
  HORIZONTAL_THRESHOLD,
  sobelAt,
  STROKE_FALLING,
  STROKE_HORIZONTAL,
  STROKE_RISING,
  STROKE_VERTICAL,
  strokeGlyph,
  VERTICAL_THRESHOLD,
} from "../../src/engine/stroke.js";

describe("the angle rule, at its boundaries", () => {
  it("a flat stroke is horizontal, either way along", () => {
    expect(strokeGlyph(1, 0)).toBe(STROKE_HORIZONTAL);
    expect(strokeGlyph(-1, 0)).toBe(STROKE_HORIZONTAL);
    expect(strokeGlyph(10, 0)).toBe(STROKE_HORIZONTAL);
  });

  it("a plumb stroke is vertical, either way along", () => {
    expect(strokeGlyph(0, 1)).toBe(STROKE_VERTICAL);
    expect(strokeGlyph(0, -1)).toBe(STROKE_VERTICAL);
  });

  // Screen y grows DOWNWARD. Right-and-down falls; right-and-up rises. Getting this
  // backwards mirrors every diagonal in the picture.
  it("the quadrant picks the diagonal, with y growing downward", () => {
    expect(strokeGlyph(1, 1)).toBe(STROKE_FALLING);
    expect(strokeGlyph(-1, -1)).toBe(STROKE_FALLING);
    expect(strokeGlyph(1, -1)).toBe(STROKE_RISING);
    expect(strokeGlyph(-1, 1)).toBe(STROKE_RISING);
  });

  it("crosses at the documented thresholds and not somewhere else", () => {
    // Build directions whose corrected |cos| sits either side of each threshold, then
    // check the glyph flips exactly there.
    const glyphFor = (c: number) => {
      // c = |cos(angle)| with angle = atan2(dy*2, dx): pick dx = c, dy*2 = sqrt(1-c^2).
      const dx = c;
      const dy = Math.sqrt(Math.max(0, 1 - c * c)) / 2;
      return strokeGlyph(dx, dy);
    };
    expect(glyphFor(HORIZONTAL_THRESHOLD + 0.01)).toBe(STROKE_HORIZONTAL);
    expect(glyphFor(HORIZONTAL_THRESHOLD - 0.01)).toBe(STROKE_FALLING);
    expect(glyphFor(VERTICAL_THRESHOLD + 0.01)).toBe(STROKE_FALLING);
    expect(glyphFor(VERTICAL_THRESHOLD - 0.01)).toBe(STROKE_VERTICAL);
  });

  it("a zero vector has no direction, and says so by convention rather than throwing", () => {
    expect(strokeGlyph(0, 0)).toBe(STROKE_HORIZONTAL);
  });

  it("a non-finite direction does not produce NaN glyphs", () => {
    expect(strokeGlyph(Infinity, 1)).toBe(STROKE_HORIZONTAL);
    expect(strokeGlyph(1, NaN)).toBe(STROKE_HORIZONTAL);
  });
});

describe("the 1:2 aspect correction earns its place", () => {
  // The correction looks free on a one-by-one step, which comes out diagonal with or
  // without it. It stops looking free here: two cells across and one down is 45° ON
  // SCREEN, so it must be diagonal — and it only is because dy was doubled.
  it("two across and one down is a real 45 degrees, so it is diagonal", () => {
    expect(strokeGlyph(2, 1)).toBe(STROKE_FALLING);
  });

  it("without the correction that same step would read as horizontal", () => {
    // The uncorrected angle, computed here so the claim in §11.16 is checked rather
    // than asserted: |cos(atan2(1, 2))| ≈ 0.894, which is over the horizontal
    // threshold and would have come back as a flat line.
    const uncorrected = Math.abs(Math.cos(Math.atan2(1, 2)));
    expect(uncorrected).toBeGreaterThan(HORIZONTAL_THRESHOLD);

    const corrected = Math.abs(Math.cos(Math.atan2(1 * 2, 2)));
    expect(corrected).toBeLessThan(HORIZONTAL_THRESHOLD);
  });

  it("one across and one down stays diagonal, correction or not", () => {
    // The case that hides the bug, pinned so nobody 'simplifies' the correction away
    // on the strength of it.
    expect(strokeGlyph(1, 1)).toBe(STROKE_FALLING);
    expect(Math.abs(Math.cos(Math.atan2(1, 1)))).toBeLessThan(HORIZONTAL_THRESHOLD);
  });

  it("one across and four down is steep enough to be vertical", () => {
    expect(strokeGlyph(1, 4)).toBe(STROKE_VERTICAL);
  });
});

describe("Sobel finds an edge, and the glyph runs along it", () => {
  /** A grid split by a straight edge: `inside(x, y)` decides which side is ink. */
  const grid = (w: number, h: number, inside: (x: number, y: number) => boolean) =>
    Array.from({ length: w * h }, (_, i) => (inside(i % w, Math.floor(i / w)) ? 1 : 0));

  it("a horizontal edge has a vertical gradient", () => {
    const g = sobelAt(grid(5, 5, (_x, y) => y >= 3), 5, 5, 2, 2);
    expect(g.gx).toBe(0);
    expect(g.gy).toBeGreaterThan(0);
  });

  it("a vertical edge has a horizontal gradient", () => {
    const g = sobelAt(grid(5, 5, (x) => x >= 3), 5, 5, 2, 2);
    expect(g.gy).toBe(0);
    expect(g.gx).toBeGreaterThan(0);
  });

  // Criterion 4 of the stage: a known diagonal edge must yield the glyph that runs
  // ALONG it, not across it. The gradient points across an edge, so the rotation is
  // where this gets inverted if it is going to be.
  it("a diagonal edge yields the glyph that lies along it", () => {
    const falling = sobelAt(grid(7, 7, (x, y) => y >= x), 7, 7, 3, 3);
    expect(edgeGlyph(falling.gx, falling.gy)).toBe(STROKE_FALLING);

    const rising = sobelAt(grid(7, 7, (x, y) => x + y >= 6), 7, 7, 3, 3);
    expect(edgeGlyph(rising.gx, rising.gy)).toBe(STROKE_RISING);
  });

  it("a horizontal edge yields the horizontal glyph", () => {
    const g = sobelAt(grid(5, 5, (_x, y) => y >= 3), 5, 5, 2, 2);
    expect(edgeGlyph(g.gx, g.gy)).toBe(STROKE_HORIZONTAL);
  });

  it("flat ground has no edge and no gradient", () => {
    const g = sobelAt(grid(5, 5, () => true), 5, 5, 2, 2);
    expect(g.gx).toBe(0);
    expect(g.gy).toBe(0);
  });

  it("clamps at the border rather than inventing an edge there", () => {
    // Reading zero outside would make the frame of any solid image look like a rim.
    const g = sobelAt(grid(5, 5, () => true), 5, 5, 0, 0);
    expect(g.gx).toBe(0);
    expect(g.gy).toBe(0);
  });
});

describe("the cell aspect is a parameter, not a constant of nature", () => {
  // A terminal cell is about one wide and two tall — for SOME fonts. The registry in
  // studio/renderer/fonts.ts carries the real advance width per font, read out of the
  // font file: Unifont and Iosevka are 0.5 em (a 1:2 cell, ratio 2.0), while JetBrains
  // Mono and IBM Plex Mono are 0.6 em (ratio 1.667). Hardcoding 2.0 draws every diagonal
  // at the wrong angle on half the registered fonts.
  const WIDE_CELL = 1 / 0.6; // 1.667 — what chPerEm 0.6 actually means

  // The disagreement band, derived rather than guessed: the horizontal threshold is
  // |cos| = 0.87, i.e. 29.54 degrees, i.e. tan = 0.5668. A slope s reads as horizontal
  // when aspect * s < 0.5668, so the two aspects disagree for s between 0.5668/2 = 0.283
  // and 0.5668/1.667 = 0.340.
  const IN_BAND = 0.3;

  it("draws a different glyph inside the disagreement band", () => {
    // This is the defect, demonstrated rather than described. The same geometry, the
    // same code, two fonts the project actually ships — and two different pictures.
    expect(strokeGlyph(1, IN_BAND, 2.0)).toBe(STROKE_FALLING);
    expect(strokeGlyph(1, IN_BAND, WIDE_CELL)).toBe(STROKE_HORIZONTAL);
  });

  it("agrees outside the band, which is why this went unnoticed", () => {
    // Well below: horizontal under both. Well above: diagonal under both. Every example
    // in the repo happens to live out here, which is how a wrong constant survives.
    expect(strokeGlyph(1, 0.1, 2.0)).toBe(strokeGlyph(1, 0.1, WIDE_CELL));
    expect(strokeGlyph(1, 1.0, 2.0)).toBe(strokeGlyph(1, 1.0, WIDE_CELL));
    expect(strokeGlyph(1, 4.0, 2.0)).toBe(strokeGlyph(1, 4.0, WIDE_CELL));
  });

  it("defaults to 2.0, so every existing scene draws exactly what it drew", () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [2, 1], [1, 4], [1, IN_BAND]]) {
      expect(strokeGlyph(dx!, dy!)).toBe(strokeGlyph(dx!, dy!, 2.0));
    }
  });

  it("a square cell makes two-across-one-down read as shallow, not diagonal", () => {
    // aspect 1.0 is a cell as wide as it is tall. The 2:1 step is then a genuinely
    // shallow 26.6 degrees and SHOULD be horizontal — the opposite of the 1:2 answer
    // pinned above. A caller passing its real aspect gets its real geometry.
    expect(strokeGlyph(2, 1, 2.0)).toBe(STROKE_FALLING);
    expect(strokeGlyph(2, 1, 1.0)).toBe(STROKE_HORIZONTAL);
  });

  it("refuses an aspect that is not a positive finite number", () => {
    // Zero would collapse every stroke to horizontal and negative would mirror the
    // diagonals — both are silent wrong pictures (§15 I3), so they are rejected rather
    // than clamped into something that looks deliberate.
    for (const bad of [0, -2, NaN, Infinity]) {
      expect(() => strokeGlyph(1, 1, bad)).toThrow(/cell aspect/);
    }
  });

  it("carries the aspect through to edges, where converted art bakes it in", () => {
    // edgeGlyph rotates the gradient by 90 degrees and then asks the same question, so
    // it must ask it with the same cell shape. An image converter that got this wrong
    // would bake the error into the generated art, where no later setting can fix it.
    const gx = -IN_BAND, gy = 1; // an edge whose direction is (1, IN_BAND)
    expect(edgeGlyph(gx, gy, 2.0)).toBe(STROKE_FALLING);
    expect(edgeGlyph(gx, gy, WIDE_CELL)).toBe(STROKE_HORIZONTAL);
  });
});
