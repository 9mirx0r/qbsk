// Levenshtein distance and the "did you mean" pick, in one place.
//
// The error model (docs/language.md §8) promises a suggestion for a near-miss name,
// so both the parser and the static analyzer need it — the parser for a misspelled
// scene parameter (§14.3), the analyzer for a misspelled variable, member or export.
// A second copy would be a second set of thresholds that drift apart, and the parser
// importing the analyzer would invert the layering (the analyzer consumes the AST the
// parser produces, never the other way round). So it lives here, next to the seeded
// PRNG, for the same reason.

/** Classic edit distance, two rolling rows — no matrix allocation. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * The nearest candidate within `maxDist` edits, or `null` when nothing is close.
 *
 * `null` matters as much as a hit: a suggestion that is not actually similar sends
 * the author to fix working code, which is worse than no suggestion at all.
 */
export function closest(
  name: string,
  candidates: Iterable<string>,
  maxDist = 2,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== null && bestDist <= maxDist ? best : null;
}
