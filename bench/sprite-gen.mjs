// an earlier release — procedural pixel-art sprite tool, CLI entry point (06-active-language-phases.md).
//
// A thin wrapper over src/tools/spriteGen.ts's generateSpriteAssets() — the SAME core
// Studio's `qbsk_generate_sprite` MCP tool calls (studio/mcp/session.ts). One
// implementation of the pipeline, two ways to reach it.
//
// Run: node bench/sprite-gen.mjs [seed] [size] [shape]
// size is 16 or 32 (default 16) — both match real CDDA/Dwarf Fortress tileset
// conventions (06-active-language-phases.md's an earlier release design).
// shape is optional: omit it for the original unguided symmetric blob (writes the
// checked-in demo asset, pixelart_creature.qbdata + sprites/creature.svg — the ones
// examples/pixelart_test.qbsk references); pass a name from
// src/tools/spriteGen.ts's SILHOUETTES (currently: "sword") to mask-gate generation to
// that recognizable shape instead (writes pixelart_<shape>.qbdata + sprites/<shape>.svg).
// Same seed + size + shape -> byte-identical output, every time.
//
// For a ONE-OFF sprite at an arbitrary seed without touching a checked-in example, call
// qbsk_generate_sprite through Studio's MCP server instead (it writes to a
// seed/size/shape-specific path so repeat calls never collide with each other or with
// these fixed demo assets).

import { generateSpriteAssets } from "../dist/tools/spriteGen.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = Number(process.argv[2] ?? 27);
const size = Number(process.argv[3] ?? 16) === 32 ? 32 : 16;
const shape = process.argv[4];

const name = shape ?? "creature";
const entryName = name.toUpperCase();
const assets = generateSpriteAssets(seed, size, resolve(root, "examples/lib"), entryName, shape);

const qbdataPath = resolve(root, `examples/res/pixelart_${name}.qbdata`);
const svgPath = resolve(root, `examples/res/sprites/${name}.svg`);
writeFileSync(qbdataPath, assets.qbdataText, "utf8");
writeFileSync(svgPath, assets.svgText, "utf8");

console.log(`wrote pixelart_${name}.qbdata + res/sprites/${name}.svg`);
console.log(
  `seed=${seed} size=${size}x${assets.height}${shape ? ` shape=${shape}` : ""} filled=${assets.filled}/${assets.total} (${Math.round((assets.filled / assets.total) * 100)}%)`,
);
