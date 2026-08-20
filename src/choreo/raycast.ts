// Wall casting for a first-person view (docs/engine.md §11.21).
//
// A tile map and a camera in, one wall hit per screen column out. This is the other half
// of `project.ts`: that one answers "where on the grid does this 3D POINT land", which is
// what anchoring a label to a position needs. A first-person view asks the opposite —
// "along this ray, what do I meet first" — and wants a distance, not a coordinate.
//
// DDA over the tile grid rather than fixed-step sampling. Stepping by a small increment
// and testing each sample is easier to write and wrong in a way that shows: it misses
// walls thinner than the step and it costs the same whether the wall is next to you or
// across the map. DDA visits each tile boundary exactly once, so it is both exact and
// proportional to the distance actually travelled.
//
// NO TEXTURING, NO SPRITES, NO FLOOR CASTING. Those are the next questions and each is
// its own decision; this answers the first one completely.

/** What one ray met. */
export interface WallHit {
  /** Whether a wall was reached within `maxDistance`. */
  hit: boolean;
  /**
   * Distance along the camera's FORWARD axis, not along the ray.
   *
   * The two differ by the cosine of the ray's angle from centre, and using the ray's own
   * length bows a flat wall into a barrel — the fisheye every first draft of a raycaster
   * has. Correcting here rather than in the renderer means every consumer gets a wall
   * that looks flat without knowing why.
   */
  distance: number;
  /**
   * Which face was crossed: `"x"` for a north-south wall, `"y"` for an east-west one.
   *
   * The classic renderer darkens one of the two, which is what makes a corner readable
   * with no lighting model at all.
   */
  side: "x" | "y";
  /** The map character that stopped the ray, or `""` on a miss. */
  tile: string;
}

/** Where the eye is and where it looks. Angle 0 points along +x; +y is down the rows. */
export interface RayCamera {
  x: number;
  y: number;
  /** Facing, in radians. */
  angle: number;
  /** Horizontal field of view, in degrees. */
  fov: number;
}

/**
 * Casts one ray per column across the camera's field of view.
 *
 * `blocked` lists the characters that stop a ray. Anything outside the map stops one too:
 * walking off the array and reading `undefined` is how a caster returns NaN and paints a
 * single garbage column that nobody can trace back.
 */
export function castColumns(
  rows: readonly string[],
  camera: RayCamera,
  columns: number,
  maxDistance: number,
  blocked: string,
): WallHit[] {
  const hits: WallHit[] = [];
  const half = (camera.fov * Math.PI) / 180 / 2;
  for (let col = 0; col < columns; col += 1) {
    // The centre of the column's own slice of the view, so a 1-column cast looks straight
    // ahead and an N-column cast is symmetric about the centre line.
    const t = columns === 1 ? 0.5 : (col + 0.5) / columns;
    const offset = (t * 2 - 1) * half;
    hits.push(castOne(rows, camera, offset, maxDistance, blocked));
  }
  return hits;
}

function castOne(
  rows: readonly string[],
  camera: RayCamera,
  offset: number,
  maxDistance: number,
  blocked: string,
): WallHit {
  const dirX = Math.cos(camera.angle + offset);
  const dirY = Math.sin(camera.angle + offset);

  let mapX = Math.floor(camera.x);
  let mapY = Math.floor(camera.y);

  // How far the ray travels to cross one full tile in each axis. A ray exactly parallel
  // to an axis never crosses the other one, and Infinity is the honest value for that:
  // the comparison below then always picks the axis that does move.
  const deltaX = dirX === 0 ? Infinity : Math.abs(1 / dirX);
  const deltaY = dirY === 0 ? Infinity : Math.abs(1 / dirY);

  // Distance from the eye to the FIRST boundary in each axis, and which way to step.
  let stepX: number;
  let sideX: number;
  if (dirX < 0) {
    stepX = -1;
    sideX = (camera.x - mapX) * deltaX;
  } else {
    stepX = 1;
    sideX = (mapX + 1 - camera.x) * deltaX;
  }
  let stepY: number;
  let sideY: number;
  if (dirY < 0) {
    stepY = -1;
    sideY = (camera.y - mapY) * deltaY;
  } else {
    stepY = 1;
    sideY = (mapY + 1 - camera.y) * deltaY;
  }

  let side: "x" | "y" = "x";
  let travelled = 0;
  while (travelled <= maxDistance) {
    // Step into whichever tile boundary is nearer, and remember which face that was.
    //
    // The tie case is unreachable through this API and deliberately left unhandled.
    // `sideX === sideY` needs a ray at an exact diagonal, and `Math.cos(PI/4)` and
    // `Math.sin(PI/4)` differ by one ulp in JavaScript, so no angle produces it. Swapping
    // `<` for `<=` here therefore passes the whole suite — an equivalent mutant, recorded
    // rather than answered with a test that would pin floating-point noise as if it were
    // a decision.
    if (sideX < sideY) {
      travelled = sideX;
      sideX += deltaX;
      mapX += stepX;
      side = "x";
    } else {
      travelled = sideY;
      sideY += deltaY;
      mapY += stepY;
      side = "y";
    }
    if (travelled > maxDistance) {
      break;
    }
    const row = rows[mapY];
    const tile = row === undefined ? undefined : row[mapX];
    if (tile === undefined) {
      // Off the map. Solid, so the ray stops here rather than running to the horizon.
      return { hit: true, distance: travelled * Math.cos(offset), side, tile: "" };
    }
    if (blocked.includes(tile)) {
      return { hit: true, distance: travelled * Math.cos(offset), side, tile };
    }
  }
  return { hit: false, distance: maxDistance, side, tile: "" };
}
