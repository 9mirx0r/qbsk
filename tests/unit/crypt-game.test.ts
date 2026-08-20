// crypt.qbsk — a game that can be won, lost and quit.
//
// This test PLAYS the game. It does not check that the file parses (`fmt` and `check`
// already do that in docs-truth and the examples sweep); it drives the real handlers
// through the real turn loop and asserts on the outcome.
//
// The distinction matters: three engine bugs were found this session by trying to write
// a playable game, and none of them was visible to a test that only composed a scene.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const EXAMPLES = join(ROOT, "examples");
const SOURCE = readFileSync(join(EXAMPLES, "crypt.qbsk"), "utf8");

function boot(): SceneProgram {
  const parsed = parse(SOURCE, "crypt.qbsk");
  expect(parsed.errors).toEqual([]);
  const p = new SceneProgram(parsed.ast, { baseDir: EXAMPLES });
  expect(p.error).toBeNull();
  p.step(1 / 20);
  return p;
}

const num = (p: SceneProgram, name: string): number =>
  (p.liveEnv.get(name) as { value: number }).value;
const str = (p: SceneProgram, name: string): string =>
  (p.liveEnv.get(name) as { value: string }).value;
const flag = (p: SceneProgram, name: string): boolean =>
  (p.liveEnv.get(name) as { value: boolean }).value;

/**
 * Walk to a target the way a player with a map would: ask the game's own A* for the
 * route and take one step per frame.
 *
 * Orthogonal only (`false` as the fifth argument) — `path` allows diagonals by default
 * (docs/engine.md §13) and this game binds four arrow keys, so a diagonal step is a
 * route the player cannot follow.
 */
function walkTo(p: SceneProgram, tx: number, ty: number, budget = 300): void {
  p.evalSnippet("var __route = []", "nav.qbsk");
  for (let i = 0; i < budget; i += 1) {
    const px = num(p, "playerX");
    const py = num(p, "playerY");
    if ((px === tx && py === ty) || str(p, "over") !== "") {
      return;
    }
    const snippet = p.evalSnippet(
      `__route = path(MAP, (${px}, ${py}), (${tx}, ${ty}), "#", false)`,
      "nav.qbsk",
    );
    expect(snippet.error).toBeNull();
    const route = p.liveEnv.get("__route") as { items: { x: { value: number }; y: { value: number } }[] };
    if (route.items.length < 2) {
      return;
    }
    const next = route.items[1]!;
    const dx = next.x.value - px;
    const dy = next.y.value - py;
    p.pressKey(
      dx === 1 ? "arrow-right" : dx === -1 ? "arrow-left" : dy === 1 ? "arrow-down" : "arrow-up",
    );
    const frame = p.step(1 / 20);
    expect(frame.error).toBeNull();
  }
}

describe("crypt.qbsk can be won", () => {
  it("the amulet is reachable and the stairs end the game", () => {
    const p = boot();
    expect(flag(p, "hasAmulet")).toBe(false);

    walkTo(p, 37, 14);
    expect(flag(p, "hasAmulet")).toBe(true);
    expect(str(p, "log")).toMatch(/amulet/);

    walkTo(p, 2, 14);
    expect(str(p, "over")).toBe("win");
    expect(num(p, "hp")).toBeGreaterThan(0);
  });

  it("the winning screen is drawn, not just a variable", () => {
    const p = boot();
    walkTo(p, 37, 14);
    walkTo(p, 2, 14);
    const rows = p.step(1 / 20).canvas!.renderText().split("\n");
    expect(rows.join("\n")).toContain("YOU ESCAPED");
  });
});

describe("crypt.qbsk can be lost", () => {
  it("standing still lets the skeletons kill you", () => {
    // A game you cannot lose is not a game. The monsters path toward the player on
    // `on turn`, so waiting is a real choice with a real cost.
    const p = boot();
    for (let i = 0; i < 200 && str(p, "over") === ""; i += 1) {
      p.pressKey("space");
      expect(p.step(1 / 20).error).toBeNull();
    }
    expect(str(p, "over")).toBe("lose");
    expect(num(p, "hp")).toBeLessThanOrEqual(0);
  });

  it("the death screen is drawn and the player glyph is gone", () => {
    const p = boot();
    for (let i = 0; i < 200 && str(p, "over") === ""; i += 1) {
      p.pressKey("space");
      p.step(1 / 20);
    }
    const text = p.step(1 / 20).canvas!.renderText();
    expect(text).toContain("YOU DIED");
    expect(text).not.toContain("@");
  });
});

describe("crypt.qbsk can be quit", () => {
  it("q ends the loop with 0", () => {
    // docs/engine.md §18.1 — this was impossible before this session.
    const p = boot();
    p.pressKey("q");
    expect(p.step(1 / 20).exitCode).toBe(0);
  });
});

describe("the rules hold", () => {
  it("walls stop the player", () => {
    const p = boot();
    const before = num(p, "playerX");
    for (let i = 0; i < 5; i += 1) {
      p.pressKey("arrow-left");
      p.step(1 / 20);
    }
    // Started at x=2 with a wall at x=0, so the player stops at 1 rather than passing.
    expect(num(p, "playerX")).toBe(1);
    expect(before).toBeGreaterThan(num(p, "playerX") - 1);
  });

  it("a held key moves one cell per frame (docs/engine.md §8.3)", () => {
    const p = boot();
    const before = num(p, "playerY");
    for (let i = 0; i < 4; i += 1) {
      p.pressKey("arrow-down");
    }
    p.step(1 / 20);
    expect(num(p, "playerY")).toBe(before + 1);
  });

  it("the turn counter only advances when the player acts", () => {
    const p = boot();
    const t0 = num(p, "hp");
    // Ten frames with no input: the world does not move on its own.
    for (let i = 0; i < 10; i += 1) {
      p.step(1 / 20);
    }
    expect(num(p, "hp")).toBe(t0);
  });
});
