// Tileset workload benchmark (the roadmap 06 an earlier release, criterion 1).
//
// The question this exists to answer, before anything is designed around the answer:
// WHERE should a tile lookup happen in the paint pipeline, and what does it cost?
//
// The tileset renderer (C1) paints an image for a cell that has a tile and falls back
// to the character otherwise. The obvious concern is that a 120x40 grid is 4800 cells,
// and "resolve every cell every frame" sounds like it could eat the frame budget.
//
// Two candidate designs:
//   A. FULL-GRID: every frame, resolve every cell (120*40 = 4800 lookups).
//   B. DIFF-RIDE: only the cells the diff reported as changed get a lookup; the
//      DOM painter already patches exactly those cells, so the lookup can ride the
//      same list. Cost scales with *changed* cells, not grid area.
//
// This benchmark measures both against the real pipeline — a scene stepped through
// SceneProgram, diffed with computeDiff — and reports the per-frame cost of each.
// The result decides the design: if DIFF-RIDE is a rounding error beside the script
// cost, it is the right shape, and the full-grid pass is unnecessary work.
//
//   node bench/tiles.mjs [gridW] [gridH] [frames]    defaults: 120 40 300

import { performance } from "node:perf_hooks";
import { parse } from "../dist/parser/parser.js";
import { SceneProgram } from "../dist/interp/interpreter.js";
import { ScreenBuffer } from "../dist/engine/buffer.js";
import { computeDiff } from "../dist/engine/diff.js";

const W = Number(process.argv[2] ?? 120);
const H = Number(process.argv[3] ?? 40);
const FRAMES = Number(process.argv[4] ?? 300);

/** An animated 120x40-ish scene: moving ball + static walls + a HUD line. */
const source = (w, h) =>
  [
    `const W = ${w}`,
    `const H = ${h}`,
    "var px = 2",
    "var pdir = 1",
    "",
    "on tick(dt)",
    "    px += pdir",
    "    if px >= W - 3",
    "        pdir = -1",
    "    if px <= 2",
    "        pdir = 1",
    "",
    "scene TilesBench(width: W, height: H)",
    "layer ground z: 1",
    '    fill "."',
    '    border (1, 1) to (W - 2, H - 2) style: double',
    "layer hud z: 2",
    '    text "TILESET BENCHMARK" at (2, 2)',
    "layer ball z: 3",
    `    put "o" at (px, 10)`,
  ].join("\n");

console.log(
  `QBSK tileset workload — ${W}x${H}, ${FRAMES} frames, both designs\n`,
);

const parsed = parse(source(W, H), "bench.qbsk");
if (parsed.errors.length > 0) {
  console.error("bench program failed to parse:", parsed.errors[0].message);
  process.exit(1);
}
const program = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });

// A tileset where every drawn glyph resolves to a tile — the worst case for lookups.
const tileIds = new Map([
  ["#", 1],
  [".", 2],
  ["o", 3],
  ["T", 4],
  ["I", 5],
  ["L", 6],
  ["E", 7],
  ["S", 8],
  ["B", 9],
  ["N", 10],
  ["C", 11],
  ["H", 12],
  ["M", 13],
  ["R", 14],
  ["K", 15],
]);

let buffer = null;
let frameCount = 0;
let changedCells = 0;
let fullGridMs = 0;
let diffRideMs = 0;

// Warm: first step builds `on start` and the first composition; not counted.
let first = program.step(1 / 60);
buffer = new ScreenBuffer(first.canvas.width, first.canvas.height);
buffer.paintCanvas(first.canvas);

for (let i = 0; i < FRAMES; i += 1) {
  const frame = program.step(1 / 60);
  if (frame.error !== null || frame.canvas === null) {
    console.error("bench program failed at run time:", frame.error.message);
    process.exit(1);
  }
  const canvas = frame.canvas;
  buffer.paintCanvas(canvas);
  const diff = computeDiff(
    buffer.front,
    buffer.back,
    buffer.width,
    buffer.dirtyLines,
  );
  buffer.swap();

  const changed = diff.reduce((acc, d) => acc + d.changed, 0);
  changedCells += changed;

  // A: full-grid lookup — every cell, every frame.
  const t0 = performance.now();
  let hitsA = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    const row = y * canvas.width;
    for (let x = 0; x < canvas.width; x += 1) {
      if (tileIds.get(canvas.cells[row + x].char) !== undefined) {
        hitsA += 1;
      }
    }
  }
  fullGridMs += performance.now() - t0;

  // B: diff-ride lookup — only the cells the diff reported.
  const t1 = performance.now();
  let hitsB = 0;
  for (const line of diff) {
    if (line.rewrite && line.row !== undefined) {
      for (const cell of line.row) {
        if (tileIds.get(cell.char) !== undefined) {
          hitsB += 1;
        }
      }
    } else {
      for (const run of line.runs) {
        for (const cell of run.cells) {
          if (tileIds.get(cell.char) !== undefined) {
            hitsB += 1;
          }
        }
      }
    }
  }
  diffRideMs += performance.now() - t1;
  frameCount += 1;
}

const changedPerFrame = changedCells / frameCount;
const budget = 2; // ms/frame total (docs/engine.md §1.5)

console.log("  design      | ms/frame | % of budget | lookups/frame");
console.log("  ------------+----------+-------------+--------------");
console.log(
  `  full-grid   | ${(fullGridMs / frameCount).toFixed(4).padStart(6)} | ${(
    ((fullGridMs / frameCount) / budget) * 100
  )
    .toFixed(2)
    .padStart(8)}%  | ${(W * H).toFixed(0)}`,
);
console.log(
  `  diff-ride   | ${(diffRideMs / frameCount).toFixed(4).padStart(6)} | ${(
    ((diffRideMs / frameCount) / budget) * 100
  )
    .toFixed(2)
    .padStart(8)}%  | ${changedPerFrame.toFixed(1)}`,
);
console.log(`\n  changed cells/frame: ${changedPerFrame.toFixed(2)} of ${W * H}`);
console.log(
  "  16.6 ms is one frame at 60 fps; the 2 ms budget is the whole-frame CPU line.",
);
