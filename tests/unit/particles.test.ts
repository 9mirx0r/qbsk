// Time-indexed particles (docs/engine.md §11.10).
import { describe, expect, it } from "vitest";
import { particleAt, resolveParticleSpec } from "../../src/engine/particles.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const spec = (over: Record<string, number> = {}) =>
  resolveParticleSpec({ count: 8, life: 2, speed: 6, ...over });

describe("particleAt is a closed form, not a simulation", () => {
  // The property the whole design exists for: no accumulation, so the frame at t is
  // the same frame whatever path the clock took to get there.
  it("the same (index, t) always gives the same particle", () => {
    const s = spec();
    const a = particleAt(3, 7.25, s);
    for (let i = 0; i < 50; i += 1) {
      particleAt(i % 8, i * 0.37, s);
    }
    expect(particleAt(3, 7.25, s)).toEqual(a);
  });

  it("t far in the future needs no warm-up", () => {
    const s = spec();
    // t and t + life land on the same point in the cycle. A stateful emitter would
    // have had to run 3600 seconds to answer this.
    expect(particleAt(2, 3600, s)).toEqual(particleAt(2, 3600 + s.life, s));
  });

  it("a particle is at the emitter at birth", () => {
    const s = spec({ x: 10, y: 20 });
    // Particle 0 is born at t = 0 (births are staggered by i / count).
    const p = particleAt(0, 0, s);
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(20, 6);
    expect(p.age).toBe(0);
  });

  it("age runs 0 to 1 and wraps at the lifetime", () => {
    const s = spec();
    expect(particleAt(0, 0, s).age).toBe(0);
    expect(particleAt(0, s.life * 0.5, s).age).toBeCloseTo(0.5, 6);
    expect(particleAt(0, s.life, s).age).toBeCloseTo(0, 6);
  });

  // Without stagger every particle is born together and the emitter pulses instead
  // of streaming — and looks empty on its first frame.
  it("births are staggered across the lifetime", () => {
    const s = spec();
    const ages = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => particleAt(i, 0, s).age);
    expect(new Set(ages).size).toBe(8);
  });

  it("negative time is as valid as positive — the cycle has no start", () => {
    const s = spec();
    const p = particleAt(1, 0 - s.life * 2 + 0.4, s);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(p.age).toBeCloseTo(particleAt(1, 0.4, s).age, 6);
  });
});

describe("particleAt motion", () => {
  it("fall pulls downward over the lifetime", () => {
    const s = spec({ fall: 9, speed: 0, spread: 0, drift: 0 });
    const early = particleAt(0, 0.2, s).y;
    const late = particleAt(0, 1.2, s).y;
    expect(late).toBeGreaterThan(early);
  });

  it("a negative fall rises, which is how smoke is written", () => {
    const s = spec({ fall: 0 - 4, speed: 0, spread: 0, drift: 0 });
    expect(particleAt(0, 1.2, s).y).toBeLessThan(particleAt(0, 0.2, s).y);
  });

  // The grid's y grows down, so an anticlockwise angle is the only way `90` means up.
  it("angle 90 goes up the screen and 270 goes down", () => {
    const up = spec({ angle: 90, spread: 0, y: 30, fall: 0, drift: 0 });
    const down = spec({ angle: 270, spread: 0, y: 30, fall: 0, drift: 0 });
    expect(particleAt(0, 0.5, up).y).toBeLessThan(30);
    expect(particleAt(0, 0.5, down).y).toBeGreaterThan(30);
  });

  it("angle 0 goes right and 180 goes left", () => {
    const right = spec({ angle: 0, spread: 0, x: 30, fall: 0, drift: 0 });
    const left = spec({ angle: 180, spread: 0, x: 30, fall: 0, drift: 0 });
    expect(particleAt(0, 0.5, right).x).toBeGreaterThan(30);
    expect(particleAt(0, 0.5, left).x).toBeLessThan(30);
  });

  it("spread 0 is a beam: every particle leaves along one ray", () => {
    // Speed still varies per particle, so they sit at different points ON the ray —
    // assert the heading, which is what `spread: 0` actually promises.
    const s = spec({ spread: 0, fall: 0, drift: 0, x: 0, y: 0, angle: 30 });
    const heading = (p: { x: number; y: number }) => Math.atan2(p.y, p.x);
    const a = particleAt(0, 0.5, s);
    const b = particleAt(4, 0.5 + s.life * (4 / 8), s);
    expect(heading(b)).toBeCloseTo(heading(a), 6);
  });

  // A round burst on a grid whose cells are twice as tall as wide has to spread twice
  // as far horizontally, exactly as §11.6 and §11.7 already do.
  it("a burst is round on screen, not an ellipse", () => {
    const s = spec({ spread: 180, fall: 0, drift: 0, x: 0, y: 0, count: 64 });
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < 64; i += 1) {
      const p = particleAt(i, 0.9, s);
      maxX = Math.max(maxX, Math.abs(p.x));
      maxY = Math.max(maxY, Math.abs(p.y));
    }
    expect(maxX / maxY).toBeGreaterThan(1.5);
    expect(maxX / maxY).toBeLessThan(2.5);
  });
});

describe("particle randomness", () => {
  it("the same seed gives the same layout", () => {
    expect(particleAt(5, 1.1, spec({ seed: 42 }))).toEqual(
      particleAt(5, 1.1, spec({ seed: 42 })),
    );
  });

  it("a different seed gives a different layout", () => {
    const a = particleAt(5, 1.1, spec({ seed: 42, spread: 60 }));
    const b = particleAt(5, 1.1, spec({ seed: 43, spread: 60 }));
    expect(a.x === b.x && a.y === b.y).toBe(false);
  });

  // Neighbouring indices must not come out visibly correlated, or a spray shows
  // banding — the reason the index is hashed rather than added to the seed.
  it("neighbouring particles do not clump", () => {
    const s = spec({ spread: 90, count: 32, drift: 2 });
    const xs = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      xs.add(particleAt(i, 4.3, s).x.toFixed(3));
    }
    expect(xs.size).toBeGreaterThan(28);
  });
});

describe("resolveParticleSpec", () => {
  it("count and life are required", () => {
    expect(() => resolveParticleSpec({ life: 2 })).toThrow(/count/);
    expect(() => resolveParticleSpec({ count: 4 })).toThrow(/life/);
  });

  it("rejects a lifetime or count that cannot produce a particle", () => {
    expect(() => resolveParticleSpec({ count: 0, life: 2 })).toThrow(/count/);
    expect(() => resolveParticleSpec({ count: 4, life: 0 })).toThrow(/life/);
  });

  // A typo'd key that silently leaves the default in place reads as a physics bug,
  // which is the most expensive kind of mistake to chase.
  it("an unknown key is named, and the valid ones listed", () => {
    expect(() => resolveParticleSpec({ count: 4, life: 2, lifetime: 3 })).toThrow(
      /lifetime/,
    );
    expect(() => resolveParticleSpec({ count: 4, life: 2, lifetime: 3 })).toThrow(
      /life/,
    );
  });

  it("fills the optional keys with documented defaults", () => {
    const s = resolveParticleSpec({ count: 4, life: 2 });
    expect(s).toMatchObject({
      x: 0,
      y: 0,
      speed: 5,
      angle: 90,
      spread: 20,
      fall: 0,
      drift: 0,
      seed: 1,
    });
  });
});

describe("the particle() native", () => {
  const run = (src: string) => runQbsk(src, "t.qbsk");

  const EMBERS = [
    'const e = {"x": 10.0, "y": 20.0, "count": 8, "life": 2.0,',
    '           "speed": 6.0, "angle": 90.0, "spread": 0.0, "seed": 3}',
  ].join("\n");

  it("returns [x, y, age]", () => {
    const r = run(`${EMBERS}\nvar p = particle(0, 0.0, e)\nprint(len(p))`);
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("3");
  });

  it("particle 0 starts at the emitter", () => {
    const r = run(
      `${EMBERS}\nvar p = particle(0, 0.0, e)\nprint(p[0])\nprint(p[1])\nprint(p[2])`,
    );
    expect(r.error).toBeNull();
    // x and y come back as CELLS, rounded like project() does, so the result drops
    // straight into a `put ... at (...)`.
    expect(r.out).toEqual(["10", "20", "0.0"]);
  });

  it("composes with glyph(): fading by age", () => {
    const r = run(
      `${EMBERS}\nvar p = particle(0, 1.9, e)\nprint(glyph(1.0 - p[2], " .:*"))`,
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe(" ");
  });

  it("an index outside the emitter reports with the count", () => {
    const r = run(`${EMBERS}\nvar p = particle(8, 0.0, e)`);
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("8");
  });

  it("a negative index reports rather than wrapping", () => {
    const r = run(`${EMBERS}\nvar p = particle(0 - 1, 0.0, e)`);
    expect(r.error).not.toBeNull();
  });

  it("an unknown spec key reports it by name", () => {
    const r = run(
      'const e = {"count": 4, "life": 2.0, "lifetime": 9.0}\nvar p = particle(0, 0.0, e)',
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("lifetime");
  });

  it("a spec that is not a dict reports with the type it got", () => {
    const r = run("var p = particle(0, 0.0, 7)");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("int");
  });

  it("rejects the wrong arity by name", () => {
    const r = run("var p = particle(0, 0.0)");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("particle");
  });

  it("drives a scene: an emitter fills cells that an empty one does not", () => {
    const src = [
      'const e = {"x": 20.0, "y": 12.0, "count": 24, "life": 2.0,',
      '           "speed": 8.0, "angle": 90.0, "spread": 30.0, "seed": 5}',
      "scene P(width: 40, height: 14)",
      "layer a z: 1",
      '    fill "."',
      "    var i = 0",
      "    while i < 24",
      "        var p = particle(i, 1.0, e)",
      '        put "*" at (p[0], p[1])',
      "        i += 1",
    ].join("\n");
    const r = run(src);
    expect(r.error).toBeNull();
    const text = r.canvas!.renderText();
    expect(text.split("*").length - 1).toBeGreaterThan(8);
  });
});
