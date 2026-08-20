// Measuring ink coverage from a glyph strip (docs/engine.md §11.15).
import { describe, expect, it } from "vitest";
import { measureCoverage, normalise } from "../../src/tools/rampMeasure.js";
import { DENSITY_RAMP, rampFromTable } from "../../src/engine/ramp.js";

/**
 * Builds a strip whose coverage is known before it is measured.
 *
 * `fills` gives each cell's ink fraction: 0 leaves it white, 1 paints it black, 0.5
 * paints the top half. This is the synthetic set the stage's second criterion asks for
 * — the pipeline is checked against numbers arithmetic already knows, so a measurement
 * that agrees is measuring what it claims rather than agreeing with a guess.
 */
function strip(fills: number[], cellWidth = 8, height = 8, channels: 3 | 4 = 3) {
  const width = fills.length * cellWidth;
  const pixels = new Uint8Array(width * height * channels).fill(255);
  if (channels === 4) {
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  }
  fills.forEach((fill, cell) => {
    const inkRows = Math.round(fill * height);
    for (let y = 0; y < inkRows; y += 1) {
      for (let x = cell * cellWidth; x < (cell + 1) * cellWidth; x += 1) {
        const at = (y * width + x) * channels;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
      }
    }
  });
  return { pixels, width, height, channels };
}

describe("the measurement is checked against coverage arithmetic already knows", () => {
  it("reads all-ink as 1, half-ink as 0.5 and no-ink as 0", () => {
    const measured = measureCoverage({
      ...strip([0, 0.5, 1]),
      glyphs: "abc",
    });
    expect(measured.map((m) => m.glyph)).toEqual(["a", "b", "c"]);
    expect(measured[0]!.coverage).toBeCloseTo(0, 5);
    expect(measured[1]!.coverage).toBeCloseTo(0.5, 5);
    expect(measured[2]!.coverage).toBeCloseTo(1, 5);
  });

  it("measures the same on transparency as on white", () => {
    const rgb = measureCoverage({ ...strip([0.25, 0.75], 8, 8, 3), glyphs: "ab" });
    const rgba = measureCoverage({ ...strip([0.25, 0.75], 8, 8, 4), glyphs: "ab" });
    expect(rgba[0]!.coverage).toBeCloseTo(rgb[0]!.coverage, 5);
    expect(rgba[1]!.coverage).toBeCloseTo(rgb[1]!.coverage, 5);
  });

  it("counts antialiasing instead of thresholding it away", () => {
    // A cell of mid-grey is half ink. A hard threshold would call it all or nothing,
    // and would lose exactly the partial pixels that separate '.' from ','.
    const width = 4, height = 4;
    const pixels = new Uint8Array(width * height * 3).fill(128);
    const measured = measureCoverage({ pixels, width, height, channels: 3, glyphs: "x" });
    expect(measured[0]!.coverage).toBeCloseTo(1 - 128 / 255, 3);
  });

  it("reads light-on-dark when told to", () => {
    const width = 2, height = 2;
    const pixels = new Uint8Array(width * height * 3).fill(0);
    const dark = measureCoverage({ pixels, width, height, channels: 3, glyphs: "x" });
    const light = measureCoverage({
      pixels, width, height, channels: 3, glyphs: "x", inkIsDark: false,
    });
    expect(dark[0]!.coverage).toBeCloseTo(1, 5);
    expect(light[0]!.coverage).toBeCloseTo(0, 5);
  });

  it("distributes a width that does not divide evenly, rather than dropping a column", () => {
    // 10 px across 3 glyphs: the cells cannot be equal, and the last one must still
    // reach the right edge.
    const width = 10, height = 2;
    const pixels = new Uint8Array(width * height * 3).fill(255);
    for (let y = 0; y < height; y += 1) {
      const at = (y * width + (width - 1)) * 3;
      pixels[at] = 0; pixels[at + 1] = 0; pixels[at + 2] = 0;
    }
    const measured = measureCoverage({ pixels, width, height, channels: 3, glyphs: "abc" });
    expect(measured[2]!.coverage).toBeGreaterThan(0);
    expect(measured[0]!.coverage).toBe(0);
  });

  it("reports a strip too narrow to hold its glyphs", () => {
    expect(() => measureCoverage({
      pixels: new Uint8Array(3 * 1 * 3), width: 3, height: 1, channels: 3, glyphs: "abcd",
    })).toThrow(/3px wide but names 4/);
  });
});

describe("normalising stretches the measurement to the ends of the ramp", () => {
  it("puts the lightest at 0 and the heaviest at 1", () => {
    const out = normalise([
      { glyph: "a", coverage: 0.2 },
      { glyph: "b", coverage: 0.4 },
      { glyph: "c", coverage: 0.6 },
    ]);
    expect(out[0]!.coverage).toBeCloseTo(0, 5);
    expect(out[1]!.coverage).toBeCloseTo(0.5, 5);
    expect(out[2]!.coverage).toBeCloseTo(1, 5);
  });

  it("does not divide by zero on a flat strip", () => {
    const out = normalise([
      { glyph: "a", coverage: 0.3 },
      { glyph: "b", coverage: 0.3 },
    ]);
    expect(out.every((e) => e.coverage === 0)).toBe(true);
  });
});

describe("the table becomes a ramp", () => {
  it("orders sparse to dense", () => {
    expect(rampFromTable([
      { glyph: "@", coverage: 0.9 },
      { glyph: " ", coverage: 0.0 },
      { glyph: "-", coverage: 0.3 },
    ])).toBe(" -@");
  });

  it("keeps ties in the order they were measured", () => {
    expect(rampFromTable([
      { glyph: "b", coverage: 0.5 },
      { glyph: "a", coverage: 0.5 },
    ])).toBe("ba");
  });

  // Two glyphs of equal density waste a bucket, but dropping one would make the
  // emitted table disagree with the measurement it came from — and agreement between
  // the table and the font is the entire point of measuring.
  it("keeps duplicates rather than collapsing them", () => {
    expect(rampFromTable([
      { glyph: "a", coverage: 0.5 },
      { glyph: "b", coverage: 0.5 },
    ])).toHaveLength(2);
  });

  it("round-trips a synthetic strip into a ramp in the right order", () => {
    const measured = measureCoverage({ ...strip([1, 0, 0.5]), glyphs: "@ -" });
    expect(rampFromTable(normalise(measured))).toBe(" -@");
  });

  it("leaves the hardcoded default alone", () => {
    // Criterion 4: the measured ramp is an addition, never a replacement.
    expect(DENSITY_RAMP).toBe(" .:-=+*#%@");
  });
});
