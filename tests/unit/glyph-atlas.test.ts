// The glyph atlas (docs/studio.md §4.2): characters to texture slots.
//
// Pure, and deliberately separated from anything that touches WebGL. Slot assignment is
// where a GPU painter is actually wrong or right — a shader that samples the wrong cell
// of the atlas draws the wrong letter, and no amount of GL mocking finds that. The GL
// calls themselves are four lines and are checked with a fake context.
import { describe, expect, it } from "vitest";
import { GlyphAtlas } from "../../studio/renderer/atlas.js";

describe("GlyphAtlas assigns slots", () => {
  it("reserves slot 0 for the space, so an unwritten cell draws nothing", () => {
    // The fg/bg textures start as zeroed bytes, which means slot 0 for every cell. If
    // slot 0 held whatever character happened to be seen first, a grid would come up
    // tiled with it before anything was painted.
    const atlas = new GlyphAtlas(4, 4);
    expect(atlas.slotOf(" ")).toBe(0);
    expect(atlas.slotOf("A")).toBe(1);
  });

  it("gives the same character the same slot every time", () => {
    const atlas = new GlyphAtlas(4, 4);
    const first = atlas.slotOf("█");
    expect(atlas.slotOf("█")).toBe(first);
    atlas.slotOf("x");
    expect(atlas.slotOf("█")).toBe(first);
  });

  it("reports each newly assigned character exactly once, for rasterising", () => {
    // The caller draws only what is pending, because rasterising the whole atlas on
    // every new glyph is how a painter that was supposed to be fast stops being one.
    const atlas = new GlyphAtlas(4, 4);
    atlas.slotOf("a");
    atlas.slotOf("b");
    atlas.slotOf("a");
    expect(atlas.takePending()).toEqual([
      { char: "a", slot: 1 },
      { char: "b", slot: 2 },
    ]);
    expect(atlas.takePending()).toEqual([]);
  });

  it("places a slot at the right pixel, counting across then down", () => {
    const atlas = new GlyphAtlas(4, 4, 16, 32);
    expect(atlas.pixelOf(0)).toEqual({ x: 0, y: 0 });
    expect(atlas.pixelOf(3)).toEqual({ x: 48, y: 0 });
    expect(atlas.pixelOf(4)).toEqual({ x: 0, y: 32 });
    expect(atlas.pixelOf(15)).toEqual({ x: 48, y: 96 });
  });

  it("sizes its texture from the slot grid and the cell", () => {
    const atlas = new GlyphAtlas(32, 32, 16, 32);
    expect(atlas.textureWidth).toBe(512);
    expect(atlas.textureHeight).toBe(1024);
    expect(atlas.capacity).toBe(1024);
  });

  // --- Overflow: the case a fixed atlas cannot avoid, only handle -----------------

  it("falls back to the space and SAYS SO when it runs out of slots", () => {
    // A 2x2 atlas holds four glyphs. The fifth has nowhere to go.
    //
    // Silence here would be §14's shape exactly: the wrong glyph on screen, no error,
    // and a bug reported as "sometimes a character is missing". `overflowed` is what an
    // author can be told, and the fallback is the space rather than an arbitrary slot,
    // because a blank reads as absence instead of as a different letter.
    const atlas = new GlyphAtlas(2, 2);
    for (const ch of ["a", "b", "c"]) {
      expect(atlas.slotOf(ch)).toBeGreaterThan(0);
    }
    expect(atlas.overflowed).toBe(false);
    expect(atlas.slotOf("d")).toBe(0);
    expect(atlas.overflowed).toBe(true);
    expect(atlas.overflowedChars).toEqual(["d"]);
  });

  it("keeps serving the characters it did fit after overflowing", () => {
    // Overflow must degrade, not break. The glyphs already placed keep their slots.
    const atlas = new GlyphAtlas(2, 2);
    const a = atlas.slotOf("a");
    atlas.slotOf("b");
    atlas.slotOf("c");
    atlas.slotOf("d");
    expect(atlas.slotOf("a")).toBe(a);
  });

  it("holds every braille cell and the box-drawing set at its real size", () => {
    // 1024 slots is not a round number picked for looks. Braille alone is 256
    // characters (§11.15) and QBSK draws with them; a 16x16 atlas would overflow on a
    // single braille scene.
    const atlas = new GlyphAtlas(32, 32);
    for (let i = 0; i < 256; i += 1) {
      atlas.slotOf(String.fromCharCode(0x2800 + i));
    }
    for (let i = 0; i < 128; i += 1) {
      atlas.slotOf(String.fromCharCode(0x2500 + i));
    }
    expect(atlas.overflowed).toBe(false);
  });
});
