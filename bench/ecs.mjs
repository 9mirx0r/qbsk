// ECS Benchmark — an earlier design (docs/engine.md §16.7)
// Run with: node bench/ecs.mjs

import { performance } from "node:perf_hooks";
import { ECS } from "../dist/ecs/index.js";

// --- Benchmark helpers ---

function makeEntityParts(i) {
  return [
    { __part: "Position", x: (i % 40) * 1.0, y: (i % 20) * 1.0, z: 0 },
    { __part: "Velocity", vx: 0, vy: 0 },
    { __part: "Renderable", glyph: "g", fg: "green", bg: "black", z: 1 },
    { __part: "Health", hp: 10, max_hp: 10, regen: 0 },
    { __part: "Brain", kind: "melee" },
    { __part: "Faction", name: "hostile" },
    { __part: "Name", name: `Goblin ${i}` },
  ];
}

function benchmark(name, fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < 10; i++) fn();

  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  const sorted = times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const mean = sum / times.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  console.log(`${name}: mean=${mean.toFixed(3)}ms, median=${median.toFixed(3)}ms, p99=${p99.toFixed(3)}ms`);
  return mean;
}

// --- Dict-list baseline (current an earlier release approach) ---

function dictListSpawn(n) {
  const entities = [];
  let nextId = 1;
  for (let i = 0; i < n; i++) {
    entities.push({
      id: nextId++,
      x: (i % 40) * 1.0,
      y: (i % 20) * 1.0,
      z: 0,
      vx: 0,
      vy: 0,
      glyph: "g",
      fg: "green",
      bg: "black",
      hp: 10,
      max_hp: 10,
      kind: "melee",
      faction: "hostile",
      name: `Goblin ${i}`,
    });
  }
  return entities;
}

function dictListFind(entities, id) {
  for (const e of entities) {
    if (e.id === id) return e;
  }
  return null;
}

function dictListWithout(entities, id) {
  return entities.filter((e) => e.id !== id);
}

function dictListQuery(entities, partNames) {
  // In dict-list model, all entities have all fields, so just return all
  return entities;
}

function dictListRadius(entities, x, y, radius) {
  const results = [];
  for (const e of entities) {
    const dx = e.x - x;
    const dy = e.y - y;
    if (dx * dx + dy * dy <= radius * radius) {
      results.push(e);
    }
  }
  return results;
}

// --- ECS approach ---

function ecsSpawn(ecs, n) {
  for (let i = 0; i < n; i++) {
    ecs.spawn([
      { __part: "Position", x: (i % 40) * 1.0, y: (i % 20) * 1.0, z: 0 },
      { __part: "Velocity", vx: 0, vy: 0 },
      { __part: "Renderable", glyph: "g", fg: "green", bg: "black", z: 1 },
      { __part: "Health", hp: 10, max_hp: 10, regen: 0 },
      { __part: "Brain", kind: "melee" },
      { __part: "Faction", name: "hostile" },
      { __part: "Name", name: `Goblin ${i}` },
    ]);
  }
}

function ecsFind(ecs, entity, partName) {
  return ecs.find(entity, "Position");
}

function ecsDespawn(ecs, entity) {
  ecs.despawn(entity);
}

function ecsQuery(ecs, parts) {
  return ecs.query(parts);
}

function ecsRadius(ecs, x, y, radius) {
  return ecs.entitiesInRadius(x, y, 0, radius);
}

// --- Run benchmarks ---

const COUNTS = [50, 200, 500, 1000, 2000];

console.log("=== QBSK ECS Benchmark ===\n");

for (const n of COUNTS) {
  console.log(`\n--- ${n} entities ---`);

  // Dict-list baseline
  const dictEntities = dictListSpawn(n);
  const dictFindId = Math.floor(n / 2);
  const dictRadiusX = 20, dictRadiusY = 10, dictRadius = 5;

  benchmark(`Dict-list spawn ${n}`, () => dictListSpawn(n), 100);
  benchmark(`Dict-list find`, () => dictListFind(dictEntities, dictFindId), 1000);
  benchmark(`Dict-list without`, () => dictListWithout(dictEntities, dictFindId), 100);
  benchmark(`Dict-list query`, () => dictListQuery(dictEntities, ["Position"]), 1000);
  benchmark(`Dict-list radius`, () => dictListRadius(dictEntities, 20, 10, 5), 100);

  // ECS
  const { ECS } = await import("../dist/ecs/index.js");
  const ecs = new ECS();
  ecsSpawn(ecs, n);

  // Get an entity for find test
  const testEntity = ecs.spawn([
    { __part: "Position", x: 20, y: 10, z: 0 },
    { __part: "Velocity", vx: 0, vy: 0 },
    { __part: "Renderable", glyph: "@", fg: "white", bg: "black", z: 1 },
    { __part: "Health", hp: 10, max_hp: 10 },
    { __part: "Brain", kind: "player" },
    { __part: "Faction", name: "player" },
    { __part: "Name", name: "Player" },
  ]);

  benchmark(`ECS spawn ${n}`, () => {
    const ecs2 = new ECS();
    ecsSpawn(ecs2, n);
  }, 100);
  benchmark(`ECS find`, () => ecs.find(testEntity, "Position"), 1000);
  benchmark(`ECS query`, () => ecs.query(["Position", "Velocity"]), 1000);
  benchmark(`ECS radius`, () => ecs.entitiesInRadius(20, 10, 0, 5), 100);
  benchmark(`ECS despawn`, () => {
    const e = ecs.spawn([
      { __part: "Position", x: 0, y: 0, z: 0 },
      { __part: "Velocity", vx: 0, vy: 0 },
    ]);
    ecs.despawn(e);
  }, 1000);

  console.log(`\n  ECS stats:`, JSON.stringify(ecs.getStats()));
}

console.log("\n=== Done ===");