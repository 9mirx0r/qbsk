// ECS Core Types — an earlier design (docs/engine.md §16)
// Pure TypeScript, no Electron, no Node deps — host-side only.

export type ArchetypeKey = string;  // sorted part names joined by "|"

export interface PartDef {
  name: string;
  fields: Record<string, PartFieldDef>;
  required?: string[];
  defaults?: Record<string, unknown>;
}

export type PartFieldDef =
  | { type: "int" | "float" | "bool" | "str" }
  | { type: "list"; item: PartFieldDef }
  | { type: "dict"; schema: Record<string, PartFieldDef> }
  | { type: "entity_ref" };

export interface Pool {
  archetype: ArchetypeKey;
  parts: Map<string, unknown[]>;  // part name -> contiguous array
  entityIds: number[];        // entity ID per index (stable)
  freeIndices: number[];      // recycled slots
}

export interface EntityHandle {
  __entity: number;
  __archetype: ArchetypeKey;
  __index: number;
}

export interface PartData {
  name: string;
  data: Record<string, unknown>;
}

// Standard part definitions (host-side)
export const STANDARD_PARTS: Record<string, PartDef> = {
  Position: {
    name: "Position",
    fields: {
      x: { type: "float" },
      y: { type: "float" },
      z: { type: "int" },
    },
    required: ["x", "y", "z"],
    defaults: { x: 0.0, y: 0.0, z: 0 },
  },
  Velocity: {
    name: "Velocity",
    fields: {
      vx: { type: "float" },
      vy: { type: "float" },
    },
    required: ["vx", "vy"],
    defaults: { vx: 0.0, vy: 0.0 },
  },
  Renderable: {
    name: "Renderable",
    fields: {
      glyph: { type: "str" },
      fg: { type: "str" },
      bg: { type: "str" },
      z: { type: "int" },
    },
    required: ["glyph", "fg", "bg", "z"],
    defaults: { glyph: "?", fg: "white", bg: "black", z: 0 },
  },
  Health: {
    name: "Health",
    fields: {
      hp: { type: "int" },
      max_hp: { type: "int" },
      regen: { type: "float" },
    },
    required: ["hp", "max_hp"],
    defaults: { hp: 1, max_hp: 1, regen: 0.0 },
  },
  Brain: {
    name: "Brain",
    fields: {
      kind: { type: "str" },
    },
    required: ["kind"],
    defaults: { kind: "none" },
  },
  Faction: {
    name: "Faction",
    fields: {
      name: { type: "str" },
    },
    required: ["name"],
    defaults: { name: "neutral" },
  },
  Inventory: {
    name: "Inventory",
    fields: {
      items: { type: "list", item: { type: "entity_ref" } },
    },
    required: ["items"],
    defaults: { items: [] },
  },
  Name: {
    name: "Name",
    fields: {
      name: { type: "str" },
      description: { type: "str" },
    },
    required: ["name"],
    defaults: { name: "", description: "" },
  },
};

// Reserved keys injected by host
export const RESERVED_PART_KEYS = ["__part", "__entity", "__archetype"] as const;

export function makeArchetypeKey(partNames: string[]): ArchetypeKey {
  return [...partNames].sort().join("|");
}

export function validatePartData(partName: string, data: Record<string, unknown>): string | null {
  const def = STANDARD_PARTS[partName];
  if (!def) {
    return `Unknown part: ${partName}`;
  }
  for (const req of def.required ?? []) {
    if (!(req in data)) {
      return `Part ${partName} missing required field: ${req}`;
    }
  }
  return null;
}