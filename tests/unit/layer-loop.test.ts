// Drawing in a loop (docs/engine.md §11.11).
import { describe, expect, it } from "vitest";
import { runQbsk, SceneProgram } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

const rows = (src: string): string[] => {
  const r = runQbsk(src, "t.qbsk");
  expect(r.error).toBeNull();
  return r.canvas!.renderText().split("\n");
};

describe("a layer body collects what nested blocks draw", () => {
  // Before this, a `put` inside a loop ran, produced its primitive, and the
  // primitive was dropped — so an emitter of N particles needed N hand-written puts.
  it("a while loop draws every iteration", () => {
    const out = rows(
      [
        "scene S(width: 10, height: 3)",
        "layer a z: 1",
        '    fill "."',
        "    var i = 0",
        "    while i < 5",
        '        put "#" at (i, 1)',
        "        i += 1",
      ].join("\n"),
    );
    expect(out[1]).toBe("#####.....");
  });

  it("an if draws its taken branch and only that", () => {
    const out = rows(
      [
        "scene S(width: 10, height: 3)",
        "var shown = true",
        "layer a z: 1",
        '    fill "."',
        "    if shown",
        '        put "Y" at (0, 1)',
        "    else",
        '        put "N" at (1, 1)',
      ].join("\n"),
    );
    expect(out[1]).toBe("Y.........");
  });

  it("a function called from the body can draw — the reusable-widget door", () => {
    const out = rows(
      [
        "scene S(width: 12, height: 3)",
        "func bar(x, n)",
        "    var i = 0",
        "    while i < n",
        '        put "=" at (x + i, 1)',
        "        i += 1",
        "layer a z: 1",
        '    fill "."',
        "    bar(2, 4)",
      ].join("\n"),
    );
    expect(out[1]).toBe("..====......");
  });

  it("nested loops draw a grid", () => {
    const out = rows(
      [
        "scene S(width: 6, height: 4)",
        "layer a z: 1",
        '    fill "."',
        "    var y = 0",
        "    while y < 2",
        "        var x = 0",
        "        while x < 3",
        '            put "o" at (x, y)',
        "            x += 1",
        "        y += 1",
      ].join("\n"),
    );
    expect(out[0]).toBe("ooo...");
    expect(out[1]).toBe("ooo...");
  });

  it("a loop that runs zero times draws nothing", () => {
    const out = rows(
      [
        "scene S(width: 6, height: 2)",
        "layer a z: 1",
        '    fill "."',
        "    var i = 5",
        "    while i < 0",
        '        put "#" at (i, 0)',
        "        i += 1",
      ].join("\n"),
    );
    expect(out[0]).toBe("......");
  });
});

describe("state directives reach into the loop", () => {
  // Execution order is collection order, so `color` above a loop applies to
  // everything the loop draws, exactly as to a primitive written in place.
  it("a color above a loop colours the whole loop", () => {
    const r = runQbsk(
      [
        "scene S(width: 6, height: 2)",
        "layer a z: 1",
        "    color fg: red",
        "    var i = 0",
        "    while i < 3",
        '        put "#" at (i, 0)',
        "        i += 1",
      ].join("\n"),
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    // Colour lives in the cell, not in the plain text, so assert on the cell.
    const canvas = r.canvas!;
    for (let x = 0; x < 3; x += 1) {
      const cell = canvas.cells[0 * canvas.width + x]!;
      expect(cell.char).toBe("#");
      expect(cell.fg).not.toBe(-1);
    }
  });

  it("visible: false above a loop hides everything it draws", () => {
    const out = rows(
      [
        "scene S(width: 6, height: 2)",
        "layer a z: 1",
        '    fill "."',
        "    visible: false",
        "    var i = 0",
        "    while i < 3",
        '        put "#" at (i, 0)',
        "        i += 1",
      ].join("\n"),
    );
    expect(out[0]).toBe("......");
  });

  it("a directive written INSIDE the loop still applies from that point on", () => {
    const out = rows(
      [
        "scene S(width: 6, height: 2)",
        "layer a z: 1",
        '    fill "."',
        "    var i = 0",
        "    while i < 3",
        "        visible: i > 0",
        '        put "#" at (i, 0)',
        "        i += 1",
      ].join("\n"),
    );
    // Iteration 0 is hidden; 1 and 2 are drawn.
    expect(out[0]).toBe(".##...");
  });
});

describe("what did NOT change", () => {
  // The collector exists only while a layer body is evaluating.
  it("a put in a plain function outside a layer is an error (§15.2)", () => {
    // This used to assert that it "still draws nothing" — it pinned the ghost as
    // correct behaviour. Evaluating a primitive and dropping it is exactly the
    // silence §15 exists to remove: the program ran, drew nothing, and exited 0.
    const r = runQbsk(
      [
        "scene S(width: 6, height: 2)",
        "func stray()",
        '    put "X" at (0, 0)',
        "stray()",
        "layer a z: 1",
        '    fill "."',
      ].join("\n"),
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/'put' draws into a layer/);
  });

  it("a function CALLED from a layer body still draws into it", () => {
    // The rule is about where the primitive lands, not about nesting depth: a
    // helper invoked while the layer is collecting is inside the layer.
    const out = rows(
      [
        "scene S(width: 6, height: 2)",
        "func brush(x)",
        '    put "X" at (x, 0)',
        "layer a z: 1",
        '    fill "."',
        "    brush(1)",
      ].join("\n"),
    );
    expect(out[0]).toBe(".X....");
  });

  it("declaration order still decides ties", () => {
    const out = rows(
      [
        "scene S(width: 4, height: 2)",
        "layer a z: 1",
        '    fill "."',
        "    var i = 0",
        "    while i < 2",
        '        put "a" at (0, 0)',
        '        put "b" at (0, 0)',
        "        i += 1",
      ].join("\n"),
    );
    expect(out[0]![0]).toBe("b");
  });
});

describe("a layer body gets its own scope, every frame", () => {
  // Regression: the loop-in-layer feature shipped with a `var` in a layer body being
  // declared into the ENCLOSING scope, so the second composition died with
  // "already defined". Nothing caught it because runQbsk composes exactly once — only
  // a persistent program composes the same layer twice, which is every real frame.
  const program = (src: string) => {
    const parsed = parse(src, "t.qbsk");
    expect(parsed.errors).toEqual([]);
    return new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
  };

  const LOOPY = [
    "scene S(width: 10, height: 3)",
    "layer a z: 1",
    '    fill "."',
    "    var n = 3",
    "    var i = 0",
    "    while i < n",
    '        put "#" at (i, 1)',
    "        i += 1",
  ].join("\n");

  it("survives being composed many times", () => {
    const p = program(LOOPY);
    for (let frame = 0; frame < 5; frame += 1) {
      const f = p.step(1 / 60);
      expect(f.error).toBeNull();
      expect(f.canvas!.renderText().split("\n")[1]).toBe("###.......");
    }
  });

  it("a layer local does not leak into the top level", () => {
    const p = program(
      [
        "scene S(width: 10, height: 3)",
        "layer a z: 1",
        "    var hidden = 7",
        '    fill "."',
      ].join("\n"),
    );
    expect(p.step(1 / 60).error).toBeNull();
    expect(p.liveEnv.get("hidden")).toBeUndefined();
  });

  it("a layer still SEES and can mutate a top-level var", () => {
    const p = program(
      [
        "var total = 0",
        "scene S(width: 10, height: 3)",
        "layer a z: 1",
        '    fill "."',
        "    total += 1",
        '    put "#" at (total, 1)',
      ].join("\n"),
    );
    p.step(1 / 60);
    const after = p.liveEnv.get("total");
    expect(after).toEqual({ type: "int", value: 2 });
  });

  it("two layers may each declare the same local name", () => {
    const p = program(
      [
        "scene S(width: 10, height: 3)",
        "layer a z: 1",
        '    fill "."',
        "    var x = 1",
        '    put "a" at (x, 1)',
        "layer b z: 2",
        "    var x = 5",
        '    put "b" at (x, 1)',
      ].join("\n"),
    );
    const f = p.step(1 / 60);
    expect(f.error).toBeNull();
    const row = f.canvas!.renderText().split("\n")[1]!;
    expect(row[1]).toBe("a");
    expect(row[5]).toBe("b");
  });
});
