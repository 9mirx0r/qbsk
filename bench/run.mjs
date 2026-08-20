// `npm run bench` — the quality gate RULE #3 asks for (docs/engine.md §13.1).
//
// This file used to be two lines: it printed "no benchmarks yet (milestone M14)" and
// exited 0, while six real benchmarks sat beside it, unrun, and bench/baseline.md held
// real numbers produced by a command it never called. A gate that cannot fail is worse
// than no gate — it reports confidence it never measured. It hid a 2.4x interpreter
// speedup and would have hidden a 2.4x slowdown just as well.
//
// WHAT THIS DOES NOT DO, on purpose: it does not fail on absolute milliseconds.
// baseline.md's own addendum records the reason — the same commit measured 0.735 ms in
// one session and 0.975 ms in another on the same machine, with nothing changed but
// background load. A threshold on those numbers would cry regression at the weather.
// So this reports, the human compares, and the exit code answers a question a machine
// can actually answer: did every benchmark still RUN?
//
// The asset generators in bench/ (sprite-gen, worldgen-gen, worldgen-names-gen,
// spritesheet-slice, sprite-gen-batch, measure-ramp) are deliberately absent: they
// WRITE into examples/res/. A gate with side effects is not a gate.
//
//   node bench/run.mjs            run everything, print the table
//   node bench/run.mjs --profile  only the reference profile
//   node bench/run.mjs --list     name what would run, measure nothing

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = join(ROOT, "dist", "cli", "main.js");

/**
 * The read-only benchmarks. `args` are the defaults each one documents, spelled out
 * here so the gate measures a fixed workload rather than whatever a default becomes.
 */
const BENCHMARKS = [
  { name: "camera-dsl", file: "camera-dsl.mjs", args: [] },
  { name: "tiles", file: "tiles.mjs", args: ["120", "40", "300"] },
  { name: "entities", file: "entities.mjs", args: [] },
  { name: "maps", file: "maps.mjs", args: [] },
  { name: "ecs", file: "ecs.mjs", args: [] },
  { name: "worldgen-entities", file: "worldgen-entities.mjs", args: [] },
];

/** The reference scene from baseline.md — the one number with a documented history. */
const PROFILE = {
  scene: join("examples", "bounce.qbsk"),
  frames: "300",
};

function runNode(file, args) {
  const started = performance.now();
  try {
    const stdout = execFileSync(process.execPath, [file, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, ms: performance.now() - started, stdout };
  } catch (err) {
    return {
      ok: false,
      ms: performance.now() - started,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? err),
    };
  }
}

function requireBuild() {
  if (existsSync(CLI)) {
    return;
  }
  console.error("bench: dist/cli/main.js is missing — run `npm run build` first.");
  console.error("       (the reference profile runs the real CLI, not the sources)");
  process.exit(1);
}

/** The reference profile, parsed into the fields baseline.md tracks. */
function referenceProfile() {
  const r = runNode(CLI, ["profile", PROFILE.scene, "--frames", PROFILE.frames]);
  if (!r.ok) {
    return { ok: false, detail: r.stderr.trim().split("\n")[0] ?? "profile failed" };
  }
  const text = r.stdout;
  const num = (re) => {
    const m = text.match(re);
    return m === null ? null : Number(m[1]);
  };
  return {
    ok: true,
    raw: text.trim(),
    fpsMean: num(/fps mean:\s*([\d.]+)/),
    p99: num(/p99:\s*([\d.]+)/),
    script: num(/script:\s*([\d.]+)/),
    compose: num(/compose:\s*([\d.]+)/),
    diff: num(/diff:\s*([\d.]+)/),
    emit: num(/emit:\s*([\d.]+)/),
  };
}

function printProfile(p) {
  console.log("Reference profile — examples/bounce.qbsk, 300 frames");
  console.log("  (baseline.md records this same command; absolute ms are a SHAPE");
  console.log("   reference, never a threshold — see §13.1)\n");
  if (!p.ok) {
    console.log(`  FAILED: ${p.detail}\n`);
    return;
  }
  for (const line of p.raw.split("\n")) {
    console.log(`  ${line}`);
  }
  const total = (p.script ?? 0) + (p.compose ?? 0) + (p.diff ?? 0) + (p.emit ?? 0);
  if (total > 0) {
    const interp = (((p.script ?? 0) / total) * 100).toFixed(1);
    const render = ((((p.diff ?? 0) + (p.emit ?? 0)) / total) * 100).toFixed(1);
    console.log("");
    console.log(`  total CPU: ${total.toFixed(3)} ms/frame of a 2 ms budget`);
    console.log(`  RATIOS (trust these): interpreter ${interp}%  diff+emit ${render}%`);
  }
  console.log("");
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--list")) {
    console.log("reference profile:");
    console.log(`  qbsk profile ${PROFILE.scene} --frames ${PROFILE.frames}`);
    console.log("benchmarks:");
    for (const b of BENCHMARKS) {
      const args = b.args.length > 0 ? ` ${b.args.join(" ")}` : "";
      console.log(`  ${b.name.padEnd(20)} (bench/${b.file}${args})`);
    }
    console.log("\nnot run here (they write files): sprite-gen, sprite-gen-batch,");
    console.log("worldgen-gen, worldgen-names-gen, spritesheet-slice");
    return;
  }

  requireBuild();
  console.log(`QBSK bench — node ${process.version} on ${process.platform}\n`);

  printProfile(referenceProfile());
  if (argv.includes("--profile")) {
    return;
  }

  console.log("Benchmarks");
  console.log("  name                 status    wall");
  console.log("  ---------------------+---------+--------");

  const failures = [];
  for (const b of BENCHMARKS) {
    const r = runNode(join(HERE, b.file), b.args);
    const status = r.ok ? "ok" : "FAILED";
    console.log(
      `  ${b.name.padEnd(20)} ${status.padEnd(8)} ${`${r.ms.toFixed(0)} ms`.padStart(7)}`,
    );
    if (!r.ok) {
      failures.push({ name: b.name, detail: (r.stderr ?? "").trim().split("\n")[0] });
    }
  }
  console.log("");

  if (failures.length > 0) {
    console.error("A benchmark stopped working — that IS a regression:\n");
    for (const f of failures) {
      console.error(`  ${f.name}: ${f.detail}`);
    }
    console.error("\nRun it directly to see the whole failure.");
    process.exit(1);
  }

  console.log(`All ${BENCHMARKS.length} benchmarks ran. Numbers above are for reading,`);
  console.log("not for gating: compare A/B back to back in one sitting (§13.1).");
}

main();
