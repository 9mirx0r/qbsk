// Converting a source image into a glyph grid (docs/engine.md §11.17).
import { describe, expect, it } from "vitest";
import { convertImage, fidelity, type SourceImage } from "../../src/tools/imageToGrid.js";
import { DENSITY_RAMP } from "../../src/engine/ramp.js";
import {
  STROKE_FALLING,
  STROKE_HORIZONTAL,
  STROKE_RISING,
  STROKE_VERTICAL,
} from "../../src/engine/stroke.js";

/** A grey image whose per-pixel value `f(x, y)` is known before it is converted. */
function image(width: number, height: number, f: (x: number, y: number) => number): SourceImage {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y) * 255)));
      const at = (y * width + x) * 3;
      pixels[at] = v;
      pixels[at + 1] = v;
      pixels[at + 2] = v;
    }
  }
  return { pixels, width, height, channels: 3 };
}

/** Coverage table for the default ramp: bucket k of n covers k/(n-1). */
const RAMP_COVERAGE = new Map(
  [...DENSITY_RAMP].map((g, i) => [g, i / (DENSITY_RAMP.length - 1)]),
);

describe("downsampling maps a cell's mean luminance to a glyph", () => {
  it("turns a horizontal gradient into the ramp, left to right", () => {
    const grid = convertImage(image(200, 40, (x) => x / 199), { cols: 20, rows: 4 });
    expect(grid.lines).toHaveLength(4);
    for (const line of grid.lines) {
      expect(line).toHaveLength(20);
      // Monotonic: no cell is lighter than the one to its left.
      const ranks = [...line].map((g) => DENSITY_RAMP.indexOf(g));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
    expect(grid.lines[0]![0]).toBe(DENSITY_RAMP[0]);
    expect(grid.lines[0]!.at(-1)).toBe(DENSITY_RAMP.at(-1));
  });

  it("keeps an intensity per cell, so a scene can modulate the light later", () => {
    // The layered-output decision: the asset carries the number the glyph came from,
    // not only the glyph. A torch that flickers needs the number.
    const grid = convertImage(image(20, 20, () => 0.5), { cols: 4, rows: 4 });
    expect(grid.intensity).toHaveLength(16);
    for (const v of grid.intensity) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a colour per cell, because the source art has more than one light", () => {
    const width = 4, height = 2;
    const pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      pixels[i * 3] = 200;      // amber-ish: strong red
      pixels[i * 3 + 1] = 120;
      pixels[i * 3 + 2] = 20;
    }
    const grid = convertImage({ pixels, width, height, channels: 3 }, { cols: 2, rows: 1 });
    expect(grid.colors).toHaveLength(2);
    for (const packed of grid.colors) {
      expect((packed >> 16) & 255).toBe(200);
      expect((packed >> 8) & 255).toBe(120);
      expect(packed & 255).toBe(20);
    }
  });

  it("reads transparency as absence of ink rather than as black", () => {
    const width = 2, height = 2;
    const opaque = new Uint8Array(width * height * 4);
    const clear = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      opaque[i * 4] = 255; opaque[i * 4 + 1] = 255; opaque[i * 4 + 2] = 255; opaque[i * 4 + 3] = 255;
      clear[i * 4] = 255; clear[i * 4 + 1] = 255; clear[i * 4 + 2] = 255; clear[i * 4 + 3] = 0;
    }
    const lit = convertImage({ pixels: opaque, width, height, channels: 4 }, { cols: 1, rows: 1 });
    const gone = convertImage({ pixels: clear, width, height, channels: 4 }, { cols: 1, rows: 1 });
    expect(lit.intensity[0]).toBeCloseTo(1, 5);
    expect(gone.intensity[0]).toBeCloseTo(0, 5);
  });

  it("distributes a size that does not divide evenly instead of dropping a column", () => {
    const grid = convertImage(image(10, 10, () => 0.5), { cols: 3, rows: 3 });
    expect(grid.lines.every((l) => l.length === 3)).toBe(true);
  });

  it("reports a request for more cells than the image has pixels", () => {
    expect(() => convertImage(image(4, 4, () => 0), { cols: 8, rows: 2 }))
      .toThrow(/8 columns.*4px/);
  });
});

describe("tone mapping, which the spike measured as the largest lever", () => {
  // On the reference art a raw mapping left 78.9% of cells blank because the image
  // never rises above 0.77 and averages 0.068. Stretching the range and bending it
  // moved that to 10.6%. This is a first-class control, not a flag nobody sets.
  const dark = image(100, 20, (x) => (x / 99) * 0.2);

  it("leaves the source range alone by default", () => {
    const grid = convertImage(dark, { cols: 10, rows: 2 });
    expect(Math.max(...grid.intensity)).toBeLessThan(0.25);
  });

  it("stretches the measured range to the ends of the ramp when asked", () => {
    const grid = convertImage(dark, { cols: 10, rows: 2, normalise: true });
    expect(Math.min(...grid.intensity)).toBeCloseTo(0, 5);
    expect(Math.max(...grid.intensity)).toBeCloseTo(1, 5);
  });

  it("lifts the shadows with gamma below 1 and crushes them above", () => {
    const lifted = convertImage(dark, { cols: 10, rows: 2, normalise: true, gamma: 0.5 });
    const crushed = convertImage(dark, { cols: 10, rows: 2, normalise: true, gamma: 2.0 });
    const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(mean(lifted.intensity)).toBeGreaterThan(mean(crushed.intensity));
  });

  it("does not divide by zero on a flat image", () => {
    const grid = convertImage(image(8, 8, () => 0.4), { cols: 2, rows: 2, normalise: true });
    expect(grid.intensity.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("rejects a gamma that is not a positive finite number", () => {
    for (const bad of [0, -1, NaN]) {
      expect(() => convertImage(dark, { cols: 4, rows: 2, gamma: bad })).toThrow(/gamma/);
    }
  });
});

describe("the edge pass, which is where a wrong cell aspect gets baked in", () => {
  it("leaves a flat region flat instead of speckling it with edges", () => {
    // Criterion 3, first half. An edge pass that fires on noise turns an unlit wall
    // into gravel, which is the failure §11.16 exists to avoid.
    const grid = convertImage(image(40, 40, () => 0.5), {
      cols: 10, rows: 10, edgeThreshold: 0.1,
    });
    const glyphs = new Set(grid.lines.join("").split(""));
    expect(glyphs.size).toBe(1);
  });

  // Criterion 3, second half. The gradient points ACROSS an edge, so the 90-degree
  // rotation in edgeGlyph is where this is wrong if it is going to be.
  //
  // A 45-degree edge CANNOT test that rotation. Mutation-tested here: inverting the
  // rotation to strokeGlyph(-gx, gy) still returns the falling glyph for a symmetric
  // diagonal, so the whole suite passed against a broken converter. The discriminating
  // cases are the axis-aligned ones, where a wrong rotation turns a wall into a floor.
  it("draws a horizontal edge along itself, not across itself", () => {
    const grid = convertImage(image(80, 80, (_x, y) => (y >= 40 ? 1 : 0)), {
      cols: 20, rows: 20, edgeThreshold: 0.3, cellAspect: 1.0,
    });
    const drawn = grid.lines.join("");
    expect(drawn).toContain(STROKE_HORIZONTAL);
    expect(drawn).not.toContain(STROKE_VERTICAL);
  });

  it("draws a vertical edge along itself too", () => {
    const grid = convertImage(image(80, 80, (x) => (x >= 40 ? 1 : 0)), {
      cols: 20, rows: 20, edgeThreshold: 0.3, cellAspect: 1.0,
    });
    const drawn = grid.lines.join("");
    expect(drawn).toContain(STROKE_VERTICAL);
    expect(drawn).not.toContain(STROKE_HORIZONTAL);
  });

  it("draws a diagonal edge with the diagonal that lies along it", () => {
    const falling = convertImage(image(80, 80, (x, y) => (y >= x ? 1 : 0)), {
      cols: 20, rows: 20, edgeThreshold: 0.3, cellAspect: 1.0,
    });
    expect(falling.lines.join("")).toContain(STROKE_FALLING);

    const rising = convertImage(image(80, 80, (x, y) => (x + y >= 80 ? 1 : 0)), {
      cols: 20, rows: 20, edgeThreshold: 0.3, cellAspect: 1.0,
    });
    expect(rising.lines.join("")).toContain(STROKE_RISING);
  });

  it("takes the cell aspect, because the answer is written into the asset", () => {
    // 10 across and 3 down at a 1:2 cell is a diagonal; at 1:1.667 it is a horizontal.
    // A converter that hardcoded the aspect would bake one of those into the art.
    const src = image(100, 30, (x, y) => (y * (100 / 30) >= x ? 1 : 0));
    const narrow = convertImage(src, { cols: 25, rows: 25, edgeThreshold: 0.3, cellAspect: 2.0 });
    const wide = convertImage(src, { cols: 25, rows: 25, edgeThreshold: 0.3, cellAspect: 1 / 0.6 });
    expect(narrow.lines.join("")).not.toBe(wide.lines.join(""));
  });

  it("skips the edge pass entirely when no threshold is given", () => {
    const grid = convertImage(image(80, 80, (x, y) => (y >= x ? 1 : 0)), { cols: 20, rows: 20 });
    for (const g of [STROKE_FALLING, STROKE_RISING]) {
      expect(grid.lines.join("")).not.toContain(g);
    }
  });
});

describe("fidelity scores order, not levels", () => {
  // Criterion 1, adjusted. The first version of this measured mean absolute luminance
  // error and ranked the unreadable conversion above the readable one on the project's
  // own reference art -- 3.27% for raw against 6.97% for tone-mapped, on an image so
  // dark that blanks reproduce it almost perfectly. A tone curve is a monotonic remap,
  // so what has to survive is the ORDER of light.

  it("scores a faithful gradient near 1", () => {
    const grid = convertImage(image(200, 20, (x) => x / 199), { cols: 10, rows: 2 });
    expect(fidelity(grid, RAMP_COVERAGE)).toBeGreaterThan(0.98);
  });

  it("is blind to the tone curve, which is the whole point of the change", () => {
    const dark = image(200, 20, (x) => (x / 199) * 0.2);
    const raw = fidelity(convertImage(dark, { cols: 10, rows: 2 }), RAMP_COVERAGE);
    const toned = fidelity(
      convertImage(dark, { cols: 10, rows: 2, normalise: true, gamma: 0.6 }),
      RAMP_COVERAGE,
    );
    // Both preserve the ordering, so neither is punished for the author's exposure
    // choice. The old metric called these 3.15% and 6.97% and preferred the dark one.
    expect(toned).toBeGreaterThan(0.9);
    expect(Math.abs(toned - raw)).toBeLessThan(0.15);
  });

  it("drops when the ramp cannot carry the ordering", () => {
    const src = image(200, 20, (x) => x / 199);
    const full = fidelity(convertImage(src, { cols: 10, rows: 2 }), RAMP_COVERAGE);
    const twoStep = fidelity(
      convertImage(src, { cols: 10, rows: 2, ramp: " @" }),
      RAMP_COVERAGE,
    );
    expect(twoStep).toBeLessThan(full);
  });

  it("reports no information rather than a perfect score on a flat image", () => {
    // Every cell equal means there is no ordering to preserve. Returning 1 would claim
    // a perfect reproduction of nothing.
    const grid = convertImage(image(40, 40, () => 0.5), { cols: 8, rows: 8 });
    expect(fidelity(grid, RAMP_COVERAGE)).toBe(0);
  });

  it("stays within [-1, 1]", () => {
    const grid = convertImage(image(120, 60, (x, y) => ((x * 7 + y * 13) % 97) / 96), {
      cols: 30, rows: 15,
    });
    const score = fidelity(grid, RAMP_COVERAGE);
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("the conversion is deterministic", () => {
  it("gives byte-identical output for the same input and options", () => {
    const src = image(120, 60, (x, y) => ((x * 7 + y * 13) % 97) / 96);
    const opts = { cols: 30, rows: 15, normalise: true, gamma: 0.6, edgeThreshold: 0.4 };
    const a = convertImage(src, opts);
    const b = convertImage(src, opts);
    expect(a.lines.join("\n")).toBe(b.lines.join("\n"));
    expect([...a.intensity]).toEqual([...b.intensity]);
    expect([...a.sourceIntensity]).toEqual([...b.sourceIntensity]);
    expect([...a.colors]).toEqual([...b.colors]);
  });
});
