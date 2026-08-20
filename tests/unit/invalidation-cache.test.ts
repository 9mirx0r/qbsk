// Invalidation caching (docs/engine.md §11.19): a layer reused until its inputs move.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { analyzeLayerStaticity } from "../../src/analyze/analyzer.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

function program(lines: string[]): SceneProgram {
  const parsed = parse(lines.join("\n"), "t.qbsk");
  expect(parsed.errors).toEqual([]);
  return new SceneProgram(parsed.ast, { baseDir: EXAMPLES });
}

/** Frames rendered as text, so a stale layer shows up as identical bytes. */
function frames(p: SceneProgram, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const f = p.step(0.05);
    expect(f.error?.message ?? null).toBeNull();
    out.push(f.canvas!.renderText());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Why the cache is not here yet — kept as tests rather than as a note, because these
// are the behaviours it must not break, and they are the ones that broke it.
//
// The first attempt cached the LAYER VALUE, keyed on (mutation epoch, identity of the
// names the layer reads). It was correct about staleness and wrong about something the
// design never looked at: evaluating a layer has SIDE EFFECTS. The audio plan (§7 of
// docs/audio.md) and the shade plan are built while the layer evaluates, so replaying a
// cached value skips them, and a `tone` inside a layer stops sounding on every frame
// after the first. Three suites caught it — tone, timeline and E1's own — and none of
// them is about caching.
//
// That is the §14 shape wearing the costume of a performance win: green on the tests
// that describe the feature, broken on the ones that describe everything around it.
//
// The fix is not a smaller cache. It is separating what a layer PRODUCES from what it
// REGISTERS, so the second can be replayed when the first is reused. That is a real
// change to how layers evaluate and it deserves its own stage, not a corner of this one.
// ---------------------------------------------------------------------------

describe("what invalidation caching must not break", () => {
  it("recomposes the frame its input changes, which is the failure mode that matters", () => {
    // Staleness is the §14 shape here: a cache that never invalidates passes every
    // "did it draw?" test and draws last frame's picture forever.
    const p = program([
      "var n = 0",
      "scene S(width: 6, height: 2)",
      "on tick(dt)",
      "    n = n + 1",
      "layer body z: 0",
      '    fill "."',
      "    put str(n) at (0, 0)",
    ]);
    const seen = frames(p, 4);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("sees an in-place edit, which comparing values by identity cannot", () => {
    // The dict is the same object every frame; only its contents move. Without the
    // mutation epoch this layer would be held stale and draw 1 forever.
    const p = program([
      'var bag = {"n": 1}',
      "scene S(width: 6, height: 2)",
      "on tick(dt)",
      '    bag["n"] = bag["n"] + 1',
      "layer body z: 0",
      '    fill "."',
      '    put str(bag["n"]) at (0, 0)',
    ]);
    const seen = frames(p, 4);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("recomposes a layer that reads a volatile native every frame", () => {
    // gameTime() is not a name the reads set can see, so the classifier must keep this
    // layer out of the cache entirely. In doubt, recompose.
    const p = program([
      "scene S(width: 8, height: 2)",
      "layer body z: 0",
      '    fill "."',
      "    put str(int(gameTime() * 100.0)) at (0, 0)",
    ]);
    const seen = frames(p, 4);
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// The second thing the cache must not assume: that an empty read set means nothing moves.
//
// `collectReads` adds a name only when `top.has(name)` — a TOP-LEVEL binding. A native
// call is not one, so a layer whose only source of change is `gameTime()` or `random()`
// collects NOTHING and would satisfy "none of my reads moved" on every frame, forever.
//
// E1's cache is safe from this because it caches only layers the analyzer proved static,
// and the analyzer does flag these ("calls gameTime", "calls random"). The invalidation
// cache is aimed at DYNAMIC layers, which is precisely where that protection ends. So
// before it is built, the rule it needs is written down: a layer may be reused on the
// strength of its reads only when its reads are the whole story, and `reads.size === 0`
// on a dynamic layer is proof that they are not.
describe("an empty read set is not a promise that nothing changes", () => {
  it("collects no reads for a layer driven only by gameTime or random", () => {
    const parsed = parse(
      [
        "scene main(width: 8, height: 5)",
        "layer clock z: 0",
        "    put str(int(gameTime())) at (0, 0)",
        "layer noise z: 1",
        "    put str(int(random() * 10.0)) at (0, 1)",
      ].join("\n"),
      "t.qbsk",
    );
    expect(parsed.errors).toEqual([]);
    const layers = analyzeLayerStaticity(parsed.ast);

    // Dynamic, correctly. And with nothing at all for a read-comparing cache to compare.
    expect(layers.map((l) => l.static)).toEqual([false, false]);
    expect(layers.map((l) => l.reason)).toEqual(["calls gameTime", "calls random"]);
    expect(layers.map((l) => l.reads.size)).toEqual([0, 0]);
  });

  it("keeps such a layer repainting, which is what a read-only cache would stop", () => {
    // The behaviour the assertion above protects, stated in frames rather than in
    // analysis: this layer must differ from frame to frame.
    const p = program([
      "scene main(width: 12, height: 3)",
      "layer clock z: 0",
      "    put str(int(gameTime() * 100.0)) at (0, 0)",
    ]);
    const rendered = frames(p, 3);
    expect(new Set(rendered).size).toBe(3);
  });
});
