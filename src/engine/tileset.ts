// Tileset renderer (C1) — a second door to the screen (docs/engine.md §15).
//
// The engine emits one Cell grid; the ANSI emitter paints it in a terminal and the
// Studio DOM painter paints it in a window. A tileset adds presentation on top of the
// window path only: a cell whose character has a tile entry is painted with the tile
// image as its background, and the character text stays in the cell. The grid remains
// the truth — diffing, ANSI bytes, goldens and qbsk_read_window never see a tile.
//
// A tileset is a `.qbdata` file, so it cannot run and its entries are validated at
// load (docs/language.md §12). This loader adds the tile-specific checks on top of the
// shape check: each entry is a dict with a one-character `glyph` and an `image` path
// relative to the tileset file, a glyph is mapped at most once, and the image file
// must exist. Every error carries a span pointing at the entry that caused it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QbskSyntaxError } from "../interp/error.js";
import { loadQbdata } from "../parser/qbdata.js";
import type { Cell } from "./cell.js";

export interface Tileset {
  /** glyph -> absolute image path, for every entry that loaded and validated. */
  glyphs: Map<string, string>;
  /** All errors, each with a span at the offending entry's line. */
  errors: QbskSyntaxError[];
}

/**
 * Loads and validates a tileset file. Errors are RETURNED, never thrown — the same
 * contract as `loadQbdata`, so a caller that reports them never crashes on a broken
 * tileset (docs/engine.md §15: a failed tileset leaves the window painting characters).
 */
export function loadTileset(source: string, file: string): Tileset {
  const glyphs = new Map<string, string>();
  const data = loadQbdata(source, file);
  const errors: QbskSyntaxError[] = [...data.errors];
  const entryLines = data.entryLines;

  const fail = (message: string, entry: string): void => {
    const line = entryLines.get(entry) ?? 1;
    const at = { line, col: 1, offset: 0 };
    errors.push(new QbskSyntaxError(message, { file, start: at, end: at }));
  };

  const glyphOwner = new Map<string, string>();
  for (const [name, value] of data.entries) {
    if (value.type !== "dict") {
      fail(`tile '${name}' must be a dict with 'glyph' and 'image'`, name);
      continue;
    }
    const glyph = value.map.get("glyph");
    const image = value.map.get("image");
    if (glyph === undefined || image === undefined) {
      fail(
        `tile '${name}' is missing '${glyph === undefined ? "glyph" : "image"}'`,
        name,
      );
      continue;
    }
    if (glyph.type !== "str" || image.type !== "str") {
      fail(`tile '${name}': 'glyph' and 'image' must be strings`, name);
      continue;
    }
    const ch = glyph.value;
    if (ch.length !== 1) {
      fail(
        `tile '${name}': 'glyph' must be exactly one character, got '${ch}'`,
        name,
      );
      continue;
    }
    const first = glyphOwner.get(ch);
    if (first !== undefined) {
      fail(`glyph '${ch}' is mapped by both '${first}' and '${name}'`, name);
      continue;
    }
    const path = resolve(dirname(file), image.value);
    if (!existsSync(path)) {
      fail(`tile '${name}': image '${image.value}' does not exist`, name);
      continue;
    }
    glyphs.set(ch, path);
    glyphOwner.set(ch, name);
  }

  return { glyphs, errors };
}

/**
 * The pure lookup the DOM painter uses: given a cell and the tile map, return the
 * tile value for that cell's character, or null when it has no tile (docs/engine.md
 * §15.1 — the fallback is the character, never a hole).
 */
export function tileForCell(
  cell: Pick<Cell, "char">,
  tiles: ReadonlyMap<string, string>,
): string | null {
  return tiles.get(cell.char) ?? null;
}

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * Converts a loaded tileset's image paths into data URLs, so the host can ship the
 * tileset to the renderer without touching the filesystem there. The URL is a pure
 * function of the file bytes, so identical tilesets produce identical URLs — and the
 * window CSP only needs `img-src data:`.
 */
export function tileDataUrls(tiles: ReadonlyMap<string, string>): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [glyph, path] of tiles) {
    let mime = "application/octet-stream";
    const dot = path.lastIndexOf(".");
    if (dot >= 0) {
      mime = MIME[path.slice(dot).toLowerCase()] ?? mime;
    }
    urls.set(glyph, `data:${mime};base64,${readFileSync(path).toString("base64")}`);
  }
  return urls;
}
