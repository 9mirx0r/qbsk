import { describe, expect, it } from "vitest";
import {
  composeScene,
  type SceneDef,
} from "../../src/choreo/scene.js";

function scene(overrides: Partial<SceneDef> = {}): SceneDef {
  return {
    name: "test",
    width: 6,
    height: 4,
    layers: [],
    ...overrides,
  };
}

describe("scene: composition by z", () => {
  it("layers compose bottom→top and the highest z wins", () => {
    const def = scene({
      width: 6,
      height: 3,
      layers: [
        { name: "top", z: 10, visible: true, items: [{ op: "text", x: 0, y: 0, text: "AAA" }] },
        { name: "bottom", z: 1, visible: true, items: [{ op: "text", x: 0, y: 0, text: "BBB" }] },
      ],
    });
    expect(composeScene(def).renderText()).toBe("AAA   \n      \n      ");
  });

  it("declaration order does not matter: the highest z always wins", () => {
    const def = scene({
      width: 4,
      height: 1,
      layers: [
        { name: "a", z: 5, visible: true, items: [{ op: "text", x: 0, y: 0, text: "AA" }] },
        { name: "b", z: 9, visible: true, items: [{ op: "text", x: 1, y: 0, text: "BB" }] },
      ],
    });
    expect(composeScene(def).renderText()).toBe("ABB ");
  });

  it("visible: false drops the layer", () => {
    const def = scene({
      width: 4,
      height: 1,
      layers: [
        { name: "hidden", z: 10, visible: false, items: [{ op: "text", x: 0, y: 0, text: "XX" }] },
        { name: "shown", z: 1, visible: true, items: [{ op: "text", x: 0, y: 0, text: "ok" }] },
      ],
    });
    expect(composeScene(def).renderText()).toBe("ok  ");
  });

  it("a layer fill paints below the texts of upper layers", () => {
    const def = scene({
      width: 5,
      height: 2,
      layers: [
        { name: "bg", z: 1, visible: true, items: [{ op: "fill", ch: "." }] },
        { name: "fg", z: 2, visible: true, items: [{ op: "text", x: 1, y: 0, text: "hi" }] },
      ],
    });
    expect(composeScene(def).renderText()).toBe(".hi..\n.....");
  });

  it("border with single, double and rounded styles", () => {
    const single = scene({
      width: 4,
      height: 3,
      layers: [{ name: "l", z: 1, visible: true, items: [{ op: "border", x1: 0, y1: 0, x2: 3, y2: 2, style: "single" }] }],
    });
    expect(composeScene(single).renderText()).toBe("+--+\n|  |\n+--+");
    const double = scene({
      width: 4,
      height: 3,
      layers: [{ name: "l", z: 1, visible: true, items: [{ op: "border", x1: 0, y1: 0, x2: 3, y2: 2, style: "double" }] }],
    });
    expect(composeScene(double).renderText()).toBe("╔══╗\n║  ║\n╚══╝");
    const rounded = scene({
      width: 4,
      height: 3,
      layers: [{ name: "l", z: 1, visible: true, items: [{ op: "border", x1: 0, y1: 0, x2: 3, y2: 2, style: "rounded" }] }],
    });
    expect(composeScene(rounded).renderText()).toBe("╭──╮\n│  │\n╰──╯");
  });

  it("blit copies text lines at (x, y)", () => {
    const def = scene({
      width: 6,
      height: 3,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [{ op: "blit", x: 1, y: 1, lines: [" O", "/|\\", "/ \\"] }],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("      \n  O   \n /|\\  ");
  });

  it("out-of-range ops are dropped (clipping, no crash)", () => {
    const def = scene({
      width: 4,
      height: 2,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [
            { op: "border", x1: -5, y1: -5, x2: 10, y2: 10, style: "single" },
            { op: "text", x: 8, y: 8, text: "zzz" },
            { op: "line", x1: -2, y1: 0, x2: -1, y2: 5, ch: "*" },
          ],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("    \n    ");
  });

  it("border partially out of range draws only what is visible", () => {
    const def = scene({
      width: 4,
      height: 2,
      layers: [
        { name: "l", z: 1, visible: true, items: [{ op: "border", x1: -1, y1: -1, x2: 3, y2: 1, style: "single" }] },
      ],
    });
    expect(composeScene(def).renderText()).toBe("   |\n---+");
  });

  it("line draws a diagonal inside the canvas", () => {
    const def = scene({
      width: 3,
      height: 3,
      layers: [{ name: "l", z: 1, visible: true, items: [{ op: "line", x1: 0, y1: 0, x2: 2, y2: 2, ch: "*" }] }],
    });
    expect(composeScene(def).renderText()).toBe("*  \n * \n  *");
  });

  it("rect fills the area", () => {
    const def = scene({
      width: 5,
      height: 3,
      layers: [{ name: "l", z: 1, visible: true, items: [{ op: "rect", x1: 1, y1: 1, x2: 3, y2: 2, ch: "#" }] }],
    });
    expect(composeScene(def).renderText()).toBe("     \n ### \n ### ");
  });
});

describe("scene: per-primitive z and visible (M15)", () => {
  it("inside a layer, items compose by ascending z", () => {
    const def = scene({
      width: 3,
      height: 1,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [
            { op: "text", x: 0, y: 0, text: "HHH", z: 5 },
            { op: "text", x: 0, y: 0, text: "LLL", z: 1 },
          ],
        },
      ],
    });
    // z=5 overwrites z=1 in each cell; the item order does not matter
    expect(composeScene(def).renderText()).toBe("HHH");
  });

  it("z tie: declaration order wins (stable)", () => {
    const def = scene({
      width: 3,
      height: 1,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [
            { op: "text", x: 0, y: 0, text: "abc", z: 2 },
            { op: "text", x: 0, y: 0, text: "XYZ", z: 2 },
          ],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("XYZ");
  });

  it("items with default z are 0", () => {
    const def = scene({
      width: 3,
      height: 1,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [
            { op: "text", x: 0, y: 0, text: "zzz", z: 3 },
            { op: "text", x: 0, y: 0, text: "AAA" },
          ],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("zzz");
  });

  it("visible: false drops the primitive, not the layer", () => {
    const def = scene({
      width: 4,
      height: 1,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [
            { op: "text", x: 0, y: 0, text: "XX", visible: false },
            { op: "text", x: 0, y: 0, text: "ok" },
          ],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("ok  ");
  });

  it("visible: true by default: the primitive composes", () => {
    const def = scene({
      width: 3,
      height: 1,
      layers: [
        { name: "l", z: 1, visible: true, items: [{ op: "text", x: 0, y: 0, text: "hey" }] },
      ],
    });
    expect(composeScene(def).renderText()).toBe("hey");
  });
});

describe("scene: layer and world offsets (M16)", () => {
  it("layer at (x, y): local primitives compose at at + local", () => {
    const def = scene({
      width: 6,
      height: 5,
      layers: [
        {
          name: "hud",
          z: 1,
          visible: true,
          at: { x: 0, y: 4 },
          items: [{ op: "text", x: 1, y: 0, text: "pts" }],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("      \n      \n      \n      \n pts  ");
  });

  it("primitive with world:true ignores the layer offset", () => {
    const def = scene({
      width: 6,
      height: 5,
      layers: [
        {
          name: "hud",
          z: 1,
          visible: true,
          at: { x: 0, y: 4 },
          items: [
            { op: "text", x: 1, y: 0, text: "aaa", world: true },
            { op: "text", x: 1, y: 0, text: "bbb" },
          ],
        },
      ],
    });
    // "aaa" (world) en (1,0); "bbb" (local) en (1,4)
    expect(composeScene(def).renderText()).toBe(" aaa  \n      \n      \n      \n bbb  ");
  });

  it("layer without at equals offset (0,0)", () => {
    const def = scene({
      width: 4,
      height: 2,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          items: [{ op: "text", x: 0, y: 0, text: "hi" }],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("hi  \n    ");
  });

  it("world:true with a negative offset stays global", () => {
    const def = scene({
      width: 4,
      height: 4,
      layers: [
        {
          name: "l",
          z: 1,
          visible: true,
          at: { x: -10, y: -10 },
          items: [{ op: "text", x: 2, y: 1, text: "ab", world: true }],
        },
      ],
    });
    expect(composeScene(def).renderText()).toBe("    \n  ab\n    \n    ");
  });
});
