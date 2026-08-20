// an earlier release — shared core for procedural pixel-art generation. One implementation, used
// by both bench/sprite-gen.mjs (CLI) and Studio's `qbsk_generate_sprite` MCP tool
// (studio/mcp/session.ts) — not two copies of the same entropy-plus-QBSK-call pipeline.
//
// Calls into examples/lib/pixelart.qbsk through runQbsk(), exactly the way
// tests/unit/pixelart.test.ts does — this module supplies only what QBSK genuinely
// cannot do itself (entropy: no bitwise ops for a seeded PRNG; file output: no
// file-write native, both checked against the code, not assumed) and never
// reimplements the generation algorithm in TypeScript.
import { runQbsk } from "../interp/interpreter.js";
import { mulberry32, streamSeed } from "../util/random.js";
import { edgeGlyph, sobelAt } from "../engine/stroke.js";

// A small, original earthy/creature palette — hand-authored content, not generated.
// Index 0 is reserved for "empty" (pixelart.qbsk's own convention) and never appears
// here. Used for unmasked (free-form blob) generation. `OUTLINE` is appended as the
// LAST palette entry at generation time (see buildPalette below), never mixed into the
// fill-color roll range.
const CREATURE_FILL_COLORS = ["#2d1b0e", "#5c3d1e", "#8b5a2b", "#c9945a", "#e8c896"];
const CREATURE_OUTLINE = "#140b05";

// Tuned by rendering and looking (06-active-language-phases.md's an earlier release entry records
// what was tried and rejected before landing here): a single smoothing pass gave a
// scattered checkerboard; a higher threshold with 4 passes eroded almost everything
// away. FILL_CHANCE dropped from 0.45 to 0.30 after the outline pass (below) was added
// and rendered: at 0.45 the blob already covered ~65% of the canvas, so the outline
// pass had almost no real background left to border INTO and the render came out
// nearly solid dark instead of a bordered shape. 0.30 leaves enough open canvas for the
// border to actually read as a border.
const FILL_CHANCE = 0.3;
const SURVIVE_THRESHOLD = 2;
const GROW_THRESHOLD = 4;
const ITERATIONS = 2;

// Mask-gated silhouettes (an earlier release's "found live" extension): a hand-authored tri-state
// template per named shape, gating the SAME seed/smooth/color/mirror pipeline instead
// of replacing it (06-active-language-phases.md's an earlier release research — every technique
// that produces a recognizable shape encodes its structure by hand somewhere; this is
// the cheapest version of "somewhere"). One row = one string, one character per
// half-column, read edge-to-center (examples/lib/pixelart.qbsk's `mirror()` maps
// half-column 0 to the outer edge and the LAST half-column to the image center) —
// '0' never, '1' maybe (real noise/CA texture), '2' always.
//
// The sword mask below has ZERO '1's, unlike its first version — found by comparing
// against Dwarf Fortress's own item_weapons.png (06-active-language-phases.md's Phase
// 32 entry): real weapon sprites are precise, deliberate line art with no internal
// noise; noise/texture belongs on MATERIALS (stone, wood grain), not on a discrete
// object's silhouette. Every cell that used to be "maybe" is now a definite choice.
// Narrow head (3 rows) -> neck (1) -> wide shoulders/arms (4) -> narrowing torso (2) ->
// hips (1) -> narrow legs/feet (5). 16 rows, halfWidth 8 — the same "occupies one tile"
// scale the creature/sword sprites already use.
const HUMANOID_ROWS = [
  "00000002",
  "00000022",
  "00000022",
  "00000002",
  "00022222",
  "00022222",
  "00022222",
  "00022222",
  "00002222",
  "00002222",
  "00000022",
  "00000022",
  "00000022",
  "00000022",
  "00000022",
  "00000022",
];

// Builds one mask row of `halfWidth` chars: '0' everywhere except the given inclusive
// [start,end] column ranges, which get `fillChar` ('2'=always by default). Replaces
// hand-counting characters in a 16- or 8-char string by eye — the sword/orc/demon rows
// above were authored before this helper existed and stayed as literals since they're
// already verified; every silhouette added after this comment uses rowStr so a
// miscounted column is a visible off-by-one in the generated function call, not a typo
// buried in 32 rows of "0002220000000000".
function rowStr(halfWidth: number, ranges: Array<[number, number, string?]>): string {
  const chars = new Array(halfWidth).fill("0");
  for (const [start, end, fillChar] of ranges) {
    for (let i = start; i <= end; i += 1) chars[i] = fillChar ?? "2";
  }
  return chars.join("");
}

const SILHOUETTES: Record<
  string,
  { halfWidth: number; height: number; rows: string[]; fillColors: string[]; outline: string }
> = {
  sword: {
    halfWidth: 8,
    height: 16,
    // Point tip (2 rows) -> blade body (8 rows) -> cross-guard (1 row, flares wide) ->
    // grip (3 rows, narrow) -> pommel (1 row) -> pommel base (1 row). 16 rows total.
    rows: [
      "00000002",
      "00000002",
      "00000022",
      "00000022",
      "00000022",
      "00000022",
      "00000022",
      "00000022",
      "00000022",
      "00000022",
      "00022222",
      "00000002",
      "00000002",
      "00000002",
      "00000022",
      "00000002",
    ],
    // Steel blade tones + a gold guard/pommel accent — a weapon palette, deliberately
    // not the creature palette's earthy browns.
    fillColors: ["#4a4a52", "#7d7d87", "#b0b0ba", "#d4af37", "#8b6914"],
    outline: "#1a1a1e",
  },
  // A shared humanoid silhouette (owner request, 2026-08-09: a player-character orc and
  // an enemy demon, both "occupy a tile on the map"): narrow head, wide shoulders/arms,
  // narrowing torso, narrow legs — the same "reskin one rig with a new palette" approach
  // real games use for character variants, not a new shape per creature. Zero '1's, same
  // reasoning as sword: a character's silhouette reads better precise than noisy.
  orc: {
    halfWidth: 8,
    height: 16,
    rows: HUMANOID_ROWS,
    // Swamp-green skin + a leather-brown accent (armor/loincloth).
    fillColors: ["#3d5c2e", "#5a7d42", "#7fa35c", "#6b4a2f"],
    outline: "#16210f",
  },
  demon: {
    halfWidth: 8,
    height: 16,
    rows: HUMANOID_ROWS,
    // Blood-red skin + a charcoal accent (horns/hooves read dark against red).
    fillColors: ["#4a1010", "#7a1f1f", "#a8342f", "#2b2b2b"],
    outline: "#1a0505",
  },
  // Owner request, 2026-08-09: a third reskin of HUMANOID_ROWS — bone tones instead of
  // skin tones. Same "one rig, new palette" reasoning as orc/demon.
  skeleton: {
    halfWidth: 8,
    height: 16,
    rows: HUMANOID_ROWS,
    fillColors: ["#e8e4d0", "#c9c4a8", "#a8a385"],
    outline: "#3a3628",
  },
  angel: {
    halfWidth: 8,
    height: 16,
    // Halo (row 0), head (rows 2-3), winged shoulders (rows 4-7),
    // and flowing celestial robe (rows 8-15).
    rows: [
      rowStr(8, [[5, 7]]),
      rowStr(8, []),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[1, 3], [7, 7]]),
      rowStr(8, [[0, 7]]),
      rowStr(8, [[0, 7]]),
      rowStr(8, [[1, 7]]),
      rowStr(8, [[2, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[4, 7]]),
      rowStr(8, [[4, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[2, 7]]),
      rowStr(8, [[2, 7]]),
    ],
    fillColors: ["#ffffff", "#f0ece1", "#ffd700", "#fada5e", "#b8d8f8"],
    outline: "#2c2a20",
  },


  // Resources/vegetation (owner request, 2026-08-09: prompts for a set of map assets —
  // 06-active-language-phases.md's an earlier release entry has the full list). Discrete objects
  // get a SILHOUETTES mask like the creatures above; ironOre and farmland are texture
  // fills instead (TERRAIN below), since the prompts describe them as filling the whole
  // tile ("rock wall with metallic flecks", "tilled soil rows"), not a bounded object.
  oakTree: {
    halfWidth: 8,
    height: 16,
    // Round canopy (rows 2-8, widening then narrowing) over a narrow trunk (rows 9-15,
    // hugging the mirror edge so it reads as a single ~4px-wide trunk after mirroring).
    rows: [
      rowStr(8, []),
      rowStr(8, []),
      rowStr(8, [[5, 7]]),
      rowStr(8, [[4, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[4, 7]]),
      rowStr(8, [[5, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[6, 7]]),
    ],
    fillColors: ["#3d2817", "#4a7c3f", "#5f9950", "#77b562"],
    outline: "#1f1610",
  },
  boulder: {
    halfWidth: 8,
    height: 16,
    // A rounded blob, narrow top and bottom, wide middle — the same "occupies a tile"
    // scale as everything else, no separate object riding on it.
    rows: [
      rowStr(8, []),
      rowStr(8, [[6, 7]]),
      rowStr(8, [[5, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[2, 7]]),
      rowStr(8, [[1, 7]]),
      rowStr(8, [[1, 7]]),
      rowStr(8, [[0, 7]]),
      rowStr(8, [[0, 7]]),
      rowStr(8, [[0, 7]]),
      rowStr(8, [[1, 7]]),
      rowStr(8, [[1, 7]]),
      rowStr(8, [[2, 7]]),
      rowStr(8, [[3, 7]]),
      rowStr(8, [[5, 7]]),
      rowStr(8, [[6, 7]]),
    ],
    fillColors: ["#6b6b6b", "#8a8a8a", "#5c5c5c"],
    outline: "#333333",
  },

  // Structures/settlements (owner request, 2026-08-09). 32x32 icons, halfWidth 16.
  // Simplified/iconic on purpose — the same "one recognizable silhouette, not a
  // detailed illustration" choice sword/HUMANOID_ROWS already made, for the same
  // reason: a 32x32 map icon reads better crisp than busy.
  castle: {
    halfWidth: 16,
    height: 32,
    // Flag+pole (rows 2-7) over a crenellated tower (row 8 notches, rows 9-19 shaft);
    // rows 20-31 widen the fill from the tower (cols 2-6) out to the mirror line (col
    // 15), so mirroring produces two corner towers joined by a shorter connecting wall.
    rows: [
      rowStr(16, []),
      rowStr(16, []),
      rowStr(16, [[3, 5]]),
      rowStr(16, [[3, 5]]),
      rowStr(16, [[4, 4]]),
      rowStr(16, [[4, 4]]),
      rowStr(16, [[4, 4]]),
      rowStr(16, [[4, 4]]),
      rowStr(16, [[2, 2], [4, 4], [6, 6]]),
      ...Array.from({ length: 11 }, () => rowStr(16, [[2, 6]])),
      ...Array.from({ length: 12 }, () => rowStr(16, [[2, 15]])),
    ],
    fillColors: ["#8a8a8a", "#a8a8a8", "#6b6b6b", "#c9c9c9"],
    outline: "#3a3a3a",
  },
  watchtower: {
    halfWidth: 16,
    height: 32,
    // Torch (rows 1-2) over a post (3-4), a platform that flares wide (5-6), then a
    // narrow shaft the rest of the way down.
    rows: [
      rowStr(16, []),
      rowStr(16, [[6, 6]]),
      rowStr(16, [[6, 6]]),
      rowStr(16, [[6, 7]]),
      rowStr(16, [[6, 7]]),
      rowStr(16, [[3, 7]]),
      rowStr(16, [[3, 7]]),
      ...Array.from({ length: 25 }, () => rowStr(16, [[5, 7]])),
    ],
    fillColors: ["#6b4a2f", "#8b6914", "#5c3d1e"],
    outline: "#2f1f0f",
  },
  ruinedTower: {
    halfWidth: 16,
    height: 32,
    // Rows 0-2 are '1' (maybe), not '2' (always) — deliberately the opposite choice
    // from sword/HUMANOID_ROWS: those wanted a precise silhouette, this one wants an
    // irregular broken top, so the CA noise this pipeline already produces for "maybe"
    // cells IS the ruin. Rows 3-31 are a plain uniform shaft — a ruin is otherwise just
    // "less than a tower," not a different shape.
    rows: [
      rowStr(16, [[4, 7, "1"]]),
      rowStr(16, [[4, 7, "1"]]),
      rowStr(16, [[4, 7, "1"]]),
      ...Array.from({ length: 29 }, () => rowStr(16, [[4, 7]])),
    ],
    fillColors: ["#5c5c52", "#4a4a42", "#6b6b5f", "#3d5c2e"],
    outline: "#2a2a24",
  },
  village: {
    halfWidth: 16,
    height: 32,
    // Two huts of different sizes (a bigger one at the outer edge, a smaller one
    // nearer the mirror line — mirroring turns this into three-plus roofs across the
    // tile, not a single repeated hut) on a thin ground line at the bottom.
    rows: [
      ...Array.from({ length: 9 }, () => rowStr(16, [])),
      rowStr(16, [[4, 4]]),
      rowStr(16, [[3, 5]]),
      rowStr(16, [[2, 6]]),
      rowStr(16, [[2, 6]]),
      rowStr(16, [[2, 6], [11, 11]]),
      rowStr(16, [[2, 6], [10, 12]]),
      ...Array.from({ length: 5 }, () => rowStr(16, [[2, 6], [10, 13]])),
      rowStr(16, [[10, 13]]),
      ...Array.from({ length: 10 }, () => rowStr(16, [])),
      rowStr(16, [[0, 15]]),
    ],
    fillColors: ["#8b6914", "#a8834a", "#6b4a2f", "#c9945a"],
    outline: "#3a2712",
  },
  dungeonEntrance: {
    halfWidth: 16,
    height: 32,
    // A solid rock face (rows 8-31) with a doorway punched out of its lower-center:
    // rows 18-19 carve a narrow notch near the mirror line, rows 20-31 carve the full
    // arch — the step between them is what reads as an arched (not flat) top when
    // mirrored into a full opening.
    rows: [
      ...Array.from({ length: 8 }, () => rowStr(16, [])),
      ...Array.from({ length: 10 }, () => rowStr(16, [[0, 15]])),
      rowStr(16, [[0, 10]]),
      rowStr(16, [[0, 10]]),
      ...Array.from({ length: 12 }, () => rowStr(16, [[0, 7]])),
    ],
    fillColors: ["#5c5248", "#4a423a", "#6b6155", "#3a332c"],
    outline: "#1f1a16",
  },
  banditCamp: {
    halfWidth: 16,
    height: 32,
    // A pyramid tent (rows 18-27, cols 3-9) plus a small campfire near the mirror line
    // (rows 26-27, cols 12-14) on a ground line — low-profile on purpose, a camp reads
    // close to the ground unlike the towers above it in this list.
    rows: [
      ...Array.from({ length: 18 }, () => rowStr(16, [])),
      rowStr(16, [[6, 6]]),
      rowStr(16, [[5, 7]]),
      rowStr(16, [[4, 8]]),
      rowStr(16, [[3, 9]]),
      rowStr(16, [[3, 9]]),
      rowStr(16, [[3, 9]]),
      rowStr(16, [[3, 9]]),
      rowStr(16, [[3, 9]]),
      rowStr(16, [[3, 9], [13, 13]]),
      rowStr(16, [[3, 9], [12, 14]]),
      ...Array.from({ length: 3 }, () => rowStr(16, [])),
      rowStr(16, [[0, 15]]),
    ],
    fillColors: ["#8b6914", "#6b4a2f", "#c9945a", "#d4741a"],
    outline: "#3a2712",
  },
};

// Terrain/texture tiles (owner request, 2026-08-09): unlike everything in SILHOUETTES
// above, these aren't a bounded object on a transparent background — the prompts
// describe a texture filling the WHOLE tile ("mountain tile", "rock wall with metallic
// flecks", "tilled soil rows"). generate() (not generateMasked()) with per-terrain
// colors/fillChance stands in for a new mask per type. No outline: adjacent map tiles
// should butt against each other, and a border ring around every tile would read as a
// grid line, not a material edge.
//
// FILL_CHANCE/SURVIVE/GROW/ITERATIONS below were tuned by rendering, not guessed: the
// first attempt (0.85 fill, 2 iterations) converged to 100% filled — colorHalf assigns
// each filled cell an independent random palette index with no spatial correlation, so
// a fully-filled tile rendered as per-pixel static, not a material texture. Dropping to
// a lower fillChance with only ONE smoothing pass leaves real background gaps (~35-40%
// empty) — those gaps are what read as texture (patches, mortar lines, furrows), the
// same way sword/HUMANOID_ROWS need a mask because color noise alone can't carry shape.
const TERRAIN_FILL_CHANCE = 0.55;
const TERRAIN_SURVIVE_THRESHOLD = 3;
const TERRAIN_GROW_THRESHOLD = 5;
const TERRAIN_ITERATIONS = 1;

const TERRAIN: Record<string, { fillColors: string[] }> = {
  mountain: { fillColors: ["#6b6b6b", "#8a8a8a", "#5c5c5c", "#e8e8f0"] },
  forest: { fillColors: ["#1e3d1e", "#2d5a2d", "#3d7a3d", "#4a8f4a"] },
  river: { fillColors: ["#2a5a8a", "#3d7ab5", "#5a9ad0", "#e8f4ff"] },
  desert: { fillColors: ["#c9a869", "#d4b878", "#b89555", "#e0c896"] },
  swamp: { fillColors: ["#3d4a2a", "#4a5a35", "#2a3520", "#5c6b40"] },
  plains: { fillColors: ["#7fb055", "#8fc065", "#6fa045", "#9fd075"] },
  volcanic: { fillColors: ["#1a1a1a", "#2a2a2a", "#0d0d0d", "#ff6b1a"] },
  // Resource textures (16x16) reuse this same registry/function — "rock wall" and
  // "tilled soil" are materials filling their tile exactly like a terrain tile, not
  // bounded objects, so they don't belong in SILHOUETTES.
  ironOre: { fillColors: ["#4a4a48", "#5c5c58", "#3a3a38", "#d4af37"] },
  farmland: { fillColors: ["#5c3d1e", "#6b4a2f", "#4a2f18", "#7fa35c"] },
};

function parseMask(rows: string[]): number[] {
  return rows.join("").split("").map(Number);
}

export interface SpriteAssets {
  seed: number;
  width: number;
  height: number;
  shape: string | null;
  /** Fill colors only — index 0 here is palette index 1 in `pixels` (see below). Does
   * NOT include the outline color; `outlinePaletteIndex` names that entry separately,
   * so a caller can tell "the border" from "an actual fill" if it needs to. */
  palette: string[];
  /** `palette[outlinePaletteIndex - 1]` is the border color `pixels` uses; 0 if this
   * sprite has no outline. Matches pixelart.qbsk's own "0 disables it" convention. */
  outlinePaletteIndex: number;
  pixels: number[];
  filled: number;
  total: number;
  /** Full text of a `.qbdata` `pixel_sprite` entry, ready to write to disk. */
  qbdataText: string;
  /** Full text of a renderable SVG tile image, ready to write to disk. */
  svgText: string;
}

// Shared by generateSpriteAssets and generateTerrainAssets — everything past "we have
// pixels and a palette" (qbdata text, SVG text, filled count) is identical between a
// masked/unmasked SILHOUETTES sprite and a TERRAIN tile; only how `pixels` gets
// produced differs, which is why this takes them as plain arguments instead of being
// one giant function with a texture/silhouette branch threaded through it.
function buildAssets(
  seed: number,
  size: number,
  height: number,
  shape: string | null,
  palette: string[],
  outlinePaletteIndex: number,
  pixels: number[],
  entryName: string,
): SpriteAssets {
  const filled = pixels.filter((v) => v !== 0).length;

  const qbdataList = (values: (string | number)[], quote: boolean): string =>
    `[${values.map((v) => (quote ? `"${v}"` : v)).join(", ")}]`;

  const qbdataText = [
    `// GENERATED by bench/sprite-gen.mjs / qbsk_generate_sprite, do not hand-edit.`,
    `// seed=${seed} size=${size}x${height}${shape !== null ? ` shape=${shape}` : ""}`,
    "//",
    "// pixel value 0 means empty; pixel value k (1..len(palette)) means palette[k-1] —",
    `// index ${outlinePaletteIndex} (the last entry) is the outline/border color`,
    "// (examples/lib/pixelart.qbsk's own convention). 0 means this tile has none.",
    "",
    "shape pixel_sprite",
    "    width: int",
    "    height: int",
    "    palette: list",
    "    pixels: list",
    "",
    `${entryName} = {"width": ${size}, "height": ${height}, "palette": ${qbdataList(palette, true)}, "pixels": ${qbdataList(pixels, false)}}`,
    "",
  ].join("\n");

  const rects: string[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = pixels[y * size + x]!;
      if (v === 0) continue;
      rects.push(`  <rect x="${x}" y="${y}" width="1" height="1" fill="${palette[v - 1]}"/>`);
    }
  }
  const svgText = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}" shape-rendering="crispEdges">`,
    ...rects,
    "</svg>",
    "",
  ].join("\n");

  return {
    seed,
    width: size,
    height,
    shape,
    palette,
    outlinePaletteIndex,
    pixels,
    filled,
    total: pixels.length,
    qbdataText,
    svgText,
  };
}

/**
 * Generates one pixel-art sprite deterministically from `seed` and `size`.
 * `libDir` must be the directory containing `pixelart.qbsk` (examples/lib), since
 * generation happens by literally running QBSK's `use "pixelart.qbsk"` against it.
 * `entryName` is the `.qbdata` entry's identifier (default "SPRITE").
 *
 * `shape`, if given, must be a key of SILHOUETTES (e.g. "sword") — generation is then
 * mask-gated to that silhouette instead of a free-form symmetric blob. Omit it (or pass
 * undefined) for the original unguided generator.
 */
export function generateSpriteAssets(
  seed: number,
  size: 16 | 32,
  libDir: string,
  entryName = "SPRITE",
  shape?: string,
): SpriteAssets {
  const halfWidth = size / 2;
  const height = size;
  const silhouette = shape !== undefined ? SILHOUETTES[shape] : undefined;
  if (shape !== undefined && silhouette === undefined) {
    throw new Error(
      `unknown sprite shape '${shape}' — known shapes: ${Object.keys(SILHOUETTES).join(", ")}`,
    );
  }
  if (silhouette !== undefined && (silhouette.halfWidth !== halfWidth || silhouette.height !== height)) {
    throw new Error(
      `shape '${shape}' is authored for ${silhouette.halfWidth * 2}x${silhouette.height}, not ${size}x${height}`,
    );
  }
  const fillColors = silhouette !== undefined ? silhouette.fillColors : CREATURE_FILL_COLORS;
  const outlineColor = silhouette !== undefined ? silhouette.outline : CREATURE_OUTLINE;
  // The outline is appended as the LAST palette entry — fill colors keep indices
  // 1..fillColors.length (colorHalf's own range), the outline gets the one index past
  // that, never competing with a real roll for a fill color.
  const palette = [...fillColors, outlineColor];
  const outlinePaletteIndex = palette.length;

  // Two independent streams, the pattern every generator in this project uses (Phase
  // 27 §5, 28, 31) — regenerating colors must never reroll shape.
  const STREAM = { fill: 0, color: 1 };
  const fillRng = mulberry32(streamSeed(seed, STREAM.fill));
  const colorRng = mulberry32(streamSeed(seed, STREAM.color));
  const cellCount = halfWidth * height;
  const roll3 = (rng: () => number): number => Math.round(rng() * 1000) / 1000;
  const fillRolls = Array.from({ length: cellCount }, () => roll3(fillRng));
  const colorRolls = Array.from({ length: cellCount }, () => roll3(colorRng));

  const qbskSource =
    silhouette !== undefined
      ? `
use "pixelart.qbsk" as art
var fillRolls = ${JSON.stringify(fillRolls)}
var colorRolls = ${JSON.stringify(colorRolls)}
var mask = ${JSON.stringify(parseMask(silhouette.rows))}
var pixels = art.generateMasked(${halfWidth}, ${height}, fillRolls, colorRolls, ${fillColors.length}, ${FILL_CHANCE}, ${SURVIVE_THRESHOLD}, ${GROW_THRESHOLD}, ${ITERATIONS}, mask, ${outlinePaletteIndex})
print(pixels)
`
      : `
use "pixelart.qbsk" as art
var fillRolls = ${JSON.stringify(fillRolls)}
var colorRolls = ${JSON.stringify(colorRolls)}
var pixels = art.generate(${halfWidth}, ${height}, fillRolls, colorRolls, ${fillColors.length}, ${FILL_CHANCE}, ${SURVIVE_THRESHOLD}, ${GROW_THRESHOLD}, ${ITERATIONS}, ${outlinePaletteIndex})
print(pixels)
`;
  const result = runQbsk(qbskSource, "examples/lib/_sprite_driver.qbsk", undefined, {
    baseDir: libDir,
  });
  if (result.error) {
    throw new Error(`sprite generation failed: ${result.error.message}`);
  }
  const pixels: number[] = JSON.parse(result.out[0]!) as number[];
  return buildAssets(seed, size, height, shape ?? null, palette, outlinePaletteIndex, pixels, entryName);
}

/**
 * Generates one full-tile texture (terrain like "mountain", or a resource texture like
 * "ironOre") deterministically from `seed` and `size` — the TERRAIN-registry sibling of
 * generateSpriteAssets. `terrainKey` must be a key of the TERRAIN registry above.
 * Always unmasked (there is no mask-gated texture concept) and never has an outline
 * (adjacent map tiles should butt against each other, not each carry a border ring).
 */
export function generateTerrainAssets(
  seed: number,
  size: 16 | 32,
  libDir: string,
  entryName: string,
  terrainKey: string,
): SpriteAssets {
  const terrain = TERRAIN[terrainKey];
  if (terrain === undefined) {
    throw new Error(`unknown terrain '${terrainKey}' — known terrain: ${Object.keys(TERRAIN).join(", ")}`);
  }
  const halfWidth = size / 2;
  const height = size;
  const palette = terrain.fillColors;

  const STREAM = { fill: 0, color: 1 };
  const fillRng = mulberry32(streamSeed(seed, STREAM.fill));
  const colorRng = mulberry32(streamSeed(seed, STREAM.color));
  const cellCount = halfWidth * height;
  const roll3 = (rng: () => number): number => Math.round(rng() * 1000) / 1000;
  const fillRolls = Array.from({ length: cellCount }, () => roll3(fillRng));
  const colorRolls = Array.from({ length: cellCount }, () => roll3(colorRng));

  const qbskSource = `
use "pixelart.qbsk" as art
var fillRolls = ${JSON.stringify(fillRolls)}
var colorRolls = ${JSON.stringify(colorRolls)}
var pixels = art.generate(${halfWidth}, ${height}, fillRolls, colorRolls, ${terrain.fillColors.length}, ${TERRAIN_FILL_CHANCE}, ${TERRAIN_SURVIVE_THRESHOLD}, ${TERRAIN_GROW_THRESHOLD}, ${TERRAIN_ITERATIONS}, 0)
print(pixels)
`;
  const result = runQbsk(qbskSource, "examples/lib/_terrain_driver.qbsk", undefined, {
    baseDir: libDir,
  });
  if (result.error) {
    throw new Error(`terrain generation failed: ${result.error.message}`);
  }
  const pixels: number[] = JSON.parse(result.out[0]!) as number[];
  return buildAssets(seed, size, height, terrainKey, palette, 0, pixels, entryName);
}

/**
 * Edge-orientation glyphs for a generated sprite (docs/engine.md §11.16).
 *
 * Sobel over the sprite's filled/empty mask, then the glyph that runs ALONG each edge —
 * the gradient points across it, so the rotation in `edgeGlyph` is what turns "which
 * way does the brightness change" into "which way does the edge run".
 *
 * **Offline only, and that is a rule rather than a note.** This lives here, beside the
 * generator, because a sprite's pixel grid genuinely exists at generation time. At run
 * time the engine has no pixel source, and a native that sampled one would be inventing
 * its input — the shape invariant I2 forbids.
 *
 * `threshold` is the gradient magnitude below which a cell is called flat. Sobel on a
 * binary mask gives 0 in the interior and multiples of 1 at a boundary, so anything
 * above 0 is an edge; the parameter exists for callers feeding it real intensities.
 */
export function spriteEdgeGlyphs(
  sprite: { pixels: readonly number[]; width: number; height: number },
  threshold = 0.5,
): string[] {
  const mask = sprite.pixels.map((p) => (p > 0 ? 1 : 0));
  const rows: string[] = [];
  for (let y = 0; y < sprite.height; y += 1) {
    let row = "";
    for (let x = 0; x < sprite.width; x += 1) {
      const { gx, gy } = sobelAt(mask, sprite.width, sprite.height, x, y);
      row += Math.hypot(gx, gy) <= threshold ? " " : edgeGlyph(gx, gy);
    }
    rows.push(row);
  }
  return rows;
}
