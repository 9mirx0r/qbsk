// Whether a layer's dynamism is EXPLAINED by its reads (docs/engine.md §11.19).
//
// `static` is one bit and `reads` is a set of names, and the pair of them is not enough
// to license reuse. A layer driven by `gameTime()` is dynamic with an EMPTY read set, so
// "none of my reads moved" is true of it on every frame forever. E1 never met that case
// because it caches only what it proved static; an invalidation cache aims squarely at
// dynamic layers, which is where the gap lives.
//
// `readTracked` is the missing bit: true when suppressing name-reads leaves no reason at
// all, which is precisely the statement "reads are the whole story here".
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { analyzeLayerStaticity } from "../../src/analyze/analyzer.js";

function report(src: string) {
  const parsed = parse(src.trim(), "t.qbsk");
  expect(parsed.errors).toEqual([]);
  return analyzeLayerStaticity(parsed.ast);
}

describe("readTracked separates dynamism reads can see from dynamism they cannot", () => {
  it("tracks a layer whose only movement is a top-level var", () => {
    const [layer] = report(`
var frame = 0
scene main(width: 8, height: 5)
layer counter z: 0
    put str(frame) at (0, 0)
`);
    expect(layer).toMatchObject({ static: false, readTracked: true, untracked: null });
    expect([...layer!.reads]).toEqual(["frame"]);
  });

  it("refuses a layer driven by gameTime, whose read set is empty", () => {
    const [layer] = report(`
scene main(width: 8, height: 5)
layer clock z: 0
    put str(int(gameTime())) at (0, 0)
`);
    // The whole trap in one row: dynamic, nothing to compare, so nothing may be reused.
    expect(layer!.reads.size).toBe(0);
    expect(layer).toMatchObject({ static: false, readTracked: false, untracked: "calls gameTime" });
  });

  it("refuses a layer that reads a var AND calls gameTime", () => {
    // The case that makes a reason-string check unsound: `reason` reports only the FIRST
    // thing it finds, so a layer can look tracked while carrying an untracked source
    // behind it. Read order is deliberately var-first here.
    const [layer] = report(`
var frame = 0
scene main(width: 8, height: 5)
layer both z: 0
    put str(frame) at (0, 0)
    put str(int(gameTime())) at (0, 1)
`);
    expect(layer!.reason).toBe("reads var 'frame'");
    expect(layer).toMatchObject({ readTracked: false, untracked: "calls gameTime" });
  });

  it("follows helper functions rather than trusting the layer body alone", () => {
    const [layer] = report(`
func now()
    return int(gameTime())
scene main(width: 8, height: 5)
layer indirect z: 0
    put str(now()) at (0, 0)
`);
    expect(layer).toMatchObject({ readTracked: false, untracked: "calls gameTime" });
  });

  it("refuses an animated sprite and an indirect call", () => {
    const layers = report(`
const callback = str
scene main(width: 8, height: 5)
layer animated z: 0
    sprite "res/walk.qba" at (0, 0) frames: 2 fps: 4 loop: true
layer indirect z: 1
    put callback(1) at (0, 1)
`);
    expect(layers.map((l) => l.readTracked)).toEqual([false, false]);
  });

  it("reports a static layer as tracked, since a layer that never moves cannot move unseen", () => {
    const [layer] = report(`
scene main(width: 8, height: 5)
layer fixed z: 0
    put "hi" at (0, 0)
`);
    expect(layer).toMatchObject({ static: true, readTracked: true, untracked: null });
  });
});
