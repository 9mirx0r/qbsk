// The seeded PRNG, in one place.
//
// QBSK has exactly ONE seeded generator, shared by audio noise (docs/audio.md §2) and
// particles (docs/engine.md §11.10). A second one would mean a second set of goldens
// that drift apart for no reason, so this lives in util/ rather than in either of the
// two subsystems that use it.
//
// `random()` stays the language's only non-deterministic source, and it deliberately
// cannot appear in a golden. Anything a golden pins comes through here.

/**
 * mulberry32 — small, fast, and seeded.
 *
 * Returns a generator producing floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Turns (seed, index) into a well-separated stream seed.
 *
 * Seeding with `seed + index` would start neighbouring streams one step apart in the
 * same sequence. mulberry32's avalanche makes that survivable, but a spray of
 * particles is precisely where a faint correlation shows up as banding, so the index
 * gets multiplied by a large odd constant and mixed in first. One line, no doubt.
 */
export function streamSeed(seed: number, index: number): number {
  return (Math.imul(index + 1, 0x9e3779b1) ^ (seed >>> 0)) >>> 0;
}
