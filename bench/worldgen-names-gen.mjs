// An earlier release — phoneme-based procedural naming (the design notes).
//
// Host-side name generator: for the SAME reason an earlier release's personality rolls stayed
// host-side (bench/worldgen-gen.mjs's own header — QBSK has no bitwise operators, so a
// seeded PRNG cannot be a QBSK-language library), *selecting* which root concept and
// which culture's phoneme to use for a name needs randomness too. Composing the chosen
// syllables into a display string does not — that half could be QBSK code if a scene
// ever needed it live, but nothing here does yet, so it stays in this one pass with the
// selection it depends on.
//
// Reads the ALREADY-GENERATED worldgen_npcs.qbdata (an earlier release) and the hand-authored
// worldgen_locations.qbdata, adds/replaces a "name" field on each using
// worldgen_concepts.qbdata + worldgen_cultures.qbdata, and rewrites both files.
//
// Run: node bench/worldgen-names-gen.mjs [seed]
// Same seed -> byte-identical names, every time (re-run and diff to check).

import { mulberry32, streamSeed } from "../dist/util/random.js";
import { loadQbdata } from "../dist/parser/qbdata.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = Number(process.argv[2] ?? 27);

// A fifth stream, alongside an earlier release's four (the design notes §5) — regenerating
// names must never reroll personalities, locations' positions, or history.
const nameRng = mulberry32(streamSeed(seed, 4));

function qToJs(v) {
  if (v.type === "dict") {
    const o = {};
    for (const [k, val] of v.map) o[k] = qToJs(val);
    return o;
  }
  if (v.type === "list") return v.items.map(qToJs);
  return v.value;
}

function loadEntries(relPath) {
  const source = readFileSync(resolve(root, relPath), "utf8");
  const result = loadQbdata(source, relPath);
  if (result.errors.length > 0) {
    console.error(`failed to load ${relPath}:`, result.errors[0].message);
    process.exit(1);
  }
  const out = {};
  for (const [name, value] of result.entries) out[name] = qToJs(value);
  return out;
}

const concepts = loadEntries("examples/res/worldgen_concepts.qbdata");
const cultures = loadEntries("examples/res/worldgen_cultures.qbdata");

const CULTURE_BY_LOCATION = {
  ashford: "ASHFORD_CULTURE",
  millbrook: "MILLBROOK_CULTURE",
  cairn_hollow: "CAIRN_HOLLOW_CULTURE",
};
const CULTURES = Object.keys(cultures);

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Three DISTINCT concepts from the culture's allowed categories, phoneme-translated and
// joined — the same "root + root" shape a Dwarf Fortress name has (the design notes
// §2), applied to an original phoneme table, not DF's actual one, extended to a third
// root. Recorded-debt fix (an earlier release closure): 2 roots out of a 6-candidate pool measured
// 38% collision (62/100 unique) in a batch test. 3 roots out of the now 13-15-candidate
// pool (worldgen_concepts.qbdata) multiplies the combination space by two full orders of
// magnitude — see bench/worldgen-names-gen.mjs's own run log for the honest re-measure.
function generateName(cultureKey) {
  const culture = cultures[cultureKey];
  const candidates = Object.keys(concepts).filter((id) =>
    concepts[id].categories.some((c) => culture.allowed.includes(c)),
  );
  const pickDistinct = (taken) => {
    let id = pick(nameRng, candidates);
    let guard = 0;
    while (taken.includes(id) && candidates.length > taken.length && guard < 10) {
      id = pick(nameRng, candidates);
      guard += 1;
    }
    return id;
  };
  const a = pickDistinct([]);
  const b = pickDistinct([a]);
  const c = pickDistinct([a, b]);
  const syllable = (id) => culture.phonemes[id];
  const raw = syllable(a) + syllable(b) + syllable(c);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// The world's name, not any one people's — one concept contributed by EACH of the
// three cultures, each translated through its OWN phoneme table, joined into a single
// composite word. Every civilization's language is literally present in the name of the
// world they share, rather than one culture's language standing in for all of them.
function generateWorldName() {
  const parts = [];
  for (const cultureKey of CULTURES) {
    const culture = cultures[cultureKey];
    const candidates = Object.keys(concepts).filter((id) =>
      concepts[id].categories.some((c) => culture.allowed.includes(c)),
    );
    const id = pick(nameRng, candidates);
    parts.push(culture.phonemes[id]);
  }
  const raw = parts.join("");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function qbdataDict(obj) {
  const parts = Object.entries(obj).map(([k, v]) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return `"${k}": {${Object.entries(v)
        .map(([k2, v2]) => `"${k2}": ${v2}`)
        .join(", ")}}`;
    }
    if (typeof v === "string") return `"${k}": "${v}"`;
    return `"${k}": ${v}`;
  });
  return `{${parts.join(", ")}}`;
}

// --- NPCs: add a "name" field, everything else untouched ---
const npcSource = readFileSync(resolve(root, "examples/res/worldgen_npcs.qbdata"), "utf8");
const npcResult = loadQbdata(npcSource, "worldgen_npcs.qbdata");
const npcNames = [];
const npcEntries = [];
let npcIndex = 0;
for (const [entryName, value] of npcResult.entries) {
  const n = qToJs(value);
  const cultureKey = CULTURE_BY_LOCATION[n.location];
  n.name = generateName(cultureKey);
  npcNames.push(n.name);
  npcEntries.push(`NPC_${npcIndex} = ${qbdataDict(n)}`);
  npcIndex += 1;
}

writeFileSync(
  resolve(root, "examples/res/worldgen_npcs.qbdata"),
  [
    "// worldgen_npcs.qbdata — GENERATED by bench/worldgen-gen.mjs +",
    "// bench/worldgen-names-gen.mjs, do not hand-edit.",
    `// seed=${seed} — regenerate: node bench/worldgen-gen.mjs ${seed} && node bench/worldgen-names-gen.mjs ${seed}`,
    "//",
    "// Facets (0-100, how the NPC acts) and values (-50..50, what it believes) follow the",
    "// Dwarf Fortress model (14-dwarf-fortress-worldgen-research.md §3). `name` is",
    "// generated by the phoneme system.",
    "// profession_roll is a raw [0,1) float, resolved against a weighted",
    "// population table by lib/population.qbsk's weightedPick() inside the scene.",
    "",
    "shape npc",
    "    id: str",
    "    location: str",
    "    profession_roll: float",
    "    facets: dict",
    "    values: dict",
    "    name: str",
    "",
    ...npcEntries,
    "",
  ].join("\n"),
  "utf8",
);

// --- Locations: replace the "name" field, keep key/glyph/x/y/founded_turn ---
const locSource = readFileSync(resolve(root, "examples/res/worldgen_locations.qbdata"), "utf8");
const locResult = loadQbdata(locSource, "worldgen_locations.qbdata");
const locEntries = [];
const locNames = [];
for (const [entryName, value] of locResult.entries) {
  const l = qToJs(value);
  const cultureKey = CULTURE_BY_LOCATION[l.key];
  l.name = generateName(cultureKey);
  locNames.push(l.name);
  locEntries.push(`${entryName} = ${qbdataDict(l)}`);
}

writeFileSync(
  resolve(root, "examples/res/worldgen_locations.qbdata"),
  [
    "// worldgen_locations.qbdata — structure, with a generated `name`,",
    "// bench/worldgen-names-gen.mjs). `key` stays the internal identifier; `name` is",
    "// the phoneme-generated display name — regenerate: node bench/worldgen-names-gen.mjs " + seed,
    "//",
    "// A real terrain-field pipeline and a CDDA-style placement engine are both out of",
    "// scope — positions here are still hand-placed.",
    "",
    "shape location",
    "    key: str",
    "    name: str",
    "    glyph: str",
    "    x: int",
    "    y: int",
    "    founded_turn: int",
    "",
    ...locEntries,
    "",
  ].join("\n"),
  "utf8",
);

// --- The world's own name, generated last so it draws from the seed AFTER every
// person/place has already drawn theirs — the world is named once everything in it
// already has a name, not before. ---
const worldName = generateWorldName();
writeFileSync(
  resolve(root, "examples/res/worldgen_world.qbdata"),
  [
    "// worldgen_world.qbdata — GENERATED by bench/worldgen-names-gen.mjs, do not",
    "// hand-edit. The world's name, composed from one concept contributed by EACH of",
    "// the three civilizations (worldgen_cultures.qbdata), each in its own language —",
    "// no single culture's tongue stands in for the whole world's name.",
    `// seed=${seed} — regenerate: node bench/worldgen-names-gen.mjs ${seed}`,
    "",
    "shape world",
    "    name: str",
    "",
    `WORLD = {"name": "${worldName}"}`,
    "",
  ].join("\n"),
  "utf8",
);

console.log(`seed=${seed}`);
console.log("World name:", worldName);
console.log("NPC names:", npcNames.join(", "));
console.log("Location names:", locNames.join(", "));
const allNames = [...npcNames, ...locNames, worldName];
const unique = new Set(allNames);
console.log(`uniqueness: ${unique.size}/${allNames.length} distinct`);

// Recorded-debt re-measure (an earlier release closure): the SAME batch-of-100 test that found
// 38% collision (62/100 unique) against the old 12-concept/2-root pool, re-run here
// against the new 26-concept/3-root pool, at the same scale, so the comparison is
// honest — continuing the same rng stream rather than reseeding, since this is a
// diagnostic-only draw that writes nothing to disk.
const batch = [];
for (let i = 0; i < 100; i += 1) {
  batch.push(generateName(CULTURES[i % CULTURES.length]));
}
const batchUnique = new Set(batch);
console.log(
  `batch-of-100 re-measure: ${batchUnique.size}/100 distinct (was 62/100 before this fix)`,
);
