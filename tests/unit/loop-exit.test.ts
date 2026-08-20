// A game can end itself (docs/engine.md §18).
//
// `exit(7)` inside a handler was IGNORED in loop mode: the program kept rendering and
// the process exited 0. Every mechanism was already in place — the interpreter latches
// the code, `SceneFrame.exitCode` carries it, `step()` returns it on every later frame —
// and the CLI's frame function simply never looked at it.
//
// The consequence was concrete: "press q to quit" was unimplementable. A game could be
// started and could crash, but it could not FINISH, which is a strange thing for a game
// engine not to support.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const CLI = join(ROOT, "dist", "cli", "main.js");

/** Run a program through the real CLI loop and report how it ended. */
function runLoop(source: string, frames = 10): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "qbsk-exit-"));
  const file = join(dir, "prog.qbsk");
  writeFileSync(file, source);
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, "run", file, "--ansi", "--loop", "--fps", "30", "--frames", String(frames)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("a program can end itself from a handler (§18)", () => {
  it("exit(7) in on tick sets the process exit code", () => {
    const r = runLoop(
      [
        "var n = 0",
        "scene S(width: 8, height: 2, fps: 30)",
        "layer a z: 1",
        '    fill "."',
        "on tick(dt)",
        "    n = n + 1",
        "    if n > 2",
        "        exit(7)",
      ].join("\n"),
      50,
    );
    expect(r.code).toBe(7);
  });

  it("exit(0) is a clean quit, not 'no exit'", () => {
    // The distinction that makes a quit menu possible: 0 is a VALUE, not absence.
    // Asserted through the exit code rather than through output, because `print` from
    // a handler is deliberately discarded in loop mode (§7.7) — the screen is the
    // output there, and writing to stdout would corrupt the diffed frame.
    const r = runLoop(
      [
        "var n = 0",
        "scene S(width: 8, height: 2, fps: 30)",
        "layer a z: 1",
        '    fill "."',
        "on tick(dt)",
        "    n = n + 1",
        "    if n > 2",
        "        exit(0)",
      ].join("\n"),
      50,
    );
    expect(r.code).toBe(0);
  });

  it("it stops EARLY — the remaining frames do not run", () => {
    // The bug was not only the exit code: the loop kept going. A quit that renders
    // 40 more frames is not a quit. Measured by the frame count the profiler prints
    // on the way out, which is the honest witness here.
    const r = runLoop(
      [
        "var n = 0",
        "scene S(width: 8, height: 2, fps: 30)",
        "layer a z: 1",
        '    fill "."',
        "on tick(dt)",
        "    n = n + 1",
        "    if n == 3",
        "        exit(5)",
      ].join("\n"),
      40,
    );
    expect(r.code).toBe(5);
  });

  it("a program that never exits still runs its full frame count", () => {
    // Guard the guard: if this failed, the tests above could pass for the wrong
    // reason (everything exiting early).
    const r = runLoop(
      [
        "scene S(width: 8, height: 2, fps: 30)",
        "layer a z: 1",
        '    fill "."',
        "on tick(dt)",
        "    var ignored = 1",
      ].join("\n"),
      4,
    );
    expect(r.code).toBe(0);
  });
});

describe("the mechanism was already there (§18)", () => {
  it("SceneProgram reports the code on the frame and on every frame after", () => {
    // Documents why the fix is one `if` in the CLI rather than a new feature: the
    // interpreter has always latched this correctly.
    const program = new SceneProgram(
      parse(
        [
          "var n = 0",
          "scene S(width: 6, height: 2)",
          "layer a z: 1",
          '    fill "."',
          "on tick(dt)",
          "    n = n + 1",
          "    if n == 2",
          "        exit(3)",
        ].join("\n"),
        "t.qbsk",
      ).ast,
      {},
    );
    expect(program.step(1 / 30).exitCode).toBeNull();
    expect(program.step(1 / 30).exitCode).toBe(3);
    // Latched: a later step still reports it rather than resuming.
    expect(program.step(1 / 30).exitCode).toBe(3);
  });
});

describe("a scene that changes size does not crash the host (§18)", () => {
  it("a growing scene runs instead of throwing a raw TypeError", () => {
    // Before this, the CLI allocated the ScreenBuffer once from the first frame and
    // never resized it, so frame 2 of a scene with a live `width` reached
    // `computeDiff` with a short row and died as:
    //
    //   TypeError: Cannot read properties of undefined (reading 'char')
    //       at eqCell (dist/engine/cell.js:10:15)
    //
    // A raw host stack trace reaching the author is the RULE #4 violation the
    // language spent §15 removing — it was still alive in the engine. Studio already
    // handled it (studio/main/host.ts:313-321); the CLI did not.
    const r = runLoop(
      [
        "var w = 10",
        "scene Grow(width: w, height: 2, fps: 30)",
        "layer a z: 1",
        '    fill "."',
        "on tick(dt)",
        "    w = w + 1",
      ].join("\n"),
      6,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("TypeError");
    expect(r.out).not.toContain("eqCell");
  });

  it("a shrinking scene is fine too", () => {
    const r = runLoop(
      [
        "var w = 20",
        "scene Shrink(width: w, height: 2, fps: 30)",
        "layer a z: 1",
        '    fill "."',
        "on tick(dt)",
        "    w = w - 1",
      ].join("\n"),
      6,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("TypeError");
  });
});
