// 3D → cell projection (docs/engine.md §11.7).
//
// Turns a world point into a grid coordinate: the smallest useful piece of "ASCII
// 3D", and useful entirely on its own — anchoring a label to a 3D position needs
// this and nothing else.
//
// NO MATRIX LIBRARY, DELIBERATELY. The research this era draws on prescribed a
// Vec3/Mat4 core first (see the design notes). Matrices earn their
// keep when thousands of vertices share one cached transform — that is a
// rasterizer's problem, and there is no rasterizer yet. Doing the same arithmetic
// directly is shorter, has fewer places to be wrong, and is exactly as correct.
// Mat4 arrives with the thing that needs it, not before.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera {
  /** Eye position in world space. */
  pos: Vec3;
  /** The point the camera looks at. */
  target: Vec3;
  /** Vertical field of view, in degrees. */
  fov: number;
  /**
   * Cell aspect: how many times taller a cell is than it is wide.
   *
   * NOT a constant, and this is the correction that matters. `studio/renderer/fit.ts`
   * already carries a per-font ratio because Unifont (0.50 em wide) and JetBrains
   * Mono (0.60 em) genuinely differ — hard-coding one value has caused a real sizing
   * bug in this repository once already. 2.0 is a sane default for a typical
   * terminal cell; a renderer that knows its font should pass its own.
   */
  aspect: number;
}

export const DEFAULT_ASPECT = 2.0;

/** Points at or behind this distance from the eye cannot be projected. */
export const NEAR_PLANE = 0.1;

export interface Projected {
  /** Column, rounded to a cell. */
  u: number;
  /** Row, rounded to a cell. */
  v: number;
  /** Distance along the view axis. Larger is further away. */
  depth: number;
  /**
   * False when the point is behind the near plane. `u`/`v` are meaningless then,
   * and a caller that ignores this will draw things that are behind the camera.
   */
  visible: boolean;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

/** Returns a unit vector, or null when the input has no direction to normalise. */
function normalise(v: Vec3): Vec3 | null {
  const len = length(v);
  if (!(len > 0) || !Number.isFinite(len)) {
    return null;
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };
/** Used when the camera looks straight up or down and WORLD_UP is degenerate. */
const FALLBACK_UP: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * Projects a world point onto a `width` × `height` character grid.
 *
 * Cells are rounded, never truncated: `Math.floor` biases every coordinate toward
 * the origin, which shows up as visible jitter when a camera pans slowly — one of
 * the anti-patterns the research names explicitly.
 */
export function project(
  point: Vec3,
  camera: Camera,
  width: number,
  height: number,
): Projected {
  const offscreen: Projected = { u: -1, v: -1, depth: Infinity, visible: false };

  const forward = normalise(sub(camera.target, camera.pos));
  if (forward === null) {
    // Eye and target coincide: there is no direction to look in.
    return offscreen;
  }
  // Order matters and is easy to get backwards: cross(up, forward) points RIGHT,
  // while cross(forward, up) points left. Reversed, the world mirrors horizontally
  // and every x offset lands on the wrong side of the screen.
  //
  // If the camera looks straight up or down, WORLD_UP is parallel to forward and
  // the cross product collapses. Swapping in a different reference keeps the basis
  // well-formed instead of producing NaN coordinates.
  let right = normalise(cross(WORLD_UP, forward));
  if (right === null) {
    right = normalise(cross(FALLBACK_UP, forward));
    if (right === null) {
      return offscreen;
    }
  }
  const up = cross(forward, right);

  const rel = sub(point, camera.pos);
  const depth = dot(rel, forward);
  if (depth < NEAR_PLANE) {
    return { u: -1, v: -1, depth, visible: false };
  }

  const focal = 1 / Math.tan((camera.fov * Math.PI) / 360);
  const px = (focal * dot(rel, right)) / depth;
  const py = (focal * dot(rel, up)) / depth;

  const aspect = camera.aspect > 0 ? camera.aspect : DEFAULT_ASPECT;
  // x is scaled by the cell aspect, not y: a cell is taller than it is wide, so
  // without this a cube projects as a rectangle.
  const u = Math.round(((px * aspect + 1) / 2) * width);
  const v = Math.round(((1 - (py + 1) / 2)) * height);
  return { u, v, depth, visible: true };
}
