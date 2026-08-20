// An earlier release extension (owner request, 2026-08-09) — batch-generates the full set of
// terrain/structure/resource/creature assets the owner asked for prompts on, using
// src/tools/spriteGen.ts's generateSpriteAssets (SILHOUETTES) and generateTerrainAssets
// (TERRAIN) — no new generation logic here, just fixed seeds and output paths under
// examples/res/assets/generated/, per that folder's README.
//
// Run: node bench/sprite-gen-batch.mjs

import { generateSpriteAssets, generateTerrainAssets } from "../dist/tools/spriteGen.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = resolve(root, "examples/lib");
const genDir = resolve(root, "examples/res/assets/generated");

function write(category, name, assets) {
  const dir = resolve(genDir, category);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.qbdata`), assets.qbdataText, "utf8");
  writeFileSync(resolve(dir, `${name}.svg`), assets.svgText, "utf8");
  console.log(`${category}/${name}: filled=${assets.filled}/${assets.total}`);
}

const TERRAIN_KEYS = ["mountain", "forest", "river", "desert", "swamp", "plains", "volcanic"];
for (const key of TERRAIN_KEYS) {
  const assets = generateTerrainAssets(101, 32, libDir, key.toUpperCase(), key);
  write("terrain", key, assets);
}

const STRUCTURE_KEYS = ["castle", "village", "ruinedTower", "watchtower", "dungeonEntrance", "banditCamp"];
for (const key of STRUCTURE_KEYS) {
  const assets = generateSpriteAssets(102, 32, libDir, key.toUpperCase(), key);
  write("structures", key, assets);
}

const RESOURCE_KEYS = ["oakTree", "boulder", "ironOre", "farmland"];
for (const key of RESOURCE_KEYS) {
  const isTexture = key === "ironOre" || key === "farmland";
  const assets = isTexture
    ? generateTerrainAssets(103, 16, libDir, key.toUpperCase(), key)
    : generateSpriteAssets(103, 16, libDir, key.toUpperCase(), key);
  write("resources", key, assets);
}

const skeleton = generateSpriteAssets(104, 16, libDir, "SKELETON", "skeleton");
write("creatures", "skeleton", skeleton);

console.log("done");
