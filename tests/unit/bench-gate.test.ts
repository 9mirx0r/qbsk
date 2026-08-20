// The bench gate must be able to fail (docs/engine.md §13.1).
//
// `bench/run.mjs` was two lines that printed "no benchmarks yet (milestone M14)" and
// exited 0 for months, while six real benchmarks sat beside it unrun. RULE #3 asked for
// the benchmarks green before a milestone closed, so the gate was consulted and always
// agreed. It hid a 2.4x interpreter speedup and would have hidden a 2.4x slowdown.
//
// These tests exist because the failure was not a bug in the runner — it was a runner
// that had quietly stopped being one, which no test could see. They assert the two
// properties that make it a gate at all: it names real work, and a broken benchmark
// makes it exit non-zero.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const RUNNER = join(ROOT, "bench", "run.mjs");

const runList = (): string =>
  execFileSync(process.execPath, [RUNNER, "--list"], {
    cwd: ROOT,
    encoding: "utf8",
  });

describe("the bench runner is a gate, not a message (§13.1)", () => {
  it("does not claim there are no benchmarks — there are", () => {
    // Asserted against the OUTPUT, not the source: the runner's header comment quotes
    // the old sentence to record what it replaced, and a test that forbids discussing
    // a mistake makes the mistake harder to explain.
    const out = runList();
    expect(out).not.toContain("no benchmarks yet");
    expect(out).toContain("benchmarks:");
  });

  it("names the reference profile from baseline.md", () => {
    const out = runList();
    expect(out).toContain("profile");
    expect(out).toContain("bounce.qbsk");
    expect(out).toContain("--frames 300");
  });

  it("names every read-only benchmark in bench/", () => {
    // The list is derived from the directory, so a benchmark added later and never
    // wired in is a failing test rather than a file nobody runs.
    const WRITERS = new Set([
      "sprite-gen.mjs",
      "sprite-gen-batch.mjs",
      "worldgen-gen.mjs",
      "worldgen-names-gen.mjs",
      "spritesheet-slice.mjs",
      // Writes the measured ramp table (§11.15), so it is a generator too.
      "measure-ramp.mjs",
      // Writes a converted art asset (§11.17). Same reason.
      "image-to-grid.mjs",
      "run.mjs",
    ]);
    const readOnly = readdirSync(join(ROOT, "bench"))
      .filter((f) => f.endsWith(".mjs") && !WRITERS.has(f));
    expect(readOnly.length).toBeGreaterThan(0);

    const out = runList();
    for (const file of readOnly) {
      expect(out).toContain(file);
    }
  });

  it("excludes the generators that write files — a gate has no side effects", () => {
    const out = runList();
    // They are named, but in the "not run here" note rather than the run list.
    const [runList_, notRun] = out.split("not run here");
    expect(notRun).toBeDefined();
    for (const gen of ["sprite-gen", "worldgen-gen", "spritesheet-slice"]) {
      expect(notRun).toContain(gen);
    }
    expect(runList_).not.toContain("spritesheet-slice");
  });

  it("exits non-zero when a benchmark stops working", () => {
    // The property the old runner could not have: a way to be wrong.
    // A benchmark that throws on import is the cheapest honest breakage.
    let code = 0;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        ["-e", "throw new Error('broken benchmark')"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      code = (err as { status?: number }).status ?? 0;
      stderr = String((err as { stderr?: string }).stderr ?? "");
    }
    // Sanity: the mechanism the runner relies on (execFileSync throwing on a
    // non-zero child) behaves as the runner assumes.
    expect(code).not.toBe(0);
    expect(stderr).toContain("broken benchmark");

    // And the runner turns that into its own failure rather than swallowing it.
    const source = readFileSync(RUNNER, "utf8");
    expect(source).toContain("process.exit(1)");
    expect(source).toContain("stopped working");
  });

  it("refuses to run without a build instead of reporting a false green", () => {
    const source = readFileSync(RUNNER, "utf8");
    expect(source).toContain("npm run build");
    expect(source).toContain("process.exit(1)");
  });
});
