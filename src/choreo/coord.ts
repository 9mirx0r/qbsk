// World ↔ local coordinates (spec engine.md §10): pure functions, no state.
// The DSL declares layer-local positions by default and `world:` for
// absolute ones; mounting resolves them and composition applies the layer offset.

export interface Point {
  x: number;
  y: number;
}

// Local → world: the local position is translated by the layer offset.
export function localToWorld(lx: number, ly: number, x: number, y: number): Point {
  return { x: lx + x, y: ly + y };
}

// World → local: inverse of localToWorld.
export function worldToLocal(lx: number, ly: number, x: number, y: number): Point {
  return { x: x - lx, y: y - ly };
}

export interface OffsetPoint extends Point {
  // true = absolute coordinates (world): the layer offset is NOT applied.
  world?: boolean;
}

// Composition resolution: local → at + local; world → as-is.
export function applyLayerOffset(p: OffsetPoint, lx: number, ly: number): Point {
  return p.world === true ? { x: p.x, y: p.y } : { x: lx + p.x, y: ly + p.y };
}
