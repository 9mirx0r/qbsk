// The masked map — `put ... mask:` (docs/engine.md §11.12).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { analyzeLayerStaticity } from "../../src/analyze/analyzer.js";
import { parse } from "../../src/parser/parser.js";

const NEWLINE = String.fromCharCode(10);

function run(lines: string[]) {
  return runQbsk(lines.join("\n"), "masked.qbsk");
}

function grid(lines: string[]): string[] {
  const result = run(lines);
  expect(result.error?.message ?? null).toBeNull();
  return result.canvas!.renderText().split("\n");
}

function failure(lines: string[]) {
  const result = run(lines);
  expect(result.error, "expected this program to report").not.toBeNull();
  return result.error!;
}

// The map is constant, the mask changes: the shape §11.12 exists for.
const MAP = ['const MAP = ["#####", "#...#", "#####"]'];
const FULL = 'const FULL = ["*****", "*****", "*****"]';
const PARTIAL = 'const PARTIAL = ["**   ", "  *  ", "   **"]';

describe("put ... mask: composes the map the loop would have drawn", () => {
  // Criterion 4 of the stage: the composite may not be a different picture from
  // the loop it replaces, so both forms are drawn and compared byte for byte.
  it("is byte-identical to the nested loop on the same map and mask", () => {
    const looped = grid([
      ...MAP,
      PARTIAL,
      "scene S(width: 5, height: 3)",
      "layer floor z: 0",
      '    fill "."',
      "    for y in 0..3",
      "        for x in 0..5",
      '            if PARTIAL[y][x] != " "',
      "                put MAP[y][x] at (x, y)",
    ]);
    const masked = grid([
      ...MAP,
      PARTIAL,
      "scene S(width: 5, height: 3)",
      "layer floor z: 0",
      '    fill "."',
      "    put MAP at (0, 0) mask: PARTIAL",
    ]);
    expect(masked).toEqual(looped);
  });

  it("a fully open mask draws the whole map", () => {
    expect(
      grid([
        ...MAP,
        FULL,
        "scene S(width: 5, height: 3)",
        "layer floor z: 0",
        '    fill "."',
        "    put MAP at (0, 0) mask: FULL",
      ]),
    ).toEqual(["#####", "#...#", "#####"]);
  });

  // The distinguishing rule against a sprite blit: a hidden cell is NOT painted
  // with a space, it is not painted, so the layer below survives.
  it("leaves the layer below showing through a hidden cell", () => {
    expect(
      grid([
        ...MAP,
        'const NARROW = ["  #  ", "     ", "     "]',
        "scene S(width: 5, height: 3)",
        "layer under z: 0",
        '    fill "~"',
        "layer over z: 1",
        "    put MAP at (0, 0) mask: NARROW",
      ]),
    ).toEqual(["~~#~~", "~~~~~", "~~~~~"]);
  });

  it("a space in the map is drawn when the mask shows it", () => {
    // The mask decides visibility; the map decides the glyph, space included.
    expect(
      grid([
        'const M = ["a b"]',
        'const K = ["***"]',
        "scene S(width: 3, height: 2)",
        "layer under z: 0",
        '    fill "~"',
        "layer over z: 1",
        "    put M at (0, 0) mask: K",
      ]),
    ).toEqual(["a b", "~~~"]);
  });

  it("draws at the offset `at` names", () => {
    expect(
      grid([
        'const M = ["ab", "cd"]',
        'const K = ["**", "**"]',
        "scene S(width: 5, height: 4)",
        "layer floor z: 0",
        '    fill "."',
        "    put M at (2, 1) mask: K",
      ]),
    ).toEqual([".....", "..ab.", "..cd.", "....."]);
  });

  it("clips off-grid instead of throwing, exactly as the canvas does", () => {
    expect(
      grid([
        'const M = ["abc", "def"]',
        'const K = ["***", "***"]',
        "scene S(width: 3, height: 2)",
        "layer floor z: 0",
        '    fill "."',
        "    put M at (-1, -1) mask: K",
        "    put M at (2, 1) mask: K",
      ]),
      // at (-1, -1): row 0 falls off the top, row 1 lands on canvas row 0 with its
      // first character clipped, so "def" contributes "ef" from x = 0.
    ).toEqual(["ef.", "..a"]);
  });
});

describe("put ... mask: inside the layer's own state", () => {
  it("takes the layer's colour like any other put", () => {
    const result = run([
      'const M = ["ab"]',
      'const K = ["**"]',
      "scene S(width: 2, height: 1)",
      "layer floor z: 0",
      "    color fg: bright-red",
      "    put M at (0, 0) mask: K",
    ]);
    expect(result.error?.message ?? null).toBeNull();
    const cells = result.canvas!.cells;
    expect(cells[0]!.fg).toBe(cells[1]!.fg);
    expect(cells[0]!.fg).not.toBe(-1);
  });

  it("respects visible: false", () => {
    expect(
      grid([
        'const M = ["ab"]',
        'const K = ["**"]',
        "scene S(width: 2, height: 1)",
        "layer floor z: 0",
        '    fill "."',
        "    visible: false",
        "    put M at (0, 0) mask: K",
      ]),
    ).toEqual([".."]);
  });

  // §11.8 says depth competes per CELL. A composite is many cells, so it has to
  // compete cell by cell too rather than as one object.
  it("depth: competes per cell, not per composite", () => {
    expect(
      grid([
        'const M = ["FF"]',
        'const K = ["**"]',
        "scene S(width: 2, height: 1)",
        "layer a z: 0",
        "    put M at (0, 0) mask: K depth: 20.0",
        '    put "N" at (1, 0) depth: 5.0',
      ]),
    ).toEqual(["FN"]);
  });
});

describe("put ... mask: reports rather than guessing", () => {
  it("names 'mask:' when a list is put without one", () => {
    // The §15 silent-wrong-value this construct closes: it used to stringify the
    // list and clip it, drawing `[ab, c` with no error at all.
    const error = failure([
      'const M = ["ab", "cd"]',
      "scene S(width: 6, height: 2)",
      "layer floor z: 0",
      "    put M at (0, 0)",
    ]);
    expect(error.message).toMatch(/mask:/);
    expect(error.span).not.toBeUndefined();
  });

  it("still stringifies a scalar, as examples/hud.qbsk relies on", () => {
    expect(
      grid([
        "scene S(width: 4, height: 1)",
        "layer floor z: 0",
        '    fill "."',
        "    put 42 at (0, 0)",
      ]),
    ).toEqual(["42.."]);
  });

  it("rejects a mask with fewer rows than the map, naming both sizes", () => {
    const error = failure([
      'const M = ["ab", "cd"]',
      'const K = ["**"]',
      "scene S(width: 4, height: 2)",
      "layer floor z: 0",
      "    put M at (0, 0) mask: K",
    ]);
    expect(error.message).toMatch(/1/);
    expect(error.message).toMatch(/2/);
  });

  it("rejects a mask row shorter than the map row beside it", () => {
    const error = failure([
      'const M = ["abcd"]',
      'const K = ["**"]',
      "scene S(width: 4, height: 1)",
      "layer floor z: 0",
      "    put M at (0, 0) mask: K",
    ]);
    expect(error.message).toMatch(/row/i);
  });

  it("rejects a map that is not a list of strings", () => {
    const error = failure([
      "const M = [1, 2]",
      'const K = ["**", "**"]',
      "scene S(width: 4, height: 2)",
      "layer floor z: 0",
      "    put M at (0, 0) mask: K",
    ]);
    expect(error.message).toMatch(/list of strings/);
  });

  it("rejects a mask that is not a list of strings", () => {
    const error = failure([
      'const M = ["ab"]',
      "const K = [7]",
      "scene S(width: 4, height: 1)",
      "layer floor z: 0",
      "    put M at (0, 0) mask: K",
    ]);
    expect(error.message).toMatch(/list of strings/);
  });

  it("rejects a mask on a scalar, which has no rows to mask", () => {
    const error = failure([
      'const K = ["**"]',
      "scene S(width: 4, height: 1)",
      "layer floor z: 0",
      '    put "ab" at (0, 0) mask: K',
    ]);
    expect(error.message).toMatch(/mask/);
  });

  // I1: the named-argument set stays closed, and the error names the whole set.
  it("keeps put's named-argument set closed, now naming mask: too", () => {
    const result = run([
      "scene S(width: 4, height: 1)",
      "layer floor z: 0",
      '    put "a" at (0, 0) sideways: 3',
    ]);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/mask/);
    expect(result.error!.message).toMatch(/depth/);
  });
});
describe("the masked map, pinned", () => {
  // Criterion 3 of the stage. The example exists to make the transparency visible:
  // the fog below survives wherever the mask holds a space, which is the one thing a
  // sprite blit would get wrong.
  it("examples/masked_map.qbsk matches its golden byte for byte", () => {
    const source = readFileSync(
      new URL("../../examples/masked_map.qbsk", import.meta.url),
      "utf8",
    );
    const golden = readFileSync(
      new URL("../golden/masked_map.qbsk.out", import.meta.url),
      "utf8",
    );
    const result = runQbsk(source, "masked_map.qbsk");
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n"));
  });

  // Criterion 2: the game had to keep behaving identically, not merely keep running.
  it("crypt.qbsk draws its map through the composite, not a loop", () => {
    const source = readFileSync(
      new URL("../../examples/crypt.qbsk", import.meta.url),
      "utf8",
    );
    expect(source).toContain("put MAP at (0, 0) mask: seen");
    const result = runQbsk(source, "crypt.qbsk");
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toContain("@");
  });
});

describe("the mask is an expression the staticity walk must read", () => {
  // Without this the E1 cache would happily cache a layer drawn through a live mask
  // and redraw last turn's visibility forever — the §9.1 silent-wrong-picture bug,
  // arrived at from the other direction. crypt.qbsk cannot pin it: its map is exposed
  // to `sight` outside the layer, so it is dynamic for a second reason anyway.
  const classify = (source: string) => {
    const parsed = parse(source, "mask-staticity.qbsk");
    expect(parsed.errors).toHaveLength(0);
    return analyzeLayerStaticity(parsed.ast);
  };

  it("a const map through a var mask is dynamic, and says which", () => {
    const layers = classify([
      'const MAP = ["ab", "cd"]',
      'var seen = ["**", "**"]',
      "scene P(width: 2, height: 2)",
      "layer floor z: 0",
      "    put MAP at (0, 0) mask: seen",
    ].join(NEWLINE));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.static).toBe(false);
    expect(layers[0]!.reason).toBe("reads var 'seen'");
  });

  it("a const map through a const mask is still provably static", () => {
    const layers = classify([
      'const MAP = ["ab", "cd"]',
      'const SEEN = ["**", "**"]',
      "scene P(width: 2, height: 2)",
      "layer floor z: 0",
      "    put MAP at (0, 0) mask: SEEN",
    ].join(NEWLINE));
    expect(layers[0]!.static).toBe(true);
  });
});
