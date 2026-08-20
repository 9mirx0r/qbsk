// The canonical key vocabulary (docs/studio.md §14.5, docs/language.md §7.2).
//
// One table, two hosts. The Studio window decodes a DOM `KeyboardEvent.key` and the
// terminal backend decodes an ANSI escape sequence, and both must produce byte-identical
// names — `on key` matching is an exact Map lookup with no normalisation and no fallback
// (src/interp/interpreter.ts), so a host that spells a key differently produces a handler
// that silently never fires.
//
// This lives in src/ and not in studio/ because the one-way dependency rule forbids src/
// importing from studio/, and the terminal backend needs the same table.
//
// It also exists so the ANALYZER can reject an unknown name. Before this module,
// `on key "qwerty"` parsed clean, analyzed clean, ran clean and did nothing — the
// silent-ghost failure shape catalogued in docs/language.md §14, and exactly what
// an earlier release exists to stop.

/**
 * Keys that have a name rather than a character.
 *
 * The arrows carry the `arrow-` prefix. This is the project's one long-standing
 * naming contradiction: `docs/engine.md` §8 wrote them bare (`left`), while the
 * language spec, the parser's own error message, both test files and every example
 * write `arrow-left`. The prefixed form wins, and the bare form is now an error with
 * a suggestion rather than a key that never fires.
 */
/**
 * The key queue cap (docs/engine.md §8.2).
 *
 * The spec said "max size N" for months with N never chosen. It is 256, picked after
 * measuring: the queue was unbounded, and 50 000 presses drained in one frame took
 * 832 ms. A held arrow under OS key repeat reaches that scale, and a frame that long is
 * a freeze. The OLDEST is dropped, keeping the input the player still means.
 */
export const QUEUE_LIMIT = 256;

export const NAMED_KEYS = [
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "space",
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "home",
  "end",
  "page-up",
  "page-down",
  // Only the terminal produces this: raw mode stops the OS generating SIGINT and
  // delivers 0x03 as data, so it becomes an ordinary key a program can bind — and the
  // decoder must name it, or a loop in raw mode is unkillable.
  "ctrl-c",
] as const;

const NAMED = new Set<string>(NAMED_KEYS);

/**
 * Whether a name can ever be delivered.
 *
 * Two shapes are valid: a name from the table above, or a **single printable
 * character**, which is its own name ("rest → char", `docs/engine.md` §8). The second
 * rule is what lets a console receive ordinary typing without enumerating 95 entries,
 * and it is why the check is a predicate rather than a set membership.
 *
 * Case-sensitive on purpose: `A` is a different press than `a` — one of them involves
 * Shift — and collapsing them would make a handler fire on a key the author did not
 * write.
 */
export function isCanonicalKey(name: string): boolean {
  if (NAMED.has(name)) {
    return true;
  }
  return isPrintableChar(name);
}

function isPrintableChar(name: string): boolean {
  if ([...name].length !== 1) {
    return false;
  }
  const code = name.codePointAt(0)!;
  // Anything below 0x20 is a control character: it arrives as a named key or not at
  // all, never as itself. 0x7f is DEL, which is `delete`.
  return code > 0x1f && code !== 0x7f;
}

/**
 * DOM spellings that map onto a canonical name.
 *
 * `KeyboardEvent.key` is the property to read, not `code`: `key` is layout-aware, so a
 * French keyboard's `a` arrives as `a`. `code` would report the physical position and
 * hand a QWERTY name to an AZERTY user.
 */
const FROM_DOM = new Map<string, string>([
  ["ArrowLeft", "arrow-left"],
  ["ArrowRight", "arrow-right"],
  ["ArrowUp", "arrow-up"],
  ["ArrowDown", "arrow-down"],
  [" ", "space"],
  ["Spacebar", "space"],
  ["Enter", "enter"],
  ["Escape", "escape"],
  ["Esc", "escape"],
  ["Tab", "tab"],
  ["Backspace", "backspace"],
  ["Delete", "delete"],
  ["Del", "delete"],
  ["Home", "home"],
  ["End", "end"],
  ["PageUp", "page-up"],
  ["PageDown", "page-down"],
]);

/**
 * Turns a DOM `KeyboardEvent.key` into a canonical name, or null if the program should
 * never see it.
 *
 * Null is the common and correct answer for a modifier: a held Shift fires `keydown`
 * repeatedly, and delivering it would call a handler dozens of times for a press the
 * user does not think of as a press at all. The function keys return null too, because
 * F5 belongs to play mode (`docs/studio.md` §13) and a scene must not be able to steal
 * the key that leaves full screen.
 */
export function keyFromDom(domKey: string): string | null {
  const mapped = FROM_DOM.get(domKey);
  if (mapped !== undefined) {
    return mapped;
  }
  if (isPrintableChar(domKey)) {
    return domKey;
  }
  return null;
}

/** Wrong spellings common enough to name outright rather than leave to edit distance. */
const KNOWN_MISTAKES = new Map<string, string>([
  ["left", "arrow-left"],
  ["right", "arrow-right"],
  ["up", "arrow-up"],
  ["down", "arrow-down"],
]);

/**
 * The canonical name a wrong one probably meant, or null.
 *
 * The DOM spellings are checked first and exactly, because `ArrowLeft` is what a person
 * gets from `console.log(event.key)` and is the single likeliest mistake. The bare
 * arrows are next, because `docs/engine.md` §8 told people to write them for months.
 * Only then does edit distance run.
 */
export function suggestKey(name: string): string | null {
  const fromDom = FROM_DOM.get(name);
  if (fromDom !== undefined) {
    return fromDom;
  }
  const known = KNOWN_MISTAKES.get(name.toLowerCase());
  if (known !== undefined) {
    return known;
  }
  let best: string | null = null;
  let bestDist = Infinity;
  const lower = name.toLowerCase();
  for (const candidate of NAMED_KEYS) {
    const d = distance(lower, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best !== null && bestDist <= 2 ? best : null;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
