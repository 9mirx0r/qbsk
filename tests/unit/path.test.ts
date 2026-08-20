// Pathfinding (docs/engine.md §13).
import { describe, expect, it } from "vitest";
import { findPath } from "../../src/engine/path.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const ROOM = [
  "##########",
  "#....#...#",
  "#....#...#",
  "#....#...#",
  "#........#",
  "##########",
];

const route = (
  map: string[],
  from: [number, number],
  to: [number, number],
  blocked = "#",
  diagonal = true,
) => findPath(map, from, to, blocked, diagonal);

describe("findPath", () => {
  it("walks a straight corridor", () => {
    const r = route(["....."], [0, 0], [4, 0]);
    expect(r).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
  });

  // Both ends are included precisely so these two cases are distinguishable.
  it("a route of one step means you are already there", () => {
    expect(route(["..."], [1, 0], [1, 0])).toEqual([[1, 0]]);
  });

  it("no way through is an empty list", () => {
    expect(route(["#.#", "###", "#.#"], [1, 0], [1, 2])).toEqual([]);
  });

  it("goes around a wall rather than through it", () => {
    const r = route(ROOM, [1, 1], [8, 1]);
    expect(r.length).toBeGreaterThan(0);
    for (const [x, y] of r) {
      expect(ROOM[y]![x]).not.toBe("#");
    }
    expect(r[0]).toEqual([1, 1]);
    expect(r[r.length - 1]).toEqual([8, 1]);
  });

  it("route[1] is the next step, which is what a turn handler wants", () => {
    const r = route(ROOM, [1, 1], [8, 1]);
    const [nx, ny] = r[1]!;
    expect(Math.abs(nx - 1)).toBeLessThanOrEqual(1);
    expect(Math.abs(ny - 1)).toBeLessThanOrEqual(1);
  });

  it("a destination inside a wall has no route", () => {
    expect(route(ROOM, [1, 1], [5, 1])).toEqual([]);
  });

  it("starting inside a wall has no route", () => {
    expect(route(ROOM, [0, 0], [1, 1])).toEqual([]);
  });

  it("off the map has no route, and does not throw", () => {
    expect(route(ROOM, [1, 1], [99, 99])).toEqual([]);
    expect(route(ROOM, [-1, -1], [1, 1])).toEqual([]);
  });

  // A cell past the end of a ragged row is off the map, not floor.
  it("ragged rows do not become open space", () => {
    const map = ["....", "..", "...."];
    const r = route(map, [0, 0], [3, 2]);
    for (const [x, y] of r) {
      expect(x).toBeLessThan(map[y]!.length);
    }
  });
});

describe("diagonals", () => {
  it("takes a diagonal when it is shorter", () => {
    const r = route(["....", "....", "...."], [0, 0], [3, 2]);
    // Octile distance: three diagonals then one straight, so four steps plus the start.
    expect(r.length).toBe(4);
  });

  it("diagonal: false restricts to four directions", () => {
    const r = route(["....", "....", "...."], [0, 0], [3, 2], "#", false);
    expect(r.length).toBe(6);
    for (let i = 1; i < r.length; i += 1) {
      const dx = Math.abs(r[i]![0] - r[i - 1]![0]);
      const dy = Math.abs(r[i]![1] - r[i - 1]![1]);
      expect(dx + dy).toBe(1);
    }
  });

  // The classic grid bug: slipping between two walls that touch at a corner reads as
  // walking through a wall, and looks like a rendering fault when it happens.
  it("refuses to cut a corner between two walls", () => {
    const map = [".#", "#."];
    expect(route(map, [0, 0], [1, 1])).toEqual([]);
  });

  it("allows a diagonal when only one side is blocked", () => {
    const map = [".#.", "...", "..."];
    const r = route(map, [0, 0], [1, 1]);
    expect(r).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("blocked characters", () => {
  it("takes a set, not a single character", () => {
    const map = ["....", "#~#.", "...."];
    const r = route(map, [0, 0], [0, 2], "#~");
    for (const [x, y] of r) {
      expect("#~").not.toContain(map[y]![x]);
    }
  });

  it("an empty blocked set makes everything walkable", () => {
    expect(route(["###"], [0, 0], [2, 0], "").length).toBe(3);
  });
});

describe("determinism — a route must be pinnable by a golden", () => {
  it("the same map and endpoints always give the same route", () => {
    const a = JSON.stringify(route(ROOM, [1, 1], [8, 3]));
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(route(ROOM, [1, 1], [8, 3]))).toBe(a);
    }
  });

  it("an open field, where ties are everywhere, is still stable", () => {
    // With no walls every equal-cost node is a tie, so this is the case that would
    // wobble if the queue's ordering depended on anything but the input.
    const open = Array.from({ length: 12 }, () => ".".repeat(12));
    const a = JSON.stringify(route(open, [0, 0], [11, 11]));
    expect(JSON.stringify(route(open, [0, 0], [11, 11]))).toBe(a);
  });
});

describe("the path() native", () => {
  const out = (src: string): string[] => {
    const r = runQbsk(src, "t.qbsk");
    expect(r.error).toBeNull();
    return r.out;
  };

  const MAP = 'const m = ["#####", "#...#", "#.#.#", "#...#", "#####"]';

  it("returns tuples a put can use directly", () => {
    const src = [
      MAP,
      "var r = path(m, (1, 1), (3, 3), \"#\")",
      "print(len(r))",
      "var step = r[1]",
      "print(step)",
    ].join("\n");
    const res = out(src);
    expect(Number(res[0])).toBeGreaterThan(1);
    expect(res[1]).toMatch(/^\(\d+, \d+\)$/);
  });

  it("no route is an empty list, not an error", () => {
    const src = [
      'const m = ["#.#", "###", "#.#"]',
      'var r = path(m, (1, 0), (1, 2), "#")',
      "print(len(r))",
    ].join("\n");
    expect(out(src)).toEqual(["0"]);
  });

  it("a fifth argument restricts to four directions", () => {
    const src = [
      'const m = ["....", "....", "...."]',
      'var a = path(m, (0, 0), (3, 2), ".x")',
      'var b = path(m, (0, 0), (3, 2), "x")',
      'var c = path(m, (0, 0), (3, 2), "x", false)',
      "print(len(a))",
      "print(len(b))",
      "print(len(c))",
    ].join("\n");
    expect(out(src)).toEqual(["0", "4", "6"]);
  });

  it("reports the wrong type by name", () => {
    for (const [src, needle] of [
      ['var r = path(7, (0, 0), (1, 1), "#")', "int"],
      ['var r = path(["..."], 3, (1, 1), "#")', "int"],
      ['var r = path(["..."], (0, 0), (1, 1), 9)', "int"],
    ] as const) {
      const r = runQbsk(src, "t.qbsk");
      expect(r.error).not.toBeNull();
      expect(r.error!.message).toContain(needle);
    }
  });

  it("a map that is not a list of strings reports", () => {
    const r = runQbsk('var r = path([1, 2], (0, 0), (1, 1), "#")', "t.qbsk");
    expect(r.error).not.toBeNull();
  });
});
