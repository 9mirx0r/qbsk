// an earlier release — frame-swapping (docs/engine.md §11.4).
import { describe, expect, it } from "vitest";
import { pickFrame } from "../../src/choreo/frames.js";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const EXAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
);

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "golden");

describe("pickFrame: the frame follows the game clock (docs/engine.md §11.4)", () => {
  it("advances one frame per 1/fps of game time", () => {
    for (let k = 0; k < 4; k += 1) {
      expect(pickFrame(4, 8, true, k / 8).index).toBe(k);
    }
  });

  it("loops back to the first frame after the last", () => {
    expect(pickFrame(4, 8, true, 4 / 8).index).toBe(0);
    expect(pickFrame(4, 8, true, 5 / 8).index).toBe(1);
  });

  it("without loop it HOLDS the last frame instead of vanishing or restarting", () => {
    // What a one-shot animation needs: a door that opened stays open.
    expect(pickFrame(4, 8, false, 3 / 8).index).toBe(3);
    expect(pickFrame(4, 8, false, 99).index).toBe(3);
    expect(pickFrame(4, 8, false, 99).finished).toBe(true);
  });

  it("a single-frame sprite is a still, not an animation", () => {
    expect(pickFrame(1, 30, true, 12.5)).toEqual({ index: 0, finished: true });
  });

  it("fps 0 or negative is a still frame, not a division by zero", () => {
    expect(pickFrame(4, 0, true, 5).index).toBe(0);
    expect(pickFrame(4, -3, true, 5).index).toBe(0);
    expect(Number.isFinite(pickFrame(4, 0, true, 5).index)).toBe(true);
  });

  it("never returns an out-of-range index, however odd the inputs", () => {
    for (const t of [0, 0.001, 1, 7.77, 1e6]) {
      for (const fps of [1, 8, 60]) {
        const i = pickFrame(5, fps, true, t).index;
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(5);
      }
    }
  });

  // THE point of this module. gameTime accumulates floats, and a frame boundary is
  // exactly where floor() changes its answer, so without the epsilon a 20 fps run
  // and a 60 fps run disagree at t = 0.25. Measured before the fix; this is the
  // test that keeps it fixed.
  it("the same game time gives the same frame at any frame rate", () => {
    const times = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.5, 2];
    for (const t of times) {
      const slow = accumulate(t, 1 / 20);
      const fast = accumulate(t, 1 / 60);
      expect(pickFrame(4, 8, true, fast).index).toBe(
        pickFrame(4, 8, true, slow).index,
      );
    }
  });

  function accumulate(target: number, dt: number): number {
    let t = 0;
    for (let i = 0; i < Math.round(target / dt); i += 1) {
      t += dt;
    }
    return t;
  }
});

describe("the sprite DSL: frames / fps / loop", () => {
  const SCENE = `scene W(width: 14, height: 5)
layer a z: 1
    fill "."
    sprite "res/walk.qba" at (5, 1) frames: 4 fps: 8 loop: true
`;

  function frameAt(steps: number, dt: number): string {
    const p = new SceneProgram(parse(SCENE, "w.qbsk").ast, { baseDir: EXAMPLES });
    let f = p.step(dt);
    for (let i = 1; i < steps; i += 1) {
      f = p.step(dt);
    }
    expect(f.error).toBeNull();
    return f.canvas!.renderText();
  }

  it("a multi-frame sprite actually changes over time", () => {
    const a = frameAt(1, 1 / 8);
    const b = frameAt(2, 1 / 8);
    expect(a).not.toBe(b);
  });

  it("the walk cycle returns to its first frame after a full loop", () => {
    // 4 frames at 8 fps, so step 5 lands back on frame 0.
    expect(frameAt(5, 1 / 8)).toBe(frameAt(1, 1 / 8));
    // ...and step 2 must differ, or this would pass on a sprite that never
    // changes. Frame 2 rather than 3: walk.qba is a standard contact-pass-
    // contact-pass cycle, so frames 1 and 3 are deliberately the same pose.
    expect(frameAt(2, 1 / 8)).not.toBe(frameAt(1, 1 / 8));
  });

  it("renders identically at 20 fps and at 60 fps for the same game time", () => {
    expect(frameAt(60, 1 / 60)).toBe(frameAt(20, 1 / 20));
  });

  it("declaring more frames than the file has is an error with a span", () => {
    const bad = `scene W(width: 14, height: 5)
layer a z: 1
    sprite "res/walk.qba" at (5, 1) frames: 9 fps: 8 loop: true
`;
    const p = new SceneProgram(parse(bad, "w.qbsk").ast, { baseDir: EXAMPLES });
    const f = p.step(1 / 8);
    expect(f.error).not.toBeNull();
    expect(f.error!.message).toContain("frames: 9");
    expect(f.error!.message).toContain("4");
  });

  it("without `frames` a multi-frame sprite still shows frame 0, as before", () => {
    const plain = `scene W(width: 14, height: 5)
layer a z: 1
    fill "."
    sprite "res/walk.qba" at (5, 1)
`;
    const p = new SceneProgram(parse(plain, "w.qbsk").ast, { baseDir: EXAMPLES });
    const a = p.step(1 / 8).canvas!.renderText();
    for (let i = 0; i < 10; i += 1) p.step(1 / 8);
    expect(p.step(1 / 8).canvas!.renderText()).toBe(a);
  });

  it("intermediate frame matches byte-exact golden (walk frame 2 at 0.25s)", () => {
    const out = frameAt(2, 1 / 8); // gameTime 0.25 → frame 1 (second frame)
    const golden = readFileSync(resolve(GOLDEN, "walk-frame2.out"), "utf8");
    expect(out).toBe(golden);
  });
});
