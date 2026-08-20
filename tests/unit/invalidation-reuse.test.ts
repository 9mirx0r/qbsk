// The invalidation cache itself (docs/engine.md §11.19): a dynamic layer reused until
// something it reads moves.
//
// A correct cache is invisible — that is the point of it — so these tests come in pairs:
// a counter says reuse HAPPENED, and a frame comparison says reuse was ALLOWED. Either
// alone passes for the wrong reason. A cache that never fires satisfies every frame
// assertion; a cache that always fires satisfies every counter.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

function program(lines: string[]): SceneProgram {
  const parsed = parse(lines.join("\n"), "t.qbsk");
  expect(parsed.errors).toEqual([]);
  return new SceneProgram(parsed.ast, { baseDir: EXAMPLES });
}

function frames(p: SceneProgram, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const f = p.step(0.05);
    expect(f.error?.message ?? null).toBeNull();
    out.push(f.canvas!.renderText());
  }
  return out;
}

describe("a dynamic layer is reused until something it reads moves", () => {
  it("reuses a layer whose var is unchanged, and still repaints when it changes", () => {
    const p = program([
      "var frame = 0",
      "scene main(width: 12, height: 3)",
      "on tick(dt)",
      "    if frame < 2",
      "        frame += 1",
      "layer counter z: 0",
      "    put str(frame) at (0, 0)",
    ]);
    const rendered = frames(p, 5);

    // frame stops at 2, so the last three compositions are identical and reusable.
    expect(p.invalidationStats().hits).toBeGreaterThan(0);
    expect(rendered[0]).not.toBe(rendered[1]);
    expect(rendered[3]).toBe(rendered[4]);
  });

  it("re-evaluates when a list is edited IN PLACE, which rebinding checks cannot see", () => {
    // The mutation epoch's whole reason for existing. `names` is never rebound, so a
    // cache comparing bindings alone would hold the first frame forever.
    const p = program([
      "var names = [\"a\"]",
      "scene main(width: 12, height: 3)",
      "on tick(dt)",
      "    names = push(names, \"b\")",
      "layer listing z: 0",
      "    put join(names, \"\") at (0, 0)",
    ]);
    const rendered = frames(p, 3);
    expect(new Set(rendered).size).toBe(3);
  });

  it("never admits a layer whose reads do not explain it, so gameTime keeps moving", () => {
    const p = program([
      "scene main(width: 14, height: 3)",
      "layer clock z: 0",
      "    put str(int(gameTime() * 100.0)) at (0, 0)",
    ]);
    const rendered = frames(p, 3);
    expect(new Set(rendered).size).toBe(3);
    expect(p.invalidationStats().eligible).toBe(0);
  });

  it("keeps a tone sounding through a reused layer", () => {
    // §11.20 reached through the REAL path rather than through a forced cache. This is
    // the assertion the first F4 attempt failed.
    const p = program([
      "var pitch = 440",
      "scene main(width: 12, height: 3)",
      "layer sounding z: 0",
      "    put str(pitch) at (0, 0)",
      "    tone 440",
    ]);
    for (let i = 0; i < 3; i += 1) {
      const f = p.step(0.05);
      expect(f.error?.message ?? null).toBeNull();
      expect(f.audioPlan).toHaveLength(1);
    }
    expect(p.invalidationStats().hits).toBeGreaterThan(0);
  });

  // --- Mutations of things born this composition (docs/engine.md §11.19) ---------

  it("does not let one layer's private list-building invalidate another layer", () => {
    // The measured failure that sent F4 back for a second pass, in its real shape.
    //
    // The pushing layer is NOT the one being cached, and cannot be: a layer that calls a
    // mutating native has an effect, and reusing it would skip that effect. What it must
    // not do is invalidate its NEIGHBOUR. `cinematic.qbsk`'s `wrap` calls `push` on a
    // list it just created, one bump used to invalidate every cached layer in the frame,
    // and cell_block.qbsk measured 0 hits against 922 misses on layers that had nothing
    // to do with any of it.
    const p = program([
      "var word = \"ab\"",
      "var sink = []",
      "scene main(width: 14, height: 4)",
      "layer busy z: 0",
      "    var out = []",
      "    for i in 0..len(word)",
      "        out = push(out, word[i])",
      "    put join(out, \"-\") at (0, 0)",
      "layer quiet z: 1",
      "    put word at (0, 1)",
    ]);
    frames(p, 5);
    expect(p.invalidationStats().eligible).toBe(1);
    expect(p.invalidationStats().hits).toBeGreaterThan(0);
  });

  it("still invalidates when the mutated list existed before this composition", () => {
    // The other side, and the one that must not be lost buying the first. `names` is
    // created at the top level, so by the time any layer is cached it is old; editing it
    // has to be seen. Skipping the bump here would freeze the frame.
    const p = program([
      "var names = [\"a\"]",
      "scene main(width: 12, height: 3)",
      "on tick(dt)",
      "    names = push(names, \"b\")",
      "layer listing z: 0",
      "    put join(names, \"\") at (0, 0)",
    ]);
    expect(new Set(frames(p, 3)).size).toBe(3);
  });

  it("invalidates when a list born LAST composition is edited in this one", () => {
    // The subtlety the whole rule turns on. A list created during frame N is invisible to
    // every layer cached before it — but a layer cached DURING frame N can hold it, so in
    // frame N+1 it is old and editing it must bump. Getting this wrong freezes a scene
    // that stashes a fresh list into a top-level var and then grows it.
    const p = program([
      "var kept = []",
      "var started = false",
      "scene main(width: 14, height: 3)",
      "on tick(dt)",
      "    if not started",
      "        kept = [\"x\"]",
      "        started = true",
      "    else",
      "        kept = push(kept, \"y\")",
      "layer listing z: 0",
      "    put join(kept, \"\") at (0, 0)",
    ]);
    const rendered = frames(p, 4);
    expect(new Set(rendered).size).toBe(4);
  });

  it("exempts a birth only for the LAYER that made it, not for the whole frame", () => {
    // The hole the first version of this rule had, and the reason it is scoped per layer.
    //
    // `shared` is born at the top level. Scoped to the composition it would be exempt —
    // so `layer reading` could be cached holding it, an edit later in that same top-level
    // run would bump nothing, and the layer would be reused stale forever. Scoped to the
    // layer, `shared` was born outside any layer and is never exempt.
    //
    // `mutation-epoch.test.ts` is what caught this; four of its cases went red at once.
    // This test states the consequence in frames so the reason is not only in a comment.
    const p = program([
      "var shared = [\"a\"]",
      "scene main(width: 14, height: 3)",
      "on tick(dt)",
      "    shared[0] = shared[0] + \"a\"",
      "layer reading z: 0",
      "    put join(shared, \"\") at (0, 0)",
    ]);
    expect(new Set(frames(p, 4)).size).toBe(4);
  });

  it("counts a layer as eligible only when it is dynamic and read-tracked", () => {
    const p = program([
      "var frame = 0",
      "scene main(width: 12, height: 4)",
      "layer fixed z: 0",
      "    put \"hi\" at (0, 0)",
      "layer moving z: 1",
      "    put str(frame) at (0, 1)",
      "layer clock z: 2",
      "    put str(int(gameTime())) at (0, 2)",
    ]);
    p.step(0.05);
    // static -> E1's cache, gameTime -> nobody's, only `moving` belongs here.
    expect(p.invalidationStats().eligible).toBe(1);
  });
});
