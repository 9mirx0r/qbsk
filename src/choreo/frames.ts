// Frame-swapping for multi-frame sprites (docs/engine.md §11.4).
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: the frame follows the GAME clock, never
// the render clock and never `Date.now()`. It is listed as a forbidden anti-pattern
// in the qbsk-engine skill, and for a concrete reason — a scene rendered at 60 fps
// and the same scene rendered at 20 fps must show the SAME sprite frame at the same
// game time. Tie it to the render clock and a slow machine plays the animation in
// slow motion; tie it to wall time and goldens stop being reproducible.
//
// Pure arithmetic, no clock of its own: the caller passes the game time in.

export interface FramePick {
  /** Index into the sprite's frames, always in range. */
  index: number;
  /** True once a non-looping animation has reached and held its last frame. */
  finished: boolean;
}

/**
 * Chooses which frame of a multi-frame sprite is showing at `gameTime`.
 *
 * `fps` here is the ANIMATION rate, unrelated to how often the scene is drawn.
 * A 6-frame walk at `fps: 10` takes 0.6 s to cycle whether the window is
 * repainting 20 or 60 times a second.
 */
export function pickFrame(
  count: number,
  fps: number,
  loop: boolean,
  gameTime: number,
): FramePick {
  if (count <= 1) {
    return { index: 0, finished: true };
  }
  if (fps <= 0 || gameTime <= 0) {
    // A zero or negative rate is a still frame, not a division by zero.
    return { index: 0, finished: fps <= 0 };
  }
  // `gameTime` is an accumulation of floats, so a value that should be exactly
  // 0.25 can arrive as 0.2499999999999999. Since a frame boundary is precisely
  // where `floor` changes its answer, that noise would show a different frame at
  // 20 fps than at 60 fps — breaking the game-clock guarantee this module exists
  // for. Measured accumulation is ~1e-16 per step, so ~2e-11 after an hour at
  // 60 fps; a nanosecond of tolerance swallows it with orders of magnitude to
  // spare and is far below any timing anyone can perceive or test for.
  const EPSILON = 1e-9;
  const raw = Math.floor(gameTime * fps + EPSILON);
  if (loop) {
    // `%` on a non-negative raw is safe; gameTime <= 0 was handled above.
    return { index: raw % count, finished: false };
  }
  if (raw >= count - 1) {
    // Hold the last frame rather than looping or vanishing — the behaviour a
    // one-shot animation (a door opening, an explosion) needs.
    return { index: count - 1, finished: true };
  }
  return { index: raw, finished: false };
}
