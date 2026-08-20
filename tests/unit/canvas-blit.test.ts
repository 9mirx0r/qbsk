// A canvas drawn into a layer — `put <canvas>` (docs/engine.md §11.13).
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

function run(lines: string[]) {
  return runQbsk(lines.join("\n"), "canvas-blit.qbsk");
}

function grid(lines: string[]): string[] {
  const result = run(lines);
  expect(result.error?.message ?? null).toBeNull();
  return result.canvas!.renderText().split("\n");
}

describe("put <canvas> blits instead of stringifying", () => {
  // The defect this closes: `qbskStr` on a canvas is `renderText()`, which is
  // multi-line, and it went into a single-line text primitive. The newlines ended
  // rows early, so the scene came out with rows of the wrong width and a line past
  // its own declared height — no error, a malformed grid.
  it("keeps the scene's declared shape", () => {
    const rows = grid([
      "var c = canvas(4, 2)",
      'box(c, (0, 0), (3, 1), "#")',
      "scene S(width: 8, height: 4)",
      "layer l z: 0",
      '    fill "."',
      "    put c at (0, 0)",
    ]);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toHaveLength(8);
    }
  });

  it("lands the canvas where `at` names it", () => {
    expect(
      grid([
        "var c = canvas(2, 2)",
        'fill(c, "#")',
        "scene S(width: 6, height: 4)",
        "layer l z: 0",
        '    fill "."',
        "    put c at (2, 1)",
      ]),
    ).toEqual(["......", "..##..", "..##..", "......"]);
  });

  // A canvas is an image with a known extent, not a sparse overlay: its blank cells
  // are part of what it says. This is the opposite of `mask:` (§11.12), deliberately.
  it("is opaque — a space in the canvas erases what is under it", () => {
    expect(
      grid([
        "var c = canvas(2, 1)",
        'fill(c, " ")',
        "scene S(width: 4, height: 1)",
        "layer under z: 0",
        '    fill "~"',
        "layer over z: 1",
        "    put c at (1, 0)",
      ]),
    ).toEqual(["~  ~"]);
  });

  // The canvas natives are monochrome today, so every cell of a hand-drawn canvas
  // says "no opinion" (-1). Letting that win would make the layer's `color` directive
  // a silent no-op above a blit, which is what invariant I2 forbids.
  it("takes the layer's colour where the canvas has none of its own", () => {
    const result = run([
      "var c = canvas(2, 1)",
      'put(c, "ab", (0, 0))',
      "scene S(width: 2, height: 1)",
      "layer l z: 0",
      "    color fg: bright-red",
      "    put c at (0, 0)",
    ]);
    expect(result.error?.message ?? null).toBeNull();
    const cells = result.canvas!.cells;
    expect(cells[0]!.char).toBe("a");
    expect(cells[0]!.fg, "the layer's colour must reach a colourless canvas cell")
      .not.toBe(-1);
    expect(cells[1]!.fg).toBe(cells[0]!.fg);
  });

  it("clips off-grid rather than throwing", () => {
    expect(
      grid([
        "var c = canvas(3, 3)",
        'fill(c, "#")',
        "scene S(width: 3, height: 2)",
        "layer l z: 0",
        '    fill "."',
        "    put c at (-1, -1)",
        "    put c at (2, 1)",
      ]),
    ).toEqual(["##.", "###"]);
  });

  it("still refuses a list, which has no extent of its own", () => {
    const result = run([
      'const M = ["ab", "cd"]',
      "scene S(width: 4, height: 2)",
      "layer l z: 0",
      "    put M at (0, 0)",
    ]);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/mask:/);
  });
});
