// examples/main_menu.qbsk — menu -> jail -> live world creation, end to end.
//
// Runs the actual scene through a full playthrough (no shortcuts, no mocking of
// the generation logic) and asserts the three screens are reached in order and
// that the world/history produced are real, non-empty data — not just that the
// scene fails to crash.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

const examplesDir = fileURLToPath(new URL("../../examples/", import.meta.url));
const source = readFileSync(`${examplesDir}main_menu.qbsk`, "utf8");

function boot(): SceneProgram {
  const parsed = parse(source, "main_menu.qbsk");
  expect(parsed.errors).toEqual([]);
  return new SceneProgram(parsed.ast, {
    runtime: { gameTime: 0 },
    baseDir: dirname(`${examplesDir}main_menu.qbsk`),
  });
}

function stepMany(p: SceneProgram, times: number, dt: number): void {
  for (let i = 0; i < times; i += 1) {
    const f = p.step(dt);
    if (f.error !== null) {
      throw new Error(`frame ${i}: ${f.error.message}`);
    }
  }
}

describe("main_menu.qbsk — the full menu -> jail -> live world loop", () => {
  it("checks with no parser/analyzer errors", () => {
    const parsed = parse(source, "main_menu.qbsk");
    expect(parsed.errors).toEqual([]);
  });

  it("starts on the menu screen", () => {
    const p = boot();
    stepMany(p, 3, 1 / 20);
    expect(p.liveEnv.get("screen")).toEqual({ type: "str", value: "menu" });
  });

  it("START GAME enters the jail scene", () => {
    const p = boot();
    stepMany(p, 1, 1 / 20);
    p.pressKey("enter");
    stepMany(p, 1, 1 / 20);
    expect(p.liveEnv.get("screen")).toEqual({ type: "str", value: "jail" });
  });

  it("the jail conversation ends and hands off to LIVE generation, which produces a real world", () => {
    // Stepping the interpreter hundreds of times in a test process is inherently
    // slower than a real 20fps run; this comfortably beats the default 5s cap.
    const p = boot();
    stepMany(p, 1, 1 / 20);
    p.pressKey("enter");
    stepMany(p, 1, 1 / 20);
    expect(p.liveEnv.get("screen")).toEqual({ type: "str", value: "jail" });

    // Fast-forward through the ~41s conversation (timelines are pure functions of
    // gameTime, so a coarse dt covers it correctly — no frame-count assumptions).
    stepMany(p, 120, 0.5);
    expect(p.liveEnv.get("screen")).toEqual({
      type: "str",
      value: "generating",
    });

    // Generation is throttled to real per-tick work (a few rows/events at a time),
    // so it needs enough actual ticks, not just elapsed time.
    stepMany(p, 250, 0.1);

    expect(p.liveEnv.get("screen")).toEqual({ type: "str", value: "world" });

    const worldMap = p.liveEnv.get("worldMap");
    expect(worldMap?.type).toBe("list");
    expect(
      (worldMap as { type: "list"; items: unknown[] }).items.length,
    ).toBe(18);

    const historyLog = p.liveEnv.get("historyLog");
    expect(historyLog?.type).toBe("list");
    expect(
      (historyLog as { type: "list"; items: unknown[] }).items.length,
    ).toBeGreaterThan(0);

    expect(p.liveEnv.get("worldGenerated")).toEqual({
      type: "bool",
      value: true,
    });
  }, 60000);

  it("ESC during the jail scene skips straight to a still-live generation", () => {
    const p = boot();
    stepMany(p, 1, 1 / 20);
    p.pressKey("enter");
    stepMany(p, 1, 1 / 20);
    p.pressKey("escape");
    stepMany(p, 1, 1 / 20);
    expect(p.liveEnv.get("screen")).toEqual({
      type: "str",
      value: "generating",
    });
  });
});
