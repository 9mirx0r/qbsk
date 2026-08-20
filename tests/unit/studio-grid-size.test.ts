// The window tells the scene how big it is (studio/renderer/fit.ts, studio/shared/api.ts).
//
// `StudioHost.resize` existed from the day it was written, carried a doc comment saying
// "queues a resize for the next frame", and NOTHING called it — it was not even on the
// bridge interface. So `on resize` never fired inside the Studio, and a scene that sizes
// itself from the window opened at whatever its declaration said and stayed there.
//
// That is a capability built and never connected, which is the same shape as a value
// computed and dropped. The arithmetic that closes it is `gridForBox`, and it is the exact
// inverse of the fit the Studio already did.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fitFontSize, gridForBox, CH_PER_EM, CELL_ASPECT } from "../../studio/renderer/fit.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(ROOT, ...p), "utf8");

describe("gridForBox: how many cells fit at a given font size", () => {
  it("fills the box without overflowing it", () => {
    const { cols, rows } = gridForBox({ availWidth: 1400, availHeight: 900, fontPx: 16 });
    expect(cols * CH_PER_EM * 16).toBeLessThanOrEqual(1400);
    expect(rows * CELL_ASPECT * 16).toBeLessThanOrEqual(900);
    // One more cell on either axis would spill — that is what "fits" means, and it is
    // the assertion that catches an off-by-one in either direction.
    expect((cols + 1) * CH_PER_EM * 16).toBeGreaterThan(1400);
    expect((rows + 1) * CELL_ASPECT * 16).toBeGreaterThan(900);
  });

  it("is the inverse of fitFontSize", () => {
    // Fit a grid to a box, then ask what fits at that size: the answer must be at least
    // the grid we started from. If it were smaller the Studio would tell a scene it has
    // less room than the Studio itself just decided to give it.
    for (const [cols, rows] of [[80, 24], [113, 48], [40, 14], [200, 60]]) {
      const px = fitFontSize({ cols: cols!, rows: rows!, availWidth: 1600, availHeight: 1000 });
      const back = gridForBox({ availWidth: 1600, availHeight: 1000, fontPx: px });
      expect(back.cols, `${cols}x${rows}`).toBeGreaterThanOrEqual(cols!);
      expect(back.rows, `${cols}x${rows}`).toBeGreaterThanOrEqual(rows!);
    }
  });

  it("honours a font with a different advance width", () => {
    const wide = gridForBox({ availWidth: 1000, availHeight: 500, fontPx: 16, chPerEm: 0.5 });
    const narrow = gridForBox({ availWidth: 1000, availHeight: 500, fontPx: 16, chPerEm: 0.6 });
    expect(wide.cols).toBeGreaterThan(narrow.cols);
    // The row count depends on the cell aspect, not the advance — same font size, same rows.
    expect(wide.rows).toBe(narrow.rows);
  });

  it("answers zero rather than a negative or a NaN for a degenerate box", () => {
    // A window mid-collapse reports a zero-width box, and a scene told it has -3 columns
    // is worse than one told nothing.
    for (const box of [
      { availWidth: 0, availHeight: 500, fontPx: 16 },
      { availWidth: 500, availHeight: 0, fontPx: 16 },
      { availWidth: 500, availHeight: 500, fontPx: 0 },
      { availWidth: -10, availHeight: -10, fontPx: 16 },
    ]) {
      const { cols, rows } = gridForBox(box);
      expect(cols).toBe(0);
      expect(rows).toBe(0);
    }
  });
});

describe("the capability is connected end to end", () => {
  it("is on the bridge interface, which is where it was missing", () => {
    expect(read("studio", "shared", "api.ts")).toMatch(/resize\(cols: number, rows: number\)/);
  });

  it("is exposed by the preload and handled in main", () => {
    expect(read("studio", "bridge", "preload.cts")).toContain("studio:resize");
    expect(read("studio", "main", "index.ts")).toContain('ipcMain.handle("studio:resize"');
  });

  it("reaches the running program and not a dead one", () => {
    // A resize arriving between two scenes must not land on the previous program, so the
    // handler reads the live host rather than closing over one run's.
    expect(read("studio", "main", "index.ts")).toMatch(/liveHost\?\.resize\(cols, rows\)/);
  });

  it("is sent when a scene starts, not only when the window changes", () => {
    // The defect the CLI had until yesterday: a responsive scene opened at its declared
    // size and stayed there until somebody dragged the corner.
    const renderer = read("studio", "renderer", "renderer.ts");
    expect(renderer).toContain("tellSceneTheSize");
    expect(renderer.indexOf("void tellSceneTheSize();")).toBeGreaterThan(0);
  });

  it("does not re-send the same size on every pixel of a drag", () => {
    // A drag fires `resize` dozens of times a second and most land on the same cell
    // count; re-sending is a queued event per frame for no change at all.
    expect(read("studio", "renderer", "renderer.ts")).toContain("lastSent");
  });
});
