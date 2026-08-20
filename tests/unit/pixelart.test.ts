// an earlier release — procedural pixel-art generation (the roadmap).
// Exercises examples/lib/pixelart.qbsk in isolation via `use` + runQbsk, the same style
// as an earlier release's action_rules tests and an earlier release's population tests. Only `generate()` is
// exported (module-private helpers aren't reachable from outside), so every test drives
// the full seed -> smooth -> color -> mirror pipeline through it.
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

describe("an earlier release: pixelart.qbsk", () => {
  it("fillChance 0.0 produces an entirely empty sprite, any rolls", () => {
    // No cell can seed as filled (a [0,1) roll is never < 0.0), so no neighbor is ever
    // filled either — the smoothing pass has nothing to spread, at any threshold.
    // Output is the FULL (mirrored) grid: halfWidth 2 * 2 * height 4 = 16 cells.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4]
var colorRolls = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
var pixels = art.generate(2, 4, fillRolls, colorRolls, 3, 0.0, 0, 1, 3, 0)
print(pixels)
`),
    ).toEqual(["[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]"]);
  });

  it("fillChance 1.0 + surviveThreshold 0 + a 1-color palette fills every pixel", () => {
    // Every cell seeds filled (any [0,1) roll is < 1.0); surviveThreshold 0 means a
    // filled cell always survives (count >= 0 is always true, regardless of
    // neighbors); paletteSize 1 means every filled cell's color index resolves to 1.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.1, 0.5, 0.9, 0.3]
var colorRolls = [0.0, 0.0, 0.0, 0.0]
var pixels = art.generate(2, 2, fillRolls, colorRolls, 1, 1.0, 0, 9, 3, 0)
print(pixels)
`),
    ).toEqual(["[1, 1, 1, 1, 1, 1, 1, 1]"]);
  });

  it("mirrors a half-row into a palindrome, hand-computed", () => {
    // halfWidth=2, height=1: seed [1, 0] (0.0 < 0.5, 0.9 is not). surviveThreshold=0
    // keeps the filled cell filled no matter how isolated it is; growThreshold=9 is
    // unreachable in a 2x1 grid (at most 1 real neighbor exists) so the empty cell
    // never gets infected — smoothing is a deliberate no-op here, decoupled thresholds
    // making that possible (a single shared threshold cannot do both at once).
    // colorRolls=[0.0, 0.0] with paletteSize=2 colors the one filled cell as 1.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.0, 0.9]
var colorRolls = [0.0, 0.0]
var pixels = art.generate(2, 1, fillRolls, colorRolls, 2, 0.5, 0, 9, 3, 0)
print(pixels)
`),
    ).toEqual(["[1, 0, 0, 1]"]);
  });

  it("same inputs, same output — deterministic, no hidden randomness", () => {
    const src = `
use "pixelart.qbsk" as art
var fillRolls = [0.2, 0.6, 0.4, 0.8, 0.1, 0.9, 0.3, 0.5]
var colorRolls = [0.1, 0.4, 0.7, 0.2, 0.9, 0.3, 0.6, 0.8]
var a = art.generate(2, 4, fillRolls, colorRolls, 4, 0.5, 1, 5, 3, 0)
var b = art.generate(2, 4, fillRolls, colorRolls, 4, 0.5, 1, 5, 3, 0)
print(a == b)
`;
    expect(out(src)).toEqual(["true"]);
  });

  it("output length is always (halfWidth*2)*height", () => {
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75]
var colorRolls = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75]
var pixels = art.generate(4, 4, fillRolls, colorRolls, 3, 0.5, 1, 5, 3, 0)
print(len(pixels))
`),
    ).toEqual(["32"]);
  });

  it("a color index is never 0 (empty) on a filled cell, never > paletteSize", () => {
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.0, 0.0, 0.0, 0.0]
var colorRolls = [0.999, 0.999, 0.999, 0.999]
var pixels = art.generate(2, 2, fillRolls, colorRolls, 3, 1.0, 0, 9, 3, 0)
print(pixels)
`),
    ).toEqual(["[3, 3, 3, 3, 3, 3, 3, 3]"]);
  });

});

// an earlier release (mask-gated generation) — generateMasked() adds a tri-state silhouette mask
// (0=never, 1=maybe, 2=always) on top of the exact same seed->smooth->color->mirror
// pipeline generate() already uses. Found live: a pure symmetric blob has no way to
// target a recognizable shape (a sword, an axe) — every technique that DOES produce one
// encodes its structure by hand somewhere (06-active-language-phases.md's an earlier release
// research). This is that: the cheapest version of "somewhere."
describe("an earlier release: pixelart.qbsk generateMasked()", () => {
  it("an all-never mask forces every pixel empty, regardless of rolls or fillChance", () => {
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.1, 0.5, 0.9, 0.3]
var colorRolls = [0.0, 0.0, 0.0, 0.0]
var mask = [0, 0, 0, 0]
var pixels = art.generateMasked(2, 2, fillRolls, colorRolls, 3, 1.0, 2, 4, 2, mask, 0)
print(pixels)
`),
    ).toEqual(["[0, 0, 0, 0, 0, 0, 0, 0]"]);
  });

  it("an all-always mask forces every pixel filled, regardless of rolls or fillChance", () => {
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.1, 0.5, 0.9, 0.3]
var colorRolls = [0.0, 0.0, 0.0, 0.0]
var mask = [2, 2, 2, 2]
var pixels = art.generateMasked(2, 2, fillRolls, colorRolls, 1, 0.0, 2, 4, 2, mask, 0)
print(pixels)
`),
    ).toEqual(["[1, 1, 1, 1, 1, 1, 1, 1]"]);
  });

  it("an all-maybe mask (every cell 1) is identical to calling generate() directly", () => {
    const src = `
use "pixelart.qbsk" as art
var fillRolls = [0.2, 0.6, 0.4, 0.8, 0.1, 0.9, 0.3, 0.5]
var colorRolls = [0.1, 0.4, 0.7, 0.2, 0.9, 0.3, 0.6, 0.8]
var mask = [1, 1, 1, 1, 1, 1, 1, 1]
var a = art.generate(2, 4, fillRolls, colorRolls, 4, 0.5, 1, 5, 3, 0)
var b = art.generateMasked(2, 4, fillRolls, colorRolls, 4, 0.5, 1, 5, 3, mask, 0)
print(a == b)
`;
    expect(out(src)).toEqual(["true"]);
  });

  it("an 'always' cell stays filled even though its own roll never would have seeded it", () => {
    // fillChance 0.0 means nothing would ever seed on its own (an earlier release's first
    // suite already proved this for generate()) — the mask is what overrides that.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.9, 0.9]
var colorRolls = [0.0, 0.0]
var mask = [2, 0]
var pixels = art.generateMasked(2, 1, fillRolls, colorRolls, 2, 0.0, 0, 9, 2, mask, 0)
print(pixels)
`),
    ).toEqual(["[1, 0, 0, 1]"]);
  });

  it("a 'never' cell stays empty even though its own roll would have seeded it", () => {
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.0, 0.0]
var colorRolls = [0.0, 0.0]
var mask = [1, 0]
var pixels = art.generateMasked(2, 1, fillRolls, colorRolls, 2, 1.0, 0, 9, 2, mask, 0)
print(pixels)
`),
    ).toEqual(["[1, 0, 0, 1]"]);
  });

  it("growThreshold spreads fill into a surrounded empty cell", () => {
    // 3x3 half-grid, the center (index 4) is the ONLY empty seed — every other cell
    // (the 8 around it) is filled. surviveThreshold=0 keeps every already-filled cell
    // filled regardless of its own neighbor count; growThreshold=8 requires ALL 8
    // neighbors filled to grow, which is exactly the center's situation. Since the
    // center was the one cell not already filled, a fully-filled result after
    // smoothing is only possible if growth actually flipped it — corners/edges alone
    // could never produce an all-filled grid on their own. Mirrored: 3-wide half
    // becomes 6-wide, 3 tall = 18 cells, every one now color index 1.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.0, 0.0, 0.0, 0.0, 0.9, 0.0, 0.0, 0.0, 0.0]
var colorRolls = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
var pixels = art.generate(3, 3, fillRolls, colorRolls, 1, 0.5, 0, 8, 3, 0)
print(pixels)
`),
    ).toEqual(["[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]"]);
  });
});

// an earlier release (outline pass) — found by comparing against real reference sprites
// (Dwarf Fortress's own item/creature graphics, 06-active-language-phases.md's Phase
// 32 entry): a filled silhouette with no border reads as "raw fill," not as an
// intentional object — everything in the reference material has an outline. This adds
// exactly that, as a pass over the already-colored grid.
describe("an earlier release: pixelart.qbsk applyOutline (via generateMasked's outlineIndex)", () => {
  it("an outlineIndex of 0 is a real no-op — byte-identical to before this feature existed", () => {
    // mask=[2, 0]: cell 0 always filled, cell 1 always empty, deterministically.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.9, 0.9]
var colorRolls = [0.0, 0.0]
var mask = [2, 0]
var pixels = art.generateMasked(2, 1, fillRolls, colorRolls, 1, 0.0, 0, 9, 1, mask, 0)
print(pixels)
`),
    ).toEqual(["[1, 0, 0, 1]"]);
  });

  it("a non-zero outlineIndex borders the filled cell without overwriting it", () => {
    // Same shape as above, outlineIndex=9 this time: the empty neighbor becomes 9
    // (border), the filled cell stays 1 (its own color, not overwritten).
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.9, 0.9]
var colorRolls = [0.0, 0.0]
var mask = [2, 0]
var pixels = art.generateMasked(2, 1, fillRolls, colorRolls, 1, 0.0, 0, 9, 1, mask, 9)
print(pixels)
`),
    ).toEqual(["[1, 9, 9, 1]"]);
  });

  it("an empty cell with no filled neighbor stays empty, not outlined", () => {
    // mask all-never: nothing is ever filled, so nothing should ever be bordered
    // either — an outline only exists next to something real.
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.9, 0.9]
var colorRolls = [0.0, 0.0]
var mask = [0, 0]
var pixels = art.generateMasked(2, 1, fillRolls, colorRolls, 1, 1.0, 0, 9, 1, mask, 9)
print(pixels)
`),
    ).toEqual(["[0, 0, 0, 0]"]);
  });

  it("generate() (unmasked) also supports an outline, same convention", () => {
    expect(
      out(`
use "pixelart.qbsk" as art
var fillRolls = [0.0, 0.9]
var colorRolls = [0.0, 0.0]
var pixels = art.generate(2, 1, fillRolls, colorRolls, 1, 0.5, 0, 9, 1, 9)
print(pixels)
`),
    ).toEqual(["[1, 9, 9, 1]"]);
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced (library review).
//
// `generateMasked` walks `i < halfWidth * height` reading `mask[i]`. A mask SHORTER than
// that ran off the end and reported an index error from inside a private helper, naming
// nothing the caller passed. A mask LONGER than that silently ignored the extra entries
// — so a silhouette authored at one size, used at another, produced a different shape
// with no complaint, which is precisely the failure this whole feature exists to avoid:
// the mask is the authored part, the only part that is not noise.
// ---------------------------------------------------------------------------

describe("generateMasked insists the mask is the shape it was told", () => {
  const NL = "\n";
  const rolls = (n: number): string =>
    "[" + Array.from({ length: n }, (_, i) => ((i * 37) % 100) / 100).map((v) => v.toFixed(2)).join(", ") + "]";

  const call = (maskLen: number): string =>
    [
      'use "pixelart.qbsk" as art',
      `var m = []`,
      `var k = 0`,
      `while k < ${maskLen}`,
      `    m = push(m, 1)`,
      `    k += 1`,
      `print(str(len(art.generateMasked(3, 4, ${rolls(12)}, ${rolls(12)}, 3, 0.5, 4, 5, 2, m, 0))))`,
    ].join(NL);

  it("refuses a mask with too few cells", () => {
    const r = run(call(6));
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("12");
  });

  it("refuses a mask with too many, which used to be silently ignored", () => {
    const r = run(call(20));
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("12");
  });

  it("still generates when the mask is exactly the half-grid", () => {
    // 3 wide by 4 tall is twelve cells in the half-grid, and the mirrored output is
    // twenty-four. The guard has to admit this or the feature stops working.
    const r = run(call(12));
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["24"]);
  });
});

