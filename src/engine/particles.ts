// Time-indexed particles (docs/engine.md §11.10).
//
// A particle system with NO state. `particleAt(index, t, spec)` is a pure function:
// particle 17 at t = 90 is computed directly, never by stepping ninety seconds of
// simulation. That is the same discipline as tweens (§11.3) and frame-swapping
// (§11.4), and it is what makes an effect golden-testable, seekable, and immune to
// frame rate. A stateful emitter would be none of those.
//
// The cost is that particles cannot collide or react to each other. That is the
// deliberate trade: everything this engine animates is decoration over a character
// grid, and decoration that can be scrubbed is worth more than decoration that can
// bounce.

import { mulberry32, streamSeed } from "../util/random.js";
import { DEFAULT_CELL_ASPECT } from "./stroke.js";

// The cell shape lives in stroke.ts as DEFAULT_CELL_ASPECT. This file kept its own copy
// until an earlier review, and its comment already said "the same constant as §11.6 and
// §11.7" — the class was named here before it was fixed anywhere.

const DEG_TO_RAD = Math.PI / 180;

export interface ParticleSpec {
  x: number;
  y: number;
  count: number;
  life: number;
  speed: number;
  angle: number;
  spread: number;
  fall: number;
  drift: number;
  seed: number;
}

export interface Particle {
  x: number;
  y: number;
  /** 0 at birth, approaching 1 at death. */
  age: number;
}

const DEFAULTS: Omit<ParticleSpec, "count" | "life"> = {
  x: 0,
  y: 0,
  speed: 5,
  angle: 90,
  spread: 20,
  fall: 0,
  drift: 0,
  seed: 1,
};

const REQUIRED = ["count", "life"] as const;

/** Every key a spec may carry, in the order the docs list them. */
export const SPEC_KEYS = [
  "count",
  "life",
  "x",
  "y",
  "speed",
  "angle",
  "spread",
  "fall",
  "drift",
  "seed",
] as const;

/**
 * Validates a spec and fills in the documented defaults.
 *
 * Unknown keys are an error rather than being ignored: `"lifetime"` for `"life"`
 * would otherwise leave every particle on the default and read as a physics bug,
 * which is the most expensive kind of mistake to chase.
 *
 * Throws plain `Error`; the native wraps it with a span so the QBSK user sees a
 * fragment and never a bare Node error (the project rules RULE #4).
 */
export function resolveParticleSpec(
  given: Readonly<Record<string, number>>,
): ParticleSpec {
  for (const key of Object.keys(given)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `'${key}' is not a particle setting — expected one of ${SPEC_KEYS.join(", ")}`,
      );
    }
  }
  for (const key of REQUIRED) {
    if (given[key] === undefined) {
      throw new Error(`a particle emitter needs '${key}'`);
    }
  }

  const count = Math.floor(given["count"]!);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`'count' must be at least 1, got ${given["count"]}`);
  }
  const life = given["life"]!;
  if (!Number.isFinite(life) || life <= 0) {
    throw new Error(`'life' must be greater than 0 seconds, got ${life}`);
  }

  const spec: ParticleSpec = { ...DEFAULTS, count, life };
  for (const key of SPEC_KEYS) {
    if (key === "count" || key === "life") {
      continue;
    }
    const value = given[key];
    if (value !== undefined) {
      if (!Number.isFinite(value)) {
        throw new Error(`'${key}' must be a finite number, got ${value}`);
      }
      spec[key] = value;
    }
  }
  return spec;
}

/**
 * Where particle `index` is at time `t`.
 *
 * Births are staggered by `index / count` of a lifetime, so an emitter streams from
 * its very first frame instead of pulsing all `count` at once and then standing empty.
 * The age wraps, which is what makes the particle reborn rather than gone: there is
 * no "start" to the cycle, so a negative `t` is as valid as a positive one.
 */
export function particleAt(
  index: number,
  t: number,
  spec: ParticleSpec,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): Particle {
  const { life, count } = spec;
  const birth = (index / count) * life;
  // Two modulos: JS `%` keeps the sign of the dividend, so a t before the birth would
  // otherwise give a negative age.
  const elapsed = (((t - birth) % life) + life) % life;
  const age = elapsed / life;

  const rnd = mulberry32(streamSeed(spec.seed, index));
  // Order matters and is fixed: heading, then speed, then drift phase. Changing it
  // reshuffles every existing emitter.
  const heading = spec.angle + (rnd() * 2 - 1) * spread(spec);
  const speed = spec.speed * (0.75 + rnd() * 0.5);
  const phase = rnd() * Math.PI * 2;

  const radians = heading * DEG_TO_RAD;
  // The angle is anticlockwise (docs §11.10) but the grid's y grows downward, so the
  // vertical component is negated: `angle: 90` has to mean up.
  const vx = Math.cos(radians) * speed;
  const vy = -Math.sin(radians) * speed;

  // Scaled by age so a drifting particle is still born exactly at the emitter and
  // wanders further as it goes, rather than popping into place off to one side.
  const wander =
    spec.drift === 0 ? 0 : Math.sin(phase + elapsed * 2.4) * spec.drift * age;

  return {
    // x is scaled by the cell aspect so a wide spread comes out round on screen
    // rather than as an ellipse squashed to half its height.
    x: spec.x + (vx * elapsed + wander) * cellAspect,
    y: spec.y + vy * elapsed + 0.5 * spec.fall * elapsed * elapsed,
    age,
  };
}

/** Half-angle of the cone, clamped: beyond a full circle it stops meaning anything. */
function spread(spec: ParticleSpec): number {
  const s = Math.abs(spec.spread);
  return s > 180 ? 180 : s;
}
