// The first-person demo is pinned (docs/engine.md §11.21).
//
// RULE #5: no feature without a demo. `raycast` is the DDA and nothing else, so the
// proof that it is usable is a scene that draws a corridor out of it — height falloff,
// distance ramp and side shading all written in QBSK.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";

const NL = String.fromCharCode(10);
const ROOT = resolve(import.meta.dirname, "..", "..");
const EXAMPLES = resolve(ROOT, "examples");
const SOURCE = readFileSync(resolve(EXAMPLES, "first_person.qbsk"), "utf8");

function started(): SceneProgram {
  const parsed = parse(SOURCE, "first_person.qbsk");
  expect(parsed.errors).toEqual([]);
  return new SceneProgram(parsed.ast, { baseDir: EXAMPLES });
}

/** The wall rows only, without the HUD, whose turn counter legitimately moves. */
function corridor(p: SceneProgram): string {
  return view(p).split("\n").slice(0, 32).join("\n");
}

/**
 * One press, one frame.
 *
 * §8.3 coalesces key presses to one per frame on purpose, so pressing three keys and
 * then stepping once delivers fewer than three. Stepping between presses is not test
 * ceremony — it is how the engine is actually driven.
 */
function press(p: SceneProgram, key: string): void {
  p.pressKey(key);
  view(p);
}

function view(p: SceneProgram): string {
  const f = p.step(0.05);
  expect(f.error?.message ?? null).toBeNull();
  return f.canvas!.renderText();
}

describe("a corridor seen from inside it", () => {
  it("matches its golden byte for byte", () => {
    const golden = readFileSync(resolve(ROOT, "tests", "golden", "first_person.qbsk.out"), "utf8");
    expect(view(started())).toBe(golden.replace(/\r\n/g, "\n").replace(/\n$/, ""));
  });

  it("does not move between key presses, because a turn is not a frame", () => {
    // The turn-based half. Ten frames pass and nothing happens — which is the property
    // that separates this from a free-look renderer, and the one a `gameTime()`-driven
    // camera would quietly break.
    const p = started();
    const first = view(p);
    for (let i = 0; i < 9; i += 1) {
      expect(view(p)).toBe(first);
    }
  });

  it("turns the view when the player turns", () => {
    const p = started();
    const ahead = corridor(p);
    press(p, "arrow-left");
    expect(corridor(p)).not.toBe(ahead);
  });

  it("brings the guard back into view after a full circle of turns", () => {
    // Eight 45-degree lefts is one revolution, so the guard standing dead ahead must be
    // ahead again. He is nearer by eight turns of walking, which is why the assertion is
    // "visible" and not "identical bytes".
    //
    // An earlier version compared the two views byte for byte, through a program that
    // spent the same turns waiting. It failed, and it deserved to: eight additions of
    // pi/4 land on -2pi, where `sin` returns -2.4e-16 rather than 0, and one ray in
    // ninety-six crosses a tile boundary on the other side. That is the FPU, not the
    // game. Bit-exactness through trigonometry is not a property worth pinning; coming
    // back around is.
    const p = started();
    expect(view(p)).toContain("╠");
    for (let i = 0; i < 4; i += 1) {
      press(p, "arrow-left");
    }
    expect(view(p)).not.toContain("╠");
    for (let i = 0; i < 4; i += 1) {
      press(p, "arrow-left");
    }
    expect(view(p)).toContain("╠");
  });

  it("refuses a step into stone rather than sliding along it", () => {
    // Two lefts from east is north, and the north wall is half a tile away. Forward is
    // refused and the corridor is unchanged: a move that half-happens is one the player
    // cannot plan around.
    const p = started();
    press(p, "arrow-left");
    press(p, "arrow-left");
    const facingNorth = corridor(p);
    press(p, "arrow-up");
    expect(corridor(p)).toBe(facingNorth);
  });

  it("draws the guard standing in the open corridor", () => {
    // He is seven tiles dead ahead, so he lands in the middle columns at two rows tall.
    expect(view(started())).toContain("╠");
  });

  it("hides the guard the walls stand in front of", () => {
    // The second guard is inside the field of view and twelve tiles out, with the row-2
    // block between. He must not be drawn. This is the assertion that fails if occlusion
    // compares a radial entity distance against a perpendicular wall distance, or skips
    // the comparison entirely.
    expect(view(started())).not.toContain("║");
  });

  it("loses the guard when the player turns away from him", () => {
    // Occlusion says what is behind a wall; the field of view says what is behind the
    // player. Both must remove him, and only one of them is about geometry in front.
    const p = started();
    expect(view(p)).toContain("╠");
    press(p, "arrow-left");
    press(p, "arrow-left");
    expect(view(p)).not.toContain("╠");
  });

  // --- The guards move, on turns (docs/engine.md §12) -------------------------

  /** The `near` figure the HUD reports: how far the closest awake guard is. */
  function nearest(p: SceneProgram): number {
    const hud = view(p).split(NL)[32]!;
    const m = hud.match(/near (\d+)/);
    expect(m, `HUD must report a distance, got: ${hud}`).not.toBeNull();
    return Number(m![1]);
  }

  it("does not let a guard move between key presses", () => {
    // The same property as the camera's, and the one that matters more: an enemy that
    // walks on `gameTime()` turns a turn-based game into a real-time one nobody asked
    // for. Ten frames, no press, no approach.
    const p = started();
    const start = nearest(p);
    for (let i = 0; i < 9; i += 1) {
      expect(nearest(p)).toBe(start);
    }
  });

  it("brings a guard closer on each turn the player spends", () => {
    const p = started();
    const start = nearest(p);
    press(p, "arrow-left");
    press(p, "arrow-right");
    expect(nearest(p)).toBeLessThan(start);
  });

  it("stops a guard beside the player rather than on top of them", () => {
    // Enough turns for the corridor guard to cross the whole map. He must come to rest
    // adjacent, not share the player's tile — a guard standing where the eye is renders
    // as a wall of glyphs across the frame and is the first thing a naive `path` step
    // does.
    const p = started();
    for (let i = 0; i < 30; i += 1) {
      press(p, "arrow-left");
      press(p, "arrow-right");
    }
    expect(nearest(p)).toBe(1);
  });

  it("gives every guard a stable identity from spawn", () => {
    // An earlier release's `spawn` is what makes these entities rather than dicts, and the ids must
    // survive the turns that move them.
    const p = started();
    const first = view(p).split(NL)[33]!;
    press(p, "arrow-left");
    press(p, "arrow-right");
    expect(view(p).split(NL)[33]).toBe(first);
  });

  it("counts a turn for every press, including the refused one", () => {
    // `advance()` runs whether or not the move landed: deciding to walk into a wall is
    // still deciding, and an enemy acting on that turn must still get its move.
    const p = started();
    view(p);
    press(p, "arrow-left");
    press(p, "arrow-left");
    press(p, "arrow-up");
    expect(view(p)).toContain("turn 3");
  });
});
