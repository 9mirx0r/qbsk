// Entity workload benchmark (the roadmap 06 an earlier release, criterion 1).
//
// The question this exists to answer, before anything is designed around the answer:
// CAN AN ENTITY SYSTEM LIVE IN QBSK, or does it have to be TypeScript exposed as natives?
//
// It matters because the two choices are hard to swap later. Entities as QBSK dicts are
// readable and changeable from the console the moment they exist; entities in TypeScript
// are fast and invisible unless deliberately surfaced. The interpreter is the dominant
// cost in a frame (bench/baseline.md), so the honest way to choose is to measure the
// shape of the real workload rather than argue about it.
//
// The workload is deliberately entity-SHAPED and not a microbenchmark: N entities, each
// a dict of components, all stepped once per turn, with the result read back — which is
// what a turn in a roguelike actually does.
//
//   node bench/entities.mjs [counts...]     default: 50 200 500 1000 2000

import { performance } from "node:perf_hooks";
import { parse } from "../dist/parser/parser.js";
import { SceneProgram } from "../dist/interp/interpreter.js";

const counts = process.argv.slice(2).map(Number).filter((n) => n > 0);
const COUNTS = counts.length > 0 ? counts : [50, 200, 500, 1000, 2000];

/** One turn: every entity reads its components, decides, and writes back. */
const source = (n) =>
  [
    `const COUNT = ${n}`,
    "var entities = []",
    "var turnCount = 0",
    "",
    "func makeEntity(i)",
    '    return {"x": i % 40, "y": i % 20, "hp": 10 + i % 5, "kind": "goblin", "alive": true}',
    "",
    "on start",
    "    var i = 0",
    "    while i < COUNT",
    "        entities = push(entities, makeEntity(i))",
    "        i += 1",
    "",
    // The turn: read every component, decide, rebuild. Index assignment does not exist,
    // so a turn ACCUMULATES a fresh list — the same immutable-by-construction pattern
    // examples/cube.qbsk uses, and the one a real entity step would have to use today.
    "on tick(dt)",
    "    turnCount += 1",
    "    var next = []",
    "    var i = 0",
    "    while i < len(entities)",
    "        var e = entities[i]",
    "        var nx = e[\"x\"]",
    "        if e[\"alive\"]",
    "            if e[\"hp\"] > 3",
    "                nx = (e[\"x\"] + 1) % 40",
    '        next = push(next, {"x": nx, "y": e["y"], "hp": e["hp"] - 1, "kind": e["kind"], "alive": e["hp"] > 1})',
    "        i += 1",
    "    entities = next",
    "",
    "scene Sim(width: 40, height: 20)",
    "layer ground z: 1",
    '    fill "."',
  ].join("\n");

/** The same work in TypeScript, as the natives path would do it. */
function nativeTurn(entities) {
  const next = new Array(entities.length);
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i];
    let nx = e.x;
    if (e.alive && e.hp > 3) {
      nx = (e.x + 1) % 40;
    }
    next[i] = { x: nx, y: e.y, hp: e.hp - 1, kind: e.kind, alive: e.hp > 1 };
  }
  return next;
}

const TURNS = 60;

console.log("QBSK entity workload — ms per turn, averaged over " + TURNS + " turns\n");
console.log("  count |    QBSK |  native |  ratio | verdict");
console.log("  ------+---------+---------+--------+--------");

for (const n of COUNTS) {
  const parsed = parse(source(n), "bench.qbsk");
  if (parsed.errors.length > 0) {
    console.error("bench program failed to parse:", parsed.errors[0].message);
    process.exit(1);
  }
  const program = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });

  // One warm step so `on start` and the first composition are not counted as a turn.
  program.step(1 / 60);

  const t0 = performance.now();
  for (let i = 0; i < TURNS; i += 1) {
    const frame = program.step(1 / 60);
    if (frame.error !== null) {
      console.error("bench program failed at run time:", frame.error.message);
      process.exit(1);
    }
  }
  const qbskMs = (performance.now() - t0) / TURNS;

  let entities = Array.from({ length: n }, (_, i) => ({
    x: i % 40,
    y: i % 20,
    hp: 10 + (i % 5),
    kind: "goblin",
    alive: true,
  }));
  const t1 = performance.now();
  for (let i = 0; i < TURNS; i += 1) {
    entities = nativeTurn(entities);
  }
  const nativeMs = (performance.now() - t1) / TURNS;

  // 16.6 ms is one frame at 60 fps. A turn is not a frame, but a turn that takes longer
  // than a frame is one the player can feel, and that is the line worth reporting.
  const verdict =
    qbskMs < 4 ? "comfortable" : qbskMs < 16.6 ? "usable" : "too slow";
  console.log(
    `  ${String(n).padStart(5)} | ${qbskMs.toFixed(2).padStart(7)} | ` +
      `${nativeMs.toFixed(3).padStart(7)} | ${(qbskMs / nativeMs).toFixed(0).padStart(5)}x | ${verdict}`,
  );
}

console.log(
  "\n  QBSK column includes scene composition, which a real turn also pays.",
);
console.log("  16.6 ms is one frame at 60 fps — the line a player can feel.");
