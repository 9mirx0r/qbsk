// GlGrid (docs/studio.md §4.2): the same four methods DomGrid exposes, painting through a
// glyph atlas instead of through one DOM node per cell.
//
// The GPU lives behind a `GlyphDevice`, so what is tested here is the GRID logic — which
// cells were packed, which glyphs were rasterised, how many uploads a frame costs — and
// not whether WebGL was called correctly. The device implementation is the thin half; a
// test that mocked `gl` would assert the shape of the mock.
import { describe, expect, it } from "vitest";
import { GlGrid } from "../../studio/renderer/glgrid.js";
import type { GlyphDevice } from "../../studio/renderer/glgrid.js";
import { CRT_OFF, type CrtSettings } from "../../studio/renderer/glshader.js";
import type { Cell } from "../../src/engine/cell.js";
import type { DiffLine } from "../../src/engine/diff.js";

const cell = (char: string, over: Partial<Cell> = {}): Cell =>
  ({ char, fg: 0xffffff, bg: 0x000000, attrs: 0, ...over }) as Cell;

interface Recorder extends GlyphDevice {
  glyphs: { char: string; slot: number; tile: string | null }[];
  uploads: number;
  draws: number;
  last: { fg: Uint8Array; bg: Uint8Array } | null;
  cells: { w: number; h: number } | null;
  crt: CrtSettings | null;
}

function recorder(): Recorder {
  return {
    glyphs: [], uploads: 0, draws: 0, last: null, cells: null, crt: null,
    resize() {},
    setCrt(crt) { this.crt = crt; },
    setCellSize(w, h) { this.cells = { w, h }; },
    drawGlyph(char, slot, tile) { this.glyphs.push({ char, slot, tile }); },
    upload(fg, bg) { this.uploads += 1; this.last = { fg: fg.slice(), bg: bg.slice() }; },
    draw() { this.draws += 1; },
  };
}

/** A diff that rewrites row `y` with `text`. */
const row = (y: number, text: string): DiffLine => ({
  y, rewrite: true, row: [...text].map((c) => cell(c)), runs: [],
}) as unknown as DiffLine;

describe("GlGrid paints a grid through an atlas", () => {
  it("rasterises each new glyph exactly once, however often it is painted", () => {
    // The property that makes an atlas worth having. "aaa" is one glyph, and painting it
    // again next frame is none.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(4, 2);
    grid.paint([row(0, "aab")]);
    expect(dev.glyphs.map((g) => g.char)).toEqual(["a", "b"]);
    grid.paint([row(1, "aba")]);
    expect(dev.glyphs.map((g) => g.char)).toEqual(["a", "b"]);
  });

  it("costs ONE upload and ONE draw per frame, whatever the diff holds", () => {
    // The whole reason for the change. DomGrid's cost is per changed cell; this is per
    // frame, so a full repaint and a two-cell edit cost the same.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(8, 4);
    grid.paint([row(0, "aaaaaaaa"), row(1, "bbbbbbbb"), row(2, "cccccccc")]);
    expect(dev.uploads).toBe(1);
    expect(dev.draws).toBe(1);
  });

  it("writes a painted cell into the texture at its own texel", () => {
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(3, 2);
    grid.paint([{ y: 1, rewrite: false, runs: [{ x: 2, cells: [cell("Z", { fg: 0x112233 })] }] } as unknown as DiffLine]);
    // Row 1, column 2 of a 3-wide grid is index 5, so byte offset 20.
    const fg = dev.last!.fg;
    expect([fg[20], fg[21], fg[22]]).toEqual([0x11, 0x22, 0x33]);
    // ... and nothing else was touched.
    expect([...fg.slice(0, 20)].every((b) => b === 0)).toBe(true);
  });

  it("reads back the text it painted, so the smoke check still works", () => {
    // DomGrid's `renderText` reads the DOM. There is no DOM here, so the grid keeps what
    // it painted — which it needs anyway to repaint on a tileset change.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(3, 2);
    grid.paint([row(0, "hi")]);
    expect(grid.renderText()).toBe("hi \n   ");
  });

  it("forgets the old scene on resize", () => {
    // A resize that kept the old cells would let them be repainted into a grid they no
    // longer fit — the bug `DomGrid.reset` names in its own comment.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(4, 1);
    grid.paint([row(0, "abcd")]);
    grid.reset(2, 1);
    expect(grid.renderText()).toBe("  ");
  });

  it("repaints everything when a tileset arrives, not just what the diff touches", () => {
    // The defect `DomGrid.setTiles` was written to fix, which a second painter would
    // reintroduce for free: a tileset changes every cell at once and the diff has
    // nothing to say about it.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(2, 1);
    grid.paint([row(0, "ab")]);
    const before = dev.draws;
    grid.setTiles(new Map([["a", "data:image/png;base64,AA"]]));
    expect(dev.draws).toBe(before + 1);
    expect(dev.glyphs.filter((g) => g.tile !== null).map((g) => g.char)).toEqual(["a"]);
  });

  it("re-rasterises a glyph whose tile changed, and drops it when tiles go away", () => {
    // A slot holds pixels, not a character, so the same character with and without a
    // tile is two different pictures in the same slot. Keeping the old one is how a
    // tileset appears to work and then refuses to be turned off.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(2, 1);
    grid.paint([row(0, "ab")]);
    grid.setTiles(new Map([["a", "data:x,1"]]));
    grid.setTiles(null);
    const last = dev.glyphs.slice(-2);
    expect(last.every((g) => g.tile === null)).toBe(true);
  });

  it("passes a new cell size through and repaints at it", () => {
    // The fit recomputes the font size on every resize, and a texture has no font-size to
    // inherit. The first wiring hard-coded 8x16, which renders correctly at exactly one
    // font size and stretches at every other — invisible in a test that never resizes,
    // and the first thing an author sees.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(2, 1);
    grid.paint([row(0, "ab")]);
    const before = dev.draws;
    grid.setCellSize(12, 24);
    expect(dev.cells).toEqual({ w: 12, h: 24 });
    expect(dev.draws).toBe(before + 1);
  });

  it("says nothing about cells the diff did not mention", () => {
    // A run-based diff patches; it does not clear. A painter that zeroed the texture
    // each frame would erase everything the diff considered unchanged.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(3, 1);
    grid.paint([row(0, "xyz")]);
    grid.paint([{ y: 0, rewrite: false, runs: [{ x: 1, cells: [cell("Q")] }] } as unknown as DiffLine]);
    expect(grid.renderText()).toBe("xQz");
  });
});

describe("changing the CRT look", () => {
  it("forwards the settings and redraws, without touching the atlas", () => {
    // The uniforms change; the textures and the atlas do not. Rebuilding the device to
    // change a look would drop both, which on a running scene is a visible stutter for
    // a setting that costs five uniform writes.
    const dev = recorder();
    const grid = new GlGrid(dev);
    grid.reset(4, 1);
    grid.paint([row(0, "ab@d")]);
    const glyphsBefore = dev.glyphs.length;
    const drawsBefore = dev.draws;

    grid.setCrt(CRT_OFF);

    expect(dev.crt).toEqual(CRT_OFF);
    expect(dev.draws).toBe(drawsBefore + 1);
    expect(dev.glyphs.length, "the atlas was re-rasterised").toBe(glyphsBefore);
  });
});
