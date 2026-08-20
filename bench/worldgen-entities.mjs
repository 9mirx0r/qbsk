// An earlier release benchmark (the roadmap 06 that release, criterion 2): dict-list entities
// (an earlier release) vs. the D1 archetype ECS (src/ecs/, commit 32c7457 — correct and tested,
// deliberately unwired from the language), measured against THIS phase's actual entity
// shape — nested facet/value dicts (the design notes §3), a
// profession bundle (the design notes §5) — not a generic
// microbenchmark. Extends bench/entities.mjs's method to a richer, real shape.
//
//   node bench/worldgen-entities.mjs [counts...]     default: 50 200 500 1000 2000

import { performance } from "node:perf_hooks";
import { parse } from "../dist/parser/parser.js";
import { SceneProgram } from "../dist/interp/interpreter.js";
import { ECS } from "../dist/ecs/index.js";

const counts = process.argv.slice(2).map(Number).filter((n) => n > 0);
const COUNTS = counts.length > 0 ? counts : [50, 200, 500, 1000, 2000];

const FACETS = ["ambition", "cruelty", "bashfulness", "sociability"];
const VALUES = ["tradition", "cooperation", "honesty"];
const PROFESSIONS = ["guard", "merchant", "hermit"];

// One turn of worldgen_test.qbsk's real workload: read every NPC's facets, compute an
// aggregate (matching avgFacet()), and rebuild the list — the same immutable pattern
// the language forces (no index assignment), which is also what a real `on turn` pays.
const source = (n) =>
  [
    `const COUNT = ${n}`,
    "var npcs = []",
    "",
    "func professionOf(i)",
    "    if i % 3 == 0",
    '        return "guard"',
    "    if i % 3 == 1",
    '        return "merchant"',
    '    return "hermit"',
    "",
    "func makeNpc(i)",
    "    return {",
    '        "id": i, "profession": professionOf(i),',
    '        "facets": {"ambition": i % 100, "cruelty": (i * 7) % 100, "bashfulness": (i * 3) % 100, "sociability": (i * 11) % 100},',
    '        "values": {"tradition": (i % 100) - 50, "cooperation": (i % 100) - 50, "honesty": (i % 100) - 50},',
    '        "x": i % 40, "y": i % 20,',
    "    }",
    "",
    "on start",
    "    var i = 0",
    "    while i < COUNT",
    "        npcs = push(npcs, makeNpc(i))",
    "        i += 1",
    "",
    // avgFacet-shaped aggregation over the whole list, every turn — this is the actual
    // access pattern worldgen_test.qbsk's history rules use.
    "on tick(dt)",
    "    var total = 0.0",
    "    var count = 0",
    "    var i = 0",
    "    while i < len(npcs)",
    '        if npcs[i]["profession"] == "guard"',
    '            total += npcs[i]["facets"]["cruelty"]',
    "            count += 1",
    "        i += 1",
    "    var next = []",
    "    i = 0",
    "    while i < len(npcs)",
    "        var n = npcs[i]",
    '        next = push(next, {"id": n["id"], "profession": n["profession"], "facets": n["facets"], "values": n["values"], "x": n["x"], "y": n["y"]})',
    "        i += 1",
    "    npcs = next",
    "",
    "scene Sim(width: 40, height: 20)",
    "layer ground z: 1",
    '    fill "."',
  ].join("\n");

const TURNS = 60;

console.log(
  "worldgen entity shape — ms per turn, averaged over " + TURNS + " turns\n",
);
console.log("  count |    QBSK |     ECS |  ratio | verdict");
console.log("  ------+---------+---------+--------+--------");

for (const n of COUNTS) {
  // --- QBSK dict-list ---
  const parsed = parse(source(n), "bench.qbsk");
  if (parsed.errors.length > 0) {
    console.error("bench program failed to parse:", parsed.errors[0].message);
    process.exit(1);
  }
  const program = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
  program.step(1 / 60); // warm: on start + first composition, not counted

  const t0 = performance.now();
  for (let i = 0; i < TURNS; i += 1) {
    const frame = program.step(1 / 60);
    if (frame.error !== null) {
      console.error("bench program failed at run time:", frame.error.message);
      process.exit(1);
    }
  }
  const qbskMs = (performance.now() - t0) / TURNS;

  // --- D1 ECS, same shape, same aggregation ---
  const ecs = new ECS(10);
  const handles = [];
  for (let i = 0; i < n; i += 1) {
    const facets = {
      ambition: i % 100,
      cruelty: (i * 7) % 100,
      bashfulness: (i * 3) % 100,
      sociability: (i * 11) % 100,
    };
    const values = {
      tradition: (i % 100) - 50,
      cooperation: (i % 100) - 50,
      honesty: (i % 100) - 50,
    };
    const h = ecs.spawn([
      { __part: "Position", x: i % 40, y: i % 20, z: 0 },
      { __part: "Faction", name: PROFESSIONS[i % 3] },
      { __part: "Name", name: `npc_${i}`, description: "" },
    ]);
    handles.push(h);
    // "Personality" is not a STANDARD_PART (types.ts) — attaching it exercises the
    // "add a part the entity never had" migration path an earlier release itself fixed (setPart
    // used to silently fail here). This is the ECS equivalent of the dict's
    // "facets"/"values" keys.
    ecs.setPart(h, "Personality", { facets, values });
  }

  const t1 = performance.now();
  for (let t = 0; t < TURNS; t += 1) {
    let total = 0;
    let count = 0;
    const guards = ecs.query(["Faction"]);
    for (const h of guards) {
      const fac = ecs.find(h, "Faction");
      if (fac.name === "guard") {
        const personality = ecs.find(h, "Personality");
        total += personality.facets.cruelty;
        count += 1;
      }
    }
  }
  const ecsMs = (performance.now() - t1) / TURNS;

  const verdict = qbskMs < 4 ? "comfortable" : qbskMs < 16.6 ? "usable" : "too slow";
  console.log(
    `  ${String(n).padStart(5)} | ${qbskMs.toFixed(3).padStart(7)} | ` +
      `${ecsMs.toFixed(3).padStart(7)} | ${(qbskMs / Math.max(ecsMs, 0.0001)).toFixed(1).padStart(5)}x | ${verdict}`,
  );
}

console.log(
  "\n  QBSK column includes scene composition, which a real turn also pays; ECS column",
);
console.log(
  "  is query()+find() only, no composition (the ECS is not wired to rendering).",
);
console.log("  16.6 ms is one frame at 60 fps — the line a player can feel.");
