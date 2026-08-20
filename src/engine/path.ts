// Pathfinding (docs/engine.md §13).
//
// A* over a grid of characters, because a grid of characters is what an ASCII map already
// is. Reading the same rows the player sees means there is no parallel structure to build
// and keep in step — which is the bug that structure would eventually have.
//
// This is the one part of the simulation that is TypeScript rather than QBSK, and the
// reason is the opposite of the entity decision (§12.1). Entities are touched a few
// hundred times a turn and are worth having in the live environment where the console
// reaches them. A* touches thousands of cells for a single question and returns one
// answer; there is nothing to inspect in the middle of it.
//
// Everything here is deterministic by construction. See `pop` for why that took care.

/** Orthogonal step. Integers, not floats — see the module note on determinism. */
const STRAIGHT = 10;
/** Diagonal step: the standard integer approximation of √2. */
const DIAGONAL = 14;

// Fixed order, so two equal-cost routes always resolve the same way. Orthogonals first:
// with equal scores a straight step is the one a person would have drawn.
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

interface Node {
  index: number;
  g: number;
  f: number;
  h: number;
}

/**
 * The route from `from` to `to`, inclusive of both, or an empty array when there is none.
 *
 * Both ends are included so that "already there" (one entry) is distinguishable from "no
 * route" (none). With the start excluded they would both be empty, and a creature that
 * cannot reach you would behave exactly like one standing on you.
 */
export function findPath(
  map: readonly string[],
  from: readonly [number, number],
  to: readonly [number, number],
  blocked: string,
  diagonal = true,
): [number, number][] {
  const height = map.length;
  if (height === 0) {
    return [];
  }
  const width = map.reduce((max, row) => Math.max(max, row.length), 0);
  const wall = new Set<string>([...blocked]);

  const open = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || y >= height) {
      return false;
    }
    const row = map[y]!;
    // Past the end of a ragged row is OFF THE MAP, not floor. Treating it as open
    // would let a creature walk into space that is not drawn anywhere.
    if (x >= row.length) {
      return false;
    }
    return !wall.has(row[x]!);
  };

  const [sx, sy] = from;
  const [tx, ty] = to;
  if (!open(sx, sy) || !open(tx, ty)) {
    return [];
  }
  if (sx === tx && sy === ty) {
    return [[sx, sy]];
  }

  const start = sy * width + sx;
  const goal = ty * width + tx;
  const size = width * height;
  const g = new Int32Array(size).fill(-1);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  // Octile distance: exact for this cost model, so A* expands the minimum it can.
  const heuristic = (x: number, y: number): number => {
    const dx = Math.abs(x - tx);
    const dy = Math.abs(y - ty);
    return diagonal
      ? STRAIGHT * (dx + dy) + (DIAGONAL - 2 * STRAIGHT) * Math.min(dx, dy)
      : STRAIGHT * (dx + dy);
  };

  const heap: Node[] = [];
  push(heap, { index: start, g: 0, f: heuristic(sx, sy), h: heuristic(sx, sy) });
  g[start] = 0;

  const limit = diagonal ? NEIGHBOURS.length : 4;

  while (heap.length > 0) {
    const current = pop(heap)!;
    if (current.index === goal) {
      return rebuild(cameFrom, goal, width);
    }
    if (closed[current.index] === 1) {
      continue;
    }
    closed[current.index] = 1;
    const cx = current.index % width;
    const cy = (current.index - cx) / width;

    for (let i = 0; i < limit; i += 1) {
      const [dx, dy] = NEIGHBOURS[i]!;
      const nx = cx + dx;
      const ny = cy + dy;
      if (!open(nx, ny)) {
        continue;
      }
      if (dx !== 0 && dy !== 0) {
        // No corner cutting: refused only when BOTH orthogonals are blocked — the
        // two walls touch at the corner and a body does not fit through the gap
        // (docs/engine.md §13.2). With one side open the diagonal is a legal shortcut
        // for two steps you could have taken anyway, which is what roguelikes allow.
        if (!open(cx + dx, cy) && !open(cx, cy + dy)) {
          continue;
        }
      }
      const step = dx !== 0 && dy !== 0 ? DIAGONAL : STRAIGHT;
      const tentative = current.g + step;
      const index = ny * width + nx;
      if (g[index] !== -1 && tentative >= g[index]!) {
        continue;
      }
      g[index] = tentative;
      cameFrom[index] = current.index;
      const h = heuristic(nx, ny);
      push(heap, { index, g: tentative, f: tentative + h, h });
    }
  }
  return [];
}

/**
 * Binary heap ordered by `f`, then `h`, then cell index.
 *
 * The tie-breaking is the determinism (docs/engine.md §13.3). On an open field almost
 * every node ties on `f`, so without a total order the route would depend on the heap's
 * internal shuffling and two identical runs could disagree — which no golden could pin.
 * Lower `h` first also biases towards the goal, which produces the straighter route a
 * person would have drawn.
 */
function better(a: Node, b: Node): boolean {
  if (a.f !== b.f) {
    return a.f < b.f;
  }
  if (a.h !== b.h) {
    return a.h < b.h;
  }
  return a.index < b.index;
}

function push(heap: Node[], node: Node): void {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!better(heap[i]!, heap[parent]!)) {
      break;
    }
    [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
    i = parent;
  }
}

function pop(heap: Node[]): Node | undefined {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < heap.length && better(heap[left]!, heap[best]!)) {
        best = left;
      }
      if (right < heap.length && better(heap[right]!, heap[best]!)) {
        best = right;
      }
      if (best === i) {
        break;
      }
      [heap[i], heap[best]] = [heap[best]!, heap[i]!];
      i = best;
    }
  }
  return top;
}

function rebuild(
  cameFrom: Int32Array,
  goal: number,
  width: number,
): [number, number][] {
  const route: [number, number][] = [];
  let at = goal;
  while (at !== -1) {
    const x = at % width;
    route.push([x, (at - x) / width]);
    at = cameFrom[at]!;
  }
  return route.reverse();
}
