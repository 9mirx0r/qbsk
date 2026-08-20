// An earlier release — examples/lib/spritesheet.qbsk, cropping a decoded sprite sheet into
// individual cells. Exercises it in isolation via `use` + runQbsk, the same style as
// action_rules.qbsk/population.qbsk/pixelart.qbsk's own tests.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

function run(source: string) {
  return runQbsk(source, "examples/lib/_test.qbsk", undefined, {
    baseDir: "examples/lib",
  });
}

function out(source: string): string[] {
  const r = run(source);
  expect(r.error).toBeNull();
  return r.out;
}

describe("spritesheet.qbsk", () => {
  it("crops the top-left cell (0, 0) out of a 4x4 sheet of 2x2 cells", () => {
    // Sheet, row-major, values are just their own index for a readable expectation:
    //  0  1 |  2  3
    //  4  5 |  6  7
    // -------------
    //  8  9 | 10 11
    // 12 13 | 14 15
    expect(
      out(`
use "spritesheet.qbsk" as sheet
var pixels = [0,1,2,3, 4,5,6,7, 8,9,10,11, 12,13,14,15]
var cell = sheet.cropCell(4, 4, pixels, 2, 2, 0, 0)
print(cell)
`),
    ).toEqual(["[0, 1, 4, 5]"]);
  });

  it("crops the bottom-right cell (1, 1) out of the same sheet", () => {
    expect(
      out(`
use "spritesheet.qbsk" as sheet
var pixels = [0,1,2,3, 4,5,6,7, 8,9,10,11, 12,13,14,15]
var cell = sheet.cropCell(4, 4, pixels, 2, 2, 1, 1)
print(cell)
`),
    ).toEqual(["[10, 11, 14, 15]"]);
  });

  it("crops the top-right cell (1, 0), proving column offset is independent of row", () => {
    expect(
      out(`
use "spritesheet.qbsk" as sheet
var pixels = [0,1,2,3, 4,5,6,7, 8,9,10,11, 12,13,14,15]
var cell = sheet.cropCell(4, 4, pixels, 2, 2, 1, 0)
print(cell)
`),
    ).toEqual(["[2, 3, 6, 7]"]);
  });

  it("gridSize reports how many whole cells fit, floor-dividing a ragged sheet", () => {
    expect(
      out(`
use "spritesheet.qbsk" as sheet
var size = sheet.gridSize(20, 13, 4, 4)
print(size["cols"])
print(size["rows"])
`),
    ).toEqual(["5", "3"]); // 20/4 = 5 exactly; 13/4 = 3.25 -> 3, the trailing row is unused
  });

  it("cellIsEmpty is true only when every pixel in the cell is 0", () => {
    expect(
      out(`
use "spritesheet.qbsk" as sheet
print(sheet.cellIsEmpty([0, 0, 0, 0]))
print(sheet.cellIsEmpty([0, 3, 0, 0]))
`),
    ).toEqual(["true", "false"]);
  });

  it("a full row-by-row crop reconstructs the original sheet, in order", () => {
    const src = `
use "spritesheet.qbsk" as sheet
var pixels = [0,1,2,3, 4,5,6,7, 8,9,10,11, 12,13,14,15]
var size = sheet.gridSize(4, 4, 2, 2)
var row = 0
while row < size["rows"]
    var col = 0
    while col < size["cols"]
        print(sheet.cropCell(4, 4, pixels, 2, 2, col, row))
        col += 1
    row += 1
`;
    expect(out(src)).toEqual(["[0, 1, 4, 5]", "[2, 3, 6, 7]", "[8, 9, 12, 13]", "[10, 11, 14, 15]"]);
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced (library review).
//
// `gridSize` is documented in this library's own header as "the caller's guide for which
// (col, row) pairs are valid to pass to cropCell()". Nothing enforced it, and going past
// it did not fail — the flat index simply ran off the end of a sheet row and into the
// start of the next one, so the cell came back as a MIX OF TWO ROWS with no complaint.
//
// Demonstrated on a 6x4 sheet of numbered pixels with 4x2 cells, where gridSize says one
// column: cropCell(col: 1) answered [4, 5, 6, 7, 10, 11, 12, 13], and 6, 7, 12 and 13
// live on a different row of the sheet. A sprite one column too far to the right is not
// obviously wrong when you look at it — it is plausible garbage, which is the worst kind.
// ---------------------------------------------------------------------------

describe("cropCell stays inside the sheet", () => {
  const NUMBERED = [
    "var px = []",
    "var i = 0",
    "while i < 24",
    "    px = push(px, i)",
    "    i += 1",
  ].join("\n");

  const fails = (call: string): string => {
    const r = run(`use "spritesheet.qbsk" as S\n${NUMBERED}\nprint(str(${call}))`);
    expect(r.error).not.toBeNull();
    return r.error!.message;
  };

  it("refuses a column past the last whole cell", () => {
    // The exact call that used to answer a mix of two rows.
    expect(fails("S.cropCell(6, 4, px, 4, 2, 1, 0)")).toContain("column 1");
  });

  it("refuses a row past the last whole cell", () => {
    expect(fails("S.cropCell(6, 4, px, 4, 2, 0, 2)")).toContain("row 2");
  });

  it("refuses a negative cell coordinate", () => {
    expect(fails("S.cropCell(6, 4, px, 4, 2, 0 - 1, 0)")).toContain("column");
  });

  it("refuses a pixel list that is not the sheet it was told about", () => {
    // 24 pixels is a 6x4 sheet. Called as 8x4, every row would start in the wrong place
    // and the whole crop would be sheared — and the indices stay in range, so nothing
    // would have said so.
    expect(fails("S.cropCell(8, 4, px, 4, 2, 0, 0)")).toContain("32");
  });

  it("refuses a cell size that cannot tile anything", () => {
    expect(fails("S.gridSize(6, 4, 0, 2)")).toContain("at least 1");
    expect(fails("S.cropCell(6, 4, px, 4, 0, 0, 0)")).toContain("at least 1");
  });

  it("still crops every cell gridSize says is there", () => {
    // The guard has to admit exactly what the guide promises, or it would be trading one
    // wrong answer for a refusal of a right one.
    const r = run(
      `use "spritesheet.qbsk" as S\n${NUMBERED}\n` +
        'var g = S.gridSize(6, 4, 4, 2)\n' +
        'var seen = 0\n' +
        'for c in 0 .. g["cols"]\n' +
        '    for w in 0 .. g["rows"]\n' +
        '        seen = seen + len(S.cropCell(6, 4, px, 4, 2, c, w))\n' +
        'print(str(seen))',
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["16"]);
  });
});

