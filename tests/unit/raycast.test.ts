// The wall caster (docs/engine.md §11.21): a tile map and a camera into one wall hit per
// screen column.
//
// Separate from `project.ts`, which answers "where on the grid does this 3D POINT land".
// A first-person view asks the opposite question — "along this ray, what is the first
// thing I meet" — and gets a distance rather than a coordinate.
import { describe, expect, it } from "vitest";
import { castColumns } from "../../src/choreo/raycast.js";

// A 8x8 room, walls on the border, open inside. Row 0 is the top (north).
const ROOM = [
  "########",
  "#......#",
  "#......#",
  "#......#",
  "#......#",
  "#......#",
  "#......#",
  "########",
];

/** Facing east from the middle of the room. Angle 0 points along +x. */
const EAST = { x: 1.5, y: 3.5, angle: 0, fov: 60 };

describe("castColumns", () => {
  it("measures the distance to a wall straight ahead", () => {
    // One column means one ray, straight down the camera's centre line. The east wall's
    // inner face is at x = 7, the eye at x = 1.5, so 5.5 tiles.
    const hits = castColumns(ROOM, EAST, 1, 32, "#");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.hit).toBe(true);
    expect(hits[0]!.distance).toBeCloseTo(5.5, 6);
    expect(hits[0]!.tile).toBe("#");
    // Crossed a vertical face, so the wall runs north-south.
    expect(hits[0]!.side).toBe("x");
  });

  it("corrects the fisheye, which is the whole reason the distance is perpendicular", () => {
    // Every ray in this fan meets the SAME flat wall. The raw ray lengths differ — the
    // edge rays travel further to reach it — and drawing those would bow a flat wall into
    // a barrel. The perpendicular distance is equal across the fan, and that is what
    // makes the wall look flat.
    //
    // This is the assertion that fails if the cosine correction is dropped, which is why
    // the fan is wide (60 degrees) rather than a few degrees around the centre where
    // every implementation agrees to six decimal places.
    //
    // A TALL room, and that is not decoration. In ROOM the eye sits 2.5 tiles below the
    // north wall and 5.5 tiles from the east one, so the outer rays of a 60-degree fan
    // climb 2.77 tiles and meet the north wall first — a correct cast, and useless as a
    // fisheye test, because the distances then legitimately differ. The first draft of
    // this test asserted 5.5 across the fan and failed on a caster that was right.
    const hall = [
      "########",
      ...Array.from({ length: 16 }, () => "#......#"),
      "########",
    ];
    const hits = castColumns(hall, { x: 1.5, y: 8.5, angle: 0, fov: 60 }, 9, 32, "#");
    expect(hits).toHaveLength(9);
    const distances = hits.map((h) => h.distance);
    for (const d of distances) {
      expect(d).toBeCloseTo(5.5, 6);
    }
  });

  it("reports the side, so a renderer can shade the two wall faces differently", () => {
    // Facing north: the ray crosses a horizontal face, which the classic raycaster darkens
    // to make corners readable without any lighting model.
    const hits = castColumns(ROOM, { x: 3.5, y: 3.5, angle: -Math.PI / 2, fov: 60 }, 1, 32, "#");
    expect(hits[0]!.side).toBe("y");
    expect(hits[0]!.distance).toBeCloseTo(2.5, 6);
  });

  it("reports a miss rather than a wall at the horizon", () => {
    // A ray that runs out of range must say so. Returning maxDistance instead would draw
    // a wall infinitely far away, which is a wall, and the sky is not one.
    const open = ["....", "....", "....", "...."];
    const hits = castColumns(open, { x: 0.5, y: 0.5, angle: 0, fov: 60 }, 1, 2, "#");
    expect(hits[0]!.hit).toBe(false);
  });

  it("treats anything outside the map as solid", () => {
    // A ray leaving the map must stop. Walking off the array and reading `undefined` is
    // how a caster silently returns NaN and paints one garbage column.
    const open = ["...", "...", "..."];
    const hits = castColumns(open, { x: 1.5, y: 1.5, angle: 0, fov: 60 }, 1, 32, "#");
    expect(hits[0]!.hit).toBe(true);
    expect(hits[0]!.distance).toBeCloseTo(1.5, 6);
  });

  it("gives every column its own ray, ordered left to right", () => {
    // Facing east in a room whose north wall is closer than its east wall, so the fan
    // sweeps across two different walls and the columns cannot all be equal.
    const hits = castColumns(
      ["#####", "#...#", "#...#", "#####"],
      { x: 1.5, y: 1.5, angle: 0, fov: 90 },
      5,
      32,
      "#",
    );
    expect(hits).toHaveLength(5);
    expect(new Set(hits.map((h) => h.side)).size).toBe(2);
  });
});
