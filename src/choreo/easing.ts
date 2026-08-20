// Easing curves (docs/engine.md §11).
//
// Pure, stateless functions f(t) -> number for t in [0, 1]. No clock, no memory:
// given the same t they always return the same value, which is what lets tween
// goldens be byte-exact.
//
// Note that `bounce` and `elastic` are allowed to leave [0, 1] mid-flight — that
// overshoot IS the effect. What every curve must guarantee is f(0) = 0 and
// f(1) = 1, so an animation starts and lands exactly where it was told to.

export type EasingName =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "bounce"
  | "elastic";

export const EASING_NAMES: EasingName[] = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "bounce",
  "elastic",
];

function easeOutBounce(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  }
  if (t < 2 / d1) {
    const t2 = t - 1.5 / d1;
    return n1 * t2 * t2 + 0.75;
  }
  if (t < 2.5 / d1) {
    const t2 = t - 2.25 / d1;
    return n1 * t2 * t2 + 0.9375;
  }
  const t2 = t - 2.625 / d1;
  return n1 * t2 * t2 + 0.984375;
}

const CURVES: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  "ease-in": (t) => t * t * t,
  "ease-out": (t) => 1 - Math.pow(1 - t, 3),
  "ease-in-out": (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  bounce: easeOutBounce,
  elastic: (t) => {
    if (t === 0 || t === 1) {
      return t;
    }
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

export function isEasingName(name: string): name is EasingName {
  return Object.prototype.hasOwnProperty.call(CURVES, name);
}

/**
 * Applies a curve, clamping t into [0, 1] first.
 *
 * Clamping here rather than at the call site means a tween that has run past its
 * duration keeps returning its final value instead of extrapolating off into
 * nonsense — the behaviour a scene author expects when an animation is "done".
 */
export function ease(name: EasingName, t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return CURVES[name](clamped);
}
