// The cell aspect is one defect in several places (docs/engine.md §11.16).
//
// F0 parameterised `stroke.ts` and its phase document claimed the defect was isolated
// there. The review found `shade.ts` and `particles.ts` still holding their own
// `CELL_ASPECT = 2.0`, with comments already naming them the same constant, and
// `project.ts` already fixed with the same reasoning. These tests pin the category, so
// the next place that needs the number has somewhere to fail.
import { describe, expect, it } from "vitest";
import { DEFAULT_CELL_ASPECT, strokeGlyph } from "../../src/engine/stroke.js";
import { runQbsk } from "../../src/interp/interpreter.js";
import { applyShades, shadeAmount, type ShadeSpec } from "../../src/engine/shade.js";
import { Canvas } from "../../src/engine/canvas.js";
import { particleAt, resolveParticleSpec } from "../../src/engine/particles.js";
import { DEFAULT_ASPECT } from "../../src/choreo/project.js";

describe("every place that needs a cell shape takes it, and agrees on the default", () => {
  it("uses one default across the engine rather than four copies of 2.0", () => {
    // project.ts got here first and named its own. They must not drift apart.
    expect(DEFAULT_ASPECT).toBe(DEFAULT_CELL_ASPECT);
  });

  it("a round light stays round only when the aspect matches the font", () => {
    // A `radius:` light is measured in cell distance, so x has to be divided by the
    // cell's aspect or the falloff comes out elliptical. At a wider cell the same
    // horizontal offset is a smaller fraction of the radius, so it is brighter.
    const spec: ShadeSpec = {
      kind: "radial", x: 10, y: 10, radius: 6, tint: -1, strength: 1, speed: 0,
    };
    const narrow = shadeAmount(spec, 16, 10, 0, 2.0);
    const wide = shadeAmount(spec, 16, 10, 0, 1 / 0.6);
    expect(narrow).not.toBe(wide);
    expect(wide).toBeLessThan(narrow);
  });

  it("shading defaults to 2.0, so every existing scene shades as it did", () => {
    const spec: ShadeSpec = {
      kind: "radial", x: 5, y: 5, radius: 4, tint: -1, strength: 1, speed: 0,
    };
    expect(shadeAmount(spec, 8, 5, 0)).toBe(shadeAmount(spec, 8, 5, 0, DEFAULT_CELL_ASPECT));
  });

  it("applyShades passes the aspect down instead of accepting and dropping it", () => {
    // Caught by the linter, not by this suite's first draft: applyShades took the
    // parameter and never forwarded it. A value accepted and ignored is invariant I2,
    // and testing shadeAmount directly could never have seen it -- the hole was between
    // the two functions, which is where this kind of defect lives.
    const spec: ShadeSpec = {
      kind: "radial", x: 4, y: 4, radius: 5, tint: -1, strength: 1, speed: 0,
    };
    const paint = (aspect: number) => {
      const canvas = new Canvas(12, 8);
      canvas.fill("#", 0xffffff, 0x000000);
      applyShades(canvas, [spec], 0, aspect);
      return canvas.cells.map((c) => c.fg).join(",");
    };
    expect(paint(2.0)).not.toBe(paint(1.0));
    expect(paint(2.0)).toBe(paint(DEFAULT_CELL_ASPECT));
  });

  it("a particle drifts at the angle the font actually shows", () => {
    // Horizontal velocity is scaled by the aspect so a 45-degree launch looks like 45
    // degrees. Change the cell shape and the same launch lands somewhere else.
    const spec = resolveParticleSpec({
      x: 10, y: 10, count: 4, life: 2, seed: 7, speed: 4, angle: 45, spread: 10,
    });
    // t must be past this particle's birth. Index 1 of 4 over a life of 2 is born at
    // 0.5, and at exactly 0.5 its elapsed time is zero -- no aspect moves a particle
    // that has not travelled, so that sample proves nothing. Same trap as the
    // 45-degree edge in the converter suite.
    const narrow = particleAt(1, 1.2, spec, 2.0);
    const wide = particleAt(1, 1.2, spec, 1.0);
    expect(narrow.x).not.toBe(wide.x);
    // Only x is aspect-scaled; a wrong aspect must never move a particle vertically.
    expect(narrow.y).toBe(wide.y);
  });

  it("particles default to 2.0, so every existing golden holds", () => {
    const spec = resolveParticleSpec({
      x: 3, y: 3, count: 2, life: 1, seed: 11, speed: 3, angle: 30, spread: 5,
    });
    expect(particleAt(0, 0.6, spec).x).toBe(particleAt(0, 0.6, spec, DEFAULT_CELL_ASPECT).x);
  });
});

// ---------------------------------------------------------------------------
// The category, once more, and from the direction the review came at it.
//
// F0 gave `strokeGlyph` an aspect parameter and `line ... style: stroke` passes the
// program's. The NATIVE did not: `stroke_glyph(dx, dy)` called the two-argument form and
// always got 2.0. That was invisible while nothing supplied another number, and it
// stopped being invisible the moment Studio started sending the chosen font's real cell
// shape — so a program running in IBM Plex got one answer from `line ... style: stroke`
// and a different one from `stroke_glyph`, which §11.16 documents as two forms of one
// feature.
//
// Anti-pattern 6 for the third time in this one constant's history, which is why these
// assert the AGREEMENT rather than either answer.
// ---------------------------------------------------------------------------

describe("the stroke_glyph native sees the same cell as the statement does", () => {
  /** Whatever `stroke_glyph(dx, dy)` returns to a program run at this aspect. */
  function fromNative(dx: number, dy: number, cellAspect?: number): string {
    const r = runQbsk(`print(stroke_glyph(${dx}, ${dy}))`, "t.qbsk", undefined, { cellAspect });
    expect(r.error?.message ?? null).toBeNull();
    return r.out[0]!;
  }

  it("answers what strokeGlyph answers, at the aspect the program was given", () => {
    // 2.9/10 is inside the disagreement band: 0.283 < dy/dx < 0.340, where the same
    // geometry reads horizontal under one cell shape and diagonal under another.
    const wide = 1.15 / 0.6; // IBM Plex Mono / JetBrains Mono in Studio
    expect(fromNative(10, 2.9)).toBe(strokeGlyph(10, 2.9, DEFAULT_CELL_ASPECT));
    expect(fromNative(10, 2.9, wide)).toBe(strokeGlyph(10, 2.9, wide));
  });

  it("actually changes its answer when the cell changes", () => {
    // Guards the guard. Both assertions above would hold if the native ignored the
    // aspect AND `strokeGlyph` did too, so the band has to be shown to be a real band.
    expect(fromNative(10, 2.9, 1.15 / 0.6)).not.toBe(fromNative(10, 2.9, 2.0));
  });

  it("keeps 2.0 when the program was given no aspect, so every golden holds", () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [3, 3], [10, 2.9], [-4, 2]] as const) {
      expect(fromNative(dx, dy), `${dx},${dy}`).toBe(strokeGlyph(dx, dy));
    }
  });
});
