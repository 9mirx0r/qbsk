// Packing a grid into the two data textures the shader reads (docs/studio.md §4.2).
//
// Two RGBA textures, one texel per cell. The colours are obvious; the interesting part is
// that a glyph slot needs more than eight bits and so is split across both alphas, with
// the attribute flags sharing the second. A bit in the wrong place draws the wrong letter
// at the right colour, which is the kind of defect that looks like a font problem.
import { describe, expect, it } from "vitest";
import { GlyphAtlas } from "../../studio/renderer/atlas.js";
import { packCell, SLOT_HIGH_MASK, ATTR_BOLD_BIT, ATTR_UNDERLINE_BIT } from "../../studio/renderer/glpack.js";
import type { Cell } from "../../src/engine/cell.js";

const cell = (over: Partial<Cell> = {}): Cell => ({
  char: "A", fg: 0xff8000, bg: 0x102030, attrs: 0, ...over,
} as Cell);

/** Packs one cell and hands back the eight bytes as two named quads. */
function packed(c: Cell, atlas = new GlyphAtlas(32, 32)) {
  const fg = new Uint8Array(4);
  const bg = new Uint8Array(4);
  packCell(c, atlas, fg, 0, bg, 0);
  return { fg: [...fg], bg: [...bg] };
}

describe("packCell", () => {
  it("splits a colour into its three bytes", () => {
    const p = packed(cell());
    expect(p.fg.slice(0, 3)).toEqual([0xff, 0x80, 0x00]);
    expect(p.bg.slice(0, 3)).toEqual([0x10, 0x20, 0x30]);
  });

  it("carries the glyph slot's low byte in the foreground alpha", () => {
    const atlas = new GlyphAtlas(32, 32);
    atlas.slotOf("A");
    expect(packed(cell({ char: "A" }), atlas).fg[3]).toBe(1);
  });

  it("carries the slot's high bits in the background alpha", () => {
    // A slot above 255 is the case a single alpha channel cannot express, and the one an
    // eight-bit-only implementation gets wrong SILENTLY: slot 256 wraps to 0 and draws a
    // space. Braille reaches slot 256 on its own (§11.15), so this is reached in practice
    // and not only in a test.
    const atlas = new GlyphAtlas(32, 32);
    for (let i = 0; i < 300; i += 1) {
      atlas.slotOf(String.fromCharCode(0x2800 + i));
    }
    const target = String.fromCharCode(0x2800 + 260);
    const slot = atlas.slotOf(target);
    expect(slot).toBeGreaterThan(255);

    const p = packed(cell({ char: target }), atlas);
    expect(p.fg[3]).toBe(slot & 255);
    expect(p.bg[3]! & SLOT_HIGH_MASK).toBe(slot >> 8);
    // And the two halves reassemble into the slot the atlas actually gave.
    expect(((p.bg[3]! & SLOT_HIGH_MASK) << 8) | p.fg[3]!).toBe(slot);
  });

  it("flags bold and underline without disturbing the slot", () => {
    const atlas = new GlyphAtlas(32, 32);
    const plain = packed(cell({ char: "A" }), atlas);
    const bold = packed(cell({ char: "A", attrs: 1 } as Partial<Cell>), atlas);
    const under = packed(cell({ char: "A", attrs: 2 } as Partial<Cell>), atlas);

    expect(bold.bg[3]! & ATTR_BOLD_BIT).toBeTruthy();
    expect(under.bg[3]! & ATTR_UNDERLINE_BIT).toBeTruthy();
    expect(plain.bg[3]! & (ATTR_BOLD_BIT | ATTR_UNDERLINE_BIT)).toBe(0);
    // The slot survives both flags — the assertion that fails if the bits overlap.
    for (const p of [plain, bold, under]) {
      expect(((p.bg[3]! & SLOT_HIGH_MASK) << 8) | p.fg[3]!).toBe(atlas.slotOf("A"));
    }
  });

  it("resolves reverse at pack time by swapping the two colours", () => {
    // The shader never learns about reverse, because there is nothing for it to decide:
    // the swap is exact and free here, and a branch in a fragment shader is neither.
    const p = packed(cell({ attrs: 4 } as Partial<Cell>));
    expect(p.fg.slice(0, 3)).toEqual([0x10, 0x20, 0x30]);
    expect(p.bg.slice(0, 3)).toEqual([0xff, 0x80, 0x00]);
  });

  it("paints a terminal-default colour as the theme's own, not as black", () => {
    // -1 means "inherit" (`cellColor` returns null for it in the DOM painter, and CSS
    // does the rest). A texture has no inheritance, so the default is resolved here —
    // packing -1 as 0xffffff would silently repaint every default cell white.
    const p = packed(cell({ fg: -1, bg: -1 }));
    expect(p.fg.slice(0, 3)).toEqual([0xcc, 0xcc, 0xcc]);
    expect(p.bg.slice(0, 3)).toEqual([0x00, 0x00, 0x00]);
  });

  it("writes at the offset it is given, leaving its neighbours alone", () => {
    // The painter packs a whole grid into one array, so an off-by-one here corrupts the
    // cell next door rather than failing.
    const fg = new Uint8Array(12);
    const bg = new Uint8Array(12);
    packCell(cell(), new GlyphAtlas(32, 32), fg, 4, bg, 4);
    expect([...fg.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...fg.slice(8)]).toEqual([0, 0, 0, 0]);
    expect(fg[4]).toBe(0xff);
  });
});
