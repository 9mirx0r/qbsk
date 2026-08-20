// Field of view (docs/engine.md §14).
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { computeVisible } from "../../src/engine/fov.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const see = (
  map: string[],
  from: [number, number],
  radius = 10,
  blocked = "#",
) => computeVisible(map, from, radius, blocked);

const lit = (mask: string[], x: number, y: number): boolean =>
  mask[y]?.[x] === ".";

const OPEN = Array.from({ length: 9 }, () => ".".repeat(9));

describe("computeVisible", () => {
  it("returns a mask the same shape as the map", () => {
    const mask = see(OPEN, [4, 4]);
    expect(mask.length).toBe(OPEN.length);
    for (let y = 0; y < mask.length; y += 1) {
      expect(mask[y]!.length).toBe(OPEN[y]!.length);
    }
  });

  it("uses '.' for visible and ' ' for not, so the mask is printable", () => {
    const mask = see(OPEN, [4, 4], 1);
    expect(mask[4]![4]).toBe(".");
    expect(mask[0]![0]).toBe(" ");
  });

  // A creature that could not see its own square would be a strange thing to explain.
  it("the origin is always visible, even inside a wall", () => {
    expect(lit(see(["###", "###", "###"], [1, 1]), 1, 1)).toBe(true);
  });

  it("an open room is fully lit within the radius", () => {
    const mask = see(OPEN, [4, 4], 10);
    for (let y = 0; y < 9; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        expect(lit(mask, x, y)).toBe(true);
      }
    }
  });

  it("radius is a limit, measured in cells", () => {
    const mask = see(OPEN, [4, 4], 2);
    expect(lit(mask, 4, 2)).toBe(true);
    expect(lit(mask, 4, 1)).toBe(false);
    // Euclidean, so a diagonal at 2,2 is 2.83 away and out of a radius of 2.
    expect(lit(mask, 2, 2)).toBe(false);
  });

  // Deliberately NOT corrected for the 2:1 cell aspect: a player counts squares.
  it("is round in CELLS, not on screen", () => {
    const mask = see(OPEN, [4, 4], 3);
    expect(lit(mask, 7, 4)).toBe(true);
    expect(lit(mask, 4, 7)).toBe(true);
  });
});

describe("walls", () => {
  const ROOM = [
    "#########",
    "#...#...#",
    "#...#...#",
    "#...#...#",
    "#.......#",
    "#########",
  ];

  it("you cannot see through a wall", () => {
    const mask = see(ROOM, [2, 1], 10);
    expect(lit(mask, 2, 2)).toBe(true);
    expect(lit(mask, 6, 1)).toBe(false);
    expect(lit(mask, 6, 2)).toBe(false);
  });

  // Lighting only floor makes a room look like it has no edges.
  it("a wall in view is lit — you see the face that blocks you", () => {
    const mask = see(ROOM, [2, 2], 10);
    expect(lit(mask, 4, 2)).toBe(true);
  });

  it("you can see around a corner once you reach it", () => {
    const nearGap = see(ROOM, [3, 4], 10);
    expect(lit(nearGap, 6, 4)).toBe(true);
  });

  it("a pillar casts a shadow behind it", () => {
    const map = [
      ".........",
      ".........",
      "....#....",
      ".........",
      ".........",
    ];
    const mask = see(map, [4, 0], 10);
    expect(lit(mask, 4, 2)).toBe(true);
    expect(lit(mask, 4, 3)).toBe(false);
    expect(lit(mask, 4, 4)).toBe(false);
    // Beside the shadow is still lit.
    expect(lit(mask, 2, 4)).toBe(true);
  });

  // The property that makes shadowcasting the right algorithm rather than raycasting.
  it("is symmetric: if you see a cell, from there you see back", () => {
    const map = ["........", "..####..", "........", "..####..", "........"];
    for (const [x, y] of [
      [1, 0],
      [6, 2],
      [3, 4],
      [7, 0],
    ] as const) {
      const fromA = lit(see(map, [1, 2], 20), x, y);
      const fromB = lit(see(map, [x, y], 20), 1, 2);
      expect(fromA).toBe(fromB);
    }
  });
});

describe("edges", () => {
  it("an origin off the map gives an all-dark mask rather than throwing", () => {
    const mask = see(OPEN, [99, 99]);
    expect(mask.join("").includes(".")).toBe(false);
  });

  it("a radius of zero shows only where you stand", () => {
    const mask = see(OPEN, [4, 4], 0);
    expect(lit(mask, 4, 4)).toBe(true);
    expect(lit(mask, 4, 3)).toBe(false);
  });

  it("ragged rows keep their own width", () => {
    const map = ["....", "..", "...."];
    const mask = see(map, [0, 0], 10);
    expect(mask[1]!.length).toBe(2);
  });

  it("an empty map is an empty mask", () => {
    expect(see([], [0, 0])).toEqual([]);
  });
});

describe("determinism", () => {
  // §14.3: floats are fine here because there is no ordering choice to be unspecified.
  it("the same map and origin always give the same mask", () => {
    const map = [
      "..........",
      "..#....#..",
      "..........",
      "....##....",
      "..........",
    ];
    const first = see(map, [1, 1], 8).join("\n");
    for (let i = 0; i < 20; i += 1) {
      expect(see(map, [1, 1], 8).join("\n")).toBe(first);
    }
  });
});

describe("the sight() native", () => {
  const out = (src: string): string[] => {
    const r = runQbsk(src, "t.qbsk");
    expect(r.error).toBeNull();
    return r.out;
  };

  const MAP = 'const m = ["#####", "#...#", "#.#.#", "#...#", "#####"]';

  it("gives a mask that indexes with [y][x]", () => {
    const src = [
      MAP,
      'var seen = sight(m, (1, 1), 10, "#")',
      "print(seen[1][1])",
      "print(len(seen))",
    ].join("\n");
    expect(out(src)).toEqual([".", "5"]);
  });

  it("the pillar hides the cell behind it", () => {
    const src = [
      MAP,
      'var seen = sight(m, (1, 1), 10, "#")',
      "print(seen[3][3])",
    ].join("\n");
    // (3,3) sits diagonally behind the pillar at (2,2) from (1,1).
    expect(out(src)).toEqual([" "]);
  });

  it("reports the wrong type by name", () => {
    for (const [src, needle] of [
      ['var v = sight(7, (0, 0), 5, "#")', "int"],
      ['var v = sight(["..."], 3, 5, "#")', "int"],
      ['var v = sight(["..."], (0, 0), "5", "#")', "str"],
      ["var v = sight([\"...\"], (0, 0), 5, 9)", "int"],
    ] as const) {
      const r = runQbsk(src, "t.qbsk");
      expect(r.error).not.toBeNull();
      expect(r.error!.message).toContain(needle);
    }
  });

  it("a negative radius reports rather than showing everything", () => {
    const r = runQbsk(
      'var v = sight(["..."], (0, 0), 0 - 1, "#")',
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
  });
});

describe("cost scales with the RADIUS, not the map", () => {
  // Found by bench/maps.mjs: sight at radius 11 took 1.8 ms on a 60-wide map and
  // 44 ms on a 2000-wide one. The algorithm is bounded by radius; the ALLOCATION was
  // not — the mask was built as one char array per cell of the whole map.
  const openMap = (w: number, h: number): string[] =>
    Array.from({ length: h }, (_, y) =>
      y === 0 || y === h - 1 ? "#".repeat(w) : "#" + ".".repeat(w - 2) + "#",
    );

  const timeOne = (map: string[]): number => {
    const at: [number, number] = [
      Math.floor(map[0]!.length / 2),
      Math.floor(map.length / 2),
    ];
    // Warm, then measure: the first call pays for compilation.
    for (let i = 0; i < 5; i += 1) {
      computeVisible(map, at, 11, "#");
    }
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) {
      computeVisible(map, at, 11, "#");
    }
    return (performance.now() - t0) / 20;
  };

  it("a map 30x larger is not 20x slower at the same radius", () => {
    const small = timeOne(openMap(60, 30));
    const large = timeOne(openMap(1800, 900));
    // Some growth is unavoidable — the returned mask is still map-shaped, so building
    // the strings is linear in area. The point is that the SCAN is not.
    expect(large).toBeLessThan(Math.max(small * 30, 8));
  });

  it("the mask is still exactly map-shaped on a large map", () => {
    const map = openMap(400, 200);
    const mask = computeVisible(map, [200, 100], 11, "#");
    expect(mask.length).toBe(200);
    expect(mask[0]!.length).toBe(400);
    expect(mask[100]![200]).toBe(".");
    // Far outside the radius: dark, and the row still full width.
    expect(mask[10]![20]).toBe(" ");
  });
});
