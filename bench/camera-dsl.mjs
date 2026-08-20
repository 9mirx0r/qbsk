// bench/camera-dsl.mjs — supports an earlier release "half 2" decision:
// do we need a `camera`/`mesh` DSL, or are the natives enough?
//
// Measures the raw cost of a single `project()` native call as seen by a
// QBSK scene (interpreter + native + dict lookup), and projects what a
// hypothetical per-put world-space projection would cost against the
// measured frame budget (bench/baseline.md).
import { runQbsk } from "../dist/interp/interpreter.js";

const cam = { x: 20.0, y: 6.0, z: 20.0, fov: 70.0 };
const point = [1.0, 1.0, 1.0];

const src = `
const cam = ${JSON.stringify(cam)}
const pt = [1.0, 1.0, 1.0]
var acc = 0.0
var i = 0
while i < ${250000}
    var p = project(pt, cam, 70, 26)
    acc = acc + p[2]
    i = i + 1
print(acc)
`;

const t0 = performance.now();
const r = runQbsk(src, "bench-camera-dsl");
const t1 = performance.now();
if (r.error !== null) {
  console.error("ERROR:", r.error.message);
  process.exit(1);
}
const calls = 250000;
const perCallMs = (t1 - t0) / calls;
console.log(`project() through the interpreter: ${perCallMs.toFixed(4)} ms/call (${calls} calls in ${(t1 - t0).toFixed(0)} ms)`);
console.log(`=> 8-point cube scene: ${(perCallMs * 8).toFixed(3)} ms/frame of pure projection`);
console.log(`=> 50 world-space puts re-projected per frame: ${(perCallMs * 50).toFixed(2)} ms/frame`);
console.log(`(measured 3D scene cube.qbsk: script 0.986 ms/frame total; baseline interpreter ~0.735 ms/frame)`);
