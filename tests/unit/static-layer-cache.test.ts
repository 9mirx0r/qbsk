import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeLayerStaticity,
  formatLayerStaticityReport,
  unclassifiedLayerNatives,
} from "../../src/analyze/analyzer.js";
import { SceneProgram, runQbsk } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parsed(source: string, file = "static-cache.qbsk") {
  const result = parse(source, file);
  expect(result.errors).toHaveLength(0);
  return result.ast;
}

function report(source: string) {
  return analyzeLayerStaticity(parsed(source));
}

describe("static-layer classification (static-layer)", () => {
  it("proves literal and const-only layers static with an explainable report", () => {
    const layers = report(`
const label = "still"
func caption()
    return label
scene main(width: 8, height: 2)
layer backdrop z: 0
    fill "."
layer words z: 1
    put caption() at (1, 0)
`);

    expect(layers.map(({ name, static: isStatic, reason }) => ({ name, isStatic, reason }))).toEqual([
      { name: "backdrop", isStatic: true, reason: "proven stable" },
      { name: "words", isStatic: true, reason: "proven stable" },
    ]);
    expect(formatLayerStaticityReport(layers)).toEqual([
      "layer backdrop: static — proven stable",
      "layer words: static — proven stable",
    ]);
  });

  it("marks direct var reads and volatile natives dynamic with the first reason", () => {
    const layers = report(`
var x = 1
scene main(width: 8, height: 2)
layer moving z: 0
    put "x" at (x, 0)
layer timed z: 1
    put str(gameTime()) at (0, 1)
`);

    expect(layers.map(({ static: isStatic, reason }) => ({ isStatic, reason }))).toEqual([
      { isStatic: false, reason: "reads var 'x'" },
      { isStatic: false, reason: "calls gameTime" },
    ]);
  });

  it("keeps a var read through a function-call chain dynamic", () => {
    const [layer] = report(`
var x = 1
func inner()
    return x
func outer()
    return inner()
scene main(width: 4, height: 1)
layer canary z: 0
    put str(outer()) at (0, 0)
`);

    expect(layer).toMatchObject({
      name: "canary",
      static: false,
      reason: "reads var 'x'",
    });
  });

  it("allows a locally seeded deterministic RNG layer", () => {
    const [layer] = report(`
scene main(width: 20, height: 4)
layer stars z: 0
    var r = rng(11)
    for i in 0..20
        put "*" at (roll_int(r, 0, 19), roll_int(r, 0, 3))
`);
    expect(layer).toMatchObject({ static: true, reason: "proven stable" });
  });

  it("rejects top-level mutable consts that a handler can mutate through a call", () => {
    const [layer] = report(`
const cells = ["A"]
func mutate(values)
    values[0] = "B"
on key "m"
    mutate(cells)
scene main(width: 3, height: 1)
layer value z: 0
    put cells[0] at (0, 0)
`);
    expect(layer).toMatchObject({
      static: false,
      reason: "reads mutated const 'cells'",
    });

    const [aliased] = report(`
const cells = ["A"]
var alias = cells
on key "m"
    alias[0] = "B"
scene main(width: 3, height: 1)
layer value z: 0
    put cells[0] at (0, 0)
`);
    expect(aliased).toMatchObject({
      static: false,
      reason: "reads mutated const 'cells'",
    });
  });

  it("treats an unknown const result as mutable when it crosses a helper boundary", () => {
    const [layer] = report(`
const state = load_state("slot")
func mutate(value)
    value["label"] = "B"
on key "m"
    mutate(state)
scene main(width: 3, height: 1)
layer value z: 0
    put state["label"] at (0, 0)
`);
    expect(layer).toMatchObject({
      static: false,
      reason: "reads mutated const 'state'",
    });
  });

  it("rejects a helper binding that can be reassigned before composition", () => {
    const [layer] = report(`
func label()
    return "A"
on key "m"
    label = func() "B"
scene main(width: 3, height: 1)
layer value z: 0
    put label() at (0, 0)
`);
    expect(layer).toMatchObject({
      static: false,
      reason: "calls reassigned function 'label'",
    });
  });

  it("treats imported bindings, indirect calls, and animated sprites conservatively", () => {
    const layers = report(`
use "lib.qbsk" as lib
const callback = str
scene main(width: 8, height: 5)
layer imported z: 0
    put lib.label at (0, 0)
layer indirect z: 1
    put callback(1) at (0, 1)
layer animated z: 2
    sprite "res/walk.qba" at (0, 2) frames: 2 fps: 4 loop: true
layer shaded z: 3
    shade grade
layer sounding z: 4
    tone 440
`);

    // The last two are static NOW and were not before. They were excluded
    // unconditionally, which was never a claim about `grade` or `440` — it stood in for
    // the fact that evaluating them registers something a reused layer used to lose.
    // §11.20 put that on the layer value, so they are judged on their inputs like
    // anything else. This is the one verdict in this suite that has ever been revised,
    // and it is revised because the reason for it stopped existing.
    expect(layers.map((layer) => layer.static)).toEqual([false, false, false, true, true]);
    expect(layers.map((layer) => layer.reason)).toEqual([
      "reads imported binding 'lib'",
      "calls an indirect function",
      "uses animated sprite frames",
      "proven stable",
      "proven stable",
    ]);
  });

  it("still refuses a tone or a shade whose arguments move", () => {
    // The other half of the revision: dropping a blanket exclusion is only correct if
    // what it was hiding gets checked. A tone reading a `var` is as dynamic as any other
    // statement reading one, and saying so is what makes the two `true`s above safe.
    const layers = report(`
var pitch = 440
var dim = 0.5
scene main(width: 8, height: 5)
layer moving_tone z: 0
    tone pitch
layer moving_shade z: 1
    shade grade amount: dim
`);

    expect(layers.map((layer) => layer.static)).toEqual([false, false]);
    expect(layers.map((layer) => layer.reason)).toEqual([
      "reads var 'pitch'",
      "reads var 'dim'",
    ]);
  });

  it("pins the conservative repository baseline and reviews the earlier shallow 63/140 count", () => {
    const examples = resolve(ROOT, "examples");
    const layers = readdirSync(examples)
      .filter((name) => name.endsWith(".qbsk"))
      .flatMap((name) => {
        const file = resolve(examples, name);
        return analyzeLayerStaticity(parsed(readFileSync(file, "utf8"), file));
      });

    // 57/140 at the close of E1. E2 added examples/masked_map.qbsk, whose two layers are
    // both provably static (a const map through a const mask) -> 59/142. E3 added
    // examples/subcell.qbsk, whose two layers read top-level canvas `var`s and are
    // therefore dynamic -> 59/144. Every move has been by ADDITION: no verdict on an
    // earlier layer has changed, which is the property this test exists to hold. A drop
    // in the dynamic count is the alarm — it would mean something became cacheable.
    // 2026-08-18, an earlier release: the first move that is NOT an addition, and the alarm above
    // is the one that caught it. 66 -> 70. Four layers became cacheable because two
    // classifier defects were repaired, not because a verdict was relaxed:
    //
    //   1. `tone` and `shade` were excluded from staticity unconditionally. That was
    //      never a claim about their arguments — it stood in for the fact that they
    //      REGISTER something a reused layer used to lose (docs/engine.md §11.20). The
    //      separation is built, so the exclusion went with it.
    //   2. Their arguments were then read as values, which made `wave: sine` and
    //      `shade grade` report "reads unresolved name". They are bare vocabulary, and
    //      `color` had always known that. `isBareVocabulary` now says so once for all
    //      three, which is the disagreement that produced this in the first place.
    //
    // The property the test holds is unchanged: a move must come with the reason, and no
    // verdict may drift without one written here.
    // 156 -> 159 by ADDITION: examples/first_person.qbsk brings three layers. Its walls
    // layer is dynamic (it reads the `eye` dict), its floor is static, and its HUD is
    // dynamic through `turn()`. `raycast` itself is classified STABLE — it is a pure
    // function of the map and the camera it is handed, so it does not make a layer move;
    // the camera does, and that is a read the analyzer already follows.
    // 159 -> 160: first_person.qbsk grew a `guards` layer. Dynamic, because it reads
    // `eye`, which is the read the invalidation cache follows.
    expect(layers).toHaveLength(160);
    expect(layers.filter((layer) => layer.static)).toHaveLength(71);

    // What F4's invalidation cache can actually serve, pinned as a number rather than as
    // a hope. Of the 86 dynamic layers, 64 move for reasons their read set can see; the
    // other 22 do not, and a cache that ignored the difference would freeze them
    // (tests/unit/layer-read-tracking.test.ts).
    const dynamic = layers.filter((layer) => !layer.static);
    expect(dynamic).toHaveLength(89);
    // 65, not 66: first_person.qbsk's `guards` layer is dynamic and NOT read-tracked,
    // because it CALLS through a module binding (`fp.billboard`). Calling through a name
    // is deliberately untracked — comparing the binding says what it points at, not what
    // the callee then reads — so the layer is composed every frame. That costs a cache
    // miss, never correctness, and it is the first measured price of the conservative
    // rule rather than a hypothetical one.
    expect(dynamic.filter((layer) => layer.readTracked)).toHaveLength(65);
    // The planning probe counted 63 because its shallow AST collection did not follow
    // helper calls (river/torches) and treated shade/animated-sprite layers as static.
    // It also proves one locally seeded RNG layer static that the shallow volatile-call
    // list rejected. Net production baseline at E1 close: 57/140.
    // 152/65/87 after F1 added examples/jail_scene.qbsk. Two of its three layers are
    // static; the backdrop is NOT, because it reads a `use`d module binding and the
    // classifier treats those as volatile unless proven const. That is the conservative
    // answer and the right one for now, but it means the single most expensive layer in
    // the scene -- 4,800 converted glyphs that never change -- recomposes every frame.
    // The first real case for F4's invalidation cache, found by building a scene rather
    // than by imagining one.
    expect(layers.filter((layer) => !layer.static)).toHaveLength(89);
  });

  it("has no native used by example layers outside the classifier policy", () => {
    const examples = resolve(ROOT, "examples");
    const missing = readdirSync(examples)
      .filter((name) => name.endsWith(".qbsk"))
      .flatMap((name) => {
        const file = resolve(examples, name);
        return unclassifiedLayerNatives(parsed(readFileSync(file, "utf8"), file));
      });
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe("whole-layer cache (static-layer)", () => {
  const paritySource = `
var x = 0
on tick(dt)
    x = (x + 1) % 4
scene main(width: 5, height: 2)
layer floor z: 0
    fill "."
layer actor z: 1
    put "XX" at (x, 0)
layer mask z: 2
    put " " at (2, 0)
layer label z: 3
    put "fixed" at (0, 1)
`;

  it("reuses static layers after the first frame", () => {
    const program = new SceneProgram(parsed(paritySource));

    expect(program.step(1 / 60).canvas?.renderText()).toBe(".X ..\nfixed");
    expect(program.staticCacheStats()).toEqual({
      staticLayers: 3,
      hits: 0,
      misses: 3,
      invalidations: 0,
    });

    expect(program.step(1 / 60).canvas?.renderText()).toBe(".. X.\nfixed");
    expect(program.staticCacheStats()).toEqual({
      staticLayers: 3,
      hits: 3,
      misses: 3,
      invalidations: 0,
    });
  });

  it("is byte-identical to uncached composition across dynamic frames", () => {
    const cached = new SceneProgram(parsed(paritySource));
    const uncached = new SceneProgram(parsed(paritySource), { staticLayerCache: false });

    for (let frame = 0; frame < 8; frame += 1) {
      const a = cached.step(1 / 60);
      const b = uncached.step(1 / 60);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      expect(a.canvas?.cells).toEqual(b.canvas?.cells);
      expect(a.canvas?.renderText()).toBe(b.canvas?.renderText());
    }
  });

  it("invalidates before evalSnippet mutates const-adjacent indexed state", () => {
    const program = new SceneProgram(parsed(`
const cells = ["A"]
scene main(width: 3, height: 1)
layer value z: 0
    put cells[0] at (0, 0)
`));

    expect(program.step(1 / 60).canvas?.renderText()).toBe("A  ");
    const snippet = program.evalSnippet('cells[0] = "B"', "edit.qbsk");
    expect(snippet.error).toBeNull();
    expect(snippet.canvas?.renderText()).toBe("B  ");
    expect(program.step(1 / 60).canvas?.renderText()).toBe("B  ");
    expect(program.staticCacheStats()).toMatchObject({ invalidations: 1 });
  });

  it("keeps a depth-tested layer dynamic, so the shared depth buffer stays whole", () => {
    // The cached path composes a static layer against its OWN depth buffer, never the
    // scene-wide one. That is only sound while no cached layer can carry `depth:`, and
    // nothing but the classifier enforces it. Pin both halves: the policy, and the
    // byte-identical composition that depends on it.
    const source = `
var near = 5.0
scene main(width: 4, height: 1)
layer ground z: 0
    put "...." at (0, 0)
layer projected z: 1
    put "F" at (1, 0) depth: 20.0
    put "N" at (1, 0) depth: near
`;

    const layers = report(source);
    expect(layers.map((layer) => [layer.name, layer.static, layer.reason])).toEqual([
      ["ground", true, "proven stable"],
      ["projected", false, "uses depth testing"],
    ]);

    const cached = new SceneProgram(parsed(source));
    const uncached = new SceneProgram(parsed(source), { staticLayerCache: false });
    for (let frame = 0; frame < 3; frame += 1) {
      const a = cached.step(1 / 60);
      const b = uncached.step(1 / 60);
      expect(a.error).toBeNull();
      // The nearer glyph wins the contested cell, and it wins it identically with the
      // cache on and off.
      expect(a.canvas?.renderText()).toBe(".N..");
      expect(a.canvas?.cells).toEqual(b.canvas?.cells);
    }
    expect(cached.staticCacheStats()).toMatchObject({ staticLayers: 1, hits: 2 });
  });

  it("keeps every one-shot scene golden byte-identical", () => {
    const pairs = [
      ["canvas.qbsk", "canvas.qbsk.out"],
      ["caves.qbsk", "caves.qbsk.out"],
      ["color.qbsk", "color.qbsk.out"],
      ["hello.qbsk", "hello.qbsk.out"],
      ["keys.qbsk", "keys.qbsk.out"],
      ["layers.qbsk", "layers.qbsk.out"],
      ["pixelart_test.qbsk", "pixelart_test.qbsk.out"],
      ["sprite.qbsk", "sprite.qbsk.out"],
      ["tiles.qbsk", "tiles.qbsk.out"],
    ] as const;
    for (const [example, golden] of pairs) {
      const file = resolve(ROOT, "examples", example);
      const expected = readFileSync(resolve(ROOT, "tests", "golden", golden), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\n$/, "");
      const result = runQbsk(readFileSync(file, "utf8"), file, undefined, {
        baseDir: resolve(ROOT, "examples"),
      });
      expect(result.error, example).toBeNull();
      expect(result.out.join("\n"), example).toBe(expected);
    }
  });
});
