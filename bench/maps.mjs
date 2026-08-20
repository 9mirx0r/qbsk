// Map-size workload (the roadmap 06 an earlier release, criterion 1).
//
// The question this exists to answer BEFORE any chunking is designed: how large can a
// map get before the engine stops being affordable? Chunking exists so a world can be
// bigger than memory. It also adds a coordinate translation to every `path`, every
// `sight` and every draw, so it must not be built until something needs it.
//
// Three costs are measured, and the third is the one people forget:
//
//   1. path()   — A* over the whole map. Worst case is corner to corner, and a MAZE is
//                 the real worst case: on an open map the heuristic walks nearly a
//                 straight line, which flatters the result.
//   2. sight()  — shadowcasting from one point. Bounded by radius, not by map size, so
//                 this is here to CONFIRM that rather than to assume it.
//   3. memory   — the map held as QBSK values, which is what a scene actually keeps.
//
// Composition is deliberately not measured against map size: the screen is bounded, so
// a 1000x1000 map still draws 120x40. That is the fact the whole decision turns on.
//
//   node bench/maps.mjs [sizes...]        default: 60 200 500 1000 2000

import { performance } from "node:perf_hooks";
import { findPath } from "../dist/engine/path.js";
import { computeVisible } from "../dist/engine/fov.js";

const given = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = given.length > 0 ? given : [60, 200, 500, 1000, 2000];

/** Open floor with a wall border — the best case for A*. */
function openMap(w, h) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    if (y === 0 || y === h - 1) {
      rows.push("#".repeat(w));
    } else {
      rows.push("#" + ".".repeat(w - 2) + "#");
    }
  }
  return rows;
}

/**
 * A serpentine maze: walls with one gap per row, alternating sides.
 *
 * This is the worst case that matters. A* on open floor expands almost nothing because
 * the heuristic is exact; a map that forces the route to double back makes it expand
 * a large fraction of the grid, which is what a real dungeon does.
 */
function mazeMap(w, h) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    if (y === 0 || y === h - 1) {
      rows.push("#".repeat(w));
      continue;
    }
    if (y % 2 === 0) {
      // A wall across the map with a single gap, alternating end to end.
      const gap = y % 4 === 0 ? w - 2 : 1;
      let row = "";
      for (let x = 0; x < w; x += 1) {
        row += x === 0 || x === w - 1 ? "#" : x === gap ? "." : "#";
      }
      rows.push(row);
    } else {
      rows.push("#" + ".".repeat(w - 2) + "#");
    }
  }
  return rows;
}

/** Rough bytes of the map held as QBSK values: one str QValue per row. */
function qbskBytes(rows) {
  // A JS string is ~2 bytes per char plus header; a QValue wrapper is ~32 bytes.
  return rows.reduce((sum, row) => sum + row.length * 2 + 32, 0);
}

const time = (fn) => {
  const t0 = performance.now();
  const result = fn();
  return { ms: performance.now() - t0, result };
};

console.log("QBSK map-size workload — one call each, worst case\n");
console.log("   size |    cells |  path open |  path maze |  sight r11 |   map KB");
console.log("  ------+----------+------------+------------+------------+---------");

for (const size of SIZES) {
  const w = size;
  const h = Math.max(3, Math.round(size / 2));
  const open = openMap(w, h);
  const maze = mazeMap(w, h);

  const from = [1, 1];
  // The destination must be on a FLOOR row. In the maze every even row is a wall, so
  // (w-2, h-2) lands inside one whenever h is even — the first run of this benchmark
  // reported "no route" at three sizes for exactly that reason, which would have read
  // as A* failing rather than as the fixture being wrong.
  const lastFloor = (h - 2) % 2 === 0 ? h - 3 : h - 2;
  const to = [w - 2, lastFloor];

  const a = time(() => findPath(open, from, to, "#"));
  const b = time(() => findPath(maze, from, to, "#"));
  const c = time(() => computeVisible(open, [Math.floor(w / 2), Math.floor(h / 2)], 11, "#"));

  const kb = (qbskBytes(open) / 1024).toFixed(0);
  console.log(
    `  ${String(size).padStart(5)} | ${String(w * h).padStart(8)} | ` +
      `${a.ms.toFixed(2).padStart(10)} | ${b.ms.toFixed(2).padStart(10)} | ` +
      `${c.ms.toFixed(3).padStart(10)} | ${kb.padStart(7)}`,
  );
  if (b.result.length === 0) {
    console.log(`        (maze at ${size} has no route — check the generator)`);
  }
}

console.log(
  "\n  A turn is not a frame: these are paid on a player action, not 60 times a second.",
);
console.log("  16.6 ms is one frame at 60 fps — the line a player can feel.");
