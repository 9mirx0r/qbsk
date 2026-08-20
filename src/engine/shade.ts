// Per-cell colour transforms (docs/engine.md §11.6).
//
// A shade is a pure function of (cell, x, y, gameTime) applied over the composed
// canvas before diffing. It is what "shader" means on a character grid: it changes
// colour, never characters, so the scene's geometry is decided entirely by the
// primitives and the shade only lights it.
//
// WHY THESE ARE BUILT-IN AND NOT USER-WRITTEN QBSK FUNCTIONS. A 120x40 grid is 4800
// cells. Calling a QBSK function per cell would mean 4800 interpreter calls every
// frame, and bench/baseline.md already measures the interpreter at 96% of frame cost
// for a THREE-primitive scene. User-programmable shades are the flexible design and
// the wrong one until the interpreter is much cheaper; a fixed set evaluated in
// TypeScript is fast, deterministic, and golden-testable. Recorded so the trade-off
// is understood rather than rediscovered.

import type { Cell } from "./cell.js";
import type { Canvas } from "./canvas.js";
import { DEFAULT_CELL_ASPECT } from "./stroke.js";

export const SHADE_NAMES = ["radial", "grade", "pulse", "scanline"] as const;
export type ShadeName = (typeof SHADE_NAMES)[number];

export function isShadeName(name: string): name is ShadeName {
  return (SHADE_NAMES as readonly string[]).includes(name);
}

export interface ShadeSpec {
  kind: ShadeName;
  /** Centre, for `radial`. Ignored by the others. */
  x: number;
  y: number;
  /** Falloff radius in cells, for `radial`. */
  radius: number;
  /** Colour to move towards, packed 0xRRGGBB. -1 means "darken only". */
  tint: number;
  /** 0..1 — how far towards the tint a fully-affected cell travels. */
  strength: number;
  /** Cycles per second, for `pulse`. */
  speed: number;
}

/**
 * Cell aspect. A terminal cell is about twice as tall as it is wide, so a radial
 * falloff measured in raw cell distance comes out as an ellipse. Scaling x by this
 * makes a "radius: 10" light look round instead of squashed.
 *
 * The number is not a constant, and this file held its own copy of it until an earlier release
 * review. It lives in `stroke.ts` now, as `DEFAULT_CELL_ASPECT`, with the measurement of
 * why 2.0 is right for two of the project's fonts and wrong for the other two. Four
 * copies of one assumption is how a fix reaches one of them.
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Moves a packed colour towards `tint` by `amount`, or towards black if tint < 0. */
function mix(colour: number, tint: number, amount: number): number {
  if (colour < 0) {
    // A default-coloured cell has nothing to grade: leave it alone rather than
    // inventing a base, which would make "unstyled" cells suddenly opinionated.
    return colour;
  }
  const r = (colour >> 16) & 255;
  const g = (colour >> 8) & 255;
  const b = colour & 255;
  const tr = tint < 0 ? 0 : (tint >> 16) & 255;
  const tg = tint < 0 ? 0 : (tint >> 8) & 255;
  const tb = tint < 0 ? 0 : tint & 255;
  const nr = Math.round(r + (tr - r) * amount);
  const ng = Math.round(g + (tg - g) * amount);
  const nb = Math.round(b + (tb - b) * amount);
  return (nr << 16) | (ng << 8) | nb;
}

/**
 * How strongly a shade affects one cell, in [0, 1]. Pure: same inputs, same answer,
 * which is what keeps shaded frames golden-testable.
 */
export function shadeAmount(
  spec: ShadeSpec,
  x: number,
  y: number,
  t: number,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): number {
  switch (spec.kind) {
    case "grade":
      return clamp01(spec.strength);
    case "radial": {
      if (spec.radius <= 0) {
        return 0;
      }
      const dx = (x - spec.x) / cellAspect;
      const dy = y - spec.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      // Falls off to nothing at the radius; brightest at the centre.
      return clamp01(spec.strength * (1 - clamp01(d / spec.radius)));
    }
    case "pulse": {
      // Bounded in [0, 1] so a pulse never inverts — 0.5 +/- 0.5.
      const phase = Math.sin(2 * Math.PI * spec.speed * t) * 0.5 + 0.5;
      return clamp01(spec.strength * phase);
    }
    case "scanline":
      // Every other row, for a CRT feel. Rows, not columns: a character cell is
      // taller than it is wide, so horizontal banding reads as scanlines while
      // vertical banding just looks like damage.
      return y % 2 === 0 ? 0 : clamp01(spec.strength);
  }
}

/**
 * Applies shades in declaration order. Foreground only: backgrounds carry the
 * scene's own structure (a filled panel, a highlighted row) and grading them would
 * wash that out.
 *
 * REPLACES cells rather than mutating them. `Canvas` initialises its grid with
 * `new Array(w * h).fill(DEFAULT_CELL)`, so every untouched cell is the SAME object
 * — mutating one in place would rewrite the shared default and bleed colour into
 * every unwritten cell of every canvas alive in the process. A cell that a shade
 * does not affect is left as-is, so the allocation only costs where it changes
 * something.
 */
export function applyShades(
  canvas: Canvas,
  shades: ShadeSpec[],
  gameTime: number,
  cellAspect: number = DEFAULT_CELL_ASPECT,
): void {
  if (shades.length === 0) {
    return;
  }
  const cells: Cell[] = canvas.cells;
  for (const spec of shades) {
    for (let y = 0; y < canvas.height; y += 1) {
      const row = y * canvas.width;
      for (let x = 0; x < canvas.width; x += 1) {
        const amount = shadeAmount(spec, x, y, gameTime, cellAspect);
        if (amount <= 0) {
          continue;
        }
        const cell = cells[row + x]!;
        const fg = mix(cell.fg, spec.tint, amount);
        if (fg === cell.fg) {
          continue;
        }
        cells[row + x] = { char: cell.char, fg, bg: cell.bg, attrs: cell.attrs };
      }
    }
  }
}
