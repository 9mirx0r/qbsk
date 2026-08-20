import { describe, expect, it } from "vitest";
import { GameLoop } from "../../src/engine/loop.js";

// Injected clock: the GameLoop NEVER depends on real time (spec engine.md §7).

function fakeClock() {
  let t = 0;
  const now = () => t;
  return { now, set: (v: number) => void (t = v) };
}

describe("engine/loop: fixed-timestep frame loop", () => {
  it("accumulator: a 2×dt frame → exactly two updates with fixed dt", () => {
    const clock = fakeClock();
    const updates: number[] = [];
    const renders: number[] = [];
    const loop = new GameLoop(
      { fps: 10, now: clock.now },
      {
        update: (dt) => updates.push(dt),
        render: () => {
          renders.push(1);
          return null;
        },
      },
    );
    clock.set(0.2);
    loop.step();
    clock.set(0.4);
    loop.step();
    expect(updates).toEqual([0.1, 0.1, 0.1, 0.1]);
    expect(renders).toHaveLength(2);
    expect(loop.stats().updates).toBe(4);
    expect(loop.stats().frames).toBe(2);
  });

  it("accumulator: a 2.5×dt frame → 2 updates (remainder stays in the accumulator)", () => {
    const clock = fakeClock();
    let updates = 0;
    const loop = new GameLoop(
      { fps: 10, now: clock.now },
      {
        update: () => void updates++,
        render: () => "",
      },
    );
    clock.set(0.25);
    loop.step();
    expect(updates).toBe(2);
  });

  it("unchanged frame (render null) → 0 bytes", () => {
    const clock = fakeClock();
    const loop = new GameLoop(
      { fps: 10, now: clock.now },
      { render: () => null },
    );
    clock.set(1 / 10);
    loop.step();
    expect(loop.stats().bytesPerFrame).toBe(0);
  });

  it("render returns the frame ANSI; stats accumulate cells and bytes", () => {
    const clock = fakeClock();
    const loop = new GameLoop(
      { fps: 10, now: clock.now },
      { render: () => "\x1b[1;1Hx" },
    );
    clock.set(0.1);
    loop.step();
    loop.report({ cells: 1, bytes: 7, scriptMs: 0.5, composeMs: 0.2, diffMs: 0.1, emitMs: 0.05 });
    const s = loop.stats();
    expect(s.frames).toBe(1);
    expect(s.cellsPerFrame).toBe(1);
    expect(s.bytesPerFrame).toBe(7);
    expect(s.msScript).toBeCloseTo(0.5);
    expect(s.msDiff).toBeCloseTo(0.1);
  });

  it("mean fps and p99 over the real dt of each frame", () => {
    const clock = fakeClock();
    const loop = new GameLoop(
      { fps: 60, now: clock.now },
      { render: () => null },
    );
    // exact dt of 16.67 ms → ~60 fps
    for (let i = 1; i <= 100; i += 1) {
      clock.set(i * (1 / 60));
      loop.step();
    }
    const s = loop.stats();
    expect(s.fpsMean).toBeGreaterThan(55);
    expect(s.fpsMean).toBeLessThan(65);
    expect(s.fpsP99).toBeGreaterThan(55);
    expect(s.fpsP99).toBeLessThan(65);
  });

  it("fps p99 ignores the worst 1% (jank outliers)", () => {
    const clock = fakeClock();
    const loop = new GameLoop(
      { fps: 60, now: clock.now },
      { render: () => null },
    );
    // 99 perfect frames of 16.67 ms…
    for (let i = 1; i <= 99; i += 1) {
      clock.set(i * (1 / 60));
      loop.step();
    }
    // …and the 100th hangs for 1 second (jank).
    clock.set(99 * (1 / 60) + 1);
    loop.step();
    const s = loop.stats();
    expect(s.fpsMean).toBeLessThan(60);
    expect(s.fpsP99).toBeGreaterThan(50);
  });

  it("run() with a frame limit ends with final stats", async () => {
    const clock = fakeClock();
    let renders = 0;
    const loop = new GameLoop(
      { fps: 10, frames: 5, now: clock.now },
      {
        render: () => {
          renders += 1;
          return null;
        },
      },
    );
    // fixed clock: dt = 0 each step → no updates, ends by frame counter
    const stats = await loop.run();
    expect(renders).toBe(5);
    expect(stats.frames).toBe(5);
    expect(stats.updates).toBe(0);
  });

  it("stop() cuts the loop before frames", async () => {
    const clock = fakeClock();
    const loop = new GameLoop(
      { fps: 10, frames: 1000, now: clock.now },
      { render: () => null },
    );
    const done = loop.run();
    // immediate stop(): the first tick of the loop detects it without rendered frames
    loop.stop();
    const stats = await done;
    expect(stats.frames).toBeLessThan(1000);
    expect(stats.frames).toBe(0);
  });
});
