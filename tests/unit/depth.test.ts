// Depth testing (docs/engine.md §11.8).
import { describe, expect, it } from "vitest";
import { DepthBuffer } from "../../src/engine/depth.js";
import { runQbsk } from "../../src/interp/interpreter.js";

describe("DepthBuffer", () => {
  it("starts infinitely far, so any real fragment wins", () => {
    const d = new DepthBuffer(4, 3);
    expect(d.at(0, 0)).toBe(Infinity);
    expect(d.testAndSet(0, 0, 999999)).toBe(true);
  });

  it("nearer wins, further loses, whatever the order", () => {
    const near = new DepthBuffer(4, 3);
    expect(near.testAndSet(1, 1, 5)).toBe(true);
    expect(near.testAndSet(1, 1, 20)).toBe(false);

    const far = new DepthBuffer(4, 3);
    expect(far.testAndSet(1, 1, 20)).toBe(true);
    expect(far.testAndSet(1, 1, 5)).toBe(true);
  });

  // Ties are common on a character grid — a whole face of a cube can share one
  // depth — so the rule has to be deliberate rather than incidental.
  it("an equal depth keeps the FIRST writer, so ties fall back to declaration order", () => {
    const d = new DepthBuffer(4, 3);
    expect(d.testAndSet(2, 2, 7)).toBe(true);
    expect(d.testAndSet(2, 2, 7)).toBe(false);
  });

  it("cells are independent", () => {
    const d = new DepthBuffer(4, 3);
    d.testAndSet(0, 0, 1);
    expect(d.testAndSet(1, 0, 50)).toBe(true);
    expect(d.at(0, 0)).toBe(1);
  });

  it("reset clears the whole grid", () => {
    const d = new DepthBuffer(3, 2);
    d.testAndSet(0, 0, 1);
    d.testAndSet(2, 1, 2);
    d.reset();
    expect(d.at(0, 0)).toBe(Infinity);
    expect(d.at(2, 1)).toBe(Infinity);
  });

  // The canvas clips silently; a depth buffer that threw where the canvas shrugs
  // would be a trap for exactly the code that draws projected points.
  it("off-grid fails rather than throwing", () => {
    const d = new DepthBuffer(4, 3);
    expect(d.testAndSet(-1, 0, 1)).toBe(false);
    expect(d.testAndSet(0, -1, 1)).toBe(false);
    expect(d.testAndSet(4, 0, 1)).toBe(false);
    expect(d.testAndSet(0, 3, 1)).toBe(false);
    expect(d.at(99, 99)).toBe(Infinity);
  });

  it("a non-finite depth never claims a cell", () => {
    const d = new DepthBuffer(4, 3);
    expect(d.testAndSet(0, 0, Infinity)).toBe(false);
    expect(d.testAndSet(0, 0, NaN)).toBe(false);
    expect(d.at(0, 0)).toBe(Infinity);
  });

  it("negative depths are ordinary — behind-camera filtering is project()'s job", () => {
    const d = new DepthBuffer(4, 3);
    expect(d.testAndSet(0, 0, 5)).toBe(true);
    expect(d.testAndSet(0, 0, -2)).toBe(true);
  });
});

describe("put ... depth: (docs/engine.md §11.8)", () => {
  const grid = (src: string): string[] => {
    const r = runQbsk(src, "t.qbsk");
    expect(r.error).toBeNull();
    return r.canvas!.renderText().split("\n");
  };

  it("the nearest glyph wins regardless of declaration order", () => {
    const rows = grid(
      [
        "scene D(width: 12, height: 3)",
        "layer a z: 1",
        '    fill "."',
        '    put "F" at (5, 1) depth: 20.0',
        '    put "N" at (5, 1) depth: 5.0',
        '    put "X" at (5, 1) depth: 50.0',
      ].join("\n"),
    );
    expect(rows[1]![5]).toBe("N");
  });

  // The compatibility guarantee: a scene that never says `depth:` composes exactly
  // as it always has, which is what lets every existing golden keep passing.
  it("without depth the last writer wins, exactly as before", () => {
    const rows = grid(
      [
        "scene D(width: 12, height: 3)",
        "layer a z: 1",
        '    fill "."',
        '    put "u" at (8, 1)',
        '    put "v" at (8, 1)',
      ].join("\n"),
    );
    expect(rows[1]![8]).toBe("v");
  });

  it("depth is per CELL, not per string: a nearer glyph wins only where it lands", () => {
    const rows = grid(
      [
        "scene D(width: 12, height: 3)",
        "layer a z: 1",
        '    fill "."',
        '    put "FFFF" at (2, 1) depth: 20.0',
        '    put "N" at (3, 1) depth: 5.0',
      ].join("\n"),
    );
    expect(rows[1]!.slice(2, 6)).toBe("FNFF");
  });

  it("a depth-tested glyph still respects the layer offset", () => {
    const rows = grid(
      [
        "scene D(width: 12, height: 3)",
        "layer a z: 1 at (4, 0)",
        '    fill "."',
        '    put "@" at (1, 1) depth: 1.0',
      ].join("\n"),
    );
    expect(rows[1]![5]).toBe("@");
  });

  it("a non-numeric depth reports with a span", () => {
    const r = runQbsk(
      [
        "scene D(width: 8, height: 3)",
        "layer a z: 1",
        '    put "@" at (1, 1) depth: "near"',
      ].join("\n"),
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("depth");
  });

  it("depth composes with project(): the nearer corner survives a collision", () => {
    const src = [
      'const cam = {"x": 0.0, "y": 0.0, "z": -10.0, "fov": 60.0}',
      "var near = project([0.0, 0.0, 0.0], cam, 20, 5)",
      "var far = project([0.0, 0.0, 8.0], cam, 20, 5)",
      "scene D(width: 20, height: 5)",
      "layer a z: 1",
      '    fill "."',
      '    put "F" at (far[0], far[1]) depth: far[2]',
      '    put "N" at (near[0], near[1]) depth: near[2]',
    ].join("\n");
    const all = grid(src).join("\n");
    // Both points sit on the view axis, so they project to the same cell. Assert the
    // property rather than the coordinate: the nearer glyph is on screen and the
    // further one was rejected. Hardcoding the cell would just re-test project().
    expect(all).toContain("N");
    expect(all).not.toContain("F");
  });
});
