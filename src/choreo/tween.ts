// Tweens (docs/engine.md §11).
//
// The design question the external review flagged (04-claude-review.md §5 answer 1)
// was: where does "when did this animation start" live? Answer: HOST-SIDE, next to
// gameTime — never inside the interpreter.
//
// That keeps a tween a pure function of (gameTime, recorded start): asking for the
// same tween at the same game time always gives the same number, no matter how many
// times the scene re-composes in that frame. Accumulating per frame instead would
// drift, and would make byte-exact goldens impossible.

import { ease, isEasingName, type EasingName } from "./easing.js";

export interface TweenRecord {
  startTime: number;
  from: number;
  to: number;
  duration: number;
  easing: EasingName;
}

/**
 * The live tween table. Keyed by the name the scene gives each animation, so a
 * scene can re-declare the same tween every frame (which it does — the scene block
 * re-runs) without restarting it.
 */
export type TweenStore = Map<string, TweenRecord>;

export function createTweenStore(): TweenStore {
  return new Map();
}

/** True when the tween's definition changed and it must start over. */
function differs(rec: TweenRecord, from: number, to: number, duration: number, easing: EasingName): boolean {
  return (
    rec.from !== from ||
    rec.to !== to ||
    rec.duration !== duration ||
    rec.easing !== easing
  );
}

/**
 * Progress in [0, 1], 1 once the tween has finished. A zero (or negative) duration
 * is a jump, not a division by zero.
 *
 * THE one definition of how far along a tween is. `readTween` and the `animate_done`
 * native both read it, so "is this animation over?" can never disagree with what
 * the animation itself drew — the two were implemented separately once and a drift
 * between them would have broken every pacing loop in the examples while the whole
 * suite stayed green.
 */
export function tweenProgress(rec: TweenRecord, now: number): number {
  return rec.duration <= 0
    ? 1
    : Math.min(1, Math.max(0, (now - rec.startTime) / rec.duration));
}

/** Whether the tween has finished at `now`. */
export function tweenDone(rec: TweenRecord, now: number): boolean {
  return tweenProgress(rec, now) >= 1;
}

export interface TweenQuery {
  store: TweenStore;
  name: string;
  from: number;
  to: number;
  duration: number;
  easing: string;
  now: number;
}

export interface TweenResult {
  value: number;
  /** Progress in [0, 1] — 1 once the tween has finished. */
  progress: number;
  done: boolean;
}

/**
 * Reads a tween, registering it on first sight.
 *
 * Re-asking with identical parameters continues the same animation; changing any
 * parameter restarts it from the current game time. That rule is what makes the
 * obvious scene code work:
 *
 *     put "o" at (int(animate("hero", 5, 40, 2.0)), 10)
 *
 * The scene block runs every frame, so this line executes 60 times a second, and
 * the animation still takes exactly two seconds.
 */
export function readTween(q: TweenQuery): TweenResult {
  const easing: EasingName = isEasingName(q.easing) ? q.easing : "linear";
  const existing = q.store.get(q.name);
  let rec: TweenRecord;
  if (existing === undefined || differs(existing, q.from, q.to, q.duration, easing)) {
    rec = {
      startTime: q.now,
      from: q.from,
      to: q.to,
      duration: q.duration,
      easing,
    };
    q.store.set(q.name, rec);
  } else {
    rec = existing;
  }
  // A zero (or negative) duration is a jump, not a division by zero.
  const progress = tweenProgress(rec, q.now);
  const value = rec.from + (rec.to - rec.from) * ease(rec.easing, progress);
  return { value, progress, done: tweenDone(rec, q.now) };
}

/** Forgets a tween so the next read starts it again from the top. */
export function resetTween(store: TweenStore, name: string): boolean {
  return store.delete(name);
}
