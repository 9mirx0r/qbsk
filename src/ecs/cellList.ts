// Cell List (Spatial Index) — an earlier design (docs/engine.md §16.4)
// Pure TypeScript, no Electron, no Node deps.

interface CellKey {
  x: number;
  y: number;
  z: number;
}

export class CellList {
  private grid = new Map<number, Map<number, Map<number, number[]>>>();
  private cellSize: number;
  private entityToCell = new Map<number, CellKey>();

  constructor(cellSize: number = 10) {
    this.cellSize = cellSize;
  }

  private cellCoord(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private getCell(x: number, y: number, z: number): number[] {
    const zMap = this.grid.get(z);
    if (!zMap) return [];
    const yMap = zMap.get(y);
    if (!yMap) return [];
    const xArr = yMap.get(x);
    return xArr ?? [];
  }

  private getOrCreateCell(x: number, y: number, z: number): number[] {
    let zMap = this.grid.get(z);
    if (!zMap) {
      zMap = new Map();
      this.grid.set(z, zMap);
    }
    let yMap = zMap.get(y);
    if (!yMap) {
      yMap = new Map();
      zMap.set(y, yMap);
    }
    let xArr = yMap.get(x);
    if (!xArr) {
      xArr = [];
      yMap.set(x, xArr);
    }
    return xArr;
  }

  add(entityId: number, x: number, y: number, z: number): void {
    const cx = this.cellCoord(x);
    const cy = this.cellCoord(y);
    const cz = this.cellCoord(z);
    const cell = this.getOrCreateCell(cx, cy, cz);
    if (!cell.includes(entityId)) {
      cell.push(entityId);
    }
    this.entityToCell.set(entityId, { x: cx, y: cy, z: cz });
  }

  remove(entityId: number, x?: number, y?: number, z?: number): void {
    let cx: number, cy: number, cz: number;
    if (x !== undefined && y !== undefined && z !== undefined) {
      cx = this.cellCoord(x);
      cy = this.cellCoord(y);
      cz = this.cellCoord(z);
    } else {
      const old = this.entityToCell.get(entityId);
      if (!old) return;
      cx = old.x;
      cy = old.y;
      cz = old.z;
    }

    const cell = this.getCell(cx, cy, cz);
    const idx = cell.indexOf(entityId);
    if (idx >= 0) {
      cell.splice(idx, 1);
    }
    this.entityToCell.delete(entityId);
  }

  move(entityId: number, oldX: number, oldY: number, oldZ: number, newX: number, newY: number, newZ: number): void {
    const oldCx = this.cellCoord(oldX);
    const oldCy = this.cellCoord(oldY);
    const oldCz = this.cellCoord(oldZ);
    const newCx = this.cellCoord(newX);
    const newCy = this.cellCoord(newY);
    const newCz = this.cellCoord(newZ);

    // If same cell, nothing to do
    if (oldCx === newCx && oldCy === newCy && oldCz === newCz) {
      return;
    }

    // Remove from old cell
    const oldCell = this.getCell(oldCx, oldCy, oldCz);
    const idx = oldCell.indexOf(entityId);
    if (idx >= 0) {
      oldCell.splice(idx, 1);
    }

    // Add to new cell
    const newCell = this.getOrCreateCell(newCx, newCy, newCz);
    if (!newCell.includes(entityId)) {
      newCell.push(entityId);
    }

    this.entityToCell.set(entityId, { x: newCx, y: newCy, z: newCz });
  }

  queryRadius(x: number, y: number, z: number, radius: number): number[] {
    const cx = this.cellCoord(x);
    const cy = this.cellCoord(y);
    const cz = this.cellCoord(z);
    const cellRadius = Math.ceil(radius / this.cellSize);

    const results: number[] = [];
    const seen = new Set<number>();

    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        for (let dx = -cellRadius; dx <= cellRadius; dx++) {
          const cell = this.getCell(cx + dx, cy + dy, cz + dz);
          for (const entityId of cell) {
            if (!seen.has(entityId)) {
              seen.add(entityId);
              results.push(entityId);
            }
          }
        }
      }
    }

    return results;
  }

  queryCell(x: number, y: number, z: number): number[] {
    const cx = this.cellCoord(x);
    const cy = this.cellCoord(y);
    const cz = this.cellCoord(z);
    return [...this.getCell(cx, cy, cz)];
  }

  getCellSize(): number {
    return this.cellSize;
  }

  setCellSize(size: number): void {
    if (size <= 0) throw new Error("Cell size must be positive");
    this.cellSize = size;
  }

  // Stats for debugging
  getStats(): { cells: number; totalEntities: number } {
    let cells = 0;
    let totalEntities = 0;
    for (const zMap of this.grid.values()) {
      for (const yMap of zMap.values()) {
        for (const cell of yMap.values()) {
          cells++;
          totalEntities += cell.length;
        }
      }
    }
    return { cells, totalEntities };
  }
}