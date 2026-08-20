// What a layer reads (docs/engine.md §11.19) — the input to invalidation caching.
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { analyzeLayerStaticity } from "../../src/analyze/analyzer.js";

function readsOf(lines: string[]): Record<string, string[]> {
  const parsed = parse(lines.join("\n"), "t.qbsk");
  expect(parsed.errors).toEqual([]);
  const out: Record<string, string[]> = {};
  for (const layer of analyzeLayerStaticity(parsed.ast)) {
    out[layer.name] = [...layer.reads].sort();
  }
  return out;
}

describe("a layer reports the top-level names it depends on", () => {
  it("names the vars it reads, and only those", () => {
    expect(readsOf([
      "var a = 1",
      "var b = 2",
      "scene S(width: 4, height: 2)",
      "layer one z: 0",
      '    put str(a) at (0, 0)',
    ])).toEqual({ one: ["a"] });
  });

  it("follows a helper call into what the helper reads", () => {
    // The same walk E1 needs: a layer that reads nothing directly but calls a function
    // that reads a var depends on that var. Missing this is how a stale layer happens.
    expect(readsOf([
      "var t = 0",
      "func label()",
      "    return str(t)",
      "scene S(width: 4, height: 2)",
      "layer one z: 0",
      "    put label() at (0, 0)",
    ])).toEqual({ one: ["label", "t"] });
  });

  it("names a module binding, which is where in-place mutation hides", () => {
    expect(readsOf([
      'use "res/ramp.qbdata" as ramp',
      "scene S(width: 4, height: 2)",
      "layer one z: 0",
      '    put ramp.MEASURED["glyphs"] at (0, 0)',
    ])).toEqual({ one: ["ramp"] });
  });

  it("reports nothing for a layer that reads no top-level name", () => {
    expect(readsOf([
      "scene S(width: 4, height: 2)",
      "layer one z: 0",
      '    put "x" at (0, 0)',
    ])).toEqual({ one: [] });
  });

  it("keeps each layer's reads separate", () => {
    expect(readsOf([
      "var a = 1",
      "var b = 2",
      "scene S(width: 4, height: 3)",
      "layer one z: 0",
      "    put str(a) at (0, 0)",
      "layer two z: 1",
      "    put str(b) at (0, 1)",
    ])).toEqual({ one: ["a"], two: ["b"] });
  });

  it("reads what the layer's own z and at expressions reference", () => {
    // A layer whose POSITION depends on a var is as invalidatable as one whose body
    // does, and forgetting the header is how a layer moves without recomposing.
    expect(readsOf([
      "var depth = 3",
      "scene S(width: 4, height: 2)",
      "layer one z: depth",
      '    put "x" at (0, 0)',
    ])).toEqual({ one: ["depth"] });
  });
});
