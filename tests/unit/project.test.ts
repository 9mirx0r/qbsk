// 3D → cell projection (docs/engine.md §11.7).
import { describe, expect, it } from "vitest";
import {
  project,
  DEFAULT_ASPECT,
  NEAR_PLANE,
  type Camera,
  type Vec3,
} from "../../src/choreo/project.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const W = 80;
const H = 24;

const cam = (over: Partial<Camera> = {}): Camera => ({
  pos: { x: 0, y: 0, z: -10 },
  target: { x: 0, y: 0, z: 0 },
  fov: 60,
  aspect: DEFAULT_ASPECT,
  ...over,
});

const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe("project maps a world point to a cell", () => {
  it("a point on the view axis lands at the centre of the grid", () => {
    const p = project(at(0, 0, 0), cam(), W, H);
    expect(p.visible).toBe(true);
    expect(p.u).toBe(W / 2);
    expect(p.v).toBe(H / 2);
  });

  it("moving right in the world moves right on the grid", () => {
    const centre = project(at(0, 0, 0), cam(), W, H);
    const right = project(at(3, 0, 0), cam(), W, H);
    expect(right.u).toBeGreaterThan(centre.u);
    expect(right.v).toBe(centre.v);
  });

  it("moving UP in the world moves UP the grid — rows count downward", () => {
    // The classic sign error: screen rows increase downward while world y
    // increases upward, so a missing flip puts the sky at the bottom.
    const centre = project(at(0, 0, 0), cam(), W, H);
    const up = project(at(0, 3, 0), cam(), W, H);
    expect(up.v).toBeLessThan(centre.v);
  });

  it("further away is smaller: perspective divide, not orthographic", () => {
    const near = project(at(3, 0, 0), cam(), W, H);
    const far = project(at(3, 0, 20), cam(), W, H);
    const centre = W / 2;
    expect(Math.abs(far.u - centre)).toBeLessThan(Math.abs(near.u - centre));
  });

  it("reports depth along the view axis, growing with distance", () => {
    expect(project(at(0, 0, 0), cam(), W, H).depth).toBeCloseTo(10, 6);
    expect(project(at(0, 0, 5), cam(), W, H).depth).toBeCloseTo(15, 6);
  });

  it("a wider field of view shrinks the same point towards the centre", () => {
    const narrow = project(at(3, 0, 0), cam({ fov: 30 }), W, H);
    const wide = project(at(3, 0, 0), cam({ fov: 90 }), W, H);
    const centre = W / 2;
    expect(Math.abs(wide.u - centre)).toBeLessThan(Math.abs(narrow.u - centre));
  });
});

describe("the cell aspect is a parameter, not a constant", () => {
  it("a taller cell pushes horizontal offsets further out", () => {
    const square = project(at(3, 0, 0), cam({ aspect: 1 }), W, H);
    const tall = project(at(3, 0, 0), cam({ aspect: 2 }), W, H);
    const centre = W / 2;
    expect(Math.abs(tall.u - centre)).toBeGreaterThan(Math.abs(square.u - centre));
  });

  it("a zero or negative aspect falls back rather than collapsing the scene", () => {
    const bad = project(at(3, 0, 0), cam({ aspect: 0 }), W, H);
    const good = project(at(3, 0, 0), cam({ aspect: DEFAULT_ASPECT }), W, H);
    expect(bad.u).toBe(good.u);
  });
});

describe("things that must not produce NaN or draw what is behind you", () => {
  it("a point behind the camera is not visible", () => {
    const p = project(at(0, 0, -20), cam(), W, H);
    expect(p.visible).toBe(false);
  });

  it("a point exactly at the eye is not visible", () => {
    const p = project(at(0, 0, -10), cam(), W, H);
    expect(p.visible).toBe(false);
  });

  it("the near plane is the cutoff, and just past it is visible", () => {
    const justBehind = project(at(0, 0, -10 + NEAR_PLANE / 2), cam(), W, H);
    const justInFront = project(at(0, 0, -10 + NEAR_PLANE * 2), cam(), W, H);
    expect(justBehind.visible).toBe(false);
    expect(justInFront.visible).toBe(true);
  });

  it("a camera looking straight down still produces a usable basis", () => {
    // Looking along world-up makes the usual up-vector parallel to forward and the
    // cross product collapse. Without a fallback this is NaN everywhere.
    const p = project(
      at(0, 0, 0),
      cam({ pos: { x: 0, y: 10, z: 0 }, target: { x: 0, y: 0, z: 0 } }),
      W,
      H,
    );
    expect(p.visible).toBe(true);
    expect(Number.isFinite(p.u)).toBe(true);
    expect(Number.isFinite(p.v)).toBe(true);
  });

  it("a camera whose target is its own position is not visible, not NaN", () => {
    const p = project(
      at(1, 1, 1),
      cam({ pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } }),
      W,
      H,
    );
    expect(p.visible).toBe(false);
    expect(Number.isNaN(p.u)).toBe(false);
  });

  it("always returns whole cells — rounded, never truncated", () => {
    // Truncation biases every coordinate toward the origin, which reads as jitter
    // when a camera pans slowly.
    for (const x of [0.4, 1.1, 2.7, -3.3]) {
      const p = project(at(x, x, 2), cam(), W, H);
      expect(Number.isInteger(p.u)).toBe(true);
      expect(Number.isInteger(p.v)).toBe(true);
    }
  });

  it("is a pure function: same inputs, same answer", () => {
    const a = project(at(1.5, -2.25, 7), cam(), W, H);
    const b = project(at(1.5, -2.25, 7), cam(), W, H);
    expect(a).toEqual(b);
  });
});

describe("the project() native", () => {
  const CAM =
    'const cam = {"x": 0.0, "y": 0.0, "z": -10.0, "tx": 0.0, "ty": 0.0, "tz": 0.0, "fov": 60.0}';

  it("returns [u, v, depth, visible] and centres the view axis", () => {
    const r = runQbsk(`${CAM}\nvar p = project([0.0, 0.0, 0.0], cam, 80, 24)\nprint(p)`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("[40, 12, 10.0, true]");
  });

  it("a point behind the camera comes back not visible", () => {
    const r = runQbsk(
      `${CAM}\nvar p = project([0.0, 0.0, -20.0], cam, 80, 24)\nprint(p[3])`,
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("false");
  });

  it("missing camera keys take their defaults instead of erroring", () => {
    const r = runQbsk(
      'var p = project([0.0, 0.0, 0.0], {"z": -5.0}, 80, 24)\nprint(p[3])',
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("true");
  });

  it("rejects a point that is not three numbers, with a span", () => {
    const r = runQbsk(`${CAM}\nprint(project([1.0, 2.0], cam, 80, 24))`, "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("three numbers");
  });

  it("rejects a non-dict camera", () => {
    const r = runQbsk("print(project([1.0, 2.0, 3.0], 7, 80, 24))", "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("camera");
  });

  it("rejects a non-numeric camera key by name", () => {
    const r = runQbsk(
      'print(project([1.0, 2.0, 3.0], {"fov": "wide"}, 80, 24))',
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("fov");
  });
});
