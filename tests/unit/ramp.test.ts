// Glyph density ramps (docs/engine.md §11.9).
import { describe, expect, it } from "vitest";
import {
  DENSITY_RAMP,
  intensityFromDepth,
  rampGlyph,
} from "../../src/engine/ramp.js";
import { runQbsk } from "../../src/interp/interpreter.js";

describe("rampGlyph maps intensity to a character", () => {
  it("0 is the sparsest step and 1 the densest", () => {
    expect(rampGlyph(0)).toBe(DENSITY_RAMP[0]);
    expect(rampGlyph(1)).toBe(DENSITY_RAMP[DENSITY_RAMP.length - 1]);
  });

  it("walks the whole ramp monotonically — every step is reachable", () => {
    // A ramp with unreachable steps is worse than a shorter ramp: the image loses
    // contrast for no benefit.
    const seen = new Set<string>();
    for (let i = 0; i <= 100; i += 1) {
      seen.add(rampGlyph(i / 100));
    }
    expect(seen.size).toBe(DENSITY_RAMP.length);
  });

  // floor, not round: steps are equal-width buckets, so step k covers [k/n,(k+1)/n).
  // Rounding would give the first and last buckets half the width of the others and
  // quietly bias the whole image.
  it("uses equal-width buckets, so the first and last are not half-size", () => {
    const n = DENSITY_RAMP.length;
    expect(rampGlyph(0.5 / n)).toBe(DENSITY_RAMP[0]);
    expect(rampGlyph(1.5 / n)).toBe(DENSITY_RAMP[1]);
  });

  it("clamps rather than throwing, because shading maths overshoots", () => {
    expect(rampGlyph(-0.4)).toBe(DENSITY_RAMP[0]);
    expect(rampGlyph(1.7)).toBe(DENSITY_RAMP[DENSITY_RAMP.length - 1]);
    expect(rampGlyph(NaN)).toBe(DENSITY_RAMP[0]);
  });

  it("never indexes off the end at exactly 1", () => {
    // floor(1 * n) is n, one past the end — the classic off-by-one here.
    expect(rampGlyph(1, "abc")).toBe("c");
    expect(rampGlyph(1, "x")).toBe("x");
  });

  it("takes a custom ramp, including a reversed one", () => {
    expect(rampGlyph(0, "@%#*+=-:. ")).toBe("@");
    expect(rampGlyph(1, "@%#*+=-:. ")).toBe(" ");
  });

  it("an empty ramp yields a space rather than undefined", () => {
    expect(rampGlyph(0.5, "")).toBe(" ");
  });
});

describe("intensityFromDepth", () => {
  it("is 1 at near and 0 at far", () => {
    expect(intensityFromDepth(10, 10, 30)).toBe(1);
    expect(intensityFromDepth(30, 10, 30)).toBe(0);
  });

  it("falls off linearly between them", () => {
    expect(intensityFromDepth(20, 10, 30)).toBeCloseTo(0.5, 6);
  });

  // Getting this backwards makes distant things bright, which reads as a geometry
  // bug rather than a shading one — hence a test that states the direction.
  it("nearer is always brighter", () => {
    expect(intensityFromDepth(12, 10, 30)).toBeGreaterThan(
      intensityFromDepth(25, 10, 30),
    );
  });

  it("clamps outside the range instead of going negative or past 1", () => {
    expect(intensityFromDepth(5, 10, 30)).toBe(1);
    expect(intensityFromDepth(99, 10, 30)).toBe(0);
  });

  it("a degenerate range does not divide by zero", () => {
    expect(intensityFromDepth(10, 20, 20)).toBe(1);
    expect(intensityFromDepth(30, 20, 20)).toBe(0);
    expect(Number.isFinite(intensityFromDepth(30, 20, 10))).toBe(true);
  });

  it("an unprojectable depth is unlit, not NaN", () => {
    expect(intensityFromDepth(Infinity, 10, 30)).toBe(0);
    expect(intensityFromDepth(NaN, 10, 30)).toBe(0);
  });
});

describe("the glyph() and lit() natives", () => {
  it("glyph walks the ramp from QBSK", () => {
    const r = runQbsk(
      'print(glyph(0.0) + glyph(0.5) + glyph(1.0))',
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe(" +@");
  });

  it("glyph takes a custom ramp", () => {
    const r = runQbsk('print(glyph(1.0, "abc"))', "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("c");
  });

  it("an empty ramp reports rather than silently yielding a space", () => {
    const r = runQbsk('print(glyph(0.5, ""))', "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("empty");
  });

  it("a non-string ramp reports with the type it got", () => {
    const r = runQbsk("print(glyph(0.5, 7))", "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("int");
  });

  it("glyph rejects the wrong arity by name", () => {
    const r = runQbsk("print(glyph())", "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("glyph");
  });

  it("lit turns a depth into an intensity", () => {
    const r = runQbsk(
      "print(lit(10.0, 10.0, 30.0))\nprint(lit(30.0, 10.0, 30.0))",
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["1.0", "0.0"]);
  });

  it("the three compose: project, then lit, then glyph", () => {
    const src = [
      'const cam = {"x": 0.0, "y": 0.0, "z": -10.0, "fov": 60.0}',
      "var near = project([0.0, 0.0, 0.0], cam, 20, 5)",
      "var far = project([0.0, 0.0, 15.0], cam, 20, 5)",
      'print(glyph(lit(near[2], 10.0, 30.0)) + glyph(lit(far[2], 10.0, 30.0)))',
    ].join("\n");
    const r = runQbsk(src, "t.qbsk");
    expect(r.error).toBeNull();
    // Nearer must come out denser than further; that ordering is the whole point.
    const [a, b] = [r.out[0]![0]!, r.out[0]![1]!];
    expect(DENSITY_RAMP.indexOf(a)).toBeGreaterThan(DENSITY_RAMP.indexOf(b));
  });
});
