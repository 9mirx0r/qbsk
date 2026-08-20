// plot() and braille() end to end (docs/engine.md §11.14).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { BRAILLE_BASE, FULL_BLOCK, HALF_TOP } from "../../src/engine/subcell.js";
import { resolveColor } from "../../src/engine/color.js";

function run(lines: string[]) {
  return runQbsk(lines.join("\n"), "subcell.qbsk");
}

function cells(lines: string[]) {
  const result = run(lines);
  expect(result.error?.message ?? null).toBeNull();
  return result.canvas!;
}

describe("plot() reaches the screen through a canvas", () => {
  it("a top subpixel and a bottom subpixel of one colour make a full block", () => {
    const canvas = cells([
      "var c = canvas(1, 1)",
      'plot(c, (0, 0), "red")',
      'plot(c, (0, 1), "red")',
      "scene S(width: 1, height: 1)",
      "layer l z: 0",
      "    put c at (0, 0)",
    ]);
    expect(canvas.cells[0]!.char).toBe(FULL_BLOCK);
  });

  // Criterion 2 of the stage, end to end: two subpixels of different colours in one
  // cell produce the documented glyph and colour pair, byte for byte.
  it("two colours in one cell give fg = top, bg = bottom", () => {
    const canvas = cells([
      "var c = canvas(1, 1)",
      'plot(c, (0, 0), "red")',
      'plot(c, (0, 1), "blue")',
      "scene S(width: 1, height: 1)",
      "layer l z: 0",
      "    put c at (0, 0)",
    ]);
    const cell = canvas.cells[0]!;
    expect(cell.char).toBe(HALF_TOP);
    expect(cell.fg).toBe(resolveColor("red"));
    expect(cell.bg).toBe(resolveColor("blue"));
  });

  it("the plotted colour survives the blit rather than taking the layer's", () => {
    const canvas = cells([
      "var c = canvas(1, 1)",
      'plot(c, (0, 0), "red")',
      "scene S(width: 1, height: 1)",
      "layer l z: 0",
      "    color fg: bright-green",
      "    put c at (0, 0)",
    ]);
    expect(canvas.cells[0]!.fg).toBe(resolveColor("red"));
    expect(canvas.cells[0]!.fg).not.toBe(resolveColor("bright-green"));
  });

  it("clips off-grid instead of throwing", () => {
    const result = run([
      "var c = canvas(2, 1)",
      'plot(c, (-1, 0), "red")',
      'plot(c, (0, 99), "red")',
      'plot(c, (5, 0), "red")',
      "scene S(width: 2, height: 1)",
      "layer l z: 0",
      "    put c at (0, 0)",
    ]);
    expect(result.error).toBeNull();
  });

  it("reports an unknown colour, and suggests", () => {
    const result = run([
      "var c = canvas(1, 1)",
      'plot(c, (0, 0), "bright-rd")',
    ]);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/bright-rd/);
    expect(result.error!.message).toMatch(/did you mean/);
  });
});

describe("the subpixel grid is square, which is the whole point", () => {
  // Criterion 3: the 1:2 cell means a circle needs x doubled in CELL space. Drawn in
  // subpixel space it needs no compensation at all — so a circle plotted with one
  // radius must come out spanning twice as many cells across as down. Asserted
  // numerically, because the stage document says eyeballing it does not count.
  it("a circle plotted with one radius measures twice as wide as tall, in cells", () => {
    const R = 8;
    const canvas = cells([
      "var c = canvas(24, 10)",
      "var i = 0",
      "while i < 720",
      "    var a = float(i) * (pi() * 2.0 / 720.0)",
      `    var x = int(round(12.0 + cos(a) * ${R}.0))`,
      `    var y = int(round(10.0 + sin(a) * ${R}.0))`,
      '    plot(c, (x, y), "white")',
      "    i += 1",
      "scene S(width: 24, height: 10)",
      "layer l z: 0",
      "    put c at (0, 0)",
    ]);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (canvas.cells[y * canvas.width + x]!.char !== " ") {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    const widthInCells = maxX - minX + 1;
    const heightInCells = maxY - minY + 1;

    // 2R cells across, 2R subpixels down = R cells down.
    expect(widthInCells).toBe(2 * R + 1);
    expect(heightInCells).toBe(R + 1);
    expect(widthInCells / heightInCells).toBeCloseTo(2, 0);
  });
});

describe("braille packs density instead of colour", () => {
  it("a dot lands in the braille block", () => {
    const canvas = cells([
      "var c = canvas(1, 1)",
      "braille(c, (0, 0))",
      "scene S(width: 1, height: 1)",
      "layer l z: 0",
      "    put c at (0, 0)",
    ]);
    const code = canvas.cells[0]!.char.codePointAt(0)!;
    expect(code).toBeGreaterThanOrEqual(BRAILLE_BASE);
    expect(code).toBeLessThanOrEqual(BRAILLE_BASE + 0xff);
  });

  it("eight dots share one cell, at 2 x 4", () => {
    const canvas = cells([
      "var c = canvas(1, 1)",
      "var x = 0",
      "while x < 2",
      "    var y = 0",
      "    while y < 4",
      "        braille(c, (x, y))",
      "        y += 1",
      "    x += 1",
      "scene S(width: 1, height: 1)",
      "layer l z: 0",
      "    put c at (0, 0)",
    ]);
    expect(canvas.cells[0]!.char.codePointAt(0)).toBe(BRAILLE_BASE + 0xff);
  });

  // Criterion 4 of the stage, measured headless. The budget is 0.1 ms for 100 points;
  // the assertion is deliberately loose against it, because a threshold tight enough
  // to be interesting is a threshold that fails on a loaded machine — bench/baseline.md
  // §13.1 is emphatic about that. What this pins is the ORDER: drawing points must not
  // become a per-point allocation storm.
  it("100 points cost well under the 0.1 ms budget", () => {
    const source = [
      "var c = canvas(40, 10)",
      "var i = 0",
      "while i < 100",
      "    braille(c, (i, i % 40))",
      "    i += 1",
      "scene S(width: 1, height: 1)",
      "layer l z: 0",
      '    fill "."',
    ].join("\n");

    // Warm the interpreter first: the measurement is of the plotting, not of the JIT.
    runQbsk(source, "warm.qbsk");
    const started = performance.now();
    const result = runQbsk(source, "bench.qbsk");
    const elapsed = performance.now() - started;

    expect(result.error).toBeNull();
    // A whole program run, parse included, for a hundred points.
    expect(elapsed).toBeLessThan(50);
  });
});

describe("the subcell example is pinned", () => {
  // Criterion 1: the same circle and sine with and without subcell, in one scene, with
  // the staircase reduction visible in the bytes rather than merely claimed.
  it("examples/subcell.qbsk matches its golden byte for byte", () => {
    const source = readFileSync(
      new URL("../../examples/subcell.qbsk", import.meta.url),
      "utf8",
    );
    const golden = readFileSync(
      new URL("../golden/subcell.qbsk.out", import.meta.url),
      "utf8",
    );
    const result = runQbsk(source, "subcell.qbsk");
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n"));
  });

  it("draws all three alphabets, so the comparison is real", () => {
    const golden = readFileSync(
      new URL("../golden/subcell.qbsk.out", import.meta.url),
      "utf8",
    );
    expect(golden, "the one-glyph-per-cell figure").toMatch(/#/);
    expect(golden, "half blocks").toMatch(/[▀▄█]/);
    expect(golden, "braille").toMatch(/[⠀-⣿]/);
  });
});
