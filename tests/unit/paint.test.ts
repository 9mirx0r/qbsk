// The DOM painter (docs/engine.md §15, docs/studio.md §4).
//
// DomGrid had no tests, which is how a tileset change that never repainted reached the
// owner. The DOM surface it uses is four properties wide, so a fake element is enough to
// test the logic without pulling in jsdom — and the logic is where the bug was.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCell, DomGrid } from "../../studio/renderer/paint.js";
import type { Cell } from "../../src/engine/cell.js";
import type { DiffLine } from "../../src/engine/diff.js";

interface FakeElement {
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: FakeElement[];
  append(child: FakeElement): void;
}

const element = (): FakeElement => ({
  className: "",
  textContent: "",
  style: {},
  children: [],
  append(child) {
    this.children.push(child);
  },
});

const cell = (char: string, fg = -1, bg = -1, attrs = 0): Cell => ({
  char,
  fg,
  bg,
  attrs,
});

/** One full-row diff, which is what a first paint produces. */
const rowDiff = (y: number, cells: Cell[]): DiffLine[] => [
  { y, rewrite: true, row: cells, runs: [], changed: cells.length } as DiffLine,
];

let saved: unknown;

beforeEach(() => {
  saved = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: () => element(),
  };
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = saved;
});

const grid = (w: number, h: number) => {
  const container = element();
  const g = new DomGrid(container as unknown as HTMLElement);
  g.reset(w, h);
  return { g, container };
};

const bgImage = (container: FakeElement, i: number): string =>
  container.children[i]!.style["backgroundImage"] ?? "";

describe("applyCell", () => {
  it("paints a character with its colours when there is no tile", () => {
    const el = element();
    applyCell(el as unknown as HTMLSpanElement, cell("@", 0xff0000), null);
    expect(el.textContent).toBe("@");
    expect(el.style["color"]).toContain("255");
    expect(el.style["backgroundImage"]).toBe("");
  });

  it("a tile takes the cell's pixels and hides the character", () => {
    const el = element();
    const tiles = new Map([["#", "data:image/svg+xml;base64,AAA"]]);
    applyCell(el as unknown as HTMLSpanElement, cell("#"), tiles);
    // The character is still THERE — renderText reads it, and the grid stays the
    // truth (docs/engine.md §15). It is only made invisible.
    expect(el.textContent).toBe("#");
    expect(el.style["color"]).toBe("transparent");
    expect(el.style["backgroundImage"]).toContain("data:image");
  });

  it("a cell whose char has no tile paints exactly as before", () => {
    const el = element();
    const tiles = new Map([["#", "data:image/png;base64,AAA"]]);
    applyCell(el as unknown as HTMLSpanElement, cell("@", 0x00ff00), tiles);
    expect(el.style["color"]).toContain("255");
    expect(el.style["backgroundImage"]).toBe("");
  });
});

describe("DomGrid", () => {
  it("paints what the diff reports", () => {
    const { g, container } = grid(3, 1);
    g.paint(rowDiff(0, [cell("a"), cell("b"), cell("c")]));
    expect(g.renderText()).toBe("abc");
    void container;
  });

  it("renderText reads the characters back, tiles or not", () => {
    const { g } = grid(3, 1);
    g.setTiles(new Map([["a", "data:image/png;base64,AAA"]]));
    g.paint(rowDiff(0, [cell("a"), cell("b"), cell("c")]));
    // The whole §15 promise: a tiled window still reads back as characters, which is
    // what the smoke check and qbsk_read_window depend on.
    expect(g.renderText()).toBe("abc");
  });
});

// The reviewed finding: `applyTileset` set the map and stopped, `paint` only touches
// cells the diff reported, and nothing else repainted — so choosing a tileset with a
// scene on screen logged success and changed nothing.
describe("changing the tileset repaints what is already on screen", () => {
  const TILES = new Map([["#", "data:image/svg+xml;base64,AAA"]]);

  it("cells painted BEFORE the tileset arrives get their tiles", () => {
    const { g, container } = grid(2, 1);
    g.paint(rowDiff(0, [cell("#"), cell(".")]));
    expect(bgImage(container, 0)).toBe("");

    g.setTiles(TILES);
    expect(bgImage(container, 0)).toContain("data:image");
    // The untiled cell is untouched: the fallback is still the character.
    expect(bgImage(container, 1)).toBe("");
  });

  it("clearing the tileset puts the characters back", () => {
    const { g, container } = grid(2, 1);
    g.setTiles(TILES);
    g.paint(rowDiff(0, [cell("#"), cell(".")]));
    expect(bgImage(container, 0)).toContain("data:image");

    g.setTiles(null);
    expect(bgImage(container, 0)).toBe("");
    expect(container.children[0]!.style["color"]).not.toBe("transparent");
  });

  it("swapping one tileset for another re-tiles the screen", () => {
    const { g, container } = grid(1, 1);
    g.paint(rowDiff(0, [cell("#")]));
    g.setTiles(new Map([["#", "data:image/png;base64,ONE"]]));
    expect(bgImage(container, 0)).toContain("ONE");

    g.setTiles(new Map([["#", "data:image/png;base64,TWO"]]));
    expect(bgImage(container, 0)).toContain("TWO");
  });

  it("a never-painted cell stays blank rather than being invented", () => {
    const { g, container } = grid(2, 1);
    g.paint(rowDiff(0, [cell("#")]));
    g.setTiles(TILES);
    expect(container.children[1]!.textContent).toBe("");
  });

  it("the characters survive every repaint", () => {
    const { g } = grid(3, 1);
    g.paint(rowDiff(0, [cell("#"), cell("."), cell("@")]));
    g.setTiles(TILES);
    g.setTiles(null);
    g.setTiles(TILES);
    expect(g.renderText()).toBe("#.@");
  });

  it("reset forgets the old cells, so a new scene does not inherit them", () => {
    const { g, container } = grid(2, 1);
    g.paint(rowDiff(0, [cell("#"), cell("#")]));
    g.reset(2, 1);
    g.setTiles(TILES);
    // Nothing has been painted since the reset, so nothing gets a tile.
    expect(bgImage(container, 0)).toBe("");
  });
});
