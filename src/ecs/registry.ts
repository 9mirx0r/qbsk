// Archetype Registry & Pools — an earlier design (docs/engine.md §16.3)
// Pure TypeScript, no Electron, no Node deps.

import {
  ArchetypeKey,
  Pool,
  EntityHandle,
  PartData,
  makeArchetypeKey,
  validatePartData,
} from "./types.js";

export class ArchetypeRegistry {
  private pools = new Map<ArchetypeKey, Pool>();
  private entityToPool = new Map<number, ArchetypeKey>();
  private entityToIndex = new Map<number, number>();

  getPool(archetype: ArchetypeKey): Pool {
    let pool = this.pools.get(archetype);
    if (!pool) {
      pool = {
        archetype,
        parts: new Map(),
        entityIds: [],
        freeIndices: [],
      };
      this.pools.set(archetype, pool);
    }
    return pool;
  }

  // Allocate a new entity with the given parts
  addEntity(entityId: number, parts: PartData[]): EntityHandle {
    const partNames = parts.map((p) => p.name);
    const archetype = makeArchetypeKey(partNames);
    const pool = this.getPool(archetype);

    // Ensure all part arrays exist
    for (const part of parts) {
      if (!pool.parts.has(part.name)) {
        pool.parts.set(part.name, []);
      }
    }

    // Allocate slot (recycle or append)
    let index: number;
    if (pool.freeIndices.length > 0) {
      index = pool.freeIndices.pop()!;
      pool.entityIds[index] = entityId;
      for (const part of parts) {
        pool.parts.get(part.name)![index] = part.data;
      }
    } else {
      index = pool.entityIds.length;
      pool.entityIds.push(entityId);
      for (const part of parts) {
        pool.parts.get(part.name)!.push(part.data);
      }
    }

    this.entityToPool.set(entityId, archetype);
    this.entityToIndex.set(entityId, index);

    return {
      __entity: entityId,
      __archetype: archetype,
      __index: index,
    };
  }

  // Remove entity from its pool
  removeEntity(entityId: number): boolean {
    const archetype = this.entityToPool.get(entityId);
    if (!archetype) return false;

    const pool = this.pools.get(archetype)!;
    const index = this.entityToIndex.get(entityId)!;

    // Clear the slot
    pool.entityIds[index] = 0; // 0 = empty (entity IDs start at 1)
    for (const arr of pool.parts.values()) {
      arr[index] = null;
    }
    pool.freeIndices.push(index);

    this.entityToPool.delete(entityId);
    this.entityToIndex.delete(entityId);
    return true;
  }

  // Migrate entity to a new archetype (part set changed). `opts.addPart` supplies data
  // for a part the entity did not have before (set_part on a new part name); `opts.removePart`
  // drops a part it did have (remove_part) — the extraction loop below would otherwise carry
  // it into the new pool since it still reads from the old pool's arrays.
  migrateEntity(
    entityId: number,
    newArchetype: ArchetypeKey,
    opts?: { addPart?: { name: string; data: Record<string, unknown> }; removePart?: string },
  ): EntityHandle {
    const oldArchetype = this.entityToPool.get(entityId);
    if (!oldArchetype) {
      throw new Error(`Entity ${entityId} not found`);
    }
    if (oldArchetype === newArchetype) {
      // No migration needed
      const index = this.entityToIndex.get(entityId)!;
      return { __entity: entityId, __archetype: newArchetype, __index: index };
    }

    const oldPool = this.pools.get(oldArchetype)!;
    const index = this.entityToIndex.get(entityId)!;

    // Extract all part data from old pool, minus the one being removed (if any)
    const partData: PartData[] = [];
    for (const [partName, arr] of oldPool.parts) {
      if (partName === opts?.removePart) continue;
      const data = arr[index];
      if (data !== null && data !== undefined) {
        partData.push({ name: partName, data: { ...data } });
      }
    }
    if (opts?.addPart) {
      partData.push({ name: opts.addPart.name, data: { ...opts.addPart.data } });
    }

    // Remove from old pool
    oldPool.entityIds[index] = 0;
    for (const arr of oldPool.parts.values()) {
      arr[index] = null;
    }
    oldPool.freeIndices.push(index);

    // Add to new pool
    const newPool = this.getPool(newArchetype);
    for (const part of partData) {
      if (!newPool.parts.has(part.name)) {
        newPool.parts.set(part.name, []);
      }
    }

    let newIndex: number;
    if (newPool.freeIndices.length > 0) {
      newIndex = newPool.freeIndices.pop()!;
      newPool.entityIds[newIndex] = entityId;
      for (const part of partData) {
        newPool.parts.get(part.name)![newIndex] = part.data;
      }
    } else {
      newIndex = newPool.entityIds.length;
      newPool.entityIds.push(entityId);
      for (const part of partData) {
        newPool.parts.get(part.name)!.push(part.data);
      }
    }

    this.entityToPool.set(entityId, newArchetype);
    this.entityToIndex.set(entityId, newIndex);

    return { __entity: entityId, __archetype: newArchetype, __index: newIndex };
  }

  // Get part data for an entity
  getPart(entityId: number, partName: string): Record<string, unknown> | null {
    const archetype = this.entityToPool.get(entityId);
    if (!archetype) return null;

    const pool = this.pools.get(archetype)!;
    const index = this.entityToIndex.get(entityId)!;
    const arr = pool.parts.get(partName);
    if (!arr) return null;

    const data = arr[index];
    return data !== null && data !== undefined ? { ...data } : null;
  }

  // Set part data (in-place update, no migration)
  setPart(entityId: number, partName: string, data: Record<string, unknown>): boolean {
    const archetype = this.entityToPool.get(entityId);
    if (!archetype) return false;

    const pool = this.pools.get(archetype)!;
    if (!pool.parts.has(partName)) return false;

    const index = this.entityToIndex.get(entityId)!;
    pool.parts.get(partName)![index] = { ...data };
    return true;
  }

  // Check if entity has a part
  hasPart(entityId: number, partName: string): boolean {
    const archetype = this.entityToPool.get(entityId);
    if (!archetype) return false;
    const pool = this.pools.get(archetype)!;
    return pool.parts.has(partName);
  }

  // Query all entities having ALL of the listed parts. A pool's archetype key is an
  // EXACT part set, so a pool that also carries extra parts (the common case — most
  // entities have more than one part) has a different key and would never match an
  // exact-key lookup. Scanning every pool and checking "does this archetype's part set
  // contain all of the queried names" is what "having ALL of the listed parts" (as
  // opposed to "having EXACTLY these parts and no others") actually requires.
  query(partNames: string[]): EntityHandle[] {
    const results: EntityHandle[] = [];
    for (const [archetype, pool] of this.pools) {
      let hasAll = true;
      for (const name of partNames) {
        if (!pool.parts.has(name)) {
          hasAll = false;
          break;
        }
      }
      if (!hasAll) continue;

      const entityIds = pool.entityIds;
      for (let i = 0; i < entityIds.length; i++) {
        const entityId = entityIds[i]!;
        if (entityId !== 0) {
          results.push({ __entity: entityId, __archetype: archetype, __index: i });
        }
      }
    }
    return results;
  }

  // Get all entity IDs in the registry
  getAllEntityIds(): number[] {
    const ids: number[] = [];
    for (const [id] of this.entityToPool) {
      ids.push(id);
    }
    return ids;
  }

  // Get entity handle
  getHandle(entityId: number): EntityHandle | null {
    const archetype = this.entityToPool.get(entityId);
    if (!archetype) return null;
    const index = this.entityToIndex.get(entityId)!;
    return { __entity: entityId, __archetype: archetype, __index: index };
  }

  // Validation helper for spawn
  validateParts(parts: PartData[]): string | null {
    const seen = new Set<string>();
    for (const part of parts) {
      if (seen.has(part.name)) {
        return `Duplicate part: ${part.name}`;
      }
      seen.add(part.name);

      const err = validatePartData(part.name, part.data);
      if (err) return err;
    }
    return null;
  }

  // Stats for debugging/benchmarks
  getStats(): { pools: number; totalEntities: number; totalSlots: number } {
    let totalEntities = 0;
    let totalSlots = 0;
    for (const pool of this.pools.values()) {
      totalSlots += pool.entityIds.length;
      totalEntities += pool.entityIds.filter((id) => id !== 0).length;
    }
    return { pools: this.pools.size, totalEntities, totalSlots };
  }
}