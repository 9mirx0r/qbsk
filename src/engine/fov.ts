// Field of view (docs/engine.md §14).
//
// Recursive shadowcasting over the same grid of characters `path` reads, answering with a
// MASK shaped like the map: "." you can see, " " you cannot.
//
// A list of visible coordinates would have been the obvious return type and the wrong
// one. A scene asks "can I see this cell" once per creature and once per tile it draws;
// answering that from a list is a linear search each time, while `mask[y][x]` is one
// index. It is also printable, which is how a field of view gets debugged.
//
// Shadowcasting rather than casting a ray to every cell: it is SYMMETRIC — if you can see
// a cell, from that cell you can see back — and it leaves no gaps behind corners. Raycast
// artefacts look exactly like rendering bugs, which is an expensive way to save an hour.

/**
 * The eight octants, as the (xx, xy, yx, yy) transforms that map scan space to the grid.
 *
 * Scanning is written once for one octant and these turn it into the other seven, which
 * is why the algorithm is short. Getting a sign wrong here lights nothing and looks like
 * the scan is broken — the first version of this file mixed the axes and produced a mask
 * with only the origin in it.
 */
const OCTANTS: readonly (readonly [number, number, number, number])[] = [
  [1, 0, 0, -1],
  [0, 1, -1, 0],
  [0, -1, -1, 0],
  [-1, 0, 0, -1],
  [-1, 0, 0, 1],
  [0, -1, 1, 0],
  [0, 1, 1, 0],
  [1, 0, 0, 1],
];

/**
 * What can be seen from `from`, within `radius` cells.
 *
 * Radius is Euclidean and measured in CELLS, deliberately not corrected for the 2:1 cell
 * aspect: a player counts squares, and every roguelike measures the same way. `shade` and
 * `project` correct for aspect because they are drawing a picture; this answers a
 * question about a grid.
 */
export function computeVisible(
  map: readonly string[],
  from: readonly [number, number],
  radius: number,
  blocked: string,
): string[] {
  const height = map.length;
  if (height === 0) {
    return [];
  }
  // Lit cells are collected SPARSELY, by row, and the mask strings are built at the
  // end. The first version allocated one char array per cell of the whole map, so a
  // radius-11 look cost 1.8 ms on a 60-wide map and 44 ms on a 2000-wide one
  // (bench/maps.md) — the scan was bounded by the radius and the allocation was not.
  // A radius touches about 2r+1 rows however large the map is.
  const litRows = new Map<number, Set<number>>();
  const wall = new Set<string>([...blocked]);

  /** Blank rows of the same width share one string, since strings are immutable. */
  const blanks = new Map<number, string>();
  const blank = (width: number): string => {
    let row = blanks.get(width);
    if (row === undefined) {
      row = " ".repeat(width);
      blanks.set(width, row);
    }
    return row;
  };

  // Rows keep their own width, so a ragged map produces a ragged mask and a cell past
  // the end of a row stays off the map rather than becoming lightable space.
  const build = (): string[] =>
    map.map((row, y) => {
      const lit = litRows.get(y);
      if (lit === undefined) {
        return blank(row.length);
      }
      const chars = blank(row.length).split("");
      for (const x of lit) {
        chars[x] = ".";
      }
      return chars.join("");
    });

  const [ox, oy] = from;
  const inside = (x: number, y: number): boolean =>
    y >= 0 && y < height && x >= 0 && x < map[y]!.length;

  if (!inside(ox, oy)) {
    return build();
  }

  // The origin is always lit, even standing inside a wall: a creature that could not see
  // its own square would be a strange thing to explain.
  litRows.set(oy, new Set([ox]));
  if (radius <= 0) {
    return build();
  }

  const opaque = (x: number, y: number): boolean =>
    !inside(x, y) || wall.has(map[y]![x]!);

  const light = (x: number, y: number): void => {
    if (!inside(x, y)) {
      return;
    }
    let row = litRows.get(y);
    if (row === undefined) {
      row = new Set<number>();
      litRows.set(y, row);
    }
    row.add(x);
  };

  const r2 = radius * radius;

  // One octant scanned row by row outward; `start` and `end` are the slopes bounding
  // the wedge still in view, and they narrow as walls are met. Recursing on a wall's
  // left edge and continuing past its right is what makes a shadow a wedge rather than
  // a line, and what makes the result symmetric.
  const cast = (
    row: number,
    startSlope: number,
    endSlope: number,
    xx: number,
    xy: number,
    yx: number,
    yy: number,
  ): void => {
    let start = startSlope;
    if (start < endSlope) {
      return;
    }
    let blockedRun = false;
    let nextStart = start;
    for (let distance = row; distance <= radius && !blockedRun; distance += 1) {
      const dy = -distance;
      for (let dx = -distance; dx <= 0; dx += 1) {
        const x = ox + dx * xx + dy * xy;
        const y = oy + dx * yx + dy * yy;
        const leftSlope = (dx - 0.5) / (dy + 0.5);
        const rightSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rightSlope) {
          continue;
        }
        if (endSlope > leftSlope) {
          break;
        }
        if (dx * dx + dy * dy <= r2) {
          // A wall in view IS lit — you see the face that blocks you. Lighting only
          // floor makes a room look as though it has no edges.
          light(x, y);
        }
        if (blockedRun) {
          if (opaque(x, y)) {
            nextStart = rightSlope;
          } else {
            blockedRun = false;
            start = nextStart;
          }
        } else if (opaque(x, y) && distance < radius) {
          blockedRun = true;
          cast(distance + 1, start, leftSlope, xx, xy, yx, yy);
          nextStart = rightSlope;
        }
      }
    }
  };

  for (const [xx, xy, yx, yy] of OCTANTS) {
    cast(1, 1, 0, xx, xy, yx, yy);
  }

  return build();
}
