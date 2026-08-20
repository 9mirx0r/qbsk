// ECS Foundation (an earlier design, docs/engine.md §16) — host-side, pre-native.
//
// This module shipped with zero tests (Claude Code review, 2026-08-08), which is why two
// real bugs reached it undetected: query() only matched an exact archetype instead of
// "has at least these parts", and setPart()'s spatial-index update passed the same point
// as both the old and new position, so a moved entity was never re-indexed. Both are
// fixed here and pinned so neither regresses silently again.
import { describe, expect, it } from "vitest";
import { ECS } from "../../src/ecs/index.js";

const spawnMover = (ecs: ECS, x: number, y: number) =>
  ecs.spawn([
    { __part: "Position", x, y, z: 0 },
    { __part: "Velocity", vx: 0, vy: 0 },
  ]);

describe("spawn / find / despawn", () => {
  it("spawns an entity and reads its parts back", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 3, 4);
    expect(ecs.find(e, "Position")).toEqual({ x: 3, y: 4, z: 0 });
    expect(ecs.find(e, "Velocity")).toEqual({ vx: 0, vy: 0 });
  });

  it("a part the entity does not have reads as null", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    expect(ecs.find(e, "Health")).toBeNull();
  });

  it("despawn removes the entity from queries and the spatial index", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 5, 5);
    ecs.despawn(e);
    expect(ecs.query(["Position"])).toEqual([]);
    expect(ecs.entitiesInRadius(5, 5, 0, 1)).toEqual([]);
  });
});

describe("query matches a superset of the requested parts", () => {
  it("finds an entity whose archetype has MORE parts than requested", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    const found = ecs.query(["Position"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.__entity).toBe(e.__entity);
  });

  it("does not find an entity missing one of the requested parts", () => {
    const ecs = new ECS(10);
    ecs.spawn([{ __part: "Velocity", vx: 1, vy: 0 }]);
    expect(ecs.query(["Position"])).toEqual([]);
  });

  it("matches across multiple distinct archetypes that all carry the part", () => {
    const ecs = new ECS(10);
    const a = spawnMover(ecs, 0, 0); // Position + Velocity
    const b = ecs.spawn([{ __part: "Position", x: 1, y: 1, z: 0 }]); // Position only
    const ids = ecs.query(["Position"]).map((h) => h.__entity).sort();
    expect(ids).toEqual([a.__entity, b.__entity].sort());
  });
});

describe("the spatial index stays correct when an entity moves", () => {
  it("setPart(Position) re-indexes the entity at its new cell", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    expect(ecs.entitiesInRadius(0, 0, 0, 5).map((h) => h.__entity)).toEqual([e.__entity]);

    ecs.setPart(e, "Position", { x: 100, y: 100, z: 0 });

    expect(ecs.entitiesInRadius(100, 100, 0, 5).map((h) => h.__entity)).toEqual([
      e.__entity,
    ]);
    expect(ecs.entitiesInRadius(0, 0, 0, 5)).toEqual([]);
  });

  it("entitiesInCell agrees with entitiesInRadius after a move", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    ecs.setPart(e, "Position", { x: 50, y: 50, z: 0 });
    expect(ecs.entitiesInCell(50, 50, 0).map((h) => h.__entity)).toEqual([e.__entity]);
    expect(ecs.entitiesInCell(0, 0, 0)).toEqual([]);
  });
});

describe("adding a part migrates the entity to a new archetype", () => {
  it("setPart with a part the entity never had adds it, not silently fails", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    const ok = ecs.setPart(e, "Health", { hp: 5, max_hp: 5, regen: 0 });
    expect(ok).toBe(true);
    expect(ecs.find(e, "Health")).toEqual({ hp: 5, max_hp: 5, regen: 0 });
  });

  it("existing parts survive the migration unchanged", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 7, 8);
    ecs.setPart(e, "Health", { hp: 5, max_hp: 5, regen: 0 });
    expect(ecs.find(e, "Position")).toEqual({ x: 7, y: 8, z: 0 });
    expect(ecs.find(e, "Velocity")).toEqual({ vx: 0, vy: 0 });
  });

  it("a query for the new part now finds the entity", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    ecs.setPart(e, "Health", { hp: 5, max_hp: 5, regen: 0 });
    expect(ecs.query(["Health"]).map((h) => h.__entity)).toEqual([e.__entity]);
  });
});

describe("removing a part migrates the entity, rather than leaving a hollow slot", () => {
  it("removePart drops the part from the archetype", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    const ok = ecs.removePart(e, "Velocity");
    expect(ok).toBe(true);
    expect(ecs.hasPart(e, "Velocity")).toBe(false);
  });

  it("a query for the removed part no longer finds the entity", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    ecs.removePart(e, "Velocity");
    expect(ecs.query(["Velocity"])).toEqual([]);
  });

  it("the remaining parts survive the migration unchanged", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 9, 1);
    ecs.removePart(e, "Velocity");
    expect(ecs.find(e, "Position")).toEqual({ x: 9, y: 1, z: 0 });
  });

  it("removing Position takes the entity out of the spatial index", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 2, 2);
    ecs.removePart(e, "Position");
    expect(ecs.entitiesInRadius(2, 2, 0, 5)).toEqual([]);
  });

  it("removing a part the entity does not have is a no-op, not a crash", () => {
    const ecs = new ECS(10);
    const e = spawnMover(ecs, 0, 0);
    expect(ecs.removePart(e, "Health")).toBe(false);
  });
});

describe("validation rejects a malformed part at spawn", () => {
  it("a Position missing a required field is rejected", () => {
    const ecs = new ECS(10);
    expect(() => ecs.spawn([{ __part: "Position", x: 0 }])).toThrow(/missing required field/);
  });

  it("an unknown part name is rejected", () => {
    const ecs = new ECS(10);
    expect(() => ecs.spawn([{ __part: "NotAPart" }])).toThrow(/Unknown part/);
  });
});
