// line ... style: stroke (docs/engine.md §11.16).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

function run(lines: string[]) {
  return runQbsk(lines.join("\n"), "orientation.qbsk");
}

function grid(lines: string[]): string[] {
  const result = run(lines);
  expect(result.error?.message ?? null).toBeNull();
  return result.canvas!.renderText().split("\n");
}

describe("line style: stroke picks the glyph from the direction", () => {
  it("draws a flat line with the horizontal glyph", () => {
    expect(grid([
      "scene S(width: 5, height: 1)",
      "layer l z: 0",
      "    line (0, 0) to (4, 0) style: stroke",
    ])).toEqual(["─────"]);
  });

  it("draws a plumb line with the vertical glyph", () => {
    expect(grid([
      "scene S(width: 1, height: 3)",
      "layer l z: 0",
      "    line (0, 0) to (0, 2) style: stroke",
    ])).toEqual(["│", "│", "│"]);
  });

  // Two across and one down is 45 degrees ON SCREEN, because a cell is one wide and
  // two tall. It reads as a diagonal only because the angle is aspect-corrected.
  it("draws a true on-screen diagonal as a diagonal", () => {
    const rows = grid([
      "scene S(width: 3, height: 2)",
      "layer l z: 0",
      "    line (0, 0) to (2, 1) style: stroke",
    ]);
    expect(rows.join("")).toContain("╲");
  });

  it("rises and falls with the quadrant, y growing downward", () => {
    expect(grid([
      "scene S(width: 3, height: 2)",
      "layer l z: 0",
      "    line (0, 1) to (2, 0) style: stroke",
    ]).join("")).toContain("╱");
  });

  // Criterion 3 of the stage: absent style means nothing changed, which is what lets
  // every existing golden pass untouched.
  it("draws the same '*' it always did when no style is asked for", () => {
    expect(grid([
      "scene S(width: 5, height: 1)",
      "layer l z: 0",
      "    line (0, 0) to (4, 0)",
    ])).toEqual(["*****"]);
  });

  // I1: the set is closed, and an unknown name reports at parse time rather than
  // falling through to a default that would draw something looking deliberate.
  it("reports an unknown style, and suggests", () => {
    const result = run([
      "scene S(width: 5, height: 1)",
      "layer l z: 0",
      "    line (0, 0) to (4, 0) style: strke",
    ]);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/not a line style/);
    expect(result.error!.message).toMatch(/did you mean 'stroke'/);
  });

  it("takes the layer's colour like any other primitive", () => {
    const result = run([
      "scene S(width: 3, height: 1)",
      "layer l z: 0",
      "    color fg: bright-red",
      "    line (0, 0) to (2, 0) style: stroke",
    ]);
    expect(result.error).toBeNull();
    expect(result.canvas!.cells[0]!.fg).not.toBe(-1);
  });
});

describe("the orientation example is pinned", () => {
  // Criterion 1: density-only beside density+orientation, and the difference has to be
  // visible in the BYTES rather than merely claimed.
  it("examples/orientation.qbsk matches its golden byte for byte", () => {
    const source = readFileSync(
      new URL("../../examples/orientation.qbsk", import.meta.url),
      "utf8",
    );
    const golden = readFileSync(
      new URL("../golden/orientation.qbsk.out", import.meta.url),
      "utf8",
    );
    const result = runQbsk(source, "orientation.qbsk");
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n"));
  });

  it("the two halves really do differ, glyph for glyph", () => {
    const golden = readFileSync(
      new URL("../golden/orientation.qbsk.out", import.meta.url),
      "utf8",
    ).split(/\r?\n/);

    let inked = 0;
    let differing = 0;
    for (const row of golden) {
      const left = row.slice(0, 31);
      const right = row.slice(31);
      for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
        if (left[i] !== " " || right[i] !== " ") {
          inked += 1;
          if (left[i] !== right[i]) differing += 1;
        }
      }
    }
    expect(inked).toBeGreaterThan(50);
    // Nearly every inked cell changes: the left half is all '*', the right is four
    // different glyphs chosen per line.
    expect(differing / inked).toBeGreaterThan(0.9);
  });

  it("shows all four orientation glyphs, so the example exercises the whole rule", () => {
    const golden = readFileSync(
      new URL("../golden/orientation.qbsk.out", import.meta.url),
      "utf8",
    );
    for (const glyph of ["─", "│", "╱", "╲"]) {
      expect(golden, `the example must draw ${glyph}`).toContain(glyph);
    }
    expect(golden, "and the untouched default beside them").toContain("*");
  });
});

describe("a scene composes at the cell aspect it was given", () => {
  // 10 across and 3 down is a slope of 0.3, inside the band where a 1:2 cell and a
  // 1:1.667 one disagree (docs/engine.md §11.16). Integer endpoints, so the line
  // primitive can actually draw it.
  const source = [
    "scene Slope(width: 11, height: 4)",
    "layer l z: 0",
    "    fill \" \"",
    "    line (0, 0) to (10, 3) style: stroke",
  ].join("\n");

  const glyphsOf = (cellAspect?: number) => {
    const result = runQbsk(source, "slope.qbsk", undefined, { cellAspect });
    expect(result.error?.message ?? null).toBeNull();
    const drawn = new Set(result.canvas!.renderText().replace(/[\s\n]/g, "").split(""));
    return [...drawn];
  };

  it("draws the diagonal on a 1:2 cell and the horizontal on a wider one", () => {
    expect(glyphsOf(2.0)).toEqual(["╲"]);
    expect(glyphsOf(1 / 0.6)).toEqual(["─"]);
  });

  it("composes exactly as before when no aspect is given", () => {
    expect(glyphsOf(undefined)).toEqual(glyphsOf(2.0));
  });

  // The aspect comes from InterpOptions, so a bad one is the HOST misconfiguring the
  // run, not an author writing bad QBSK. It therefore throws rather than arriving as a
  // RunResult error with a span — there is no source location to point at. It also
  // throws at construction, so a scene that draws no strokes still reports instead of
  // accepting an impossible cell shape until someone adds a diagonal.
  it("rejects an impossible cell shape when the run is set up, not when a stroke is drawn", () => {
    expect(() => runQbsk(source, "slope.qbsk", undefined, { cellAspect: 0 }))
      .toThrow(/cell aspect/);
    const noStrokes = "scene S(width: 2, height: 2)\nlayer l z: 0\n    fill \" \"";
    expect(() => runQbsk(noStrokes, "s.qbsk", undefined, { cellAspect: -1 }))
      .toThrow(/cell aspect/);
  });
});
