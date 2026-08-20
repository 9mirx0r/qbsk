// an earlier release — src/tools/spriteGen.ts, the shared core both bench/sprite-gen.mjs and
// Studio's qbsk_generate_sprite MCP tool call into. Read-only against the real
// examples/lib/pixelart.qbsk (generateSpriteAssets never writes a file itself — only
// the caller does), so no temp directory is needed here.
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSpriteAssets, spriteEdgeGlyphs } from "../../src/tools/spriteGen.js";
import { loadQbdata } from "../../src/parser/qbdata.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const libDir = resolve(root, "examples/lib");

describe("an earlier release: generateSpriteAssets", () => {
  it("same seed and size -> byte-identical qbdata and SVG text", () => {
    const a = generateSpriteAssets(42, 16, libDir, "SPRITE");
    const b = generateSpriteAssets(42, 16, libDir, "SPRITE");
    expect(a.qbdataText).toBe(b.qbdataText);
    expect(a.svgText).toBe(b.svgText);
    expect(a.pixels).toEqual(b.pixels);
  });

  it("a different seed produces a different sprite", () => {
    const a = generateSpriteAssets(1, 16, libDir, "SPRITE");
    const b = generateSpriteAssets(2, 16, libDir, "SPRITE");
    expect(a.pixels).not.toEqual(b.pixels);
  });

  it("width/height/pixel count match the requested size (16 or 32)", () => {
    const s16 = generateSpriteAssets(7, 16, libDir, "SPRITE");
    expect(s16.width).toBe(16);
    expect(s16.height).toBe(16);
    expect(s16.pixels).toHaveLength(256);
    expect(s16.total).toBe(256);

    const s32 = generateSpriteAssets(7, 32, libDir, "SPRITE");
    expect(s32.width).toBe(32);
    expect(s32.height).toBe(32);
    expect(s32.pixels).toHaveLength(1024);
  });

  it("`filled` matches the actual non-zero pixel count", () => {
    const s = generateSpriteAssets(27, 16, libDir, "SPRITE");
    expect(s.filled).toBe(s.pixels.filter((v) => v !== 0).length);
    expect(s.filled).toBeGreaterThan(0);
    expect(s.filled).toBeLessThan(s.total);
  });

  it("the generated qbdata text loads clean through the real qbdata loader", () => {
    const s = generateSpriteAssets(9, 16, libDir, "MYSPRITE");
    const r = loadQbdata(s.qbdataText, "generated.qbdata");
    expect(r.errors).toEqual([]);
    expect([...r.entries.keys()]).toEqual(["MYSPRITE"]);
  });

  it("the generated SVG has one <rect> per filled pixel, none for empty ones", () => {
    const s = generateSpriteAssets(9, 16, libDir, "SPRITE");
    const rectCount = (s.svgText.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(s.filled);
  });

  it("every pixel value is in range: 0 (empty) or a valid palette index", () => {
    const s = generateSpriteAssets(15, 16, libDir, "SPRITE");
    for (const v of s.pixels) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(s.palette.length);
    }
  });
});

// an earlier release (mask-gated generation) — found live: a name/seed alone can't tell you what
// shape came out (the author asked for "an axe" and got an unrelated organic blob,
// because the original generator has no way to target a silhouette at all). `shape`
// selects a hand-authored SILHOUETTES entry; the rest of the pipeline (entropy,
// smoothing, coloring, mirroring) is unchanged.
describe("an earlier release: generateSpriteAssets with `shape`", () => {
  it("an unknown shape name is a clear error, not silent fallback to the blob", () => {
    expect(() => generateSpriteAssets(1, 16, libDir, "SPRITE", "battleaxe")).toThrow(
      /unknown sprite shape 'battleaxe'/,
    );
  });

  it("a shape requested at the wrong size is a clear error, not silent garbage", () => {
    expect(() => generateSpriteAssets(1, 32, libDir, "SPRITE", "sword")).toThrow(
      /authored for 16x16, not 32x32/,
    );
  });

  it("shape='sword' is deterministic — same seed, byte-identical output", () => {
    const a = generateSpriteAssets(27, 16, libDir, "SWORD", "sword");
    const b = generateSpriteAssets(27, 16, libDir, "SWORD", "sword");
    expect(a.pixels).toEqual(b.pixels);
    expect(a.svgText).toBe(b.svgText);
  });

  it("shape='sword' reports the shape name and uses the weapon palette, not the creature one", () => {
    const s = generateSpriteAssets(27, 16, libDir, "SWORD", "sword");
    expect(s.shape).toBe("sword");
    expect(s.palette).toEqual(["#4a4a52", "#7d7d87", "#b0b0ba", "#d4af37", "#8b6914", "#1a1a1e"]);
    expect(s.outlinePaletteIndex).toBe(6);
  });

  it("shape='sword' produces a silhouette taller-than-wide with a wide row (the guard)", () => {
    // A cheap, no-vision-model quality check (the research this phase used
    // recommended exactly this): bounding-box aspect ratio should read as a narrow,
    // upright weapon, and the guard row should be visibly wider than the blade rows.
    const s = generateSpriteAssets(27, 16, libDir, "SWORD", "sword");
    let minX = s.width, maxX = -1, minY = s.height, maxY = -1;
    const rowFill = new Array(s.height).fill(0);
    for (let y = 0; y < s.height; y += 1) {
      for (let x = 0; x < s.width; x += 1) {
        if (s.pixels[y * s.width + x] === 0) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        rowFill[y] += 1;
      }
    }
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    expect(boxHeight).toBeGreaterThan(boxWidth); // taller than wide
    const guardRowFill = Math.max(...rowFill);
    const bladeRowFill = rowFill[4]; // row 4 is blade body per the authored mask
    expect(guardRowFill).toBeGreaterThan(bladeRowFill!);
  });

  it("unmasked generation (no shape) still works, unaffected by SILHOUETTES existing", () => {
    const s = generateSpriteAssets(27, 16, libDir, "CREATURE");
    expect(s.shape).toBeNull();
    expect(s.palette).toEqual(["#2d1b0e", "#5c3d1e", "#8b5a2b", "#c9945a", "#e8c896", "#140b05"]);
    expect(s.outlinePaletteIndex).toBe(6);
  });
});

// an earlier release (character sprites) — owner request, 2026-08-09: a player-character orc
// and an enemy demon, both meant to occupy one tile on the map. Both reuse the SAME
// hand-authored humanoid silhouette (src/tools/spriteGen.ts's HUMANOID_ROWS) — a
// "reskin one rig with a new palette" approach, the same one real character-variant
// sprites use — differentiated only by color, not by a second silhouette each.
describe("an earlier release: generateSpriteAssets with shape='orc'/'demon'", () => {
  it("orc and demon share the exact same silhouette (pixel shape), only colors differ", () => {
    const orc = generateSpriteAssets(27, 16, libDir, "ORC", "orc");
    const demon = generateSpriteAssets(27, 16, libDir, "DEMON", "demon");
    const orcShape = orc.pixels.map((v) => (v === 0 ? 0 : 1));
    const demonShape = demon.pixels.map((v) => (v === 0 ? 0 : 1));
    expect(orcShape).toEqual(demonShape);
    expect(orc.palette).not.toEqual(demon.palette);
  });

  it("orc uses green tones, demon uses red tones — visibly different at a glance", () => {
    const orc = generateSpriteAssets(1, 16, libDir, "ORC", "orc");
    const demon = generateSpriteAssets(1, 16, libDir, "DEMON", "demon");
    expect(orc.palette).toEqual(["#3d5c2e", "#5a7d42", "#7fa35c", "#6b4a2f", "#16210f"]);
    expect(demon.palette).toEqual(["#4a1010", "#7a1f1f", "#a8342f", "#2b2b2b", "#1a0505"]);
  });

  it("both read as a humanoid: wider at the shoulders than at the head", () => {
    for (const [name, shape] of [["orc", "orc"], ["demon", "demon"]] as const) {
      const s = generateSpriteAssets(27, 16, libDir, name.toUpperCase(), shape);
      const rowWidth = (y: number): number => {
        let minX = 16, maxX = -1;
        for (let x = 0; x < 16; x += 1) {
          if (s.pixels[y * 16 + x] === 0) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        return maxX >= minX ? maxX - minX + 1 : 0;
      };
      expect(rowWidth(5)).toBeGreaterThan(rowWidth(0)); // shoulders (row 5) > head (row 0)
    }
  });

  it("both are deterministic — same seed, byte-identical output", () => {
    const a = generateSpriteAssets(42, 16, libDir, "ORC", "orc");
    const b = generateSpriteAssets(42, 16, libDir, "ORC", "orc");
    expect(a.svgText).toBe(b.svgText);
  });

  it("shape='angel' produces a winged celestial silhouette with halo", () => {
    const angel = generateSpriteAssets(77, 16, libDir, "ANGEL", "angel");
    expect(angel.shape).toBe("angel");
    expect(angel.palette).toEqual(["#ffffff", "#f0ece1", "#ffd700", "#fada5e", "#b8d8f8", "#2c2a20"]);
    expect(angel.outlinePaletteIndex).toBe(6);
    expect(angel.filled).toBeGreaterThan(0);
    // Row 0 has the halo, Row 5 has the wide wings
    const row5Filled = angel.pixels.slice(5 * 16, 6 * 16).filter((v) => v !== 0).length;
    const row0Filled = angel.pixels.slice(0, 16).filter((v) => v !== 0).length;
    expect(row5Filled).toBeGreaterThan(row0Filled);
  });
});


// Orientation glyphs from the offline pixel path (docs/engine.md §11.16, an earlier release).
describe("an earlier release: edge orientation from a generated sprite", () => {
  it("a known diagonal edge yields the glyph that runs ALONG it", () => {
    // Criterion 4 of the stage. Built rather than generated so the edge's direction is
    // known before it is measured: the gradient points across an edge, so this is the
    // assertion that catches the rotation being inverted.
    const size = 9;
    const falling = {
      width: size,
      height: size,
      pixels: Array.from({ length: size * size }, (_, i) =>
        Math.floor(i / size) >= i % size ? 1 : 0),
    };
    expect(spriteEdgeGlyphs(falling)[4]![4]).toBe("╲");

    const rising = {
      width: size,
      height: size,
      pixels: Array.from({ length: size * size }, (_, i) =>
        (i % size) + Math.floor(i / size) >= size - 1 ? 1 : 0),
    };
    expect(spriteEdgeGlyphs(rising)[4]![4]).toBe("╱");
  });

  it("a real generated sprite gets edges on its outline and nothing in its middle of nowhere", () => {
    const sprite = generateSpriteAssets(42, 16, libDir, "SPRITE");
    const glyphs = spriteEdgeGlyphs(sprite);
    expect(glyphs).toHaveLength(sprite.height);
    expect(glyphs[0]).toHaveLength(sprite.width);

    const inked = glyphs.join("").split("").filter((c) => c !== " ").length;
    expect(inked, "a sprite with pixels must have edges").toBeGreaterThan(0);
    // Only the four orientation glyphs, never a stray character.
    for (const ch of glyphs.join("").replace(/ /g, "")) {
      expect("─│╱╲").toContain(ch);
    }
  });

  it("is deterministic for a given sprite, like everything else here", () => {
    const a = generateSpriteAssets(7, 16, libDir, "SPRITE");
    const b = generateSpriteAssets(7, 16, libDir, "SPRITE");
    expect(spriteEdgeGlyphs(a)).toEqual(spriteEdgeGlyphs(b));
  });

  it("an empty sprite has no edges to find", () => {
    const blank = { width: 4, height: 4, pixels: new Array(16).fill(0) };
    expect(spriteEdgeGlyphs(blank).join("").trim()).toBe("");
  });
});
