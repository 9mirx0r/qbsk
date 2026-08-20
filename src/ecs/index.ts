// ECS Main Class — an earlier design (docs/engine.md §16.5)
// Pure TypeScript, no Electron, no Node deps.
// This is the host-side ECS exposed to QBSK via natives.

import { ArchetypeRegistry } from "./registry.js";
import { CellList } from "./cellList.js";
import { EntityHandle, makeArchetypeKey } from "./types.js";

export interface GameRuntime {
  gameTime: number;
  sim?: { turn: number; pending: number; nextId: number };
  tweens?: Map<string, unknown>;
  host?: Record<string, unknown>;
  ecs?: ECS;
}

export class ECS {
  private registry: ArchetypeRegistry;
  private cellList: CellList;
  private nextEntityId = 1;

  constructor(cellSize: number = 10) {
    this.registry = new ArchetypeRegistry();
    this.cellList = new CellList(cellSize);
  }

  // --- Entity lifecycle ---

  spawn(parts: Array<Record<string, unknown> & { __part: string }>): EntityHandle {
    // Convert to PartData format
    const partData = parts.map((p) => {
      const { __part, ...data } = p;
      if (!__part) {
        throw new Error("Each part must have a '__part' key");
      }
      return { name: __part, data };
    });

    // Validate
    const err = this.registry.validateParts(
      partData.map((pd) => ({ name: pd.name, data: pd.data }))
    );
    if (err) {
      throw new Error(err);
    }

    const entityId = this.nextEntityId++;
    const handle = this.registry.addEntity(entityId, partData);

    // Register in spatial index if entity has Position
    const pos = partData.find((p) => p.name === "Position")?.data as
      | { x: number; y: number; z?: number }
      | undefined;
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      this.cellList.add(entityId, pos.x, pos.y, pos.z ?? 0);
    }

    return handle;
  }

  despawn(entity: EntityHandle): void {
    const entityId = entity.__entity;
    // Remove from spatial index first
    const pos = this.registry.getPart(entityId, "Position") as
      | { x: number; y: number; z?: number }
      | null;
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      this.cellList.remove(entityId, pos.x, pos.y, pos.z ?? 0);
    }
    this.registry.removeEntity(entityId);
  }

  // --- Part access ---

  find(entity: EntityHandle, partName: string): Record<string, unknown> | null {
    return this.registry.getPart(entity.__entity, partName);
  }

  setPart(entity: EntityHandle, partName: string, data: Record<string, unknown>): boolean {
    const entityId = entity.__entity;

    // Capture the OLD position (if any) before it is overwritten below — the spatial
    // index has to move FROM where the entity actually was TO where it is going; passing
    // the same point for both is a no-op (docs/engine.md §16.4's whole reason to exist).
    let oldPos: { x: number; y: number; z?: number } | null = null;
    if (partName === "Position") {
      oldPos = this.registry.getPart(entityId, "Position") as
        | { x: number; y: number; z?: number }
        | null;
    }

    const hadPart = this.registry.hasPart(entityId, partName);
    let success: boolean;
    if (hadPart) {
      success = this.registry.setPart(entityId, partName, data);
    } else {
      // A part the entity did not have before changes its archetype — migrate rather
      // than silently failing (docs/engine.md §16.6: "If different: allocate new slot,
      // copy part data, migrate").
      const current = this.registry.getHandle(entityId);
      if (!current) return false;
      const currentParts = current.__archetype === "" ? [] : current.__archetype.split("|");
      const newArchetype = makeArchetypeKey([...currentParts, partName]);
      this.registry.migrateEntity(entityId, newArchetype, { addPart: { name: partName, data } });
      success = true;
    }

    // Update spatial index if Position changed
    if (success && partName === "Position") {
      const newPos = data as { x: number; y: number; z?: number };
      if (typeof newPos.x === "number" && typeof newPos.y === "number") {
        if (oldPos && typeof oldPos.x === "number" && typeof oldPos.y === "number") {
          this.cellList.move(
            entityId,
            oldPos.x, oldPos.y, oldPos.z ?? 0,
            newPos.x, newPos.y, newPos.z ?? 0,
          );
        } else {
          // No prior Position (or it wasn't in the index yet) — this is a first placement.
          this.cellList.add(entityId, newPos.x, newPos.y, newPos.z ?? 0);
        }
      }
    }

    return success;
  }

  removePart(entity: EntityHandle, partName: string): boolean {
    const entityId = entity.__entity;
    if (!this.registry.hasPart(entityId, partName)) return false;

    // Removing Position takes the entity out of the spatial index too — read its
    // position before migration discards it.
    if (partName === "Position") {
      const pos = this.registry.getPart(entityId, "Position") as
        | { x: number; y: number; z?: number }
        | null;
      if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
        this.cellList.remove(entityId, pos.x, pos.y, pos.z ?? 0);
      }
    }

    const current = this.registry.getHandle(entityId);
    if (!current) return false;
    const remainingParts = current.__archetype.split("|").filter((p) => p !== partName);
    const newArchetype = makeArchetypeKey(remainingParts);
    this.registry.migrateEntity(entityId, newArchetype, { removePart: partName });
    return true;
  }

  hasPart(entity: EntityHandle, partName: string): boolean {
    return this.registry.hasPart(entity.__entity, partName);
  }

  // --- Queries ---

  query(partNames: string[]): EntityHandle[] {
    return this.registry.query(partNames);
  }

  entitiesInRadius(x: number, y: number, z: number, radius: number): EntityHandle[] {
    const ids = this.cellList.queryRadius(x, y, z, radius);
    return ids.map((id) => this.registry.getHandle(id)!).filter(Boolean);
  }

  entitiesInCell(x: number, y: number, z: number): EntityHandle[] {
    const ids = this.cellList.queryCell(x, y, z);
    return ids.map((id) => this.registry.getHandle(id)!).filter(Boolean);
  }

  // --- Introspection ---

  getStats(): { registry: ReturnType<ArchetypeRegistry["getStats"]>; cellList: ReturnType<CellList["getStats"]> } {
    return {
      registry: this.registry.getStats(),
      cellList: this.cellList.getStats(),
    };
  }

  // --- Attach to runtime ---

  static attachToRuntime(runtime: GameRuntime, cellSize: number = 10): ECS {
    const ecs = new ECS(cellSize);
    runtime.ecs = ecs;
    return ecs;
  }

  static getFromRuntime(runtime: GameRuntime): ECS | null {
    return runtime.ecs ?? null;
  }
}