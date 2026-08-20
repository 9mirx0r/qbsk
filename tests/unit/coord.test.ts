import { describe, expect, it } from "vitest";
import {
  localToWorld,
  worldToLocal,
  applyLayerOffset,
} from "../../src/choreo/coord.js";

describe("coord: world ↔ local (M16)", () => {
  it("localToWorld adds the layer offset", () => {
    expect(localToWorld(0, 8, 1, 0)).toEqual({ x: 1, y: 8 });
    expect(localToWorld(5, 5, 10, 3)).toEqual({ x: 15, y: 8 });
    expect(localToWorld(0, 0, 4, 4)).toEqual({ x: 4, y: 4 });
  });

  it("worldToLocal subtracts the layer offset", () => {
    expect(worldToLocal(0, 8, 1, 8)).toEqual({ x: 1, y: 0 });
    expect(worldToLocal(5, 5, 15, 8)).toEqual({ x: 10, y: 3 });
    expect(worldToLocal(0, 0, 4, 4)).toEqual({ x: 4, y: 4 });
  });

  it("round-trip local→world→local is identity", () => {
    const layer = { x: 3, y: -2 };
    const p = { x: 7, y: 4 };
    const w = localToWorld(layer.x, layer.y, p.x, p.y);
    const back = worldToLocal(layer.x, layer.y, w.x, w.y);
    expect(back).toEqual(p);
  });

  it("applyLayerOffset: local adds the offset, world:true does not", () => {
    const local = { x: 2, y: 1, world: false };
    const abs = { x: 2, y: 1, world: true };
    expect(applyLayerOffset(local, 10, 8)).toEqual({ x: 12, y: 9 });
    expect(applyLayerOffset(abs, 10, 8)).toEqual({ x: 2, y: 1 });
  });
});
