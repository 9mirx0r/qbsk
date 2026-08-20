// A layer PRODUCES a value and REGISTERS effects. Caching the first must not lose the
// second (docs/engine.md §11.20).
//
// The static cache (§11.16) has always been safe here, but safe by EXCLUSION: the
// analyzer refuses to call a layer static when it holds a `tone` or a `shade`
// (analyzer.ts, "uses tone" / "uses shade"), so the case never arose. That is a
// whitelist, and §14 records what this project's whitelists do — the F4 invalidation
// cache reached for the same layer values from a path the exclusion does not guard, and
// a `tone` inside a layer went silent after frame one.
//
// So these tests force the cache instead of asking the analyzer for it. They hold the
// property the exclusion was standing in for: a reused layer re-registers what it
// registered when it was built.
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { Interpreter } from "../../src/interp/interpreter.js";
import type { LayerDecl, Program } from "../../src/parser/ast.js";

/** Every top-level layer forced into the static cache, whatever the analyzer thinks. */
function forceAllLayersStatic(ast: Program): Map<LayerDecl, number> {
  const keys = new Map<LayerDecl, number>();
  for (const stmt of ast.body) {
    if (stmt.kind === "LayerDecl") keys.set(stmt, keys.size);
  }
  return keys;
}

function cachedFrames(src: string, n: number): { tones: number[]; shades: number[] } {
  const parsed = parse(src, "t.qbsk");
  expect(parsed.errors).toEqual([]);
  const interp = new Interpreter({ print: () => {} }, {
    staticLayerKeys: forceAllLayersStatic(parsed.ast),
  });
  interp.evalProgram(parsed.ast);
  const tones: number[] = [];
  const shades: number[] = [];
  for (let i = 0; i < n; i += 1) {
    interp.audioPlan = [];
    interp.shadePlan = [];
    interp.recomposeScene(parsed.ast);
    tones.push(interp.audioPlan.length);
    shades.push(interp.shadePlan.length);
  }
  return { tones, shades };
}

describe("a cached layer replays what it registered", () => {
  it("keeps a tone sounding on every frame, not only the one that built it", () => {
    const { tones } = cachedFrames(
      [
        "scene main(width: 8, height: 5)",
        "layer sounding z: 0",
        "    tone 440",
      ].join("\n"),
      3,
    );
    // The whole defect in one assertion: [1, 0, 0] is a tone that plays once and dies.
    expect(tones).toEqual([1, 1, 1]);
  });

  it("keeps a shade applying on every frame", () => {
    const { shades } = cachedFrames(
      [
        "scene main(width: 8, height: 5)",
        "layer lit z: 0",
        "    put \"ab\" at (0, 0)",
        "    shade grade",
      ].join("\n"),
      3,
    );
    expect(shades).toEqual([1, 1, 1]);
  });

  it("replays a hidden tone as absent rather than as silence it forgot to record", () => {
    // `visible: false` suppresses registration at build time, and the replay must
    // reproduce the suppression rather than merely happen to push nothing.
    //
    // Hence TWO tones with the visibility flipped between them. A layer holding only
    // the hidden one would expect [0, 0, 0] and get [0, 0, 0] from an implementation
    // that never recorded anything at all -- true for the wrong reason, the same
    // degenerate shape that let an inverted `edgeGlyph` pass 21 tests. With both
    // present, dropping the visibility check reads 2 and dropping the replay reads 0;
    // only recording the suppression reads 1.
    const { tones } = cachedFrames(
      [
        "scene main(width: 8, height: 5)",
        "layer mixed z: 0",
        "    visible: false",
        "    tone 440",
        "    visible: true",
        "    tone 880",
      ].join("\n"),
      3,
    );
    expect(tones).toEqual([1, 1, 1]);
  });

  it("registers each layer's effects once per frame, not once per layer that reuses it", () => {
    const { tones } = cachedFrames(
      [
        "scene main(width: 8, height: 5)",
        "layer a z: 0",
        "    tone 440",
        "layer b z: 1",
        "    tone 880",
      ].join("\n"),
      3,
    );
    expect(tones).toEqual([2, 2, 2]);
  });
});
