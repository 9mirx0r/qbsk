// Timelines (docs/engine.md §11.5).
//
// The compositors `sequence`, `parallel` and `wait`, as a pure data structure plus
// a query. There is no scheduler thread and no callbacks: a timeline is asked "what
// is active at game time t?" and answers. That is the same discipline as tweens and
// frame-swapping, and for the same reason — a timeline that accumulated state per
// frame would drift, could not be asked twice in one frame, and could not have
// byte-exact goldens.
//
// A step is identified by name. What a name MEANS is the scene's business: the
// engine only says which names are active and how far along each one is.

export type Step =
  | { kind: "wait"; duration: number }
  | { kind: "step"; name: string; duration: number }
  | { kind: "sequence"; children: Step[] }
  | { kind: "parallel"; children: Step[] };

export function wait(duration: number): Step {
  return { kind: "wait", duration };
}

export function step(name: string, duration: number): Step {
  return { kind: "step", name, duration };
}

export function sequence(...children: Step[]): Step {
  return { kind: "sequence", children };
}

export function parallel(...children: Step[]): Step {
  return { kind: "parallel", children };
}

/**
 * Total time a step occupies.
 *
 * `sequence` sums its children; `parallel` takes the longest — a parallel block is
 * over when its slowest member is, not its first.
 */
export function duration(s: Step): number {
  switch (s.kind) {
    case "wait":
    case "step":
      return Math.max(0, s.duration);
    case "sequence":
      return s.children.reduce((total, c) => total + duration(c), 0);
    case "parallel":
      return s.children.reduce((max, c) => Math.max(max, duration(c)), 0);
  }
}

export interface ActiveStep {
  name: string;
  /** Progress within this step, in [0, 1]. */
  progress: number;
  /** Seconds since this step began. */
  elapsed: number;
}

/**
 * Everything active at time `t`, in declaration order.
 *
 * A `wait` is deliberately invisible here: it occupies time and contributes no
 * name, which is exactly what makes `sequence(step("a",1), wait(0.5), step("b",1))`
 * read the way it looks.
 *
 * Nesting works in both directions — a `parallel` inside a `sequence` and a
 * `sequence` inside a `parallel` — because this recurses rather than special-casing
 * one level.
 */
export function activeAt(s: Step, t: number, offset = 0): ActiveStep[] {
  const local = t - offset;
  const span = duration(s);
  if (local < 0 || local > span) {
    return [];
  }
  switch (s.kind) {
    case "wait":
      return [];
    case "step": {
      if (s.duration <= 0) {
        // A zero-duration step is instantaneous: reported only at its exact instant,
        // and already complete.
        return local === 0 ? [{ name: s.name, progress: 1, elapsed: 0 }] : [];
      }
      return [
        {
          name: s.name,
          progress: Math.min(1, local / s.duration),
          elapsed: local,
        },
      ];
    }
    case "sequence": {
      const out: ActiveStep[] = [];
      let cursor = offset;
      for (const child of s.children) {
        out.push(...activeAt(child, t, cursor));
        cursor += duration(child);
      }
      return out;
    }
    case "parallel": {
      const out: ActiveStep[] = [];
      for (const child of s.children) {
        // Every branch of a parallel starts at the same instant.
        out.push(...activeAt(child, t, offset));
      }
      return out;
    }
  }
}

/** True once `t` is past the whole timeline. */
export function finished(s: Step, t: number): boolean {
  return t >= duration(s);
}

/** Convenience: is this named step active at `t`? */
export function isActive(s: Step, name: string, t: number): boolean {
  return activeAt(s, t).some((a) => a.name === name);
}

/** Progress of a named step at `t`, or null when it is not running. */
export function progressOf(s: Step, name: string, t: number): number | null {
  const hit = activeAt(s, t).find((a) => a.name === name);
  return hit === undefined ? null : hit.progress;
}
