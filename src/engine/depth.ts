// Depth testing (docs/engine.md §11.8).
//
// A flat depth buffer sitting beside the cell grid. Its whole job is to answer one
// question — "is this fragment nearer than whatever already wrote here?" — so that
// two things landing on the same cell resolve by distance rather than by which
// happened to be declared last.
//
// Pre-allocated and reset with `.fill()`, never re-allocated per frame: allocation
// inside the composition path is the anti-pattern the research names first, and the
// index arithmetic is deliberately identical to `Canvas`'s (`y * width + x`) so the
// two grids stay trivially in step.

export class DepthBuffer {
  readonly width: number;
  readonly height: number;
  private readonly depths: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.depths = new Float32Array(width * height);
    this.reset();
  }

  /** Clears to "infinitely far", so any real fragment wins. */
  reset(): void {
    this.depths.fill(Infinity);
  }

  /** Current depth at a cell; Infinity when nothing has written there. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return Infinity;
    }
    return this.depths[y * this.width + x]!;
  }

  /**
   * Depth test and write in one step: returns true when `depth` is nearer than what
   * is recorded, having claimed the cell.
   *
   * Off-grid coordinates fail rather than throwing — the canvas clips silently, and
   * a depth buffer that threw where the canvas shrugs would be a trap.
   *
   * The comparison is strictly-less, so equal depths keep the FIRST writer. Ties are
   * common on a character grid (a whole face of a cube can share one depth), and
   * "first wins" makes them resolve by declaration order, which is the rule the rest
   * of the engine already uses.
   */
  testAndSet(x: number, y: number, depth: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return false;
    }
    if (!Number.isFinite(depth)) {
      return false;
    }
    const i = y * this.width + x;
    if (depth < this.depths[i]!) {
      this.depths[i] = depth;
      return true;
    }
    return false;
  }
}
