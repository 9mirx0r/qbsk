// An earlier release — play mode sizing (docs/studio.md §13.3).
//
// Only the arithmetic is tested here, and that is deliberate: hiding chrome is
// structural CSS, but a bad fit either clips the scene or wastes half the window.
// The "grid never changes" guarantee (criterion 3) is structural too — play mode
// writes a font size and touches nothing else — so it is asserted below by showing
// the fit depends on the grid rather than the other way round.
import { describe, expect, it } from "vitest";
import {
  fitFontSize, snapToFontGrid, CH_PER_EM, CELL_ASPECT, cellAspectFor,
} from "../../studio/renderer/fit.js";
import { FONTS, fontById } from "../../studio/renderer/fonts.js";
import { strokeGlyph, assertCellAspect } from "../../src/engine/stroke.js";

describe("play mode: fitFontSize (docs/studio.md §13.3)", () => {
  it("fills the box: the fitted grid is as large as it can be without overflowing", () => {
    const cols = 78;
    const rows = 34;
    const availWidth = 1400;
    const availHeight = 900;
    const px = fitFontSize({ cols, rows, availWidth, availHeight });
    expect(cols * CH_PER_EM * px).toBeLessThanOrEqual(availWidth);
    expect(rows * CELL_ASPECT * px).toBeLessThanOrEqual(availHeight);
    // One pixel larger would overflow one of the two axes — that is what "as large
    // as it can be" means, and it is the assertion that catches an off-by-one.
    const bigger = px + 1;
    const overflows =
      cols * CH_PER_EM * bigger > availWidth ||
      rows * CELL_ASPECT * bigger > availHeight;
    expect(overflows).toBe(true);
  });

  it("takes the MINIMUM of the two axes, so a tall scene is not clipped", () => {
    // A wide, short box against a tall, narrow grid: fitting width alone would cut
    // the bottom off. The height constraint has to win.
    const px = fitFontSize({ cols: 10, rows: 60, availWidth: 2000, availHeight: 700 });
    expect(60 * CELL_ASPECT * px).toBeLessThanOrEqual(700);
  });

  it("a wider window raises the size, a narrower one lowers it", () => {
    const base = { cols: 40, rows: 20, availHeight: 10_000 };
    const small = fitFontSize({ ...base, availWidth: 400 });
    const large = fitFontSize({ ...base, availWidth: 1600 });
    expect(large).toBeGreaterThan(small);
  });

  it("clamps: a degenerate scene or a collapsed window cannot produce an absurd size", () => {
    expect(fitFontSize({ cols: 1, rows: 1, availWidth: 4000, availHeight: 4000 })).toBe(64);
    expect(fitFontSize({ cols: 400, rows: 400, availWidth: 50, availHeight: 50 })).toBe(6);
    expect(fitFontSize({ cols: 0, rows: 0, availWidth: 800, availHeight: 600 })).toBe(6);
    expect(fitFontSize({ cols: 10, rows: 10, availWidth: 0, availHeight: 0 })).toBe(6);
  });

  it("returns a whole number of pixels", () => {
    const px = fitFontSize({ cols: 37, rows: 23, availWidth: 913, availHeight: 577 });
    expect(Number.isInteger(px)).toBe(true);
  });

  // Criterion 3, expressed as a property: the grid decides the font, never the
  // reverse. Two windows of different sizes showing the same scene must still be
  // the same character grid — only the pixels differ.
  it("the character grid is an input, never an output: only the font size varies", () => {
    const scene = { cols: 78, rows: 34 };
    const a = fitFontSize({ ...scene, availWidth: 800, availHeight: 600 });
    const b = fitFontSize({ ...scene, availWidth: 1920, availHeight: 1080 });
    expect(a).not.toBe(b);
    // fitFontSize returns a number and nothing else: there is no path by which it
    // could report different dimensions back to the caller.
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
  });
});

describe("play mode: font pixel grid (font/LICENSE.md)", () => {
  it("snaps DOWN to the grid, so the scene still fits", () => {
    expect(snapToFontGrid(23)).toBe(16);
    expect(snapToFontGrid(31)).toBe(24);
    expect(snapToFontGrid(16)).toBe(16);
    // Snapping up would look crisper and clip the scene — the wrong trade.
    expect(snapToFontGrid(23)).toBeLessThanOrEqual(23);
  });

  it("below one grid step there is nothing to snap to, so the raw size survives", () => {
    // A tiny-but-legible frame beats one clamped to 8px that no longer fits.
    expect(snapToFontGrid(6)).toBe(6);
    expect(snapToFontGrid(7)).toBe(7);
    expect(snapToFontGrid(8)).toBe(8);
  });

  it("a snapped size never overflows the box the raw size fitted", () => {
    const scene = { cols: 78, rows: 34, availWidth: 1400, availHeight: 900 };
    const snapped = snapToFontGrid(fitFontSize(scene));
    expect(78 * CH_PER_EM * snapped).toBeLessThanOrEqual(1400);
    expect(34 * CELL_ASPECT * snapped).toBeLessThanOrEqual(900);
  });
});

// ---------------------------------------------------------------------------
// The font picker's cell shape reaches the engine (F0 criterion 4).
//
// F0 made the aspect a parameter and left the Studio half deferred, so picking
// JetBrains Mono changed how the grid LOOKED and not what the engine DREW: diagonals
// were still computed as if every cell were 1:2. The stage's own words for the deferral
// were that the font lives in `studio/renderer/` and `host.ts` has no concept of it.
//
// `cellAspectFor` is that concept, and it is here rather than in the renderer because
// it is arithmetic: a cell is `chPerEm` em wide and `CELL_ASPECT` em tall, and the
// engine wants height over width. Deriving it from the same two numbers `applyFit`
// hands the GPU painter is what stops the drawn angle and the drawn pixels disagreeing.
// ---------------------------------------------------------------------------

describe("the cell shape a chosen font actually has (docs/studio.md §14)", () => {
  it("is the cell's height over its width, from the same two numbers the fit uses", () => {
    for (const font of FONTS) {
      const px = 32;
      const widthPx = Math.round(px * font.chPerEm);
      const heightPx = Math.round(px * CELL_ASPECT);
      // Not exact, and it cannot be: `applyFit` ROUNDS both sides to whole pixels, so
      // the shape actually drawn differs from the exact ratio by up to that rounding.
      // The bound is one pixel of width, which is what `Math.round` can move it by —
      // stated as a bound rather than as a magic tolerance.
      expect(
        Math.abs(cellAspectFor(font.chPerEm) - heightPx / widthPx),
        font.id,
      ).toBeLessThan(1 / widthPx);
    }
  });

  it("gives the two narrow fonts a different cell from the two wide ones", () => {
    // 0.5 em against 0.6 em is a 20% difference in width and none in height, so the
    // registry really does describe two cell shapes rather than four labels for one.
    const narrow = cellAspectFor(0.5);
    const wide = cellAspectFor(0.6);
    expect(narrow).toBeGreaterThan(wide);
    expect(cellAspectFor(fontById("unifont").chPerEm)).toBe(narrow);
    expect(cellAspectFor(fontById("iosevka").chPerEm)).toBe(narrow);
    expect(cellAspectFor(fontById("jetbrains").chPerEm)).toBe(wide);
    expect(cellAspectFor(fontById("plex").chPerEm)).toBe(wide);
  });

  it("changes what the engine DRAWS, which is the whole point of passing it through", () => {
    // Criterion 4 stated as an assertion rather than as a promise. There is a band of
    // slopes where the two cell shapes disagree about whether a line is horizontal or
    // diagonal, and a scene drawn in JetBrains Mono must land on the other side of it.
    const narrow = cellAspectFor(fontById("unifont").chPerEm);
    const wide = cellAspectFor(fontById("jetbrains").chPerEm);
    const disagreements = [];
    for (let i = 1; i <= 200; i += 1) {
      const dy = i / 400;
      if (strokeGlyph(1, dy, narrow) !== strokeGlyph(1, dy, wide)) {
        disagreements.push(dy);
      }
    }
    expect(disagreements.length, "the two fonts draw every slope identically").toBeGreaterThan(0);
  });

  it("keeps every font's aspect inside what the engine will accept", () => {
    // `assertCellAspect` reports a non-positive or non-finite aspect. A registry entry
    // with `chPerEm: 0` would reach the interpreter as Infinity and fail at draw time,
    // one layer away from the typo.
    for (const font of FONTS) {
      expect(() => assertCellAspect(cellAspectFor(font.chPerEm)), font.id).not.toThrow();
    }
  });
});
