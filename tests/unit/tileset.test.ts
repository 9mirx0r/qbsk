// Tileset renderer (C1) — the second door to the screen (docs/engine.md §15).
// A tileset is optional presentation: it maps a cell character to an image, applied
// only in the Studio DOM painter. The character grid stays the truth — the tile is a
// background over the cell, never a replacement for its text.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTileset, tileDataUrls, tileForCell } from "../../src/engine/tileset.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qbsk-tiles-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string): string => {
  const file = join(dir, name);
  writeFileSync(file, body, "utf8");
  return file;
};

const load = (file: string) => loadTileset(readFileSync(file, "utf8"), file);

const TILESET = [
  "shape tile",
  "    glyph: str",
  "    image: str",
  "",
  'WALL = {"glyph": "#", "image": "wall.svg"}',
  'FLOOR = {"glyph": ".", "image": "floor.svg"}',
].join("\n");

describe("loading a tileset", () => {
  it("maps each glyph to its image path resolved against the tileset file", () => {
    write("wall.svg", "<svg/>");
    write("floor.svg", "<svg/>");
    const t = load(write("tiles.qbdata", TILESET));
    expect(t.errors).toEqual([]);
    expect(t.glyphs.size).toBe(2);
    expect(t.glyphs.get("#")).toBe(join(dir, "wall.svg"));
    expect(t.glyphs.get(".")).toBe(join(dir, "floor.svg"));
  });

  it("an entry that is not a dict reports with a span", () => {
    const t = load(write("tiles.qbdata", 'BROKEN = "nope"'));
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]!.span.start.line).toBe(1);
  });

  it("a missing glyph or image key names the entry and the key", () => {
    const t = load(write("tiles.qbdata", 'WALL = {"glyph": "#"}'));
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]!.message).toContain("WALL");
    expect(t.errors[0]!.message).toContain("image");
  });

  it("a glyph that is not exactly one character reports", () => {
    const t = load(write("tiles.qbdata", 'WALL = {"glyph": "##", "image": "w.svg"}'));
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]!.message).toContain("glyph");
  });

  it("a duplicate glyph names both entries and points at the second", () => {
    write("wall.svg", "<svg/>");
    write("floor.svg", "<svg/>");
    write("d.svg", "<svg/>");
    const t = load(
      write("tiles.qbdata", TILESET + '\nDOUBLE = {"glyph": "#", "image": "d.svg"}'),
    );
    expect(t.errors.length).toBe(1);
    const msg = t.errors[0]!.message;
    expect(msg).toContain("WALL");
    expect(msg).toContain("DOUBLE");
    expect(t.errors[0]!.span.start.line).toBe(7);
  });

  it("a missing image file reports at the entry's line", () => {
    write("floor.svg", "<svg/>");
    const t = load(write("tiles.qbdata", TILESET.replace("wall.svg", "gone.svg")));
    expect(t.errors.length).toBe(1);
    expect(t.errors[0]!.message).toContain("gone.svg");
    expect(t.errors[0]!.span.start.line).toBe(5);
  });

  it("a file that fails to load reports its errors, never throws", () => {
    const t = load(write("tiles.qbdata", "X = 1 + 1"));
    expect(t.errors.length).toBeGreaterThan(0);
  });
});

describe("tileForCell", () => {
  const tiles = new Map([
    ["#", "wall"],
    [".", "floor"],
  ]);

  it("returns the mapped value for a cell whose char has a tile", () => {
    expect(tileForCell({ char: "#" }, tiles)).toBe("wall");
  });

  it("returns null for a cell whose char has no tile", () => {
    expect(tileForCell({ char: "g" }, tiles)).toBeNull();
  });

  it("the character grid stays the truth: a blank cell has no tile", () => {
    expect(tileForCell({ char: " " }, tiles)).toBeNull();
  });
});

describe("tileDataUrls", () => {
  it("encodes each image as a deterministic data URL", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/></svg>';
    write("wall.svg", svg);
    const paths = new Map([["#", join(dir, "wall.svg")]]);
    const urls = tileDataUrls(paths);
    const expected = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    expect(urls.get("#")).toBe(expected);
  });
});
