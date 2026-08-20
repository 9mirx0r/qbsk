// `raycast` exposed to QBSK (docs/engine.md §11.21).
//
// The engine does the DDA because QBSK cannot do it per column per frame; the DRAWING
// stays in QBSK, where a `line` per column and a glyph ramp are already expressible.
// Spending frozen native surface on what the language can already say is how a small
// language stops being small (§11.18).
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const ROOM = `var room = [
    "########",
    "#......#",
    "#......#",
    "#......#",
    "#......#",
    "#......#",
    "#......#",
    "########",
]
var eye = {"x": 1.5, "y": 3.5, "angle": 0.0, "fov": 60.0}`;

describe("the raycast native", () => {
  it("returns [distance, side, tile, hit] per column, mirroring project()", () => {
    const r = runQbsk(`${ROOM}\nvar cols = raycast(room, eye, 1, 32.0, "#")\nprint(cols[0])`, "t.qbsk");
    expect(r.error).toBeNull();
    // `print` renders a list without quoting the strings inside it.
    expect(r.out[0]).toBe("[5.5, x, #, true]");
  });

  it("gives one row per column", () => {
    const r = runQbsk(`${ROOM}\nprint(len(raycast(room, eye, 24, 32.0, "#")))`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("24");
  });

  it("reports a miss as hit false rather than as a wall at the horizon", () => {
    const r = runQbsk(
      `var open = ["....", "....", "....", "...."]
var eye = {"x": 0.5, "y": 0.5, "angle": 0.0, "fov": 60.0}
print(raycast(open, eye, 1, 2.0, "#")[0][3])`,
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("false");
  });

  it("takes camera defaults for missing keys, as project() does", () => {
    const r = runQbsk(`${ROOM}\nprint(raycast(room, {"x": 1.5, "y": 3.5}, 1, 32.0, "#")[0][3])`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("true");
  });

  // --- §15 invariant I3: no host error reaches the author ------------------------
  //
  // Each of these is a way to hold the native wrong, and each must come back as a QBSK
  // error with a span rather than as a TypeError from inside the caster.

  it("reports a camera that is not a dict", () => {
    const r = runQbsk(`${ROOM}\nvar c = raycast(room, 3, 1, 32.0, "#")`, "t.qbsk");
    expect(r.error?.message).toMatch(/camera must be a dict/);
  });

  it("reports a blocked set that is not a string", () => {
    const r = runQbsk(`${ROOM}\nvar c = raycast(room, eye, 1, 32.0, 5)`, "t.qbsk");
    expect(r.error?.message).toMatch(/blocked characters as a string/);
  });

  it("reports a column count below one, which would return nothing at all", () => {
    const r = runQbsk(`${ROOM}\nvar c = raycast(room, eye, 0, 32.0, "#")`, "t.qbsk");
    expect(r.error?.message).toMatch(/at least one column/);
  });

  it("reports a range that is not positive", () => {
    const r = runQbsk(`${ROOM}\nvar c = raycast(room, eye, 1, 0.0, "#")`, "t.qbsk");
    expect(r.error?.message).toMatch(/range must be positive/);
  });

  it("carries a span, so the error points at the call", () => {
    const r = runQbsk(`${ROOM}\nvar c = raycast(room, 3, 1, 32.0, "#")`, "t.qbsk");
    expect(r.error?.span).toBeDefined();
    expect(r.error?.span?.start.line).toBe(12);
  });
});
